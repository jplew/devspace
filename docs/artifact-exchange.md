# Artifact Exchange

DevSpace Artifact Exchange is a generic, private byte-transfer foundation for
MCP hosts that cannot provide an attached file as a host-visible path. It is
opt-in and independent of any product-specific import or publishing behavior.

Enable it with:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

The default private root is:

```text
~/.local/share/devspace/artifacts
```

The SQLite state database remains authoritative for records and upload
sessions. Immutable content objects are addressed by their server-computed
SHA-256 digest.

## Native File Staging

`stage_artifact` is the preferred action when an MCP host supplies an attached
or generated file as a native top-level tool value:

```json
{
  "file": "<opaque host-provided value>",
  "workspaceId": "optional association only",
  "expectedSha256": "sha256:...",
  "ttlHours": 24,
  "pin": false
}
```

The `file` value is deliberately opaque. DevSpace does not assume a ChatGPT,
Claude, URL, mounted-path, or embedded-byte shape. It selects exactly one
explicitly registered `IncomingArtifactAdapter`; zero matches fail closed, and
multiple matches fail as ambiguous. A workspace ID is metadata only and never
a write destination.

A successful stage streams through the same byte limits, total quota,
server-side SHA-256, private partial-file, and atomic content-addressed commit
pipeline as the fallback upload tools. The result contains only the artifact
ID, sanitized name, MIME hint, byte size, SHA-256, host path, expiry, and a
short instruction. It never returns file content, base64, bearer credentials,
or presigned URLs.

Adapters are injected explicitly when constructing the server:

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

No host-specific adapter is enabled by default until its real connector value
has been observed and reviewed.

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

Remaining manual validation is intentionally separate from this code change:
run the actual ChatGPT DevSpace connector in an approved maintenance window,
attach a small benign file, inject the probe adapter, inspect the process-local
capture, document a sanitized fixture, and then implement and review one
trusted host-specific adapter. Until that happens, DevSpace makes no claim that
`stage_artifact` accepts ChatGPT native file references.

## Fallback Upload Protocol

### 1. Begin

Call `artifact_upload_begin` with a safe filename and optional MIME hint,
expected decoded size, expected SHA-256, workspace association, and artifact
TTL.

The result contains:

- an opaque `uploadId`
- a decoded chunk limit of 49,152 bytes (48 KiB)
- the incomplete-upload expiry time
- `nextOffset: 0`

A workspace ID is metadata only. Beginning an upload never writes into a
workspace.

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
KiB. The offset must equal the current decoded byte count.

V1 is deliberately sequential. Out-of-order chunks fail. Repeating the most
recently committed chunk at the same offset is safe only when the decoded bytes
are identical; DevSpace acknowledges that retry without appending it again.
Conflicting retries fail.

### 3. Commit

Call `artifact_upload_commit` after all bytes have been uploaded. DevSpace
validates the declared size and optional digest, computes SHA-256 server-side,
and atomically promotes the partial file into immutable content-addressed
storage.

The result contains metadata only:

```json
{
  "artifactId": "art_...",
  "name": "report.bin",
  "mimeType": "application/octet-stream",
  "size": 61432,
  "sha256": "sha256:...",
  "hostPath": "/home/user/.local/share/devspace/artifacts/objects/...",
  "source": "chunked",
  "createdAt": "...",
  "expiresAt": "...",
  "pinned": false
}
```

Only paths returned by an artifact tool are valid artifact capability paths.
Agents must not invent paths under the artifact root.

### 4. Abort, Inspect, or Delete

- `artifact_upload_abort` removes an incomplete upload.
- `artifact_stat` returns metadata for an artifact owned by the authenticated
  OAuth client.
- `artifact_delete` deletes the record and removes the immutable object only
  when no other live record references it.

## Storage and Lifecycle

Default limits are 100 MiB per artifact, 1 GiB total storage, and a 24-hour TTL
for committed unpinned records. Incomplete uploads expire after one hour.

Cleanup runs once at startup and every 15 minutes. Each pass is bounded so a
large stale backlog cannot monopolize the server. Cleanup preserves pinned
records and immutable objects referenced by another live record.

`devspace doctor` reports:

```text
Artifact exchange: enabled
Artifact root: ...
Artifact storage: ... / ...
Pending uploads: ...
Expired artifacts awaiting cleanup: ...
```

## Security Boundaries

The store enforces:

- server-selected paths
- one normalized, non-hidden basename as metadata
- byte limits during upload, not only at commit
- total quota including pending decoded bytes
- server-computed SHA-256
- mode `0700` roots and object directories
- mode `0600` partial and object files
- no-follow file opens where supported
- symlink and non-regular-file rejection
- lexical and realpath containment checks
- atomic promotion into immutable object storage
- OAuth-client ownership for uploads and records
- logs and results without raw artifact content or base64 chunks

The MIME type is only a hint. DevSpace does not inspect archives, execute
content, fetch arbitrary URLs, serve an unauthenticated download route, widen
workspace roots, or automatically publish artifacts.

## Current Non-Goals

This foundation does not yet include a validated production host-specific
native file adapter, workspace copy/export tools, authenticated download
resources, archive handling, malware scanning, or permanent storage. The
`stage_artifact` boundary and probe harness do not claim connector
compatibility by themselves. Those capabilities require separate design and
testing rather than expanding this transfer seam implicitly.
