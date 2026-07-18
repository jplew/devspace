import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, basename, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import { ArtifactError } from "./artifacts.js";

const LOCAL_FIXTURE_KIND = "devspace-local-fixture-v1";
const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface IncomingArtifactSource {
  name: string;
  mimeType?: string;
  size?: number;
  stream: Readable;
}

export interface IncomingArtifactAdapter {
  readonly id: string;
  canHandle(value: unknown): boolean;
  open(value: unknown): Promise<IncomingArtifactSource>;
}

export interface OpenedIncomingArtifact extends IncomingArtifactSource {
  adapterId: string;
}

export class IncomingArtifactAdapterRegistry {
  private readonly adapters: readonly IncomingArtifactAdapter[];

  constructor(adapters: readonly IncomingArtifactAdapter[] = []) {
    const ids = new Set<string>();
    for (const adapter of adapters) {
      if (!ADAPTER_ID_PATTERN.test(adapter.id)) {
        throw new ArtifactError(
          "invalid_incoming_adapter",
          "Incoming artifact adapter IDs must be short lowercase identifiers.",
        );
      }
      if (ids.has(adapter.id)) {
        throw new ArtifactError(
          "duplicate_incoming_adapter",
          `Incoming artifact adapter '${adapter.id}' is registered more than once.`,
        );
      }
      ids.add(adapter.id);
    }
    this.adapters = [...adapters];
  }

  async open(value: unknown): Promise<OpenedIncomingArtifact> {
    const matching: IncomingArtifactAdapter[] = [];
    for (const adapter of this.adapters) {
      let handles = false;
      try {
        handles = adapter.canHandle(value);
      } catch {
        throw new ArtifactError(
          "incoming_artifact_adapter_failed",
          `Incoming artifact adapter '${adapter.id}' failed during recognition.`,
        );
      }
      if (handles) matching.push(adapter);
    }

    if (matching.length === 0) {
      throw new ArtifactError(
        "unsupported_incoming_artifact",
        "No trusted incoming artifact adapter recognized this file reference.",
      );
    }
    if (matching.length > 1) {
      throw new ArtifactError(
        "ambiguous_incoming_artifact",
        "More than one trusted incoming artifact adapter recognized this file reference.",
      );
    }

    const adapter = matching[0];
    let source: IncomingArtifactSource;
    try {
      source = await adapter.open(value);
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError(
        "incoming_artifact_open_failed",
        `Incoming artifact adapter '${adapter.id}' could not open the file reference.`,
      );
    }
    try {
      validateIncomingArtifactSource(source);
    } catch (error) {
      source?.stream?.destroy?.();
      throw error;
    }
    return { ...source, adapterId: adapter.id };
  }
}

export interface LocalFixtureFileReference {
  kind: typeof LOCAL_FIXTURE_KIND;
  relativePath: string;
  name?: string;
  mimeType?: string;
}

export async function createLocalFixtureIncomingArtifactAdapter(
  fixtureRoot: string,
): Promise<IncomingArtifactAdapter> {
  const rootPath = resolve(fixtureRoot);
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ArtifactError(
      "unsafe_fixture_root",
      "Incoming artifact fixture root must be a real directory.",
    );
  }
  const rootRealPath = await realpath(rootPath);

  return {
    id: "local-fixture",
    canHandle(value: unknown): value is LocalFixtureFileReference {
      return isRecord(value) && value.kind === LOCAL_FIXTURE_KIND;
    },
    async open(value: unknown): Promise<IncomingArtifactSource> {
      if (!isLocalFixtureFileReference(value)) {
        throw new ArtifactError(
          "invalid_fixture_reference",
          "Incoming artifact fixture reference is malformed.",
        );
      }
      if (!value.relativePath || isAbsolute(value.relativePath)) {
        throw new ArtifactError(
          "invalid_fixture_reference",
          "Incoming artifact fixture paths must be non-empty relative paths.",
        );
      }

      const candidate = resolve(rootRealPath, value.relativePath);
      assertContained(rootRealPath, candidate, "Fixture path escapes the configured fixture root.");
      const candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
        throw new ArtifactError(
          "unsafe_fixture_reference",
          "Incoming artifact fixture must be a regular non-symlink file.",
        );
      }
      const candidateRealPath = await realpath(candidate);
      assertContained(
        rootRealPath,
        candidateRealPath,
        "Fixture real path escapes the configured fixture root.",
      );

      return {
        name: value.name ?? basename(candidateRealPath),
        mimeType: value.mimeType,
        size: candidateStat.size,
        stream: createReadStream(candidateRealPath),
      };
    },
  };
}

export type IncomingArtifactProbeShape =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean" }
  | { type: "number"; finite: boolean }
  | { type: "bigint" }
  | { type: "string"; kind: "absolute-path" | "url" | "data-url" | "text"; length: number }
  | { type: "array"; length: number; items: IncomingArtifactProbeShape[]; truncated: boolean }
  | {
      type: "object";
      constructor?: string;
      entries: Record<string, IncomingArtifactProbeShape>;
      truncated: boolean;
    }
  | { type: "function" | "symbol" }
  | { type: "cycle" };

export interface IncomingArtifactProbeCapture {
  rawValue: unknown;
  shape: IncomingArtifactProbeShape;
}

export type IncomingArtifactProbeNormalizer = (
  capture: IncomingArtifactProbeCapture,
) => Promise<IncomingArtifactSource | undefined> | IncomingArtifactSource | undefined;

export function createIncomingArtifactProbeAdapter(
  normalize: IncomingArtifactProbeNormalizer,
): IncomingArtifactAdapter {
  return {
    id: "probe",
    canHandle: () => true,
    async open(value: unknown): Promise<IncomingArtifactSource> {
      const source = await normalize({
        rawValue: value,
        shape: describeIncomingArtifactValue(value),
      });
      if (!source) {
        throw new ArtifactError(
          "incoming_artifact_probe_captured",
          "Incoming artifact reference was captured by the probe but not normalized; no content was staged.",
        );
      }
      return source;
    },
  };
}

export function describeIncomingArtifactValue(
  value: unknown,
  maxDepth = 4,
  maxEntries = 20,
): IncomingArtifactProbeShape {
  const seen = new WeakSet<object>();

  const describe = (current: unknown, depth: number): IncomingArtifactProbeShape => {
    if (current === null) return { type: "null" };
    if (current === undefined) return { type: "undefined" };
    if (typeof current === "boolean") return { type: "boolean" };
    if (typeof current === "number") return { type: "number", finite: Number.isFinite(current) };
    if (typeof current === "bigint") return { type: "bigint" };
    if (typeof current === "function") return { type: "function" };
    if (typeof current === "symbol") return { type: "symbol" };
    if (typeof current === "string") {
      return {
        type: "string",
        kind: classifyProbeString(current),
        length: current.length,
      };
    }
    if (seen.has(current)) return { type: "cycle" };
    seen.add(current);

    if (Array.isArray(current)) {
      if (depth >= maxDepth) {
        return { type: "array", length: current.length, items: [], truncated: current.length > 0 };
      }
      const items = current.slice(0, maxEntries).map((item) => describe(item, depth + 1));
      return {
        type: "array",
        length: current.length,
        items,
        truncated: current.length > items.length,
      };
    }

    const keys = Object.keys(current).sort();
    if (depth >= maxDepth) {
      return {
        type: "object",
        constructor: safeConstructorName(current),
        entries: {},
        truncated: keys.length > 0,
      };
    }
    const entries: Record<string, IncomingArtifactProbeShape> = {};
    for (const [index, key] of keys.slice(0, maxEntries).entries()) {
      let entryValue: unknown;
      try {
        entryValue = (current as Record<string, unknown>)[key];
      } catch {
        entryValue = undefined;
      }
      entries[probeEntryKey(key, index)] = describe(entryValue, depth + 1);
    }
    return {
      type: "object",
      constructor: safeConstructorName(current),
      entries,
      truncated: keys.length > Object.keys(entries).length,
    };
  };

  return describe(value, 0);
}

function validateIncomingArtifactSource(source: IncomingArtifactSource): void {
  if (!source || typeof source !== "object") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid source.",
    );
  }
  if (typeof source.name !== "string" || source.name.length === 0) {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter must provide a filename.",
    );
  }
  if (source.mimeType !== undefined && typeof source.mimeType !== "string") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid MIME hint.",
    );
  }
  if (
    source.size !== undefined
    && (!Number.isSafeInteger(source.size) || source.size < 0)
  ) {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid byte size.",
    );
  }
  const stream = source.stream as Partial<Readable> | undefined;
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter must provide an async-readable stream.",
    );
  }
}

function isLocalFixtureFileReference(value: unknown): value is LocalFixtureFileReference {
  return isRecord(value)
    && value.kind === LOCAL_FIXTURE_KIND
    && typeof value.relativePath === "string"
    && (value.name === undefined || typeof value.name === "string")
    && (value.mimeType === undefined || typeof value.mimeType === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertContained(root: string, candidate: string, message: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new ArtifactError("unsafe_fixture_reference", message);
}

function classifyProbeString(
  value: string,
): "absolute-path" | "url" | "data-url" | "text" {
  if (value.startsWith("data:")) return "data-url";
  if (isAbsolute(value)) return "absolute-path";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return "url";
  } catch {
    // Non-URL strings are summarized only by type and length.
  }
  return "text";
}

function probeEntryKey(value: string, index: number): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/u.test(value)
    ? value
    : `<redacted-key-${index + 1}>`;
}

function safeConstructorName(value: object): string | undefined {
  try {
    const name = value.constructor?.name;
    return typeof name === "string" && name.length <= 80 ? name : undefined;
  } catch {
    return undefined;
  }
}
