import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  artifactToolLogFields,
  stageIncomingArtifact,
} from "./artifact-tools.js";
import { ArtifactError, ArtifactStore } from "./artifacts.js";
import {
  IncomingArtifactAdapterRegistry,
  createIncomingArtifactProbeAdapter,
  createLocalFixtureIncomingArtifactAdapter,
  describeIncomingArtifactValue,
  type IncomingArtifactAdapter,
  type IncomingArtifactProbeCapture,
} from "./incoming-artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-incoming-artifacts-test-"));

try {
  await testRegistryFailsClosed();
  await testExplicitLocalFixture(join(root, "fixture"));
  await testProbeHarness();
  await testStageArtifact(join(root, "stage"));
  await testFailedStageCleanup(join(root, "failed-stage"));
  testStageLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testRegistryFailsClosed(): Promise<void> {
  const empty = new IncomingArtifactAdapterRegistry();
  await expectArtifactError(empty.open("https://example.test/file.txt?token=secret"), "unsupported_incoming_artifact");
  await expectArtifactError(empty.open("/tmp/arbitrary.txt"), "unsupported_incoming_artifact");
  await expectArtifactError(empty.open({ url: "https://example.test/file.txt" }), "unsupported_incoming_artifact");

  const first: IncomingArtifactAdapter = {
    id: "first",
    canHandle: () => true,
    async open() {
      return { name: "first.txt", stream: Readable.from("first") };
    },
  };
  const second: IncomingArtifactAdapter = {
    id: "second",
    canHandle: () => true,
    async open() {
      return { name: "second.txt", stream: Readable.from("second") };
    },
  };
  await expectArtifactError(
    new IncomingArtifactAdapterRegistry([first, second]).open({ file: true }),
    "ambiguous_incoming_artifact",
  );
  assert.throws(
    () => new IncomingArtifactAdapterRegistry([{ ...first, id: "Bad Adapter" }]),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_incoming_adapter",
  );
}

async function testExplicitLocalFixture(testRoot: string): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  await mkdir(join(testRoot, "nested"), { recursive: true });
  const bytes = Buffer.from("explicit fixture bytes\n");
  await writeFile(join(testRoot, "nested", "fixture.txt"), bytes);

  const adapter = await createLocalFixtureIncomingArtifactAdapter(testRoot);
  const registry = new IncomingArtifactAdapterRegistry([adapter]);
  const opened = await registry.open({
    kind: "devspace-local-fixture-v1",
    relativePath: "nested/fixture.txt",
    name: "renamed.txt",
    mimeType: "text/plain",
  });
  assert.equal(opened.adapterId, "local-fixture");
  assert.equal(opened.name, "renamed.txt");
  assert.equal(opened.mimeType, "text/plain");
  assert.equal(opened.size, bytes.length);
  assert.deepEqual(await collect(opened.stream), bytes);

  await expectArtifactError(
    registry.open({
      kind: "devspace-local-fixture-v1",
      relativePath: "../outside.txt",
    }),
    "unsafe_fixture_reference",
  );
  await expectArtifactError(registry.open({ relativePath: "nested/fixture.txt" }), "unsupported_incoming_artifact");

  if (process.platform !== "win32") {
    const outside = join(testRoot, "..", "outside-fixture.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(testRoot, "linked.txt"));
    await expectArtifactError(
      registry.open({
        kind: "devspace-local-fixture-v1",
        relativePath: "linked.txt",
      }),
      "unsafe_fixture_reference",
    );
  }
}

async function testProbeHarness(): Promise<void> {
  const secret = "https://files.example.test/download?id=abc&token=super-secret";
  const rawValue = {
    file: {
      name: "report.md",
      href: secret,
      metadata: { opaqueId: "file_123" },
    },
    [secret]: "secret-valued-key",
  };
  let capture: IncomingArtifactProbeCapture | undefined;
  const captureOnly = createIncomingArtifactProbeAdapter((value) => {
    capture = value;
    return undefined;
  });
  await expectArtifactError(
    new IncomingArtifactAdapterRegistry([captureOnly]).open(rawValue),
    "incoming_artifact_probe_captured",
  );
  assert.equal(capture?.rawValue, rawValue);
  assert.equal(capture?.shape.type, "object");
  assert.equal(JSON.stringify(capture?.shape).includes("super-secret"), false);
  assert.equal(JSON.stringify(capture?.shape).includes(secret), false);

  const normalized = createIncomingArtifactProbeAdapter(({ rawValue: value, shape }) => {
    assert.equal(value, rawValue);
    assert.deepEqual(shape, describeIncomingArtifactValue(rawValue));
    return {
      name: "report.md",
      mimeType: "text/markdown",
      size: 6,
      stream: Readable.from(Buffer.from("report")),
    };
  });
  const opened = await new IncomingArtifactAdapterRegistry([normalized]).open(rawValue);
  assert.equal(opened.adapterId, "probe");
  assert.deepEqual(await collect(opened.stream), Buffer.from("report"));
}

async function testStageArtifact(testRoot: string): Promise<void> {
  const fixtureRoot = join(testRoot, "fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const bytes = Buffer.alloc(80 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 17) % 256;
  await writeFile(join(fixtureRoot, "payload.bin"), bytes);

  const store = createStore(testRoot);
  try {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const registry = new IncomingArtifactAdapterRegistry([
      await createLocalFixtureIncomingArtifactAdapter(fixtureRoot),
    ]);
    const result = await stageIncomingArtifact({
      store,
      clientId: "client-a",
      registry,
      input: {
        file: {
          kind: "devspace-local-fixture-v1",
          relativePath: "payload.bin",
          name: "payload.bin",
          mimeType: "application/octet-stream",
        },
        workspaceId: "ws_association_only",
        expectedSha256: `sha256:${digest}`,
        ttlHours: 12,
        pin: true,
      },
    });

    assert.deepEqual(Object.keys(result).sort(), [
      "artifactId",
      "expiresAt",
      "hostPath",
      "instruction",
      "mimeType",
      "name",
      "sha256",
      "size",
    ]);
    assert.equal(result.name, "payload.bin");
    assert.equal(result.mimeType, "application/octet-stream");
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, `sha256:${digest}`);
    assert.match(result.instruction, /artifact_copy_to_workspace/);
    assert.deepEqual(await readFile(result.hostPath), bytes);

    const record = await store.statArtifact("client-a", result.artifactId);
    assert.equal(record.source, "incoming:local-fixture");
    assert.equal(record.workspaceId, "ws_association_only");
    assert.equal(record.pinned, true);
    assert.equal(store.health().pendingUploads, 0);
  } finally {
    store.close();
  }
}

async function testFailedStageCleanup(testRoot: string): Promise<void> {
  const fixtureRoot = join(testRoot, "fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(join(fixtureRoot, "payload.txt"), "digest mismatch");
  const store = createStore(testRoot);
  try {
    const registry = new IncomingArtifactAdapterRegistry([
      await createLocalFixtureIncomingArtifactAdapter(fixtureRoot),
    ]);
    await expectArtifactError(
      stageIncomingArtifact({
        store,
        clientId: "client-a",
        registry,
        input: {
          file: {
            kind: "devspace-local-fixture-v1",
            relativePath: "payload.txt",
          },
          expectedSha256: "0".repeat(64),
        },
      }),
      "sha256_mismatch",
    );
    assert.equal(store.health().pendingUploads, 0);
    assert.equal(store.health().storedBytes, 0);
  } finally {
    store.close();
  }
}

function testStageLogRedaction(): void {
  const secret = "https://files.example.test/download?token=super-secret";
  const fields = artifactToolLogFields("stage_artifact", {
    file: { href: secret, bearer: "Bearer secret" },
    workspaceId: "ws_123",
    expectedSha256: "f".repeat(64),
    ttlHours: 24,
    pin: true,
  });
  const serialized = JSON.stringify(fields);
  assert.equal("file" in fields, false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("Bearer secret"), false);
  assert.equal(fields.fileProvided, true);
  assert.equal(fields.expectedSha256Present, true);
}

function createStore(testRoot: string): ArtifactStore {
  return new ArtifactStore({
    stateDir: join(testRoot, "state"),
    artifactRoot: join(testRoot, "artifacts"),
    artifactMaxFileBytes: 100 * 1024 * 1024,
    artifactMaxTotalBytes: 1024 * 1024 * 1024,
    artifactDefaultTtlHours: 24,
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function expectArtifactError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
