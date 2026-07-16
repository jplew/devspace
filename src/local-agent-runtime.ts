import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  SandboxMode,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import type { EffectiveLocalAgentPolicy } from "./workflows/policy.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  policy?: EffectiveLocalAgentPolicy;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export const LOCAL_AGENT_EVENT_VERSION = 1 as const;

interface LocalAgentEventBase {
  version: typeof LOCAL_AGENT_EVENT_VERSION;
  sequence: number;
  timestamp: string;
  provider: string;
}

export type LocalAgentEvent =
  | (LocalAgentEventBase & {
      type: "lifecycle";
      phase: "started" | "cancelling" | "disposing";
    })
  | (LocalAgentEventBase & {
      type: "session";
      providerSessionId: string;
      resumed: boolean;
    })
  | (LocalAgentEventBase & {
      type: "output";
      stream: "assistant" | "thinking";
      delta: string;
    })
  | (LocalAgentEventBase & {
      type: "tool";
      phase: "started" | "updated" | "completed" | "failed";
      name?: string;
      id?: string;
      metadata?: Record<string, unknown>;
    })
  | (LocalAgentEventBase & {
      type: "permission";
      phase: "requested" | "allowed" | "denied";
      tool?: string;
      metadata?: Record<string, unknown>;
    })
  | (LocalAgentEventBase & {
      type: "warning";
      message: string;
      metadata?: Record<string, unknown>;
    })
  | (LocalAgentEventBase & {
      type: "terminal";
      outcome: "succeeded" | "failed" | "cancelled";
      message?: string;
    });

export type LocalAgentEventInput =
  | { type: "lifecycle"; phase: "started" | "cancelling" | "disposing" }
  | { type: "session"; providerSessionId: string; resumed: boolean }
  | { type: "output"; stream: "assistant" | "thinking"; delta: string }
  | {
      type: "tool";
      phase: "started" | "updated" | "completed" | "failed";
      name?: string;
      id?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "permission";
      phase: "requested" | "allowed" | "denied";
      tool?: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "warning"; message: string; metadata?: Record<string, unknown> };

export interface LocalAgentRunHandle {
  readonly provider: string;
  events(): AsyncIterable<LocalAgentEvent>;
  result(): Promise<LocalAgentRunResult>;
  cancel(reason?: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export interface LocalAgentRuntime {
  readonly provider: string;
  start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle>;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

interface CodexStreamedTurnLike {
  events: AsyncGenerator<ThreadEvent>;
}

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(prompt: string, options?: TurnOptions): Promise<CodexStreamedTurnLike>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export type CodexFactory = (options?: CodexOptions) => CodexClientLike;

type EventWaiter = {
  resolve: (value: IteratorResult<LocalAgentEvent>) => void;
  reject: (error: unknown) => void;
};

const MAX_BUFFERED_EVENTS = 128;
const MAX_EVENT_TEXT_CHARS = 16_384;
const MAX_EVENT_METADATA_CHARS = 4_096;

class BoundedEventChannel implements AsyncIterable<LocalAgentEvent> {
  private readonly queue: LocalAgentEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private closed = false;
  private consumerCreated = false;

  push(event: LocalAgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= MAX_BUFFERED_EVENTS) {
      const droppable = this.queue.findIndex((queued) =>
        queued.type === "output" ||
        queued.type === "tool" ||
        queued.type === "permission" ||
        queued.type === "warning"
      );
      this.queue.splice(droppable === -1 ? 0 : droppable, 1);
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<LocalAgentEvent> {
    if (this.consumerCreated) {
      throw new Error("Local agent events support one consumer.");
    }
    this.consumerCreated = true;
    let iteratorClosed = false;
    return {
      next: () => {
        if (iteratorClosed) return Promise.resolve({ value: undefined, done: true });
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<LocalAgentEvent>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async () => {
        iteratorClosed = true;
        while (this.waiters.length > 0) {
          this.waiters.shift()?.resolve({ value: undefined, done: true });
        }
        return { value: undefined, done: true };
      },
    };
  }
}

export class LocalAgentRunController implements LocalAgentRunHandle {
  readonly provider: string;
  private readonly channel = new BoundedEventChannel();
  private readonly resultPromise: Promise<LocalAgentRunResult>;
  private resolveResult!: (result: LocalAgentRunResult) => void;
  private rejectResult!: (error: unknown) => void;
  private cancelHook: (reason?: unknown) => Promise<void> = async () => undefined;
  private disposeHook: () => Promise<void> = async () => undefined;
  private pump: Promise<void> = Promise.resolve();
  private sequence = 0;
  private terminal = false;
  private cancelling = false;
  private cancellationPromise: Promise<void> | undefined;
  private lifecycleReadyResolve!: () => void;
  private readonly lifecycleReady: Promise<void>;
  private disposePromise: Promise<void> | undefined;
  private abortSignal: AbortSignal | undefined;
  private abortListener: (() => void) | undefined;

  constructor(provider: string, signal?: AbortSignal) {
    this.provider = provider;
    this.resultPromise = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.lifecycleReady = new Promise((resolve) => {
      this.lifecycleReadyResolve = resolve;
    });
    void this.resultPromise.catch(() => undefined);
    this.emit({ type: "lifecycle", phase: "started" });
    if (signal) {
      this.abortSignal = signal;
      this.abortListener = () => void this.cancel(signal.reason);
      if (signal.aborted) void this.cancel(signal.reason);
      else signal.addEventListener("abort", this.abortListener, { once: true });
    }
  }

  events(): AsyncIterable<LocalAgentEvent> {
    return this.channel;
  }

  result(): Promise<LocalAgentRunResult> {
    return this.resultPromise;
  }

  setLifecycle(options: {
    cancel?: (reason?: unknown) => Promise<void> | void;
    dispose?: () => Promise<void> | void;
    pump?: Promise<void>;
  }): void {
    if (options.cancel) this.cancelHook = async (reason) => options.cancel?.(reason);
    if (options.dispose) this.disposeHook = async () => options.dispose?.();
    if (options.pump) {
      this.pump = options.pump;
      void this.pump.catch(() => undefined);
    }
    this.lifecycleReadyResolve();
  }

  emit(event: LocalAgentEventInput): void {
    if (this.terminal) return;
    const normalized = normalizeEventInput(event);
    this.channel.push({
      ...normalized,
      version: LOCAL_AGENT_EVENT_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      provider: this.provider,
    } as LocalAgentEvent);
  }

  succeed(result: LocalAgentRunResult): void {
    if (!this.finishTerminal("succeeded")) return;
    this.resolveResult(result);
  }

  fail(error: unknown): void {
    if (this.cancelling) {
      this.finishCancelled(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!this.finishTerminal("failed", message)) return;
    this.rejectResult(error instanceof Error ? error : new Error(message));
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.cancellationPromise) return this.cancellationPromise;
    if (this.terminal) return Promise.resolve();
    this.cancelling = true;
    this.emit({ type: "lifecycle", phase: "cancelling" });
    this.finishCancelled(reason);
    this.cancellationPromise = (async () => {
      await this.lifecycleReady;
      try {
        await this.cancelHook(reason);
      } catch {
        // Cancellation already has a deterministic terminal result.
      }
    })();
    return this.cancellationPromise;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      if (!this.terminal) await this.cancel(new Error("Local agent handle disposed."));
      else await this.cancellationPromise;
      try {
        await this.disposeHook();
      } finally {
        await this.pump.catch(() => undefined);
      }
    })();
    return this.disposePromise;
  }

  private finishCancelled(reason?: unknown): void {
    const message = reason instanceof Error ? reason.message : directCancellationMessage(reason);
    if (!this.finishTerminal("cancelled", message)) return;
    const error = new Error(message ?? "Local agent run cancelled.");
    error.name = "AbortError";
    this.rejectResult(error);
  }

  private finishTerminal(
    outcome: "succeeded" | "failed" | "cancelled",
    message?: string,
  ): boolean {
    if (this.terminal) return false;
    this.terminal = true;
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
      this.abortSignal = undefined;
      this.abortListener = undefined;
    }
    this.channel.push({
      version: LOCAL_AGENT_EVENT_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      provider: this.provider,
      type: "terminal",
      outcome,
      ...(message ? { message: message.slice(0, MAX_EVENT_TEXT_CHARS) } : {}),
    });
    this.channel.close();
    return true;
  }
}

function normalizeEventInput(event: LocalAgentEventInput): LocalAgentEventInput {
  if (event.type === "output") {
    return { ...event, delta: event.delta.slice(0, MAX_EVENT_TEXT_CHARS) };
  }
  if (event.type === "warning") {
    return {
      ...event,
      message: event.message.slice(0, MAX_EVENT_TEXT_CHARS),
      ...(event.metadata ? { metadata: redactMetadata(event.metadata) } : {}),
    };
  }
  if ((event.type === "tool" || event.type === "permission") && event.metadata) {
    return { ...event, metadata: redactMetadata(event.metadata) };
  }
  return event;
}

function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  let size = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (size >= MAX_EVENT_METADATA_CHARS) break;
    const next = /token|secret|password|authorization|cookie|api[_-]?key/i.test(key)
      ? "[redacted]"
      : typeof value === "string"
        ? value.slice(0, 512)
        : typeof value === "number" || typeof value === "boolean" || value === null
          ? value
          : "[omitted]";
    redacted[key] = next;
    size += key.length + String(next).length;
  }
  return redacted;
}

function directCancellationMessage(reason: unknown): string | undefined {
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return undefined;
}

export async function runLocalAgentHandle(handle: LocalAgentRunHandle): Promise<LocalAgentRunResult> {
  const drain = (async () => {
    for await (const _event of handle.events()) {
      // Compatibility callers intentionally ignore normalized progress events.
    }
  })();
  try {
    return await handle.result();
  } finally {
    await handle.dispose();
    await drain;
  }
}

function sandboxModeFor(input: LocalAgentRunInput): SandboxMode {
  if (input.policy) {
    if (input.policy.mode === "workflow") {
      if (input.policy.version !== 1 ||
          (input.policy.access !== "read_only" && input.policy.access !== "workspace_write")) {
        throw new Error("Invalid workflow local-agent policy.");
      }
      return input.policy.access === "workspace_write" ? "workspace-write" : "read-only";
    }
    if (input.policy.mode !== "compatibility") {
      throw new Error("Invalid local-agent policy mode.");
    }
    if (input.policy.access === "full_access") return "danger-full-access";
    return input.policy.access === "workspace_write" ? "workspace-write" : "read-only";
  }
  switch (input.writeMode) {
    case "allowed":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

function threadOptionsFor(input: LocalAgentRunInput): ThreadOptions {
  return {
    workingDirectory: input.workspace,
    sandboxMode: sandboxModeFor(input),
    approvalPolicy: "never",
    model: input.model,
    modelReasoningEffort: input.thinking as ModelReasoningEffort | undefined,
  };
}

export class CodexSdkLocalAgentRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;

  constructor(private readonly codex: CodexClientLike) {}

  async start(input: LocalAgentRunInput): Promise<LocalAgentRunHandle> {
    const options = threadOptionsFor(input);
    const resumed = Boolean(input.providerSessionId);
    const thread = input.providerSessionId
      ? this.codex.resumeThread(input.providerSessionId, options)
      : this.codex.startThread(options);
    const abortController = new AbortController();
    const controller = new LocalAgentRunController(this.provider, input.signal);
    let providerEvents: AsyncGenerator<ThreadEvent> | undefined;

    const pump = (async () => {
      try {
        const streamed = await thread.runStreamed(input.prompt, { signal: abortController.signal });
        providerEvents = streamed.events;
        const items: unknown[] = [];
        let finalResponse = "";
        let providerSessionId = thread.id;
        let emittedSessionId: string | null = null;
        if (providerSessionId) {
          emittedSessionId = providerSessionId;
          controller.emit({ type: "session", providerSessionId, resumed });
        }
        for await (const event of providerEvents) {
          if (event.type === "thread.started") {
            providerSessionId = event.thread_id;
            if (providerSessionId !== emittedSessionId) {
              emittedSessionId = providerSessionId;
              controller.emit({ type: "session", providerSessionId, resumed });
            }
          } else if (event.type === "item.completed") {
            items.push(event.item);
            if (event.item.type === "agent_message") {
              finalResponse = event.item.text;
              controller.emit({ type: "output", stream: "assistant", delta: event.item.text });
            } else if (event.item.type === "command_execution" || event.item.type === "mcp_tool_call") {
              controller.emit({
                type: "tool",
                phase: event.item.status === "failed" ? "failed" : "completed",
                name: event.item.type,
                id: event.item.id,
              });
            }
          } else if (event.type === "item.started" || event.type === "item.updated") {
            if (event.item.type === "command_execution" || event.item.type === "mcp_tool_call") {
              controller.emit({
                type: "tool",
                phase: event.type === "item.started" ? "started" : "updated",
                name: event.item.type,
                id: event.item.id,
              });
            }
          } else if (event.type === "turn.failed") {
            throw new Error(`Codex turn failed: ${event.error.message}`);
          } else if (event.type === "error") {
            throw new Error(`Codex stream failed: ${event.message}`);
          }
        }
        if (!finalResponse.trim()) throw new Error("Codex did not return a final assistant response.");
        controller.succeed({
          provider: this.provider,
          providerSessionId,
          finalResponse: finalResponse.trim(),
          items,
        });
      } catch (error) {
        controller.fail(error);
      }
    })();

    controller.setLifecycle({
      cancel: (reason) => abortController.abort(reason),
      dispose: async () => {
        if (!abortController.signal.aborted) abortController.abort();
        await providerEvents?.return(undefined);
      },
      pump,
    });
    return controller;
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    return runLocalAgentHandle(await this.start(input));
  }
}

export async function createCodexSdkLocalAgentRuntime(
  options?: CodexOptions,
  codexFactory?: CodexFactory,
): Promise<CodexSdkLocalAgentRuntime> {
  const factory = codexFactory ?? (await defaultCodexFactory());
  return new CodexSdkLocalAgentRuntime(factory(options));
}

async function defaultCodexFactory(): Promise<CodexFactory> {
  const module = await import("@openai/codex-sdk");
  return (options) => new module.Codex(options) as Codex;
}
