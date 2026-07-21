import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as z from "zod/v4";
import {
  artifactToolLogFields,
  downloadIncomingArtifact,
  registerArtifactTools,
} from "./artifact-tools.js";
import { ArtifactError } from "./artifact-error.js";
import {
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-download-test-"));

try {
  testOneToolContract();
  await testSafeDownloadAndConflict(join(root, "downloads"));
  await testDestinationValidation(join(root, "destinations"));
  await testSizeLimitAndCleanup(join(root, "size-limit"));
  await testCrashLeftoverCleanup(join(root, "stale-partials"));
  await testUnsafeDirectoryPermissions(join(root, "unsafe-permissions"));
  await testSymlinkRejection(join(root, "symlinks"));
  await testPrivateStagingPermissions(join(root, "permissions"));
  testLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

function testOneToolContract(): void {
  const registered = new Map<string, { descriptor: Record<string, unknown>; callback: (input: never) => unknown }>();
  const server = {
    registerTool(
      name: string,
      descriptor: Record<string, unknown>,
      callback: (input: never) => unknown,
    ) {
      registered.set(name, { descriptor, callback });
      return {};
    },
  };

  registerArtifactTools(server as never, {
    config: {
      artifactMaxFileBytes: 1024,
      logging: { toolCalls: false },
    } as never,
    workspaces: {} as never,
  });

  assert.deepEqual([...registered.keys()], ["download_artifact"]);
  const descriptor = registered.get("download_artifact")?.descriptor;
  assert.ok(descriptor);
  assert.deepEqual(descriptor._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual(Object.keys(descriptor.inputSchema as object).sort(), ["file", "path", "workspaceId"]);
  assert.deepEqual(Object.keys(descriptor.outputSchema as object), ["path"]);
  assert.equal((descriptor.annotations as { destructiveHint?: boolean }).destructiveHint, false);

  const fileSchema = (descriptor.inputSchema as z.ZodRawShape).file as z.ZodType;
  const valid = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  assert.deepEqual(fileSchema.parse(valid), valid);
  assert.throws(() => fileSchema.parse({ file_id: "file_123" }));
}

async function testSafeDownloadAndConflict(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const bytes = Buffer.from("native artifact bytes\u0000\xff", "latin1");
  const registry = registryFor({
    name: "../../generated.png",
    size: bytes.length,
    stream: Readable.from([bytes]),
  });

  const first = await downloadIncomingArtifact({
    registry,
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "public/images/generated.png",
  });
  assert.equal(first.path, "public/images/generated.png");
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "replacement.png",
        stream: Readable.from(["replacement"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "public/images/generated.png",
    }),
    "artifact_destination_exists",
  );
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);
  assert.deepEqual(await readdir(join(workspaceRoot, ".devspace", "incoming")), []);
}

async function testDestinationValidation(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  for (const path of ["../outside.txt", "nested/../outside.txt", "/absolute.txt", "folder/"]) {
    await expectArtifactError(
      downloadIncomingArtifact({
        registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
        workspaceId: "ws_test",
        workspaceRoot,
        maxFileBytes: 1024,
        file: { native: true },
        path,
      }),
      "artifact_destination_invalid",
    );
  }
}

async function testSizeLimitAndCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "too-large.bin",
        size: 5,
        stream: Readable.from([Buffer.from("12345")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      file: { native: true },
      path: "too-large.bin",
    }),
    "artifact_file_too_large",
  );

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "stream-too-large.bin",
        stream: Readable.from([Buffer.from("123"), Buffer.from("45")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      file: { native: true },
      path: "stream-too-large.bin",
    }),
    "artifact_file_too_large",
  );

  const incoming = join(workspaceRoot, ".devspace", "incoming");
  assert.deepEqual(await readdir(incoming), []);
}

async function testCrashLeftoverCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await downloadIncomingArtifact({
    registry: registryFor({ name: "first.txt", stream: Readable.from(["first"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "first.txt",
  });

  const incoming = join(workspaceRoot, ".devspace", "incoming");
  const stalePartial = join(incoming, ".devspace-download-stale.partial");
  const recentPartial = join(incoming, ".devspace-download-recent.partial");
  const unrelated = join(incoming, "keep-me.partial");
  await writeFile(stalePartial, "stale");
  await writeFile(recentPartial, "recent");
  await writeFile(unrelated, "unrelated");
  const old = new Date(Date.now() - (48 * 60 * 60 * 1_000));
  await utimes(stalePartial, old, old);

  await downloadIncomingArtifact({
    registry: registryFor({ name: "second.txt", stream: Readable.from(["second"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "second.txt",
  });

  const entries = await readdir(incoming);
  assert.equal(entries.includes(".devspace-download-stale.partial"), false);
  assert.equal(entries.includes(".devspace-download-recent.partial"), true);
  assert.equal(entries.includes("keep-me.partial"), true);
}

async function testUnsafeDirectoryPermissions(testRoot: string): Promise<void> {
  if (process.platform === "win32") return;

  const workspaceRoot = join(testRoot, "workspace");
  const devspaceDirectory = join(workspaceRoot, ".devspace");
  await mkdir(devspaceDirectory, { recursive: true, mode: 0o700 });
  await chmod(devspaceDirectory, 0o777);

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_directory_permissions_unsafe",
  );
}

async function testSymlinkRejection(testRoot: string): Promise<void> {
  if (process.platform === "win32") return;

  const outside = join(testRoot, "outside");
  await mkdir(outside, { recursive: true, mode: 0o700 });

  const linkedDevspaceRoot = join(testRoot, "linked-devspace-workspace");
  await mkdir(linkedDevspaceRoot, { recursive: true, mode: 0o700 });
  await symlink(outside, join(linkedDevspaceRoot, ".devspace"), "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedDevspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_directory_unsafe",
  );

  const linkedIncomingRoot = join(testRoot, "linked-incoming-workspace");
  await mkdir(join(linkedIncomingRoot, ".devspace"), {
    recursive: true,
    mode: 0o700,
  });
  await symlink(outside, join(linkedIncomingRoot, ".devspace", "incoming"), "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedIncomingRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_directory_unsafe",
  );

  const linkedDestinationRoot = join(testRoot, "linked-destination-workspace");
  await mkdir(linkedDestinationRoot, { recursive: true });
  await symlink(outside, join(linkedDestinationRoot, "assets"), "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedDestinationRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "assets/blocked.txt",
    }),
    "artifact_destination_parent_unsafe",
  );
}

async function testPrivateStagingPermissions(testRoot: string): Promise<void> {
  if (process.platform === "win32") return;

  const workspaceRoot = join(testRoot, "workspace");
  const incoming = join(workspaceRoot, ".devspace", "incoming");
  await mkdir(incoming, { recursive: true });
  await chmod(incoming, 0o755);

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "private.txt", stream: Readable.from(["private"]) }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "private.txt",
    }),
    "artifact_directory_permissions_unsafe",
  );
}

function testLogRedaction(): void {
  const fields = artifactToolLogFields({
    file: {
      download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
      file_id: "file_secret",
      file_name: "generated.png",
    },
    workspaceId: "ws_secret",
    path: "private/generated.png",
  });
  const serialized = JSON.stringify(fields);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("ws_secret"), true);
  assert.equal(serialized.includes("files.oaiusercontent.com"), true);
}

function registryFor(source: {
  name: string;
  mimeType?: string;
  size?: number;
  stream: Readable;
}): IncomingArtifactAdapterRegistry {
  const adapter: IncomingArtifactAdapter = {
    id: "test-native",
    canHandle: () => true,
    async open() {
      return source;
    },
  };
  return new IncomingArtifactAdapterRegistry([adapter]);
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
