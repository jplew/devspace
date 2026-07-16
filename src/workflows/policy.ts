import type { JsonObject } from "./types.js";

export const LOCAL_AGENT_POLICY_VERSION = 1 as const;

export type WorkflowAgentAccess = "read_only" | "workspace_write";

export interface EffectiveLocalAgentPolicy {
  readonly version: typeof LOCAL_AGENT_POLICY_VERSION;
  readonly mode: "workflow" | "compatibility";
  readonly access: WorkflowAgentAccess | "full_access";
  readonly environment: Readonly<Record<string, string>>;
}

export interface WorkflowPolicyResolutionInput {
  workflowPolicy?: JsonObject;
  nodeConfig?: JsonObject;
  environment?: NodeJS.ProcessEnv;
}

const EXACT_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NODE_NO_WARNINGS",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);
const PREFIX_ENVIRONMENT_KEYS = ["LC_", "XDG_"];

export function resolveWorkflowNodePolicy(
  input: WorkflowPolicyResolutionInput,
): EffectiveLocalAgentPolicy {
  const workflowAccess = validateWorkflowAccess(readAccess(input.workflowPolicy));
  const nodeAccess = validateWorkflowAccess(readAccess(input.nodeConfig));
  const workflowMaximum = workflowAccess ?? "read_only";
  const requested = nodeAccess ?? workflowMaximum;
  const access = workflowMaximum === "read_only" || requested === "read_only"
    ? "read_only"
    : "workspace_write";

  return deepFreeze({
    version: LOCAL_AGENT_POLICY_VERSION,
    mode: "workflow" as const,
    access,
    environment: filterWorkflowEnvironment(input.environment ?? process.env),
  });
}

export const resolveWorkflowExecutionPolicy = resolveWorkflowNodePolicy;

export function createLegacyLocalAgentPolicy(
  access: "read_only" | "workspace_write" | "full_access",
  environment: NodeJS.ProcessEnv = process.env,
): EffectiveLocalAgentPolicy {
  return deepFreeze({
    version: LOCAL_AGENT_POLICY_VERSION,
    mode: "compatibility" as const,
    access,
    environment: copyStringEnvironment(environment),
  });
}

export function filterWorkflowEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    if (!isAllowedEnvironmentKey(key)) continue;
    filtered[key] = value;
  }
  return Object.freeze(filtered);
}

function validateWorkflowAccess(access: string | undefined): WorkflowAgentAccess | undefined {
  if (access === undefined) return undefined;
  if (access === "full_access") {
    throw new Error("Workflow agents do not support full_access.");
  }
  if (access !== "read_only" && access !== "workspace_write") {
    throw new Error(`Unsupported workflow agent access '${access}'.`);
  }
  return access;
}

function readAccess(value: JsonObject | undefined): string | undefined {
  if (!value) return undefined;
  const direct = value.access;
  if (typeof direct === "string") return direct;
  const agent = value.agent;
  if (agent && typeof agent === "object" && !Array.isArray(agent)) {
    const nested = agent.access;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function isAllowedEnvironmentKey(key: string): boolean {
  if (EXACT_ENVIRONMENT_KEYS.has(key.toUpperCase())) return true;
  return PREFIX_ENVIRONMENT_KEYS.some((prefix) => key.toUpperCase().startsWith(prefix));
}

function copyStringEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const copied: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") copied[key] = value;
  }
  return Object.freeze(copied);
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}
