import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ArtifactError } from "./artifact-error.js";
import type { ServerConfig } from "./config.js";
import {
  describeIncomingArtifactValue,
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ARTIFACT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW;
const MAX_RENAME_ATTEMPTS = 10_000;
const MAX_SAFE_FILENAME_BYTES = 180;
const MAX_SAFE_EXTENSION_BYTES = 32;
const PARTIAL_PREFIX = ".devspace-download-";
const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_PARTIAL_CLEANUP = 32;

const openAIFileReferenceInputSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

export interface ArtifactToolRegistrationOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export interface DownloadIncomingArtifactInput {
  file: unknown;
  workspaceId: string;
}

export interface DownloadIncomingArtifactResult {
  path: string;
  size: number;
  sha256: string;
}

interface SecureIncomingDirectory {
  rootHandle: FileHandle;
  devspaceHandle: FileHandle;
  incomingHandle: FileHandle;
  anchorPath: string;
  close(): Promise<void>;
}

export function registerArtifactTools(
  server: McpServer,
  {
    config,
    workspaces,
    incomingArtifactAdapters = [],
  }: ArtifactToolRegistrationOptions,
): void {
  const incomingRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);

  registerAppTool(
    server,
    "download_artifact",
    {
      title: "Download attached or generated file",
      description:
        "Stream one MCP-host-provided native file into the selected workspace's .devspace/incoming directory. DevSpace chooses a collision-free filename and returns its workspace-relative path. Arbitrary URLs, local paths, and malformed file objects are rejected.",
      inputSchema: {
        file: openAIFileReferenceInputSchema.describe(
          "Native file value authorized and supplied by the MCP host.",
        ),
        workspaceId: z.string().min(1).describe(
          "Workspace identifier returned by open_workspace.",
        ),
      },
      outputSchema: {
        path: z.string(),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, input, async () => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const downloaded = await downloadIncomingArtifact({
        registry: incomingRegistry,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        maxFileBytes: config.artifactMaxFileBytes,
        file: input.file,
      });
      return {
        publicResult: { path: downloaded.path },
        logResult: downloaded,
      };
    }),
  );
}

/**
 * Stream a trusted native file directly into one already-open workspace.
 *
 * Bytes are written to an exclusive private partial, hashed and size-checked,
 * chmodded through the still-open file descriptor, fsynced, and only then
 * published with an atomic hard link. No path-based chmod/hash/verification is
 * performed after publication.
 */
export async function downloadIncomingArtifact({
  registry,
  workspaceId,
  workspaceRoot,
  maxFileBytes,
  file,
}: {
  registry: IncomingArtifactAdapterRegistry;
  workspaceId: string;
  workspaceRoot: string;
  maxFileBytes: number;
  file: unknown;
}): Promise<DownloadIncomingArtifactResult> {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ArtifactError(
      "artifact_limit_invalid",
      "Artifact file-size limit must be a positive integer.",
    );
  }
  if (!workspaceId) {
    throw new ArtifactError(
      "artifact_workspace_invalid",
      "A selected workspace is required for native file download.",
    );
  }

  const opened = await registry.open(file);
  let secureDirectory: SecureIncomingDirectory | undefined;
  let partialPath: string | undefined;
  let handle: FileHandle | undefined;

  try {
    if (opened.size !== undefined && opened.size > maxFileBytes) {
      throw new ArtifactError(
        "artifact_file_too_large",
        "Native file exceeds the configured per-file limit.",
      );
    }

    secureDirectory = await prepareIncomingDirectory(workspaceRoot);
    await cleanupStalePartials(secureDirectory);
    await assertPrivateDirectoryHandle(secureDirectory.incomingHandle);

    partialPath = join(
      secureDirectory.anchorPath,
      `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    handle = await open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );

    const hash = createHash("sha256");
    let size = 0;
    for await (const value of opened.stream) {
      const chunk = incomingStreamChunk(value);
      if (size + chunk.length > maxFileBytes) {
        throw new ArtifactError(
          "artifact_file_too_large",
          "Native file exceeds the configured per-file limit.",
        );
      }
      await writeAll(handle, chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }

    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactError(
        "artifact_file_size_mismatch",
        "Native file metadata did not match the downloaded content.",
      );
    }

    await handle.chmod(0o644);
    await handle.sync();
    const writtenEntry = await handle.stat();
    if (!writtenEntry.isFile() || writtenEntry.size !== size) {
      throw new ArtifactError(
        "artifact_write_integrity_failed",
        "Native file could not be verified before publication.",
      );
    }

    await assertPrivateDirectoryHandle(secureDirectory.incomingHandle);
    const partialEntry = await lstat(partialPath);
    if (
      partialEntry.isSymbolicLink()
      || !partialEntry.isFile()
      || partialEntry.dev !== writtenEntry.dev
      || partialEntry.ino !== writtenEntry.ino
      || partialEntry.size !== writtenEntry.size
    ) {
      throw new ArtifactError(
        "artifact_partial_unsafe",
        "Native file partial changed before publication.",
      );
    }

    const safeName = normalizeArtifactFilename(opened.name);
    const finalName = await publishCollisionFree(
      secureDirectory,
      partialPath,
      safeName,
    );
    await unlink(partialPath);
    partialPath = undefined;

    return {
      path: `.devspace/incoming/${finalName}`,
      size,
      sha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    opened.stream.destroy();
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    await secureDirectory?.close().catch(() => undefined);
  }
}

export function artifactToolLogFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    fileProvided: input.file !== undefined,
    fileReferenceShape: describeIncomingArtifactValue(input.file),
    downloadUrlHostname: incomingFileDownloadHostname(input.file),
    workspaceId: input.workspaceId,
  };
}

async function executeArtifactTool(
  config: ServerConfig,
  input: Record<string, unknown>,
  operation: () => Promise<{
    publicResult: { path: string };
    logResult: DownloadIncomingArtifactResult;
  }>,
) {
  const startedAt = performance.now();
  try {
    const { publicResult, logResult } = await operation();
    if (config.logging.toolCalls) {
      logEvent(config.logging, "info", "artifact_tool_call", {
        tool: "download_artifact",
        ...artifactToolLogFields(input),
        path: logResult.path,
        size: logResult.size,
        sha256: logResult.sha256,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return artifactToolResponse(publicResult);
  } catch (error) {
    if (config.logging.toolCalls) {
      logEvent(config.logging, "warn", "artifact_tool_call", {
        tool: "download_artifact",
        ...artifactToolLogFields(input),
        success: false,
        errorCode: error instanceof ArtifactError ? error.code : "internal_error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    throw error;
  }
}

function artifactToolResponse(result: { path: string }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

async function prepareIncomingDirectory(
  workspaceRoot: string,
): Promise<SecureIncomingDirectory> {
  let rootHandle: FileHandle | undefined;
  let devspaceHandle: FileHandle | undefined;
  let incomingHandle: FileHandle | undefined;

  try {
    rootHandle = await openDirectoryNoFollow(
      workspaceRoot,
      "artifact_workspace_unsafe",
      "Selected workspace root is not a real directory.",
    );
    const rootAnchor = descriptorDirectoryPath(rootHandle);
    devspaceHandle = await ensureChildDirectory(rootHandle, rootAnchor, ".devspace");
    const devspaceAnchor = descriptorDirectoryPath(devspaceHandle);
    incomingHandle = await ensureChildDirectory(
      devspaceHandle,
      devspaceAnchor,
      "incoming",
    );
    const anchorPath = descriptorDirectoryPath(incomingHandle);

    return {
      rootHandle,
      devspaceHandle,
      incomingHandle,
      anchorPath,
      async close() {
        await incomingHandle?.close().catch(() => undefined);
        await devspaceHandle?.close().catch(() => undefined);
        await rootHandle?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await incomingHandle?.close().catch(() => undefined);
    await devspaceHandle?.close().catch(() => undefined);
    await rootHandle?.close().catch(() => undefined);
    throw error;
  }
}

async function ensureChildDirectory(
  parentHandle: FileHandle,
  parentAnchor: string,
  name: string,
): Promise<FileHandle> {
  await assertDirectoryHandle(parentHandle);
  const path = join(parentAnchor, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }

  const child = await openDirectoryNoFollow(
    path,
    "artifact_directory_unsafe",
    "Artifact destination parent is not a real directory.",
  );
  try {
    await assertPrivateDirectoryHandle(child);
    return child;
  } catch (error) {
    await child.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectoryNoFollow(
  path: string,
  code: string,
  message: string,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, DIRECTORY_FLAGS);
    await assertDirectoryHandle(handle);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError(code, message);
  }
}

async function assertDirectoryHandle(handle: FileHandle): Promise<void> {
  const entry = await handle.stat();
  if (!entry.isDirectory()) {
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination parent is not a directory.",
    );
  }
}

async function assertPrivateDirectoryHandle(handle: FileHandle): Promise<void> {
  const entry = await handle.stat();
  if (!entry.isDirectory()) {
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination parent is not a directory.",
    );
  }
  if (process.platform === "win32") return;
  const currentUid = process.getuid?.();
  if (
    (currentUid !== undefined && entry.uid !== currentUid)
    || (Number(entry.mode) & 0o022) !== 0
  ) {
    throw new ArtifactError(
      "artifact_directory_permissions_unsafe",
      "Artifact destination directory must be owned by the current user and not group/world writable.",
    );
  }
}

function descriptorDirectoryPath(handle: FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform)) {
    return `/dev/fd/${handle.fd}`;
  }
  throw new ArtifactError(
    "artifact_platform_unsupported",
    "Native file download requires descriptor-anchored directory operations on this platform.",
  );
}

async function publishCollisionFree(
  directory: SecureIncomingDirectory,
  partialPath: string,
  filename: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt += 1) {
    await assertPrivateDirectoryHandle(directory.incomingHandle);
    const candidateName = attempt === 0
      ? filename
      : renamedFilename(filename, attempt);
    const candidate = join(directory.anchorPath, candidateName);
    try {
      await link(partialPath, candidate);
      return candidateName;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new ArtifactError(
    "artifact_filename_exhausted",
    "Could not choose an available incoming filename.",
  );
}

export function normalizeArtifactFilename(value: string): string {
  const flattened = value.replaceAll("\\", "/");
  let candidate = basename(flattened)
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .trim();
  if (!candidate || candidate === "." || candidate === ".." || candidate.startsWith(".")) {
    candidate = "download.bin";
  }

  const extension = extname(candidate);
  const safeExtension = Buffer.byteLength(extension, "utf8") <= MAX_SAFE_EXTENSION_BYTES
    ? extension
    : "";
  const stemCharacters = Array.from(
    safeExtension ? candidate.slice(0, -safeExtension.length) : candidate,
  );
  while (
    stemCharacters.length > 1
    && Buffer.byteLength(`${stemCharacters.join("")}${safeExtension}`, "utf8")
      > MAX_SAFE_FILENAME_BYTES
  ) {
    stemCharacters.pop();
  }
  candidate = `${stemCharacters.join("")}${safeExtension}`;
  return Buffer.byteLength(candidate, "utf8") <= MAX_SAFE_FILENAME_BYTES
    ? candidate
    : "download.bin";
}

function renamedFilename(filename: string, attempt: number): string {
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${attempt})${extension}`;
}

async function cleanupStalePartials(
  directory: SecureIncomingDirectory,
): Promise<void> {
  await assertPrivateDirectoryHandle(directory.incomingHandle);
  const entries = await readdir(directory.anchorPath, { withFileTypes: true });
  let inspected = 0;
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;
  for (const entry of entries) {
    if (inspected >= MAX_STALE_PARTIAL_CLEANUP) break;
    if (
      !entry.name.startsWith(PARTIAL_PREFIX)
      || !entry.name.endsWith(PARTIAL_SUFFIX)
    ) continue;
    inspected += 1;

    const path = join(directory.anchorPath, entry.name);
    const metadata = await lstatOrUndefined(path);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.mtimeMs >= cutoff
      || (process.getuid?.() !== undefined && metadata.uid !== process.getuid?.())
    ) continue;
    await unlink(path).catch(() => undefined);
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new ArtifactError(
        "artifact_short_write",
        "Native file was not fully written.",
      );
    }
    offset += bytesWritten;
  }
}

function incomingFileDownloadHostname(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const rawUrl = (value as Record<string, unknown>).download_url;
  if (typeof rawUrl !== "string") return undefined;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.length > 0 && hostname.length <= 253 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function incomingStreamChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ArtifactError(
    "invalid_incoming_artifact_chunk",
    "Incoming artifact stream yielded a value that is not bytes or text.",
  );
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
