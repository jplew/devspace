import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ArtifactError,
  type ArtifactReadHandle,
  type ArtifactRecord,
  type ArtifactStore,
} from "./artifacts.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const MAX_RENAME_ATTEMPTS = 10_000;

export type ArtifactCopyConflictMode = "error" | "rename" | "replace";

export interface ArtifactCopyToWorkspaceInput {
  store: ArtifactStore;
  clientId: string;
  workspaceId: string;
  workspaceRoot: string;
  artifactId: string;
  destination: string;
  onConflict: ArtifactCopyConflictMode;
}

export interface ArtifactCopyToWorkspaceResult {
  artifactId: string;
  workspaceId: string;
  path: string;
  size: number;
  sha256: string;
  onConflict: ArtifactCopyConflictMode;
  renamed: boolean;
}

export interface ArtifactExportFromWorkspaceInput {
  store: ArtifactStore;
  clientId: string;
  workspaceId: string;
  workspaceRoot: string;
  path: string;
  ttlHours?: number;
}

export async function copyArtifactToWorkspace(
  input: ArtifactCopyToWorkspaceInput,
): Promise<ArtifactCopyToWorkspaceResult> {
  assertLexicalWorkspaceContainment(input.workspaceRoot, input.destination);
  if (resolve(input.destination) === resolve(input.workspaceRoot)) {
    throw new ArtifactError(
      "workspace_destination_invalid",
      "Artifact destination must name a file inside the workspace.",
    );
  }

  const parent = dirname(input.destination);
  await ensureContainedWorkspaceDirectory(input.workspaceRoot, parent);

  if (input.onConflict === "error" && await lstatOrUndefined(input.destination)) {
    throw new ArtifactError(
      "workspace_destination_exists",
      "Artifact destination already exists. Select rename or replace explicitly.",
    );
  }

  const tempPath = join(parent, `.devspace-artifact-${randomUUID()}.partial`);
  let finalPath = input.destination;
  let source: ArtifactReadHandle | undefined;

  try {
    source = await input.store.openArtifactReadHandle(input.clientId, input.artifactId);
    const copied = await copyVerifiedFileToTemp(
      source.handle,
      tempPath,
      source.size,
      source.sha256,
    );
    await assertContainedWorkspaceRegularFile(input.workspaceRoot, tempPath);
    if (input.onConflict === "replace") {
      const existing = await lstatOrUndefined(finalPath);
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw new ArtifactError(
          "workspace_destination_unsafe",
          "Replace is allowed only for an existing regular file.",
        );
      }
      await ensureContainedWorkspaceDirectory(input.workspaceRoot, parent);
      await rename(tempPath, finalPath);
    } else {
      const maxAttempts = input.onConflict === "rename" ? MAX_RENAME_ATTEMPTS : 1;
      let linked = false;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        finalPath = attempt === 0
          ? input.destination
          : renamedDestination(input.destination, attempt);
        assertLexicalWorkspaceContainment(input.workspaceRoot, finalPath);
        try {
          await link(tempPath, finalPath);
          linked = true;
          break;
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST" && input.onConflict === "rename") {
            continue;
          }
          if (isNodeError(error) && error.code === "EEXIST") {
            throw new ArtifactError(
              "workspace_destination_exists",
              "Artifact destination already exists. Select rename or replace explicitly.",
            );
          }
          throw error;
        }
      }
      if (!linked) {
        throw new ArtifactError(
          "workspace_rename_exhausted",
          "Could not find an available destination filename.",
        );
      }
      await unlink(tempPath);
    }

    await chmod(finalPath, 0o644);
    const finalEntry = await assertContainedWorkspaceRegularFile(
      input.workspaceRoot,
      finalPath,
    );
    const digest = await hashFile(finalPath);
    if (finalEntry.size !== copied.size || `sha256:${digest}` !== copied.sha256) {
      throw new ArtifactError(
        "workspace_copy_integrity_failed",
        "Workspace copy failed size or SHA-256 verification.",
      );
    }

    return {
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
      path: finalPath,
      size: finalEntry.size,
      sha256: `sha256:${digest}`,
      onConflict: input.onConflict,
      renamed: finalPath !== input.destination,
    };
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  } finally {
    await source?.handle.close().catch(() => undefined);
  }
}

export async function exportArtifactFromWorkspace(
  input: ArtifactExportFromWorkspaceInput,
): Promise<ArtifactRecord> {
  const sourceEntry = await assertContainedWorkspaceRegularFile(
    input.workspaceRoot,
    input.path,
  );
  return input.store.importFile(input.clientId, {
    path: input.path,
    filename: basename(input.path),
    mimeType: mimeTypeForFilename(input.path),
    workspaceId: input.workspaceId,
    ttlHours: input.ttlHours,
    source: "workspace-export",
    expectedFile: {
      dev: sourceEntry.dev,
      ino: sourceEntry.ino,
      size: sourceEntry.size,
      mtimeMs: sourceEntry.mtimeMs,
      ctimeMs: sourceEntry.ctimeMs,
    },
  });
}

export async function assertContainedWorkspaceRegularFile(
  workspaceRoot: string,
  path: string,
) {
  assertLexicalWorkspaceContainment(workspaceRoot, path);
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ArtifactError(
      "workspace_export_not_regular",
      "Only regular, non-symlink workspace files can be exported.",
    );
  }
  const rootRealPath = await realpath(workspaceRoot);
  assertRealWorkspaceContainment(rootRealPath, await realpath(path));
  return entry;
}

export function mimeTypeForFilename(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".txt":
      return "text/plain";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    default:
      return undefined;
  }
}

async function ensureContainedWorkspaceDirectory(
  workspaceRoot: string,
  directory: string,
): Promise<void> {
  assertLexicalWorkspaceContainment(workspaceRoot, directory);
  const root = resolve(workspaceRoot);
  const rootRealPath = await realpath(root);
  const relationship = relative(root, resolve(directory));
  const parts = relationship === "" ? [] : relationship.split(sep);
  let current = root;

  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new ArtifactError(
        "workspace_path_escape",
        "Workspace destination escapes the workspace root.",
      );
    }
    current = join(current, part);
    let entry = await lstatOrUndefined(current);
    if (!entry) {
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ArtifactError(
        "workspace_parent_unsafe",
        "Workspace destination parent is not a real directory.",
      );
    }
    assertRealWorkspaceContainment(rootRealPath, await realpath(current));
  }
}

async function copyVerifiedFileToTemp(
  source: ArtifactReadHandle["handle"],
  tempPath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<{ size: number; sha256: string }> {
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let copied = 0;
  let failure: unknown;

  try {
    destination = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const sourceEntry = await source.stat();
    if (!sourceEntry.isFile() || sourceEntry.size !== expectedSize) {
      throw new ArtifactError(
        "artifact_integrity_failed",
        "Artifact source is not a regular file with the recorded size.",
      );
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, copied);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(destination, chunk, copied);
      hash.update(chunk);
      copied += bytesRead;
    }
    await destination.sync();
  } catch (error) {
    failure = error;
  } finally {
    await destination?.close().catch(() => undefined);
  }

  if (failure) {
    await unlink(tempPath).catch(() => undefined);
    throw failure;
  }

  const sha256 = `sha256:${hash.digest("hex")}`;
  if (copied !== expectedSize || sha256 !== expectedSha256) {
    await unlink(tempPath).catch(() => undefined);
    throw new ArtifactError(
      "artifact_integrity_failed",
      "Artifact source failed size or SHA-256 verification during copy.",
    );
  }
  await chmod(tempPath, 0o644);
  return { size: copied, sha256 };
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
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
      throw new ArtifactError("short_write", "Artifact workspace copy was not fully written.");
    }
    offset += bytesWritten;
  }
}

function renamedDestination(path: string, attempt: number): string {
  const extension = extname(path);
  const filename = basename(path);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return join(dirname(path), `${stem} (${attempt})${extension}`);
}

function assertLexicalWorkspaceContainment(workspaceRoot: string, candidate: string): void {
  const relationship = relative(resolve(workspaceRoot), resolve(candidate));
  if (
    relationship === ""
      ? resolve(candidate) !== resolve(workspaceRoot)
      : relationship.startsWith("..") || isAbsolute(relationship)
  ) {
    throw new ArtifactError(
      "workspace_path_escape",
      "Workspace path escapes the workspace root.",
    );
  }
}

function assertRealWorkspaceContainment(rootRealPath: string, candidateRealPath: string): void {
  const relationship = relative(rootRealPath, candidateRealPath);
  if (relationship.startsWith("..") || isAbsolute(relationship)) {
    throw new ArtifactError(
      "workspace_path_escape",
      "Workspace path resolves outside the workspace root.",
    );
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
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
