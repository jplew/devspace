import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
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
};

type ArtifactToolName =
  | "stage_artifact"
  | "artifact_upload_begin"
  | "artifact_upload_chunk"
  | "artifact_upload_commit"
  | "artifact_upload_abort"
  | "artifact_stat"
  | "artifact_delete";

export interface ArtifactToolRegistrationOptions {
  config: ServerConfig;
  store: ArtifactStore;
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

export function registerArtifactTools(
  server: McpServer,
  {
    config,
    store,
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
        instruction: z.string(),
      },
      ...ARTIFACT_TOOL_META,
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, "stage_artifact", input, async () => {
      return stageIncomingArtifact({
        store,
        clientId,
        registry: incomingRegistry,
        input,
      });
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
        "Validate the declared size and digest, compute SHA-256 server-side, and atomically promote the partial upload into immutable content-addressed storage.",
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
      async () => store.commitUpload(clientId, uploadId),
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
      description: "Return private artifact metadata by ID without returning its content.",
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
      async () => store.statArtifact(clientId, artifactId),
    ),
  );

  registerAppTool(
    server,
    "artifact_delete",
    {
      title: "Delete artifact",
      description:
        "Delete an artifact record. Its immutable object is removed only when no other live record references it.",
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
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function artifactResultLogFields(result: Record<string, unknown>): Record<string, unknown> {
  const artifact = result as Partial<ArtifactRecord>;
  return {
    artifactId: artifact.artifactId,
    uploadId: result.uploadId,
    size: artifact.size,
    sha256: artifact.sha256,
    source: artifact.source,
    receivedBytes: result.receivedBytes,
    retry: result.retry,
    objectDeleted: result.objectDeleted,
  };
}
