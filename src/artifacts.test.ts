import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { artifactToolLogFields } from "./artifact-tools.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ArtifactError,
  ArtifactStore,
  type ArtifactRecord,
} from "./artifacts.js";
import { openDatabase } from "./db/client.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifacts-test-"));

try {
  await testBinaryRoundTrip(join(root, "binary"));
  await testRestartSafeUpload(join(root, "restart"));
  await testValidationAndLimits(join(root, "limits"));
  await testReferenceAwareDeletion(join(root, "references"));
  await testExpirationAndPinning(join(root, "expiration"));
  await testBoundedCleanup(join(root, "bounded-cleanup"));
  if (process.platform !== "win32") {
    await testContainmentAndSymlinks(join(root, "containment"));
  }
  testLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testBinaryRoundTrip(testRoot: string): Promise<void> {
  const store = createStore(testRoot);
  try {
    const bytes = Buffer.alloc(ARTIFACT_CHUNK_BYTES + 137);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 31) % 256;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const begin = await store.beginUpload("client-a", {
      filename: "payload.bin",
      mimeType: "application/octet-stream",
      size: bytes.length,
      sha256: `sha256:${digest}`,
      workspaceId: "ws_123",
    });
    assert.equal(begin.chunkBytes, ARTIFACT_CHUNK_BYTES);
    assert.equal(begin.nextOffset, 0);

    if (process.platform !== "win32") {
      const database = openDatabase(join(testRoot, "state"));
      let partialPath: string;
      try {
        partialPath = String(
          database.sqlite.prepare("select temp_path from artifact_uploads where id = ?").pluck().get(begin.uploadId),
        );
      } finally {
        database.close();
      }
      assert.equal((await stat(partialPath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(partialPath))).mode & 0o777, 0o700);
    }

    const first = bytes.subarray(0, ARTIFACT_CHUNK_BYTES);
    const firstChunk = await store.uploadChunk("client-a", {
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: first.toString("base64"),
    });
    assert.equal(firstChunk.receivedBytes, ARTIFACT_CHUNK_BYTES);
    assert.equal(firstChunk.retry, false);

    const retry = await store.uploadChunk("client-a", {
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: first.toString("base64"),
    });
    assert.equal(retry.receivedBytes, ARTIFACT_CHUNK_BYTES);
    assert.equal(retry.retry, true);

    const conflicting = Buffer.from(first);
    conflicting[0] ^= 0xff;
    await expectArtifactError(
      store.uploadChunk("client-a", {
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: conflicting.toString("base64"),
      }),
      "conflicting_retry",
    );
    await expectArtifactError(
      store.uploadChunk("client-a", {
        uploadId: begin.uploadId,
        offset: ARTIFACT_CHUNK_BYTES + 1,
        dataBase64: Buffer.from("x").toString("base64"),
      }),
      "out_of_order_chunk",
    );

    await store.uploadChunk("client-a", {
      uploadId: begin.uploadId,
      offset: ARTIFACT_CHUNK_BYTES,
      dataBase64: bytes.subarray(ARTIFACT_CHUNK_BYTES).toString("base64"),
    });
    const artifact = await store.commitUpload("client-a", begin.uploadId);
    assert.equal(artifact.name, "payload.bin");
    assert.equal(artifact.mimeType, "application/octet-stream");
    assert.equal(artifact.size, bytes.length);
    assert.equal(artifact.sha256, `sha256:${digest}`);
    assert.equal(artifact.workspaceId, "ws_123");
    assert.deepEqual(await readFile(artifact.hostPath), bytes);

    const inspected = await store.statArtifact("client-a", artifact.artifactId);
    assert.deepEqual(inspected, artifact);
    await expectArtifactError(
      store.statArtifact("client-b", artifact.artifactId),
      "artifact_not_found",
    );

    const health = store.health();
    assert.equal(health.storedBytes, bytes.length);
    assert.equal(health.pendingUploads, 0);

    if (process.platform !== "win32") {
      assert.equal((await stat(join(testRoot, "artifacts"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(testRoot, "artifacts", "objects"))).mode & 0o777, 0o700);
      assert.equal((await stat(dirname(dirname(artifact.hostPath)))).mode & 0o777, 0o700);
      assert.equal((await stat(dirname(artifact.hostPath))).mode & 0o777, 0o700);
      assert.equal((await stat(artifact.hostPath)).mode & 0o777, 0o600);
    }

    const deleted = await store.deleteArtifact("client-a", artifact.artifactId);
    assert.equal(deleted.objectDeleted, true);
    await assert.rejects(lstat(artifact.hostPath), { code: "ENOENT" });
  } finally {
    store.close();
  }
}

async function testRestartSafeUpload(testRoot: string): Promise<void> {
  const bytes = Buffer.from("restart-safe-artifact-upload");
  const firstChunk = bytes.subarray(0, 10);
  const initialStore = createStore(testRoot);
  const upload = await initialStore.beginUpload("client-a", {
    filename: "restart.bin",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await initialStore.uploadChunk("client-a", {
    uploadId: upload.uploadId,
    offset: 0,
    dataBase64: firstChunk.toString("base64"),
  });
  initialStore.close();

  const resumedStore = createStore(testRoot);
  try {
    const retry = await resumedStore.uploadChunk("client-a", {
      uploadId: upload.uploadId,
      offset: 0,
      dataBase64: firstChunk.toString("base64"),
    });
    assert.equal(retry.retry, true);
    await resumedStore.uploadChunk("client-a", {
      uploadId: upload.uploadId,
      offset: firstChunk.length,
      dataBase64: bytes.subarray(firstChunk.length).toString("base64"),
    });
    const artifact = await resumedStore.commitUpload("client-a", upload.uploadId);
    assert.deepEqual(await readFile(artifact.hostPath), bytes);
  } finally {
    resumedStore.close();
  }
}

async function testValidationAndLimits(testRoot: string): Promise<void> {
  const store = createStore(testRoot, {
    artifactMaxFileBytes: 8,
    artifactMaxTotalBytes: 10,
  });
  try {
    for (const filename of ["../escape", "nested/file", "nested\\file", ".hidden", ".", "..", "bad\0name"]) {
      await expectArtifactError(
        store.beginUpload("client-a", { filename }),
        "invalid_filename",
      );
    }

    await expectArtifactError(
      store.beginUpload("client-a", { filename: "large.bin", size: 9 }),
      "file_too_large",
    );

    const invalidBase64 = await store.beginUpload("client-a", { filename: "invalid.bin" });
    await expectArtifactError(
      store.uploadChunk("client-a", {
        uploadId: invalidBase64.uploadId,
        offset: 0,
        dataBase64: "not-base64",
      }),
      "invalid_base64",
    );
    await store.abortUpload("client-a", invalidBase64.uploadId);

    const oversize = await store.beginUpload("client-a", { filename: "oversize.bin" });
    await expectArtifactError(
      store.uploadChunk("client-a", {
        uploadId: oversize.uploadId,
        offset: 0,
        dataBase64: Buffer.alloc(9).toString("base64"),
      }),
      "file_too_large",
    );
    await store.abortUpload("client-a", oversize.uploadId);

    const first = await stage(store, "client-a", "first.bin", Buffer.alloc(6, 1));
    assert.equal(store.health().storedBytes, 6);
    await expectArtifactError(
      store.beginUpload("client-a", { filename: "quota.bin", size: 5 }),
      "artifact_quota_exceeded",
    );
    await store.deleteArtifact("client-a", first.artifactId);

    const mismatchBytes = Buffer.from("hash");
    const mismatch = await store.beginUpload("client-a", {
      filename: "mismatch.bin",
      size: mismatchBytes.length,
      sha256: "0".repeat(64),
    });
    await store.uploadChunk("client-a", {
      uploadId: mismatch.uploadId,
      offset: 0,
      dataBase64: mismatchBytes.toString("base64"),
    });
    await expectArtifactError(
      store.commitUpload("client-a", mismatch.uploadId),
      "sha256_mismatch",
    );
    await store.abortUpload("client-a", mismatch.uploadId);

    const empty = await store.beginUpload("client-a", {
      filename: "empty.bin",
      size: 0,
      sha256: createHash("sha256").digest("hex"),
    });
    const emptyArtifact = await store.commitUpload("client-a", empty.uploadId);
    assert.equal(emptyArtifact.size, 0);
    assert.deepEqual(await readFile(emptyArtifact.hostPath), Buffer.alloc(0));
  } finally {
    store.close();
  }
}

async function testReferenceAwareDeletion(testRoot: string): Promise<void> {
  const store = createStore(testRoot);
  try {
    const bytes = Buffer.from("deduplicated-object");
    const first = await stage(store, "client-a", "first.txt", bytes);
    const second = await stage(store, "client-a", "second.txt", bytes);
    assert.notEqual(first.hostPath, second.hostPath);
    assert.match(first.hostPath, /materialized\/art_[^/]+\/first\.txt$/u);
    assert.match(second.hostPath, /materialized\/art_[^/]+\/second\.txt$/u);
    assert.equal(store.health().storedBytes, bytes.length);

    const firstDelete = await store.deleteArtifact("client-a", first.artifactId);
    assert.equal(firstDelete.objectDeleted, false);
    await assert.rejects(lstat(first.hostPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(second.hostPath), bytes);

    const secondDelete = await store.deleteArtifact("client-a", second.artifactId);
    assert.equal(secondDelete.objectDeleted, true);
    await assert.rejects(lstat(second.hostPath), { code: "ENOENT" });
  } finally {
    store.close();
  }
}

async function testExpirationAndPinning(testRoot: string): Promise<void> {
  let current = new Date("2026-07-18T12:00:00.000Z");
  const store = createStore(testRoot, {}, () => new Date(current));
  try {
    const abandoned = await store.beginUpload("client-a", { filename: "abandoned.bin" });
    current = new Date("2026-07-18T14:00:00.000Z");
    const uploadCleanup = await store.cleanupExpired();
    assert.equal(uploadCleanup.uploadsDeleted, 1);
    await expectArtifactError(
      store.abortUpload("client-a", abandoned.uploadId),
      "upload_not_found",
    );

    current = new Date("2026-07-18T12:00:00.000Z");
    const shared = Buffer.from("shared-expiry-object");
    const expiring = await stage(store, "client-a", "expiring.txt", shared, 1);
    const live = await stage(store, "client-a", "live.txt", shared, 4);
    const pinned = await stage(store, "client-a", "pinned.txt", Buffer.from("pinned"), 1);

    const database = openDatabase(join(testRoot, "state"));
    try {
      database.sqlite.prepare("update artifacts set pinned = 1 where id = ?").run(pinned.artifactId);
    } finally {
      database.close();
    }

    current = new Date("2026-07-18T14:00:00.000Z");
    const cleanup = await store.cleanupExpired();
    assert.equal(cleanup.artifactsDeleted, 1);
    assert.equal(cleanup.objectsDeleted, 0);
    await expectArtifactError(
      store.statArtifact("client-a", expiring.artifactId),
      "artifact_not_found",
    );
    await assert.rejects(lstat(expiring.hostPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(live.hostPath), shared);
    assert.equal((await store.statArtifact("client-a", live.artifactId)).artifactId, live.artifactId);
    assert.equal((await store.statArtifact("client-a", pinned.artifactId)).pinned, true);
  } finally {
    store.close();
  }
}

async function testBoundedCleanup(testRoot: string): Promise<void> {
  let current = new Date("2026-07-18T12:00:00.000Z");
  const store = createStore(testRoot, {}, () => new Date(current), 1);
  try {
    await store.beginUpload("client-a", { filename: "one.bin" });
    await store.beginUpload("client-a", { filename: "two.bin" });
    current = new Date("2026-07-18T14:00:00.000Z");
    const first = await store.cleanupExpired();
    assert.equal(first.uploadsDeleted, 1);
    assert.equal(store.health().pendingUploads, 1);
    const second = await store.cleanupExpired();
    assert.equal(second.uploadsDeleted, 1);
    assert.equal(store.health().pendingUploads, 0);
  } finally {
    store.close();
  }
}

async function testContainmentAndSymlinks(testRoot: string): Promise<void> {
  const store = createStore(testRoot);
  try {
    const outside = join(testRoot, "outside.txt");
    await writeFile(outside, "outside-safe");

    const upload = await store.beginUpload("client-a", { filename: "link.bin" });
    const database = openDatabase(join(testRoot, "state"));
    let tempPath: string;
    try {
      tempPath = String(
        database.sqlite.prepare("select temp_path from artifact_uploads where id = ?").pluck().get(upload.uploadId),
      );
    } finally {
      database.close();
    }
    await rm(tempPath);
    await symlink(outside, tempPath);
    await assert.rejects(
      store.uploadChunk("client-a", {
        uploadId: upload.uploadId,
        offset: 0,
        dataBase64: Buffer.from("attack").toString("base64"),
      }),
    );
    assert.equal(await readFile(outside, "utf8"), "outside-safe");
    await assert.rejects(store.abortUpload("client-a", upload.uploadId));
    assert.equal(await readFile(outside, "utf8"), "outside-safe");

    const collisionBytes = Buffer.from("collision");
    const collisionDigest = createHash("sha256").update(collisionBytes).digest("hex");
    const collisionUpload = await store.beginUpload("client-a", {
      filename: "collision.bin",
      size: collisionBytes.length,
    });
    await store.uploadChunk("client-a", {
      uploadId: collisionUpload.uploadId,
      offset: 0,
      dataBase64: collisionBytes.toString("base64"),
    });
    const objectPath = join(
      testRoot,
      "artifacts",
      "objects",
      collisionDigest.slice(0, 2),
      collisionDigest.slice(2, 4),
      collisionDigest,
    );
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(objectPath), 0o700);
    await symlink(outside, objectPath);
    await expectArtifactError(
      store.commitUpload("client-a", collisionUpload.uploadId),
      "unsafe_object",
    );
    assert.equal(await readFile(outside, "utf8"), "outside-safe");

    const protectedArtifact = await stage(
      store,
      "client-a",
      "protected.txt",
      Buffer.from("protected-materialized-content"),
    );
    const materializedDirectory = dirname(protectedArtifact.hostPath);
    const outsideMaterializedDirectory = join(testRoot, "outside-materialized");
    const outsideMaterializedFile = join(outsideMaterializedDirectory, "protected.txt");
    await mkdir(outsideMaterializedDirectory, { recursive: true });
    await writeFile(outsideMaterializedFile, "outside-materialized-safe");
    await rm(materializedDirectory, { recursive: true, force: true });
    await symlink(outsideMaterializedDirectory, materializedDirectory, "dir");
    await expectArtifactError(
      store.deleteArtifact("client-a", protectedArtifact.artifactId),
      "unsafe_materialized_artifact",
    );
    assert.equal(await readFile(outsideMaterializedFile, "utf8"), "outside-materialized-safe");

    const realRoot = join(testRoot, "real-artifact-root");
    const aliasRoot = join(testRoot, "artifact-root-alias");
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, aliasRoot);
    assert.throws(
      () => new ArtifactStore({
        stateDir: join(testRoot, "alias-state"),
        artifactRoot: aliasRoot,
        artifactMaxFileBytes: 1024,
        artifactMaxTotalBytes: 4096,
        artifactDefaultTtlHours: 24,
      }),
      (error: unknown) => error instanceof ArtifactError && error.code === "unsafe_artifact_root",
    );
  } finally {
    store.close();
  }
}

function testLogRedaction(): void {
  const secretBase64 = Buffer.from("private artifact contents").toString("base64");
  const fields = artifactToolLogFields("artifact_upload_chunk", {
    uploadId: "upl_test",
    offset: 0,
    dataBase64: secretBase64,
  });
  assert.equal("dataBase64" in fields, false);
  assert.equal(fields.encodedLength, secretBase64.length);
  assert.equal(JSON.stringify(fields).includes(secretBase64), false);
}

function createStore(
  testRoot: string,
  overrides: Partial<{
    artifactMaxFileBytes: number;
    artifactMaxTotalBytes: number;
    artifactDefaultTtlHours: number;
  }> = {},
  now?: () => Date,
  cleanupLimit?: number,
): ArtifactStore {
  return new ArtifactStore(
    {
      stateDir: join(testRoot, "state"),
      artifactRoot: join(testRoot, "artifacts"),
      artifactMaxFileBytes: overrides.artifactMaxFileBytes ?? 100 * 1024 * 1024,
      artifactMaxTotalBytes: overrides.artifactMaxTotalBytes ?? 1024 * 1024 * 1024,
      artifactDefaultTtlHours: overrides.artifactDefaultTtlHours ?? 24,
    },
    { now, cleanupLimit },
  );
}

async function stage(
  store: ArtifactStore,
  clientId: string,
  filename: string,
  bytes: Buffer,
  ttlHours?: number,
): Promise<ArtifactRecord> {
  const upload = await store.beginUpload(clientId, {
    filename,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ttlHours,
  });
  for (let offset = 0; offset < bytes.length; offset += ARTIFACT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ARTIFACT_CHUNK_BYTES);
    await store.uploadChunk(clientId, {
      uploadId: upload.uploadId,
      offset,
      dataBase64: chunk.toString("base64"),
    });
  }
  return store.commitUpload(clientId, upload.uploadId);
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
