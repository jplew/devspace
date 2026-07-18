import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { artifactDownloadUrl } from "./artifact-download.js";
import {
  copyArtifactToWorkspace,
  exportArtifactFromWorkspace,
} from "./artifact-workspace.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ArtifactError,
  type ArtifactRecord,
  type ArtifactStore,
} from "./artifacts.js";
import {
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ARTIFACT_TOOL_META = { _meta: {} };

const ARTIFACT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const artifactRecordOutputSchema = {
  artifactId: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  hostPath: z.string(),
  source: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  pinned: z.boolean(),
  resourceUri: z.string(),
  downloadUrl: z.string(),
};

type ArtifactToolName =
  | "stage_artifact"
  | "artifact_upload_begin"
  | "artifact_upload_chunk"
  | "artifact_upload_commit"
  | "artifact_upload_abort"
  | "artifact_stat"
  | "artifact_copy_to_workspace"
  | "artifact_export_from_workspace"
  | "artifact_delete";

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
  resourceUri?: string;
  downloadUrl?: string;
  instruction: string;
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
    "stage_artifact",
    {
      title: "Stage attached or generated file",
      description:
        "Stage one host-provided native file reference into the private Artifact Exchange. Only explicitly registered trusted adapters may recognize the opaque file value; arbitrary URLs and paths fail closed. A workspace ID is association metadata, not a write destination.",
      inputSchema: {
        file: z.unknown().describe("Opaque top-level file value supplied by the MCP client or connector."),
        workspaceId: z.string().min(1).optional().describe("Optional workspace association; never a write destination."),
        expectedSha256: z.string().optional().describe("Optional expected SHA-256, with or without a sha256: prefix."),
        ttlHours: z.number().int().min(1).max(24 * 365).optional().describe("Artifact lifetime after staging."),
        pin: z.boolean().optional().describe("Preserve the artifact until explicitly deleted."),
      },
      outputSchema: {
        artifactId: z.string(),
        name: z.string(),
        mimeType: z.string().optional(),
        size: z.number().int().nonnegative(),
        sha256: z.string(),
        hostPath: z.string(),
        expiresAt: z.string().optional(),
        resourceUri: z.string(),
        downloadUrl: z.string(),
        instruction: z.string(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, "stage_artifact", input, async () => {
      return withStageArtifactReferences(
        config,
        await stageIncomingArtifact({
          store,
          clientId,
          registry: incomingRegistry,
          input,
        }),
      );
    }),
  );

  registerAppTool(
    server,
    "artifact_upload_begin",
    {
      title: "Begin artifact upload",
      description:
        "Begin a private sequential artifact upload. DevSpace selects the storage path; filenames are metadata only. Returns the decoded chunk limit and next offset.",
      inputSchema: {
        filename: z.string().min(1).describe("One safe basename; path separators and hidden names are rejected."),
        mimeType: z.string().optional().describe("Optional MIME type hint. Content is not trusted or executed."),
        size: z.number().int().nonnegative().optional().describe("Optional exact decoded byte size."),
        sha256: z.string().optional().describe("Optional expected SHA-256, with or without a sha256: prefix."),
        workspaceId: z.string().optional().describe("Optional workspace association; not a write destination."),
        ttlHours: z.number().int().min(1).max(24 * 365).optional().describe("Artifact lifetime after commit."),
      },
      outputSchema: {
        uploadId: z.string(),
        chunkBytes: z.number().int().positive(),
        expiresAt: z.string(),
        nextOffset: z.number().int().nonnegative(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, "artifact_upload_begin", input, async () => {
      return store.beginUpload(clientId, input);
    }),
  );

  registerAppTool(
    server,
    "artifact_upload_chunk",
    {
      title: "Upload artifact chunk",
      description:
        `Append one canonical-base64 chunk to a private upload. Chunks must be sequential and decode to at most ${ARTIFACT_CHUNK_BYTES} bytes. An identical retry of the most recently committed chunk is acknowledged; conflicting or out-of-order data is rejected.`,
      inputSchema: {
        uploadId: z.string(),
        offset: z.number().int().nonnegative(),
        dataBase64: z.string().min(4).max(Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4),
      },
      outputSchema: {
        uploadId: z.string(),
        receivedBytes: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative(),
        retry: z.boolean(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, "artifact_upload_chunk", input, async () => {
      return store.uploadChunk(clientId, input);
    }),
  );

  registerAppTool(
    server,
    "artifact_upload_commit",
    {
      title: "Commit artifact upload",
      description:
        "Validate the declared size and digest, compute SHA-256 server-side, atomically promote the upload, and return a safe materialized filename path plus protected download reference.",
      inputSchema: {
        uploadId: z.string(),
      },
      outputSchema: artifactRecordOutputSchema,
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async ({ uploadId }) => executeArtifactTool(
      config,
      "artifact_upload_commit",
      { uploadId },
      async () => withArtifactReferences(config, await store.commitUpload(clientId, uploadId)),
    ),
  );

  registerAppTool(
    server,
    "artifact_upload_abort",
    {
      title: "Abort artifact upload",
      description: "Delete an incomplete private upload and its metadata.",
      inputSchema: {
        uploadId: z.string(),
      },
      outputSchema: {
        uploadId: z.string(),
        aborted: z.boolean(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async ({ uploadId }) => executeArtifactTool(
      config,
      "artifact_upload_abort",
      { uploadId },
      async () => store.abortUpload(clientId, uploadId),
    ),
  );

  registerAppTool(
    server,
    "artifact_stat",
    {
      title: "Inspect artifact",
      description:
        "Return private artifact metadata, a safe materialized host path, and a protected download reference by artifact ID without returning its content inline.",
      inputSchema: {
        artifactId: z.string(),
      },
      outputSchema: artifactRecordOutputSchema,
      ...ARTIFACT_TOOL_META,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId }) => executeArtifactTool(
      config,
      "artifact_stat",
      { artifactId },
      async () => withArtifactReferences(config, await store.statArtifact(clientId, artifactId)),
    ),
  );

  registerAppTool(
    server,
    "artifact_copy_to_workspace",
    {
      title: "Copy artifact to workspace",
      description:
        "Opt in to copying one private artifact into an open workspace. The destination is contained by the existing workspace guard; parent directories are created only inside that workspace. Conflict handling must be selected explicitly. This may dirty a repository.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        artifactId: z.string(),
        destination: z.string().min(1).describe("Destination path relative to the workspace root, or an absolute path inside it."),
        onConflict: z.enum(["error", "rename", "replace"]),
      },
      outputSchema: {
        artifactId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string(),
        onConflict: z.enum(["error", "rename", "replace"]),
        renamed: z.boolean(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(
      config,
      "artifact_copy_to_workspace",
      input,
      async () => {
        const workspace = workspaces.getWorkspace(input.workspaceId);
        const destination = workspaces.resolvePath(workspace, input.destination);
        return copyArtifactToWorkspace({
          store,
          clientId,
          workspaceId: input.workspaceId,
          workspaceRoot: workspace.root,
          artifactId: input.artifactId,
          destination,
          onConflict: input.onConflict,
        });
      },
    ),
  );

  registerAppTool(
    server,
    "artifact_export_from_workspace",
    {
      title: "Export workspace file",
      description:
        "Copy one regular, contained workspace file into the private Artifact Exchange without modifying the workspace. Returns metadata, a resource link, and a bearer-protected download URL.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().min(1).describe("Regular file path inside the workspace."),
        ttlHours: z.number().int().min(1).max(24 * 365).optional(),
      },
      outputSchema: artifactRecordOutputSchema,
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(
      config,
      "artifact_export_from_workspace",
      input,
      async () => {
        const workspace = workspaces.getWorkspace(input.workspaceId);
        const path = workspaces.resolvePath(workspace, input.path);
        const artifact = await exportArtifactFromWorkspace({
          store,
          clientId,
          workspaceId: input.workspaceId,
          workspaceRoot: workspace.root,
          path,
          ttlHours: input.ttlHours,
        });
        return withArtifactReferences(config, artifact);
      },
    ),
  );

  registerAppTool(
    server,
    "artifact_delete",
    {
      title: "Delete artifact",
      description:
        "Delete an artifact record and its materialized presentation path. Its immutable object is removed only when no other live record references it.",
      inputSchema: {
        artifactId: z.string(),
      },
      outputSchema: {
        artifactId: z.string(),
        deleted: z.boolean(),
        objectDeleted: z.boolean(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async ({ artifactId }) => executeArtifactTool(
      config,
      "artifact_delete",
      { artifactId },
      async () => store.deleteArtifact(clientId, artifactId),
    ),
  );
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
        "Pass hostPath to a local command, or use artifact_copy_to_workspace only when the file should become part of a project.",
    };
  } catch (error) {
    opened.stream.destroy();
    if (uploadId) {
      await store.abortUpload(clientId, uploadId).catch(() => undefined);
    }
    throw error;
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
  switch (tool) {
    case "stage_artifact":
      return {
        fileProvided: input.file !== undefined,
        workspaceId: input.workspaceId,
        expectedSha256Present: typeof input.expectedSha256 === "string",
        ttlHours: input.ttlHours,
        pin: input.pin === true,
      };
    case "artifact_upload_begin":
      return {
        filename: input.filename,
        mimeType: input.mimeType,
        declaredSize: input.size,
        expectedSha256Present: typeof input.sha256 === "string",
        workspaceId: input.workspaceId,
        ttlHours: input.ttlHours,
      };
    case "artifact_upload_chunk":
      return {
        uploadId: input.uploadId,
        offset: input.offset,
        encodedLength: typeof input.dataBase64 === "string" ? input.dataBase64.length : undefined,
      };
    case "artifact_upload_commit":
    case "artifact_upload_abort":
      return { uploadId: input.uploadId };
    case "artifact_stat":
    case "artifact_delete":
      return { artifactId: input.artifactId };
    case "artifact_copy_to_workspace":
      return {
        artifactId: input.artifactId,
        workspaceId: input.workspaceId,
        destination: input.destination,
        onConflict: input.onConflict,
      };
    case "artifact_export_from_workspace":
      return {
        workspaceId: input.workspaceId,
        path: input.path,
        ttlHours: input.ttlHours,
      };
  }
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
  const structuredContent = result as Record<string, unknown>;
  const content: ContentBlock[] = [
    { type: "text", text: JSON.stringify(result) },
  ];
  if (
    typeof structuredContent.resourceUri === "string"
    && typeof structuredContent.name === "string"
  ) {
    content.push({
      type: "resource_link",
      uri: structuredContent.resourceUri,
      name: structuredContent.name,
      mimeType: typeof structuredContent.mimeType === "string"
        ? structuredContent.mimeType
        : "application/octet-stream",
      size: typeof structuredContent.size === "number"
        ? structuredContent.size
        : undefined,
      description: "Private DevSpace artifact. Fetch with the authenticated bearer boundary.",
    });
  }
  return { content, structuredContent };
}

function withArtifactReferences(config: ServerConfig, artifact: ArtifactRecord) {
  const downloadUrl = artifactDownloadUrl(config.publicBaseUrl, artifact.artifactId);
  return {
    ...artifact,
    resourceUri: downloadUrl,
    downloadUrl,
  };
}

function withStageArtifactReferences(
  config: ServerConfig,
  artifact: StageArtifactResult,
): StageArtifactResult & { resourceUri: string; downloadUrl: string } {
  const downloadUrl = artifactDownloadUrl(config.publicBaseUrl, artifact.artifactId);
  return {
    ...artifact,
    resourceUri: downloadUrl,
    downloadUrl,
  };
}

function artifactResultLogFields(result: Record<string, unknown>): Record<string, unknown> {
  const artifact = result as Partial<ArtifactRecord>;
  return {
    artifactId: artifact.artifactId,
    uploadId: result.uploadId,
    workspaceId: result.workspaceId,
    path: result.path,
    size: artifact.size,
    sha256: artifact.sha256,
    source: artifact.source,
    receivedBytes: result.receivedBytes,
    retry: result.retry,
    renamed: result.renamed,
    objectDeleted: result.objectDeleted,
  };
}
