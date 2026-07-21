import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename, isAbsolute, relative } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  copyArtifactToWorkspace,
  type ArtifactCopyConflictMode,
} from "./artifact-workspace.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ArtifactError,
  type ArtifactStore,
} from "./artifacts.js";
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
  openWorldHint: false,
};

const openAIFileReferenceInputSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

type ArtifactToolName = "materialize_artifact";

export interface ArtifactToolRegistrationOptions {
  config: ServerConfig;
  store: ArtifactStore;
  workspaces: WorkspaceRegistry;
  clientId: string;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export interface StageArtifactInput {
  file: unknown;
  workspaceId?: string;
  expectedSha256?: string;
  ttlHours?: number;
  pin?: boolean;
}

export interface StageArtifactResult {
  artifactId: string;
  name: string;
  mimeType?: string;
  size: number;
  sha256: string;
  hostPath: string;
  expiresAt?: string;
  instruction: string;
}

export interface MaterializeArtifactInput {
  file: unknown;
  workspaceId: string;
  destination: string;
  onConflict: ArtifactCopyConflictMode;
  expectedSha256?: string;
}

export interface MaterializeArtifactResult {
  workspaceId: string;
  path: string;
  name: string;
  mimeType?: string;
  size: number;
  sha256: string;
  onConflict: ArtifactCopyConflictMode;
  renamed: boolean;
}

export function registerArtifactTools(
  server: McpServer,
  {
    config,
    store,
    workspaces,
    clientId,
    incomingArtifactAdapters = [],
  }: ArtifactToolRegistrationOptions,
): void {
  const incomingRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);

  registerAppTool(
    server,
    "materialize_artifact",
    {
      title: "Materialize attached or generated file",
      description:
        "Save one MCP-host-provided native file into an already-open workspace. DevSpace validates the file reference, streams and verifies the bytes, and atomically writes the destination. Arbitrary URLs and host paths are rejected.",
      inputSchema: {
        file: openAIFileReferenceInputSchema.describe("Native file value authorized and supplied by the MCP host."),
        workspaceId: z.string().min(1).describe("Workspace identifier returned by open_workspace."),
        destination: z.string().min(1).describe("Relative file path inside the selected workspace."),
        onConflict: z.enum(["error", "rename", "replace"]).default("error").describe("How to handle an existing destination."),
        expectedSha256: z.string().optional().describe("Optional expected SHA-256, with or without a sha256: prefix."),
      },
      outputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        name: z.string(),
        mimeType: z.string().optional(),
        size: z.number().int().nonnegative(),
        sha256: z.string(),
        onConflict: z.enum(["error", "rename", "replace"]),
        renamed: z.boolean(),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, "materialize_artifact", input, async () => {
      if (isAbsolute(input.destination)) {
        throw new ArtifactError("workspace_destination_invalid", "Artifact destination must be a relative workspace path.");
      }
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const destination = workspaces.resolvePath(workspace, input.destination);
      return materializeIncomingArtifact({
        store,
        clientId,
        registry: incomingRegistry,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        destination,
        input,
      });
    }),
  );

}

/** Materialize a native file through the private store, then remove its internal record. */
export async function materializeIncomingArtifact({
  store,
  clientId,
  registry,
  workspaceId,
  workspaceRoot,
  destination,
  input,
}: {
  store: ArtifactStore;
  clientId: string;
  registry: IncomingArtifactAdapterRegistry;
  workspaceId: string;
  workspaceRoot: string;
  destination: string;
  input: MaterializeArtifactInput;
}): Promise<MaterializeArtifactResult> {
  const staged = await stageIncomingArtifact({
    store,
    clientId,
    registry,
    input: {
      file: input.file,
      workspaceId,
      expectedSha256: input.expectedSha256,
    },
  });

  try {
    const copied = await copyArtifactToWorkspace({
      store,
      clientId,
      workspaceId,
      workspaceRoot,
      artifactId: staged.artifactId,
      destination,
      onConflict: input.onConflict,
    });
    const path = relative(workspaceRoot, copied.path);
    return {
      workspaceId,
      path,
      name: basename(path),
      mimeType: staged.mimeType,
      size: copied.size,
      sha256: copied.sha256,
      onConflict: copied.onConflict,
      renamed: copied.renamed,
    };
  } finally {
    await store.deleteArtifact(clientId, staged.artifactId).catch(() => undefined);
  }
}

export async function stageIncomingArtifact({
  store,
  clientId,
  registry,
  input,
}: {
  store: ArtifactStore;
  clientId: string;
  registry: IncomingArtifactAdapterRegistry;
  input: StageArtifactInput;
}): Promise<StageArtifactResult> {
  const opened = await registry.open(input.file);
  let uploadId: string | undefined;

  try {
    const upload = await store.beginUpload(clientId, {
      filename: opened.name,
      mimeType: opened.mimeType,
      size: opened.size,
      sha256: input.expectedSha256,
      workspaceId: input.workspaceId,
      ttlHours: input.ttlHours,
    });
    uploadId = upload.uploadId;

    let offset = 0;
    for await (const value of opened.stream) {
      const bytes = incomingStreamChunk(value);
      for (let chunkOffset = 0; chunkOffset < bytes.length; chunkOffset += ARTIFACT_CHUNK_BYTES) {
        const chunk = bytes.subarray(chunkOffset, chunkOffset + ARTIFACT_CHUNK_BYTES);
        await store.uploadChunk(clientId, {
          uploadId,
          offset,
          dataBase64: chunk.toString("base64"),
        });
        offset += chunk.length;
      }
    }

    const artifact = await store.commitUpload(clientId, uploadId, {
      source: `incoming:${opened.adapterId}`,
      pinned: input.pin === true,
    });
    uploadId = undefined;
    return {
      artifactId: artifact.artifactId,
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      sha256: artifact.sha256,
      hostPath: artifact.hostPath,
      expiresAt: artifact.expiresAt,
      instruction:
        "Pass hostPath to a local command. stage_artifact never writes into a workspace or repository.",
    };
  } catch (error) {
    opened.stream.destroy();
    if (uploadId) {
      await store.abortUpload(clientId, uploadId).catch(() => undefined);
    }
    throw error;
  }
}

function incomingFileDownloadHostname(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
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

export function artifactToolLogFields(
  tool: ArtifactToolName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    fileProvided: input.file !== undefined,
    fileReferenceShape: describeIncomingArtifactValue(input.file),
    downloadUrlHostname: incomingFileDownloadHostname(input.file),
    workspaceId: input.workspaceId,
    destination: input.destination,
    expectedSha256Present: typeof input.expectedSha256 === "string",
    onConflict: input.onConflict,
  };
}

async function executeArtifactTool<T extends object>(
  config: ServerConfig,
  tool: ArtifactToolName,
  input: Record<string, unknown>,
  operation: () => Promise<T> | T,
) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    if (config.logging.toolCalls) {
      logEvent(config.logging, "info", "artifact_tool_call", {
        tool,
        ...artifactToolLogFields(tool, input),
        ...artifactResultLogFields(result as Record<string, unknown>),
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return artifactToolResponse(result);
  } catch (error) {
    if (config.logging.toolCalls) {
      logEvent(config.logging, "warn", "artifact_tool_call", {
        tool,
        ...artifactToolLogFields(tool, input),
        success: false,
        errorCode: error instanceof ArtifactError ? error.code : "internal_error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    throw error;
  }
}

function artifactToolResponse<T extends object>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function artifactResultLogFields(result: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceId: result.workspaceId,
    path: result.path,
    size: result.size,
    sha256: result.sha256,
    renamed: result.renamed,
  };
}
