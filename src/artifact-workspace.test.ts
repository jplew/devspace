import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyArtifactToWorkspace,
  exportArtifactFromWorkspace,
} from "./artifact-workspace.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ArtifactError,
  ArtifactStore,
  type ArtifactRecord,
} from "./artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-workspace-test-"));

try {
  await testCopyConflictModes(join(root, "copy"));
  await testWorkspaceExport(join(root, "export"));
  if (process.platform !== "win32") {
    await testWorkspaceContainmentAndSymlinks(join(root, "containment"));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testCopyConflictModes(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const store = createStore(testRoot);
  try {
    const bytes = Buffer.from("artifact-copy-byte-preservation\0\xff", "latin1");
    const artifact = await stage(store, "client-a", "report.bin", bytes);
    const destination = join(workspaceRoot, "nested", "report.bin");
    const copied = await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_copy",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination,
      onConflict: "error",
    });
    assert.equal(copied.path, destination);
    assert.equal(copied.renamed, false);
    assert.equal(copied.sha256, artifact.sha256);
    assert.deepEqual(await readFile(destination), bytes);
    if (process.platform !== "win32") {
      assert.equal((await stat(destination)).mode & 0o777, 0o644);
      assert.equal((await stat(destination)).mode & 0o111, 0);
    }

    await writeFile(destination, "existing");
    await expectArtifactError(
      copyArtifactToWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_copy",
        workspaceRoot,
        artifactId: artifact.artifactId,
        destination,
        onConflict: "error",
      }),
      "workspace_destination_exists",
    );
    assert.equal(await readFile(destination, "utf8"), "existing");

    const renamed = await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_copy",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination,
      onConflict: "rename",
    });
    assert.equal(renamed.renamed, true);
    assert.equal(renamed.path, join(workspaceRoot, "nested", "report (1).bin"));
    assert.deepEqual(await readFile(renamed.path), bytes);

    const replaced = await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_copy",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination,
      onConflict: "replace",
    });
    assert.equal(replaced.path, destination);
    assert.deepEqual(await readFile(destination), bytes);

    await writeFile(artifact.hostPath, "tampered presentation path");
    const canonicalCopy = join(workspaceRoot, "canonical.bin");
    await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_copy",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination: canonicalCopy,
      onConflict: "error",
    });
    assert.deepEqual(await readFile(canonicalCopy), bytes);
  } finally {
    store.close();
  }
}

async function testWorkspaceExport(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const sourcePath = join(workspaceRoot, "generated-report.md");
  const bytes = Buffer.from("# Generated report\n\nExact bytes.\n");
  await writeFile(sourcePath, bytes);
  if (process.platform !== "win32") await chmod(sourcePath, 0o755);
  const entriesBefore = await readdir(workspaceRoot);

  const store = createStore(testRoot);
  try {
    const artifact = await exportArtifactFromWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_export",
      workspaceRoot,
      path: sourcePath,
      ttlHours: 3,
    });
    assert.equal(artifact.name, "generated-report.md");
    assert.equal(artifact.mimeType, "text/markdown");
    assert.equal(artifact.source, "workspace-export");
    assert.equal(artifact.workspaceId, "ws_export");
    assert.equal(artifact.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.match(artifact.hostPath, /materialized\/art_[^/]+\/generated-report\.md$/u);
    assert.deepEqual(await readFile(artifact.hostPath), bytes);
    assert.deepEqual(await readFile(sourcePath), bytes);
    assert.deepEqual(await readdir(workspaceRoot), entriesBefore);
    if (process.platform !== "win32") {
      assert.equal((await stat(artifact.hostPath)).mode & 0o777, 0o600);
      assert.equal((await stat(artifact.hostPath)).mode & 0o111, 0);
    }

    await expectArtifactError(
      exportArtifactFromWorkspace({
        store,
        clientId: "client-b",
        workspaceId: "ws_export",
        workspaceRoot,
        path: workspaceRoot,
      }),
      "workspace_export_not_regular",
    );

    const sourceEntry = await stat(sourcePath);
    await expectArtifactError(
      store.importFile("client-a", {
        path: sourcePath,
        filename: "changed.md",
        source: "workspace-export",
        expectedFile: {
          dev: sourceEntry.dev,
          ino: sourceEntry.ino + 1,
          size: sourceEntry.size,
          mtimeMs: sourceEntry.mtimeMs,
          ctimeMs: sourceEntry.ctimeMs,
        },
      }),
      "workspace_export_changed",
    );
  } finally {
    store.close();
  }
}

async function testWorkspaceContainmentAndSymlinks(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const outsideRoot = join(testRoot, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const outsideFile = join(outsideRoot, "outside.txt");
  await writeFile(outsideFile, "outside-safe");

  const store = createStore(testRoot);
  try {
    const artifact = await stage(store, "client-a", "payload.txt", Buffer.from("payload"));
    const linkedParent = join(workspaceRoot, "linked-parent");
    await symlink(outsideRoot, linkedParent, "dir");
    await expectArtifactError(
      copyArtifactToWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_containment",
        workspaceRoot,
        artifactId: artifact.artifactId,
        destination: join(linkedParent, "escaped.txt"),
        onConflict: "replace",
      }),
      "workspace_parent_unsafe",
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside-safe");
    await assert.rejects(lstat(join(outsideRoot, "escaped.txt")), { code: "ENOENT" });

    const linkedDestination = join(workspaceRoot, "linked.txt");
    await symlink(outsideFile, linkedDestination);
    await expectArtifactError(
      copyArtifactToWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_containment",
        workspaceRoot,
        artifactId: artifact.artifactId,
        destination: linkedDestination,
        onConflict: "replace",
      }),
      "workspace_destination_unsafe",
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside-safe");

    const sourceLink = join(workspaceRoot, "source-link.txt");
    await symlink(outsideFile, sourceLink);
    await expectArtifactError(
      exportArtifactFromWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_containment",
        workspaceRoot,
        path: sourceLink,
      }),
      "workspace_export_not_regular",
    );

    await expectArtifactError(
      copyArtifactToWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_containment",
        workspaceRoot,
        artifactId: artifact.artifactId,
        destination: join(workspaceRoot, "..", "escaped.txt"),
        onConflict: "error",
      }),
      "workspace_path_escape",
    );
  } finally {
    store.close();
  }
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

async function stage(
  store: ArtifactStore,
  clientId: string,
  filename: string,
  bytes: Buffer,
): Promise<ArtifactRecord> {
  const upload = await store.beginUpload(clientId, {
    filename,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  for (let offset = 0; offset < bytes.length; offset += ARTIFACT_CHUNK_BYTES) {
    await store.uploadChunk(clientId, {
      uploadId: upload.uploadId,
      offset,
      dataBase64: bytes.subarray(offset, offset + ARTIFACT_CHUNK_BYTES).toString("base64"),
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
