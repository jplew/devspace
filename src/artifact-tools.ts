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
}

export function registerArtifactTools(
  server: McpServer,
  { config, store, clientId }: ArtifactToolRegistrationOptions,
): void {
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

export function artifactToolLogFields(
  tool: ArtifactToolName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool) {
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
