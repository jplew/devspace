# Artifact Exchange

DevSpace Artifact Exchange is an opt-in, private, bidirectional byte-transfer
surface for MCP hosts and local workspaces. It is generic: staging or exporting
an artifact does not import, execute, publish, or otherwise interpret it.

Enable it with:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

The default private root is:

```text
~/.local/share/devspace/artifacts
```

The SQLite state database is authoritative for upload sessions and artifact
records. Canonical content objects are immutable and addressed by the
server-computed SHA-256 digest.

## Native File Staging

`stage_artifact` is the preferred action when ChatGPT supplies an attached or
generated file as a native top-level tool value. The descriptor declares
`_meta["openai/fileParams"] = ["file"]`, so ChatGPT authorizes and rewrites the
field before invoking DevSpace:

```json
{
  "file": {
    "download_url": "https://files.oaiusercontent.com/...",
    "file_id": "file_...",
    "mime_type": "image/png",
    "file_name": "generated.png",
    "name": "/mnt/data/generated.png",
    "size": 123456
  },
  "workspaceId": "optional association only",
  "expectedSha256": "sha256:...",
  "ttlHours": 24,
  "pin": false
}
```

The production OpenAI adapter requires `download_url` and `file_id`. It accepts
the documented `mime_type` and `file_name` fields plus the connector compatibility
aliases `name` and `size`. Optional metadata may be omitted or `null`, which is
important for generated-image results. A sandbox-style filename such as
`/mnt/data/generated.png` is reduced to its safe basename; when no filename is
available, DevSpace derives an extension from the MIME type. If both filename
fields are present they must resolve to the same basename, and a supplied byte
size must agree with the response `Content-Length` when both are available.

Download URLs must use HTTPS on `files.oaiusercontent.com`, redirects are
revalidated before they are followed, and arbitrary URLs, unresolved path
strings, extra credential fields, malformed IDs, and conflicting metadata fail
closed. A workspace ID is metadata only and never a write destination.

A successful stage streams through the same byte limits, total quota,
server-side SHA-256, private partial-file, and atomic content-addressed commit
pipeline as the fallback upload tools. The result contains the artifact ID,
sanitized name, MIME hint, byte size, SHA-256, verified materialized host path,
expiry, MCP resource link, tokenless bearer-protected download reference, and a
short instruction. It never returns file content, base64, bearer credentials,
or presigned query parameters.

The production OpenAI adapter is enabled by default. Tests and custom hosts may
replace the adapter list explicitly when constructing the server:

```ts
createServer(config, {
  incomingArtifactAdapters: [trustedAdapter],
});
```

The boundary is:

```ts
interface IncomingArtifactAdapter {
  readonly id: string;
  canHandle(value: unknown): boolean;
  open(value: unknown): Promise<{
    name: string;
    mimeType?: string;
    size?: number;
    stream: NodeJS.ReadableStream;
  }>;
}
```

### Deterministic Fixture and Probe Harness

Unit tests use only the explicit local fixture reference:

```ts
{
  kind: "devspace-local-fixture-v1",
  relativePath: "nested/report.md",
  name?: "report.md",
  mimeType?: "text/markdown"
}
```

`createLocalFixtureIncomingArtifactAdapter(fixtureRoot)` accepts only that
branded object, requires a contained regular non-symlink file, and is not
registered by the production server.

For the later manual connector compatibility exercise,
`createIncomingArtifactProbeAdapter(normalize)` receives:

```ts
{
  rawValue: unknown,                  // process-local callback input only
  shape: IncomingArtifactProbeShape  // redacted type/key/length summary
}
```

The callback may return a normalized stream source when the value is known and
trusted. Returning `undefined` records the in-process capture and deliberately
fails staging with `incoming_artifact_probe_captured`; the raw value is never
put in tool results or logs. The redacted shape preserves ordinary structural
keys and value classes while omitting string contents; unusual or long keys are
replaced with placeholders so tokens and presigned URLs are not persisted.
`stage_artifact` lifecycle logs include this same redacted shape summary, making
connector regressions diagnosable without recording filenames, file IDs,
signed URLs, or bearer material.

The probe remains available for future MCP hosts with different file contracts.
It is not registered by the production server and must not be used as a generic
URL or path adapter.

## Fallback Upload Protocol

### 1. Begin

Call `artifact_upload_begin` with a safe filename and optional MIME hint,
expected decoded size, expected SHA-256, workspace association, and artifact
TTL.

The result contains an opaque `uploadId`, a decoded chunk limit of 49,152 bytes
(48 KiB), the incomplete-upload expiry time, and `nextOffset: 0`.

A workspace ID is metadata only. Beginning or committing an upload never writes
into a workspace.

### 2. Upload Sequential Chunks

Call `artifact_upload_chunk` with:

```json
{
  "uploadId": "upl_...",
  "offset": 0,
  "dataBase64": "..."
}
```

`dataBase64` must be canonical standard base64 and decode to no more than 48
KiB. V1 is sequential. The offset must equal the current decoded byte count.
Repeating the most recently committed chunk is safe only when the bytes are
identical; conflicting or out-of-order data fails.

### 3. Commit

Call `artifact_upload_commit` after all bytes have been uploaded. DevSpace
validates the declared size and digest, computes SHA-256 server-side, atomically
promotes the partial file into immutable content-addressed storage, and creates
a private presentation copy with the sanitized original filename. The same
transaction stores an owner-scoped upload-to-artifact receipt for one hour. If
the first response is lost, retrying the same upload ID returns the original
artifact record and SHA-256 instead of a false `upload not found` result.

A committed or inspected artifact result includes:

```json
{
  "artifactId": "art_...",
  "name": "report.md",
  "mimeType": "text/markdown",
  "size": 61432,
  "sha256": "sha256:...",
  "hostPath": "/home/user/.local/share/devspace/artifacts/materialized/art_.../report.md",
  "source": "chunked",
  "createdAt": "...",
  "expiresAt": "...",
  "pinned": false,
  "resourceUri": "https://devspace.example/artifacts/art_...",
  "downloadUrl": "https://devspace.example/artifacts/art_..."
}
```

`hostPath` is a verified materialized presentation path. Canonical objects stay
under the digest-addressed object tree. Only paths returned by artifact tools
are valid outside-workspace capability paths; agents must never invent paths
under the artifact root.

`resourceUri` and `downloadUrl` identify the same bearer-protected route. They
do not contain access tokens or signed query parameters.

### 4. Abort, Inspect, or Delete

- `artifact_upload_abort` removes an incomplete upload.
- `artifact_stat` returns owner-scoped metadata, restores or verifies the
  materialized presentation path, and returns the protected resource link.
- `artifact_delete` deletes the record and its materialized presentation path.
  The canonical object is removed only when no other live record references it.

## Copying an Artifact into a Workspace

`artifact_copy_to_workspace` is explicit and opt-in:

```json
{
  "workspaceId": "ws_...",
  "artifactId": "art_...",
  "destination": "reports/report.md",
  "onConflict": "error"
}
```

`onConflict` must be one of:

- `error` — fail without modifying an existing destination;
- `rename` — choose the first available `name (N).ext` destination;
- `replace` — atomically replace an existing regular file.

The operation uses the canonical verified object, not a mutable presentation
copy. It resolves the destination through the existing workspace guard, creates
parents only inside that workspace, rejects symlink/non-directory parents,
copies atomically, verifies the final size and SHA-256, and writes a
non-executable `0644` file.

Copying may dirty a source repository. DevSpace never copies artifacts into a
workspace automatically.

## Exporting a Workspace File

`artifact_export_from_workspace` is the reverse seam:

```json
{
  "workspaceId": "ws_...",
  "path": "exports/report.pdf",
  "ttlHours": 24
}
```

Only a contained regular non-symlink file is accepted. DevSpace reads it through
a no-follow handle, verifies that it did not change during transfer, computes
SHA-256 server-side, stages a private copy outside the repository, and returns
the normal artifact metadata, resource link, and protected download reference.

Export does not alter the source file, create a staging directory in the
workspace, or dirty the repository.

## Protected Downloads

When Artifact Exchange is enabled, DevSpace exposes:

```text
GET /artifacts/:artifactId
HEAD /artifacts/:artifactId
```

The route uses the same OAuth bearer boundary and resource validation as MCP.
The authenticated OAuth client must own the record. Partial uploads are not
addressable and the artifact root is never exposed through `express.static`.

Responses use:

- `Content-Disposition: attachment` with a safe fallback and UTF-8 filename;
- an allowlisted content type, otherwise `application/octet-stream`;
- `X-Content-Type-Options: nosniff`;
- `Cache-Control: private, no-store`;
- the recorded byte length.

Do not place bearer tokens in URLs, logs, tool arguments, or command lines.

## Storage and Lifecycle

Default limits are 100 MiB per artifact, 1 GiB total canonical storage, and a
24-hour TTL for committed unpinned records. Incomplete uploads expire after one
hour.

Cleanup runs at startup and every 15 minutes. Each pass is bounded. Cleanup
removes expired records and materialized paths while preserving pinned records
and canonical objects referenced by another live record.

`devspace doctor` reports the configured root, canonical storage use, pending
uploads, and expired artifacts awaiting cleanup.

## Security Boundaries

The exchange enforces:

- server-selected canonical and temporary paths;
- one normalized, non-hidden basename as metadata;
- byte limits during transfer;
- total quota including pending decoded bytes;
- server-computed SHA-256 and verification on materialization/copy/download;
- mode `0700` private directories;
- mode `0600` canonical, partial, and materialized files;
- mode `0644` non-executable workspace copies;
- no-follow opens where supported;
- symlink and non-regular-file rejection;
- lexical and realpath containment checks;
- atomic promotion and workspace replacement;
- OAuth-client ownership for uploads, records, resources, and downloads;
- logs and tool results without raw artifact content, base64 chunks, bearer
  tokens, or tokenized URLs.

The MIME type is only a hint. DevSpace does not inspect archives, execute
content, fetch arbitrary URLs outside the validated ChatGPT file boundary,
serve an unauthenticated download route, widen workspace roots, automatically
publish artifacts, or treat the exchange as permanent storage.

## Current Non-Goals

This implementation does not include adapters for other MCP hosts, archive
handling, malware scanning, automatic project copying, or permanent storage.
Those capabilities require separate design and testing rather than expanding
the reviewed ChatGPT transfer seam implicitly.
