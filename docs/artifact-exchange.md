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

This foundation does not yet include a host-specific native file adapter,
workspace copy/export tools, authenticated download resources, archive
handling, malware scanning, or permanent storage. Those capabilities require
separate design and testing rather than expanding this transfer seam implicitly.
