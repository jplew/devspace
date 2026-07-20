# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Artifact Exchange

The Artifact Exchange is an opt-in private byte-transfer seam. Its root is
separate from allowed workspace roots, repositories, worktrees, temporary
folders, and public static assets.

DevSpace selects every storage path. Artifact names are metadata, not path
components. Names are Unicode-normalized and must be a single non-hidden
basename without separators, NUL bytes, or control characters. The store uses
content-addressed immutable objects, mode `0700` directories, mode `0600`
object and partial files, atomic promotion, realpath containment checks,
regular-file enforcement, and no-follow file opens where the platform supports
them.

Artifact records are scoped to the authenticated OAuth client. The first
version remains under the existing owner-only `devspace` scope. Protected
`GET`/`HEAD /artifacts/:artifactId` downloads use the same bearer and OAuth
resource boundary, require record ownership, force attachment disposition,
allowlist safe content types, add `nosniff`, and disable caching. Partial uploads
are not addressable. The artifact root is never exposed with `express.static`,
and resource URLs contain no bearer or signed query token.

Canonical objects remain digest-addressed and private. Tool results expose only
per-record materialized presentation paths under
`artifactRoot/materialized/art_<id>/<sanitized-name>`. These files are verified
against the canonical object and remain mode `0600`. Only artifact paths
returned by tools are valid outside-workspace capability paths.

Copying into a workspace is an explicit operation because it can dirty a
repository. The copy path uses the existing workspace containment guard,
rejects symlink parents/destinations, requires an explicit conflict mode, writes
atomically, re-verifies size and SHA-256, and strips executable permissions.
Workspace export accepts only a contained regular non-symlink file and stages a
private copy without modifying the workspace.

Native staging is adapter-gated. The production server declares ChatGPT's
top-level `openai/fileParams` contract and accepts only the documented
`download_url`, `file_id`, `mime_type?`, and `file_name?` object. Downloads use
HTTPS on `files.oaiusercontent.com`; credentials, fragments, alternate ports,
arbitrary hosts, malformed IDs, extra fields, and redirects outside that same
boundary fail closed. Probe captures for future hosts stay process-local, and
only a redacted type/key/length summary is suitable for logs or fixtures.

The exchange deliberately does not:

- fetch arbitrary URLs
- extract archives
- execute transferred content
- expand workspace allowlists
- preserve executable permissions
- publish or permanently retain content

MIME types are hints only. SHA-256 and byte counts are computed and enforced by
the server. Successful chunked commits retain a one-hour owner-scoped receipt
so response-loss retries return the same artifact; receipt cleanup never removes
the artifact. Pinned records require explicit deletion; unpinned records and
incomplete uploads remain subject to cleanup.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain identifiers, names, MIME hints, byte counts, hashes,
workspace paths, conflict modes, and status fields. `stage_artifact` logs whether
a file value and expected digest were supplied, non-sensitive options, and a
redacted structural summary of the file value. That summary records bounded key
names plus value types/classes and string lengths, but never string contents.
Raw content, connector file IDs, filenames, path values, base64 chunks, bearer
credentials, authorization headers, presigned URLs, and protected download URLs
are never included in tool logs.
Tool results may include a tokenless protected resource URL that still requires
the caller's bearer authorization.
