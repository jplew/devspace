import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import {
  artifactContentDisposition,
  artifactDownloadUrl,
  handleArtifactDownload,
  safeArtifactDownloadMimeType,
} from "./artifact-download.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ArtifactStore,
  type ArtifactRecord,
} from "./artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-download-test-"));
const resourceServerUrl = new URL("https://devspace.test/mcp");
const store = createStore(root);
let server: Server | undefined;

try {
  const bytes = Buffer.from("<html><body>private artifact</body></html>\n");
  const artifact = await stage(
    store,
    "client-a",
    "résumé report.html",
    "text/html; charset=utf-8",
    bytes,
  );
  const partial = await store.beginUpload("client-a", {
    filename: "partial.txt",
    size: 7,
  });

  const app = express();
  app.use((req, _res, next) => {
    const clientId = req.header("x-test-client");
    if (clientId) {
      req.auth = {
        clientId,
        scopes: ["devspace"],
        token: "test-token-that-must-not-appear-in-links",
        resource: req.header("x-test-wrong-resource")
          ? new URL("https://other-resource.test/mcp")
          : resourceServerUrl,
      };
    }
    next();
  });
  app.get("/artifacts/:artifactId", async (req, res) => {
    await handleArtifactDownload(req, res, { store, resourceServerUrl });
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const downloadPath = `/artifacts/${encodeURIComponent(artifact.artifactId)}`;

  const unauthenticated = await fetch(`${baseUrl}${downloadPath}`);
  assert.equal(unauthenticated.status, 401);

  const wrongOwner = await fetch(`${baseUrl}${downloadPath}`, {
    headers: { "x-test-client": "client-b" },
  });
  assert.equal(wrongOwner.status, 404);

  const wrongResource = await fetch(`${baseUrl}${downloadPath}`, {
    headers: {
      "x-test-client": "client-a",
      "x-test-wrong-resource": "1",
    },
  });
  assert.equal(wrongResource.status, 401);

  const invalidId = await fetch(`${baseUrl}/artifacts/not-an-artifact`, {
    headers: { "x-test-client": "client-a" },
  });
  assert.equal(invalidId.status, 404);

  const partialDownload = await fetch(
    `${baseUrl}/artifacts/${encodeURIComponent(partial.uploadId)}`,
    { headers: { "x-test-client": "client-a" } },
  );
  assert.equal(partialDownload.status, 404);

  const response = await fetch(`${baseUrl}${downloadPath}`, {
    headers: { "x-test-client": "client-a" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  const disposition = response.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment;/u);
  assert.match(disposition, /filename="r_sum_ report\.html"/u);
  assert.match(disposition, /filename\*=UTF-8''r%C3%A9sum%C3%A9%20report\.html/u);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  const head = await fetch(`${baseUrl}${downloadPath}`, {
    method: "HEAD",
    headers: { "x-test-client": "client-a" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  assert.equal(safeArtifactDownloadMimeType("image/png"), "image/png");
  assert.equal(safeArtifactDownloadMimeType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeArtifactDownloadMimeType("text/html"), "application/octet-stream");
  assert.equal(
    artifactContentDisposition("résumé report.html"),
    "attachment; filename=\"r_sum_ report.html\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20report.html",
  );

  const protectedUrl = artifactDownloadUrl(
    "https://devspace.example.test/",
    artifact.artifactId,
  );
  assert.equal(
    protectedUrl,
    `https://devspace.example.test/artifacts/${artifact.artifactId}`,
  );
  assert.equal(protectedUrl.includes("?"), false);
  assert.equal(protectedUrl.includes("token"), false);
  assert.deepEqual(await readFile(artifact.hostPath), bytes);

  if (process.platform !== "win32") {
    const verified = await store.openArtifactReadHandle("client-a", artifact.artifactId);
    const outsideSecret = join(root, "outside-secret.html");
    await writeFile(outsideSecret, "outside-secret-that-must-not-be-streamed");
    await unlink(verified.path);
    await symlink(outsideSecret, verified.path);
    const buffer = Buffer.alloc(bytes.length);
    const { bytesRead } = await verified.handle.read(buffer, 0, buffer.length, 0);
    assert.equal(bytesRead, bytes.length);
    assert.deepEqual(buffer, bytes);
    await verified.handle.close();
  }
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  store.close();
  await rm(root, { recursive: true, force: true });
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
  mimeType: string,
  bytes: Buffer,
): Promise<ArtifactRecord> {
  const upload = await store.beginUpload(clientId, {
    filename,
    mimeType,
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
