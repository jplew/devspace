import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { LocalAgentProfile } from "../local-agent-profiles.js";
import { formatAvailableLocalAgentTargets, resolveLocalAgentTarget } from "../local-agent-targets.js";
import { resolveWorkflowNodePolicy, type WorkflowAgentAccess } from "./policy.js";
import { WorkflowValidationError } from "./store.js";
import type {
  JsonObject,
  SubmitWorkflowRequest,
  WorkflowEdgeDefinitionV1,
  WorkflowNodeDefinitionV1,
  WorkflowRetryClass,
  WorkflowWorkspaceScope,
} from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_NODE_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 10;
const MAX_RETRY_BACKOFF_MS = 60_000;

export interface WorkflowAgentIntent {
  key?: string;
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
  access?: WorkflowAgentAccess;
  timeoutMs?: number;
  retry?: {
    maxAttempts?: number;
    retryOn?: WorkflowRetryClass[];
    backoffMs?: number;
  };
}

export interface WorkflowDagIntent {
  version: 1;
  nodes: Array<WorkflowAgentIntent & { key: string }>;
  edges?: WorkflowEdgeDefinitionV1[];
  maxConcurrency?: number;
  access?: WorkflowAgentAccess;
}

export interface WorkflowSubmissionIntent {
  single?: WorkflowAgentIntent;
  dag?: WorkflowDagIntent;
  idempotencyKey?: string;
}

export async function createWorkflowSubmission(input: {
  intent: WorkflowSubmissionIntent;
  workspace: WorkflowWorkspaceScope;
  profiles: LocalAgentProfile[];
  worktreeRoot: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<SubmitWorkflowRequest> {
  if (Boolean(input.intent.single) === Boolean(input.intent.dag)) {
    throw new WorkflowValidationError("Provide exactly one of single or dag");
  }
  const environment = input.environment ?? process.env;
  const dag: WorkflowDagIntent = input.intent.dag ?? {
    version: 1,
    nodes: [{ ...input.intent.single!, key: input.intent.single!.key ?? "agent" }],
    edges: [],
    maxConcurrency: 1,
    access: input.intent.single!.access ?? "read_only",
  };
  if (dag.version !== 1) throw new WorkflowValidationError("Unsupported workflow DAG version");
  const workflowAccess = dag.access ?? "read_only";
  const hasWriteNode = dag.nodes.some((node) => (node.access ?? workflowAccess) === "workspace_write");
  const baseSha = hasWriteNode ? await resolveBaseSha(input.workspace.workspaceRoot) : undefined;
  const nodes: WorkflowNodeDefinitionV1[] = dag.nodes.map((node) => ({
    key: node.key,
    type: "agent",
    config: snapshotNode({
      node,
      workflowAccess,
      workspaceRoot: input.workspace.workspaceRoot,
      worktreeRoot: input.worktreeRoot,
      baseSha,
      profiles: input.profiles,
      environment,
    }),
  }));

  return {
    definition: { version: 1, nodes, edges: dag.edges ?? [] },
    input: { kind: input.intent.dag ? "dag" : "single" },
    policy: {
      version: 1,
      access: workflowAccess,
      maxConcurrency: dag.maxConcurrency ?? 1,
    },
    idempotencyKey: input.intent.idempotencyKey,
    workspace: input.workspace,
  };
}

function snapshotNode(input: {
  node: WorkflowAgentIntent;
  workflowAccess: WorkflowAgentAccess;
  workspaceRoot: string;
  worktreeRoot: string;
  baseSha?: string;
  profiles: LocalAgentProfile[];
  environment: NodeJS.ProcessEnv;
}): JsonObject {
  const prompt = input.node.prompt.trim();
  if (!prompt) throw new WorkflowValidationError(`Workflow node ${input.node.key ?? "agent"} prompt is empty`);
  const timeoutMs = input.node.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_NODE_TIMEOUT_MS)) {
    throw new WorkflowValidationError(`Workflow node timeoutMs must be between 1 and ${MAX_NODE_TIMEOUT_MS}`);
  }
  const target = resolveTarget(
    input.node.target,
    input.profiles,
    input.node.model,
    input.node.thinking,
    input.environment,
  );
  if (!target) {
    throw new WorkflowValidationError(
      `Unknown workflow profile or provider: ${input.node.target}. Available ${formatAvailableLocalAgentTargets(input.profiles)}`,
    );
  }
  const profile = target.kind === "profile" ? target.profile : undefined;
  const profileBody = profile?.body.trim() ?? "";
  const profileName = profile?.name ?? target.name;
  const effectivePolicy = resolveWorkflowNodePolicy({
    workflowPolicy: { access: input.workflowAccess },
    nodeConfig: { access: input.node.access ?? input.workflowAccess },
    environment: input.environment,
  });
  const retry = normalizeRetry(input.node.retry);
  if (effectivePolicy.access === "workspace_write" && retry.maxAttempts > 1) {
    throw new WorkflowValidationError("workspace_write nodes cannot be retried automatically");
  }
  if (effectivePolicy.access === "workspace_write" && !input.baseSha) {
    throw new WorkflowValidationError("workspace_write nodes require a pinned Git base SHA");
  }
  const profileHash = createHash("sha256")
    .update(JSON.stringify({
      name: profileName,
      provider: target.provider,
      model: target.model ?? null,
      thinking: target.thinking ?? null,
      body: profileBody,
    }))
    .digest("hex");

  return {
    profileBody,
    profileName,
    profileHash,
    provider: target.provider,
    model: target.model ?? null,
    thinking: target.thinking ?? null,
    effectivePolicy: effectivePolicy as unknown as JsonObject,
    workspaceRoot: input.workspaceRoot,
    worktreeRoot: input.worktreeRoot,
    baseSha: input.baseSha ?? null,
    prompt,
    timeoutMs: timeoutMs ?? null,
    retry: retry as unknown as JsonObject,
    environmentPolicy: effectivePolicy.environment as JsonObject,
  };
}

function normalizeRetry(retry: WorkflowAgentIntent["retry"]): {
  maxAttempts: number;
  retryOn: WorkflowRetryClass[];
  backoffMs: number;
} {
  const maxAttempts = retry?.maxAttempts ?? 1;
  const backoffMs = retry?.backoffMs ?? 0;
  const retryOn = [...new Set(retry?.retryOn ?? [])];
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new WorkflowValidationError(`Retry maxAttempts must be between 1 and ${MAX_ATTEMPTS}`);
  }
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > MAX_RETRY_BACKOFF_MS) {
    throw new WorkflowValidationError(`Retry backoffMs must be between 0 and ${MAX_RETRY_BACKOFF_MS}`);
  }
  for (const value of retryOn) {
    if (value !== "provider_failed" && value !== "timed_out") {
      throw new WorkflowValidationError(`Unsupported retry class: ${value}`);
    }
  }
  if (maxAttempts > 1 && retryOn.length === 0) {
    throw new WorkflowValidationError("Retry policy must name at least one retryable failure class");
  }
  return { maxAttempts, retryOn, backoffMs };
}

function resolveTarget(
  name: string,
  profiles: LocalAgentProfile[],
  model: string | undefined,
  thinking: string | undefined,
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof resolveLocalAgentTarget> | {
  kind: "provider";
  name: "fake";
  provider: "fake";
  model?: string;
  thinking?: string;
  profile?: undefined;
} | undefined {
  if (name === "fake" && environment.DEVSPACE_WORKFLOW_FAKE_PROVIDER === "1") {
    return { kind: "provider", name: "fake", provider: "fake", model, thinking };
  }
  return resolveLocalAgentTarget(name, profiles, model, thinking);
}

async function resolveBaseSha(workspaceRoot: string): Promise<string> {
  try {
    const { stdout: root } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    if (!root.trim() || !sha.trim()) throw new Error("missing Git root or commit");
    if ((await realpath(root.trim())) !== (await realpath(workspaceRoot))) {
      throw new Error("workspace root must be the Git repository root");
    }
    return sha.trim();
  } catch (error) {
    throw new WorkflowValidationError(
      `workspace_write workflows require a Git repository with a commit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
