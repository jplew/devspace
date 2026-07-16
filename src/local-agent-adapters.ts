import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import type {
  CanUseTool,
  EffortLevel,
  Options as ClaudeOptions,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import {
  createCodexSdkLocalAgentRuntime,
  LocalAgentRunController,
  runLocalAgentHandle,
  type LocalAgentRunHandle,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";
import { terminateProcessTreeGracefully } from "./process-platform.js";
import type { EffectiveLocalAgentPolicy } from "./workflows/policy.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle>;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

const ACP_COMMANDS: Record<"cursor" | "copilot", [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
};
const MAX_RESULT_ITEMS = 256;
const MAX_STDERR_CHARS = 16_384;
const PROCESS_SHUTDOWN_GRACE_MS = 1_000;
const PI_AGENT_TIMEOUT_MS = 120_000;

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
): Promise<LocalAgentRunResult> {
  return runLocalAgentHandle(await createLocalAgentAdapter(provider).start(input));
}

export function createLocalAgentAdapter(provider: LocalAgentProvider): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider, ACP_COMMANDS[provider]);
  }
}

abstract class BaseLocalAgentAdapter implements LocalAgentAdapter {
  abstract readonly provider: LocalAgentProvider;
  abstract start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle>;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    return runLocalAgentHandle(await this.start(input));
  }
}

class CodexLocalAgentAdapter extends BaseLocalAgentAdapter {
  readonly provider = "codex" as const;

  async start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle> {
    const runtime = await createCodexSdkLocalAgentRuntime(
      input.policy ? { env: { ...input.policy.environment } } : undefined,
    );
    return runtime.start(input);
  }
}

export type ClaudeQueryLike = AsyncGenerator<SDKMessage, void> & Pick<Query, "interrupt" | "close">;
export type ClaudeQueryFactory = (parameters: {
  prompt: string;
  options?: ClaudeOptions;
}) => ClaudeQueryLike;

export class ClaudeLocalAgentAdapter extends BaseLocalAgentAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly queryFactory?: ClaudeQueryFactory) {
    super();
  }

  async start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle> {
    const queryFactory = this.queryFactory ?? (await defaultClaudeQueryFactory());
    const abortController = new AbortController();
    const controller = new LocalAgentRunController(this.provider, input.signal);
    const environment = input.policy?.environment ?? process.env;
    const claudeExecutable = environment.CLAUDE_COMMAND ?? resolveExecutable("claude");
    const policyOptions = claudePolicyOptions(input, controller);
    const query = queryFactory({
      prompt: input.prompt,
      options: {
        cwd: input.workspace,
        model: input.model,
        ...(input.thinking
          ? { thinking: { type: "adaptive" } as const, effort: input.thinking as EffortLevel }
          : {}),
        resume: input.providerSessionId,
        includePartialMessages: true,
        abortController,
        env: claudeCommandEnvironment(environment),
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        ...policyOptions,
      },
    });

    const pump = (async () => {
      let providerSessionId = input.providerSessionId ?? null;
      let emittedSessionId: string | null = null;
      let finalResponse = "";
      const items: unknown[] = [];
      try {
        for await (const message of query) {
          pushBounded(items, message);
          if (message.session_id && message.session_id !== emittedSessionId) {
            const sessionId = message.session_id;
            providerSessionId = sessionId;
            emittedSessionId = sessionId;
            controller.emit({
              type: "session",
              providerSessionId: sessionId,
              resumed: Boolean(input.providerSessionId),
            });
          }
          emitClaudeMessage(controller, message);
          if (message.type !== "result") continue;
          if (message.subtype === "success") {
            finalResponse = message.result;
          } else {
            throw new Error(
              `Claude returned an error result (${message.subtype}): ${message.errors.join("; ") || "unknown error"}`,
            );
          }
        }
        controller.succeed({
          provider: this.provider,
          providerSessionId,
          finalResponse: requireFinalResponse("Claude", finalResponse),
          items,
        });
      } catch (error) {
        controller.fail(error);
      }
    })();

    controller.setLifecycle({
      cancel: async (reason) => {
        await withTimeout(query.interrupt(), 1_000).catch(() => undefined);
        abortController.abort(reason);
      },
      dispose: async () => {
        abortController.abort();
        query.close();
      },
      pump,
    });
    return controller;
  }
}

async function defaultClaudeQueryFactory(): Promise<ClaudeQueryFactory> {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return module.query as ClaudeQueryFactory;
}

function claudePolicyOptions(
  input: LocalAgentRunInput,
  controller: LocalAgentRunController,
): Partial<ClaudeOptions> {
  if (input.policy?.mode !== "workflow") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
  }

  const writable = input.policy.access === "workspace_write";
  const allowedTools = new Set(writable
    ? ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit"]
    : ["Read", "Glob", "Grep"]);
  const canUseTool: CanUseTool = async (toolName, toolInput) => {
    controller.emit({ type: "permission", phase: "requested", tool: toolName });
    const path = directString(toolInput.file_path) ??
      directString(toolInput.notebook_path) ??
      directString(toolInput.path);
    const pathAllowed = !path || await isCanonicalPathInsideWorkspace(input.workspace, path);
    if (allowedTools.has(toolName) && pathAllowed) {
      controller.emit({ type: "permission", phase: "allowed", tool: toolName });
      return { behavior: "allow", updatedInput: toolInput };
    }
    controller.emit({ type: "permission", phase: "denied", tool: toolName });
    return { behavior: "deny", message: "Tool is not permitted by workflow policy." };
  };
  return {
    permissionMode: "dontAsk",
    tools: [...allowedTools],
    canUseTool,
    sandbox: { enabled: true, failIfUnavailable: true },
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    agents: {},
  };
}

function emitClaudeMessage(controller: LocalAgentRunController, message: SDKMessage): void {
  if (message.type === "stream_event") {
    const event = asRecord(message.event);
    const delta = asRecord(event?.delta);
    if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      controller.emit({ type: "output", stream: "assistant", delta: delta.text });
    } else if (event?.type === "content_block_delta" && delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      controller.emit({ type: "output", stream: "thinking", delta: delta.thinking });
    }
    return;
  }
  if (message.type === "tool_progress") {
    controller.emit({ type: "tool", phase: "updated", name: message.tool_name, id: message.tool_use_id });
  } else if (message.type === "permission_denied") {
    controller.emit({ type: "permission", phase: "denied", tool: message.tool_name });
  }
}

function resolveExecutable(command: string): string | undefined {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "command", [
    ...(process.platform === "win32" ? [command] : ["-v", command]),
  ], {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
}

export function claudeCommandEnvironment(env: NodeJS.ProcessEnv | Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ]) {
    delete next[key];
  }
  return next;
}

class OpencodeLocalAgentAdapter extends BaseLocalAgentAdapter {
  readonly provider = "opencode" as const;

  async start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle> {
    if (input.policy?.mode === "workflow") {
      throw new Error("OpenCode cannot currently enforce DevSpace workflow filesystem policy.");
    }
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    const abortController = new AbortController();
    const controller = new LocalAgentRunController(this.provider, input.signal);
    const { client, server } = await createOpencode({ signal: abortController.signal });
    const session = client.v2.session;
    let subscriptionStream: AsyncGenerator<unknown> | undefined;
    let sessionId: string | undefined;

    const pump = (async () => {
      const items: unknown[] = [];
      try {
        sessionId = input.providerSessionId ?? await createOpencodeSession(client, input);
        if (input.providerSessionId) {
          await session.get({ sessionID: sessionId }, { throwOnError: true });
          if (input.model) {
            await session.switchModel(
              { sessionID: sessionId, model: parseOpencodeV2Model(input.model, input.thinking) },
              { throwOnError: true },
            );
          }
        }
        controller.emit({
          type: "session",
          providerSessionId: sessionId,
          resumed: Boolean(input.providerSessionId),
        });
        const subscription = await client.v2.event.subscribe({
          signal: abortController.signal,
          sseMaxRetryAttempts: 1,
          onSseError: (error: unknown) => {
            controller.emit({ type: "warning", message: `OpenCode event stream error: ${errorMessage(error)}` });
          },
        });
        subscriptionStream = subscription.stream as AsyncGenerator<unknown>;
        const eventPump = (async () => {
          for await (const event of subscriptionStream ?? []) {
            if (!isOpencodeSessionEvent(event, sessionId as string)) continue;
            pushBounded(items, event);
            emitOpencodeEvent(controller, event);
          }
        })();
        const promptResult = await session.prompt({
          sessionID: sessionId,
          prompt: { text: input.prompt },
          delivery: "queue",
          resume: true,
        }, { throwOnError: true });
        pushBounded(items, promptResult);
        await session.wait({ sessionID: sessionId }, { throwOnError: true });
        const messages = await session.messages(
          { sessionID: sessionId, order: "desc", limit: 100 },
          { throwOnError: true },
        );
        pushBounded(items, messages);
        abortController.abort();
        await eventPump.catch(() => undefined);
        const finalResponse = requireFinalResponse("OpenCode", extractOpenCodeFinalResponse(promptResult));
        controller.succeed({
          provider: this.provider,
          providerSessionId: sessionId,
          finalResponse,
          items,
        });
      } catch (error) {
        controller.fail(error);
      }
    })();

    controller.setLifecycle({
      cancel: async () => {
        if (sessionId) {
          await session.interrupt({ sessionID: sessionId }, { throwOnError: true }).catch(() => undefined);
        }
        abortController.abort();
      },
      dispose: async () => {
        abortController.abort();
        await subscriptionStream?.return(undefined).catch(() => undefined);
        server.close();
      },
      pump,
    });
    return controller;
  }
}

class AcpLocalAgentAdapter extends BaseLocalAgentAdapter {
  constructor(
    readonly provider: "cursor" | "copilot",
    private readonly command: [string, ...string[]],
  ) {
    super();
  }

  async start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle> {
    if (input.policy?.mode === "workflow") {
      throw new Error(`${this.provider} ACP cannot currently enforce DevSpace workflow filesystem policy.`);
    }
    const { client, methods, ndJsonStream, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
    const [command, ...args] = this.command;
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: { ...(input.policy?.environment ?? process.env) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    assertPipedChild(child);
    const controller = new LocalAgentRunController(this.provider, input.signal);
    let stderr = "";
    let context: { notify(method: string, params: unknown): Promise<void> } | undefined;
    let providerSessionId = input.providerSessionId ?? null;
    let replaying = Boolean(input.providerSessionId);
    let disposing = false;
    const items: unknown[] = [];
    const textParts: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: "DevSpace" })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const tool = asRecord(params.toolCall)?.kind as string | undefined;
        controller.emit({ type: "permission", phase: "requested", tool });
        const outcome = resolveAcpPermissionRequest(params, input.policy);
        controller.emit({
          type: "permission",
          phase: outcome.response.outcome.outcome === "selected" && outcome.allowed ? "allowed" : "denied",
          tool,
        });
        return outcome.response;
      })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.sessionId !== providerSessionId || replaying) return;
        pushBounded(items, params);
        emitAcpUpdate(controller, params.update, textParts);
      });

    const pump = app.connectWith(stream, async (activeContext) => {
      context = activeContext;
      try {
        const initialized = await activeContext.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "DevSpace", version: "1" },
        });
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`${this.provider} ACP protocol version ${initialized.protocolVersion} is unsupported.`);
        }
        let sessionResponse: unknown;
        if (input.providerSessionId) {
          const capabilities = asRecord(initialized.agentCapabilities);
          if (capabilities?.loadSession !== true) {
            throw new Error(`${this.provider} ACP does not support loading persisted sessions.`);
          }
          sessionResponse = await activeContext.request(methods.agent.session.load, {
            sessionId: input.providerSessionId,
            cwd: input.workspace,
            mcpServers: [],
          });
          providerSessionId = input.providerSessionId;
          replaying = false;
        } else {
          sessionResponse = await activeContext.request(methods.agent.session.new, {
            cwd: input.workspace,
            mcpServers: [],
          });
          providerSessionId = directString(asRecord(sessionResponse)?.sessionId) ?? null;
        }
        if (!providerSessionId) throw new Error(`${this.provider} ACP did not return a session id.`);
        const sessionId = providerSessionId;
        controller.emit({
          type: "session",
          providerSessionId: sessionId,
          resumed: Boolean(input.providerSessionId),
        });
        let sessionMetadata = { sessionId, newSessionResponse: sessionResponse };
        if (input.model) {
          const config = resolveAcpModelConfigUpdate(sessionMetadata, input.model, this.provider);
          const response = await activeContext.request(methods.agent.session.setConfigOption, config);
          sessionMetadata = { sessionId, newSessionResponse: response };
        }
        if (input.thinking) {
          const config = resolveAcpThinkingConfigUpdate(sessionMetadata, input.thinking, this.provider);
          const response = await activeContext.request(methods.agent.session.setConfigOption, config);
          sessionMetadata = { sessionId, newSessionResponse: response };
        }
        const promptResponse = asRecord(await activeContext.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: input.prompt }],
        }));
        const stopReason = directString(promptResponse?.stopReason);
        if (stopReason !== "end_turn") {
          throw new Error(`${this.provider} ACP stopped with ${stopReason ?? "unknown"}.`);
        }
        controller.succeed({
          provider: this.provider,
          providerSessionId: sessionId,
          finalResponse: requireFinalResponse(this.provider, textParts.join("")),
          items,
        });
      } catch (error) {
        if (!disposing) {
          const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
          controller.fail(new Error(`${this.provider} ACP run failed: ${errorMessage(error)}${suffix}`));
        }
      }
    });

    child.once("error", (error) => controller.fail(error));
    child.once("exit", (code, signal) => {
      if (!disposing && code !== 0) {
        controller.fail(new Error(`${this.provider} ACP process exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`));
      }
    });
    controller.setLifecycle({
      cancel: async () => {
        if (context && providerSessionId) {
          await context.notify(methods.agent.session.cancel, { sessionId: providerSessionId }).catch(() => undefined);
        }
        disposing = true;
        await terminateProcessTreeGracefully(child, detached, PROCESS_SHUTDOWN_GRACE_MS);
      },
      dispose: async () => {
        disposing = true;
        await terminateProcessTreeGracefully(child, detached, PROCESS_SHUTDOWN_GRACE_MS);
      },
      pump: pump.then(() => undefined).catch((error) => controller.fail(error)),
    });
    return controller;
  }
}

export function resolveAcpPermissionRequest(
  params: { toolCall: unknown; options: Array<{ optionId: string; kind: string }> },
  policy?: EffectiveLocalAgentPolicy,
): {
  allowed: boolean;
  outcome: { outcome: { outcome: string; optionId?: string } };
  response: { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };
} {
  const toolKind = directString(asRecord(params.toolCall)?.kind) ?? "other";
  const compatibility = policy?.mode !== "workflow";
  const readOnlyKinds = new Set(["read", "search", "fetch", "think"]);
  const workspaceWriteKinds = new Set([...readOnlyKinds, "edit", "delete", "move"]);
  const allowed = compatibility || (policy?.access === "workspace_write"
    ? workspaceWriteKinds.has(toolKind)
    : readOnlyKinds.has(toolKind));
  const desiredKinds = allowed
    ? compatibility ? ["allow_once", "allow_always"] : ["allow_once"]
    : ["reject_once", "reject_always"];
  const selected = desiredKinds
    .map((kind) => params.options.find((option) => option.kind === kind))
    .find((option) => option !== undefined);
  if (!selected) {
    const response = { outcome: { outcome: "cancelled" as const } };
    return { allowed: false, outcome: response, response };
  }
  const response = { outcome: { outcome: "selected" as const, optionId: selected.optionId } };
  return { allowed, outcome: response, response };
}

function emitAcpUpdate(
  controller: LocalAgentRunController,
  update: unknown,
  textParts: string[],
): void {
  const record = asRecord(update);
  const kind = directString(record?.sessionUpdate);
  if (kind === "agent_message_chunk") {
    const content = asRecord(record?.content);
    if (content?.type === "text" && typeof content.text === "string") {
      textParts.push(content.text);
      controller.emit({ type: "output", stream: "assistant", delta: content.text });
    }
  } else if (kind === "agent_thought_chunk") {
    const content = asRecord(record?.content);
    if (content?.type === "text" && typeof content.text === "string") {
      controller.emit({ type: "output", stream: "thinking", delta: content.text });
    }
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    controller.emit({
      type: "tool",
      phase: kind === "tool_call" ? "started" : acpToolPhase(record?.status),
      id: directString(record?.toolCallId),
      name: directString(record?.title) ?? directString(record?.kind),
    });
  } else if (kind) {
    controller.emit({ type: "warning", message: `ACP update: ${kind}` });
  }
}

function acpToolPhase(status: unknown): "updated" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "updated";
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
  });
}

export function resolveAcpThinkingConfigUpdate(
  session: unknown,
  thinking: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "thinking option",
    provider,
    value: thinking,
  });
}

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session did not return session metadata.`);
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);

  const response = asRecord(record.newSessionResponse);
  const configOptions = response ? readArray(response, "configOptions") ?? [] : [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) {
    throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  }

  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);

  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }

  return { sessionId, configId, value: options.value };
}

function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const item of readArray(option, "options") ?? []) {
    const record = asRecord(item);
    const value = directString(record?.value);
    if (value) {
      values.push(value);
      continue;
    }
    for (const nested of readArray(record, "options") ?? []) {
      const nestedValue = directString(asRecord(nested)?.value);
      if (nestedValue) values.push(nestedValue);
    }
  }
  return values;
}

class PiRpcLocalAgentAdapter extends BaseLocalAgentAdapter {
  readonly provider = "pi" as const;

  async start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle> {
    if (input.policy?.mode === "workflow") {
      throw new Error("Pi RPC cannot currently enforce DevSpace workflow filesystem policy.");
    }
    const args = ["--mode", "rpc"];
    if (input.model) args.push("--model", input.model);
    if (input.thinking) args.push("--thinking", input.thinking);
    if (input.providerSessionId) args.push("--session", input.providerSessionId);
    const detached = process.platform !== "win32";
    const environment = input.policy?.environment ?? process.env;
    const child = spawn(environment.PI_COMMAND ?? "pi", args, {
      cwd: input.workspace,
      env: piCommandEnvironment(environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    assertPipedChild(child);
    const controller = new LocalAgentRunController(this.provider, input.signal);
    const rpc = new JsonLineRpc(child);
    const events: unknown[] = [];
    let disposing = false;
    rpc.onEvent((event) => {
      pushBounded(events, event);
      emitPiEvent(controller, event);
    });

    const pump = (async () => {
      try {
        const state = await rpc.request({ type: "get_state" });
        const providerSessionId = readNestedString(state, ["sessionId"]) ?? input.providerSessionId ?? null;
        if (providerSessionId) {
          controller.emit({
            type: "session",
            providerSessionId,
            resumed: Boolean(input.providerSessionId),
          });
        }
        const done = rpc.waitForEvent((event) => {
          const record = asRecord(event);
          return record?.type === "agent_end" && record.willRetry !== true;
        }, PI_AGENT_TIMEOUT_MS);
        await rpc.request({ type: "prompt", message: input.prompt });
        const agentEnd = await done;
        const sessionMessages = await rpc.request({ type: "get_messages" });
        const providerError =
          extractPiProviderError(agentEnd) ||
          extractPiProviderError(sessionMessages) ||
          extractPiProviderError(events);
        if (providerError) throw new Error(`Pi returned an error: ${providerError}`);
        const finalResponse = requireFinalResponse(
          "Pi",
          extractPiFinalResponse(agentEnd) ||
            extractPiFinalResponse(sessionMessages) ||
            extractPiStreamingText(events),
        );
        pushBounded(events, sessionMessages);
        controller.succeed({
          provider: this.provider,
          providerSessionId,
          finalResponse,
          items: events,
        });
      } catch (error) {
        if (!disposing) controller.fail(error);
      }
    })();

    controller.setLifecycle({
      cancel: async () => {
        await withTimeout(rpc.request({ type: "abort" }), 500).catch(() => undefined);
        disposing = true;
        await terminateProcessTreeGracefully(child, detached, PROCESS_SHUTDOWN_GRACE_MS);
      },
      dispose: async () => {
        disposing = true;
        await terminateProcessTreeGracefully(child, detached, PROCESS_SHUTDOWN_GRACE_MS);
      },
      pump,
    });
    return controller;
  }
}

function emitPiEvent(controller: LocalAgentRunController, event: unknown): void {
  const record = asRecord(event);
  if (!record) return;
  if (record.type === "message_update") {
    const update = asRecord(record.assistantMessageEvent);
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      controller.emit({ type: "output", stream: "assistant", delta: update.delta });
    } else if (update?.type === "thinking_delta" && typeof update.delta === "string") {
      controller.emit({ type: "output", stream: "thinking", delta: update.delta });
    }
  } else if (record.type === "tool_execution_start" || record.type === "tool_execution_update" || record.type === "tool_execution_end") {
    controller.emit({
      type: "tool",
      phase: record.type === "tool_execution_start" ? "started" : record.type === "tool_execution_end" ? "completed" : "updated",
      id: directString(record.toolCallId),
      name: directString(record.toolName),
    });
  } else if (record.type === "extension_error") {
    controller.emit({ type: "warning", message: directString(record.message) ?? "Pi extension error." });
  }
}

export function piCommandEnvironment(env: NodeJS.ProcessEnv | Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;

  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}

class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventSubscribers = new Set<(event: unknown) => void>();
  private readonly eventWaiterRejectors = new Set<(error: Error) => void>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendBounded(this.stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onEvent(callback: (event: unknown) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  waitForEvent(predicate: (event: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        unsubscribe();
        this.eventWaiterRejectors.delete(rejectWaiter);
      };
      const rejectWaiter = (error: Error) => {
        finish();
        reject(error);
      };
      const timer = setTimeout(() => {
        rejectWaiter(new Error(`Pi RPC timed out waiting for agent completion\n${this.stderr}`.trim()));
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        finish();
        resolve(event);
      });
      this.eventWaiterRejectors.add(rejectWaiter);
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderr = appendBounded(this.stderr, `${line}\n`);
        this.failAll(new Error(`Pi RPC emitted malformed JSON on stdout: ${line}`));
        return;
      }
      if (message.type !== "response") {
        for (const subscriber of this.eventSubscribers) subscriber(message);
        continue;
      }

      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.success === false || message.error) {
        pending.reject(new Error(errorMessage(message.error ?? `Pi RPC request failed: ${message.command ?? id}`)));
      } else {
        pending.resolve(message.data ?? message.result ?? message);
      }
    }
  }

  private failAll(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const reject of this.eventWaiterRejectors) reject(error);
    this.eventWaiterRejectors.clear();
  }
}

async function createOpencodeSession(client: unknown, input: LocalAgentRunInput): Promise<string> {
  const session = (client as {
    v2: {
      session: {
        create(parameters?: unknown, options?: unknown): Promise<unknown>;
      };
    };
  }).v2.session;
  const result = await session.create({
    location: { directory: input.workspace },
    ...(input.model ? { model: parseOpencodeV2Model(input.model, input.thinking) } : {}),
  }, { throwOnError: true });
  const id =
    readNestedString(result, ["data", "data", "id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["id"]);
  if (!id) throw new Error("OpenCode did not return a session id.");
  return id;
}

function parseOpencodeV2Model(
  model: string,
  variant?: string,
): { providerID: string; id: string; variant?: string } {
  const separator = model.indexOf("/");
  const parsed = separator === -1
    ? { providerID: "opencode", id: model }
    : { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
  return variant ? { ...parsed, variant } : parsed;
}

function isOpencodeSessionEvent(event: unknown, sessionId: string): boolean {
  const data = asRecord(asRecord(event)?.data);
  const eventSessionId = directString(data?.sessionID);
  return !eventSessionId || eventSessionId === sessionId;
}

function emitOpencodeEvent(controller: LocalAgentRunController, event: unknown): void {
  const record = asRecord(event);
  const data = asRecord(record?.data);
  if (record?.type === "session.next.text.delta" && typeof data?.delta === "string") {
    controller.emit({ type: "output", stream: "assistant", delta: data.delta });
  } else if (record?.type === "session.next.step.failed" || record?.type === "session.error") {
    controller.emit({ type: "warning", message: `OpenCode event: ${record.type}` });
  }
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

export function extractPiFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const text = extractPiAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

export function extractPiStreamingText(events: unknown[]): string {
  return events
    .map((event) => {
      const record = asRecord(event);
      if (!record || record.type !== "message_update") return "";
      const update = asRecord(record.assistantMessageEvent);
      if (!update || update.type !== "text_delta") return "";
      return typeof update.delta === "string" ? update.delta : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractPiProviderError(value: unknown): string {
  const root = unwrapProviderPayload(value);
  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);
      if (error) return error;
    }
    return "";
  }

  const messages = readArray(root, "messages");
  if (messages) return extractPiProviderError(messages);

  const message = asRecord(root)?.message ?? root;
  const record = asRecord(message);
  if (!record) return "";
  const error = record.errorMessage ?? record.error;
  return typeof error === "string" ? error.trim() : "";
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const parts = readArray(message, "parts");
  if (parts) {
    const text = parts
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function extractPiAssistantMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stringifyStructuredAssistantMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = asRecord(current);
    if (!record) return current;
    const next = record.data ?? record.result;
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

function readArray(record: unknown, key: string): unknown[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pushBounded(items: unknown[], item: unknown): void {
  if (items.length >= MAX_RESULT_ITEMS) items.shift();
  items.push(item);
}

function appendBounded(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length > MAX_STDERR_CHARS
    ? combined.slice(combined.length - MAX_STDERR_CHARS)
    : combined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Provider operation timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function isCanonicalPathInsideWorkspace(workspace: string, candidate: string): Promise<boolean> {
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(workspace);
  } catch {
    return false;
  }

  let existingPath = isAbsolute(candidate) ? resolve(candidate) : resolve(workspace, candidate);
  for (;;) {
    try {
      const canonicalCandidate = await realpath(existingPath);
      const path = relative(canonicalWorkspace, canonicalCandidate);
      return path === "" || (!path.startsWith("..") && !isAbsolute(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return false;
      const parent = dirname(existingPath);
      if (parent === existingPath) return false;
      existingPath = parent;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}
