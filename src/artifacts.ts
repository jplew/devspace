import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";

export const ARTIFACT_CHUNK_BYTES = 48 * 1024;
export const ARTIFACT_UPLOAD_TTL_HOURS = 1;
export const ARTIFACT_CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;
export const ARTIFACT_CLEANUP_LIMIT = 100;

const MAX_FILENAME_BYTES = 255;
const MAX_TTL_HOURS = 24 * 365;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export class ArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface ArtifactUploadBeginInput {
  filename: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  workspaceId?: string;
  ttlHours?: number;
}

export interface ArtifactUploadBeginResult {
  uploadId: string;
  chunkBytes: number;
  expiresAt: string;
  nextOffset: number;
}

export interface ArtifactUploadChunkInput {
  uploadId: string;
  offset: number;
  dataBase64: string;
}

export interface ArtifactUploadChunkResult {
  uploadId: string;
  receivedBytes: number;
  nextOffset: number;
  retry: boolean;
}

export interface ArtifactRecord {
  artifactId: string;
  name: string;
  mimeType?: string;
  size: number;
  sha256: string;
  hostPath: string;
  source: string;
  workspaceId?: string;
  createdAt: string;
  expiresAt?: string;
  pinned: boolean;
}

export interface ArtifactCommitOptions {
  source?: string;
  pinned?: boolean;
}

export interface ArtifactDeleteResult {
  artifactId: string;
  deleted: boolean;
  objectDeleted: boolean;
}

export interface ArtifactFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ArtifactImportFileInput {
  path: string;
  filename: string;
  mimeType?: string;
  workspaceId?: string;
  ttlHours?: number;
  source: "workspace-export";
  expectedFile?: ArtifactFileIdentity;
}

export interface ArtifactSource {
  artifactId: string;
  name: string;
  mimeType?: string;
  size: number;
  sha256: string;
  path: string;
}

export interface ArtifactReadHandle extends ArtifactSource {
  handle: FileHandle;
}

export interface ArtifactCleanupResult {
  uploadsDeleted: number;
  artifactsDeleted: number;
  objectsDeleted: number;
  skippedUnsafePaths: number;
}

export interface ArtifactStorageHealth {
  root: string;
  storedBytes: number;
  maxTotalBytes: number;
  pendingUploads: number;
  expiredArtifacts: number;
}

interface ArtifactStoreOptions {
  now?: () => Date;
  cleanupLimit?: number;
}

interface UploadRow {
  id: string;
  client_id: string | null;
  workspace_id: string | null;
  original_name: string;
  mime_type: string | null;
  expected_size: number | null;
  expected_sha256: string | null;
  received_size: number;
  temp_path: string;
  status: string;
  artifact_ttl_hours: number;
  last_chunk_offset: number | null;
  last_chunk_size: number | null;
  last_chunk_sha256: string | null;
  created_at: string;
  expires_at: string;
}

interface ArtifactRow {
  id: string;
  client_id: string | null;
  workspace_id: string | null;
  original_name: string;
  mime_type: string | null;
  size: number;
  sha256: string;
  storage_path: string;
  source: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  pinned: number;
  last_used_at: string;
}

interface IncrementalHashState {
  hash: Hash;
  receivedSize: number;
}

export class ArtifactStore {
  private readonly database: DatabaseHandle;
  private readonly root: string;
  private readonly rootRealPath: string;
  private readonly objectsRoot: string;
  private readonly uploadsRoot: string;
  private readonly materializedRoot: string;
  private readonly now: () => Date;
  private readonly cleanupLimit: number;
  private readonly incrementalHashes = new Map<string, IncrementalHashState>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Pick<
      ServerConfig,
      | "stateDir"
      | "artifactRoot"
      | "artifactMaxFileBytes"
      | "artifactMaxTotalBytes"
      | "artifactDefaultTtlHours"
    >,
    options: ArtifactStoreOptions = {},
  ) {
    this.root = resolve(config.artifactRoot);
    this.rootRealPath = ensureSecureDirectorySync(this.root);
    this.objectsRoot = join(this.root, "objects");
    this.uploadsRoot = join(this.root, "uploads");
    this.materializedRoot = join(this.root, "materialized");
    ensureSecureDirectorySync(this.objectsRoot, this.rootRealPath);
    ensureSecureDirectorySync(this.uploadsRoot, this.rootRealPath);
    ensureSecureDirectorySync(this.materializedRoot, this.rootRealPath);
    this.database = openDatabase(config.stateDir);
    this.now = options.now ?? (() => new Date());
    this.cleanupLimit = options.cleanupLimit ?? ARTIFACT_CLEANUP_LIMIT;
  }

  close(): void {
    this.database.close();
  }

  beginUpload(clientId: string, input: ArtifactUploadBeginInput): Promise<ArtifactUploadBeginResult> {
    return this.withMutation(async () => {
      const name = normalizeArtifactFilename(input.filename);
      const mimeType = normalizeMimeType(input.mimeType);
      const expectedSize = normalizeExpectedSize(input.size, this.config.artifactMaxFileBytes);
      const expectedSha256 = normalizeSha256(input.sha256);
      const ttlHours = normalizeTtlHours(input.ttlHours, this.config.artifactDefaultTtlHours);

      if (expectedSize !== undefined) {
        this.assertQuotaAvailable(expectedSize);
      }

      const uploadId = `upl_${randomUUID()}`;
      const tempPath = join(this.uploadsRoot, `${uploadId}.partial`);
      assertLexicalContainment(this.uploadsRoot, tempPath);
      const handle = await open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile()) {
          throw new ArtifactError("unsafe_partial", "Upload partial is not a regular file.");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tempPath, 0o600);
      await assertExistingFileContained(tempPath, this.uploadsRoot, this.rootRealPath);

      const now = this.now();
      const expiresAt = addHours(now, ARTIFACT_UPLOAD_TTL_HOURS).toISOString();
      this.database.sqlite.prepare(`
        insert into artifact_uploads (
          id, client_id, workspace_id, original_name, mime_type,
          expected_size, expected_sha256, received_size, temp_path,
          status, artifact_ttl_hours, last_chunk_offset, last_chunk_size,
          last_chunk_sha256, created_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, null, null, null, ?, ?)
      `).run(
        uploadId,
        clientId,
        input.workspaceId ?? null,
        name,
        mimeType ?? null,
        expectedSize ?? null,
        expectedSha256 ?? null,
        tempPath,
        ttlHours,
        now.toISOString(),
        expiresAt,
      );
      this.incrementalHashes.set(uploadId, {
        hash: createHash("sha256"),
        receivedSize: 0,
      });

      return {
        uploadId,
        chunkBytes: ARTIFACT_CHUNK_BYTES,
        expiresAt,
        nextOffset: 0,
      };
    });
  }

  uploadChunk(clientId: string, input: ArtifactUploadChunkInput): Promise<ArtifactUploadChunkResult> {
    return this.withMutation(async () => {
      const row = this.requireUpload(clientId, input.uploadId);
      this.assertUploadActive(row);
      this.assertUploadNotExpired(row);
      const data = decodeBase64Strict(input.dataBase64);
      if (data.length === 0) {
        throw new ArtifactError("empty_chunk", "Upload chunks must contain at least one decoded byte.");
      }
      if (data.length > ARTIFACT_CHUNK_BYTES) {
        throw new ArtifactError(
          "chunk_too_large",
          `Decoded chunk exceeds the ${ARTIFACT_CHUNK_BYTES}-byte limit.`,
        );
      }
      if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        throw new ArtifactError("invalid_offset", "Chunk offset must be a non-negative safe integer.");
      }

      const chunkSha256 = createHash("sha256").update(data).digest("hex");
      if (input.offset < row.received_size) {
        const identicalRetry =
          row.last_chunk_offset === input.offset
          && row.last_chunk_size === data.length
          && row.last_chunk_sha256 === chunkSha256
          && input.offset + data.length === row.received_size;
        if (!identicalRetry) {
          throw new ArtifactError(
            "conflicting_retry",
            "Chunk offset has already been committed with different data.",
          );
        }
        return {
          uploadId: row.id,
          receivedBytes: row.received_size,
          nextOffset: row.received_size,
          retry: true,
        };
      }
      if (input.offset !== row.received_size) {
        throw new ArtifactError(
          "out_of_order_chunk",
          `Expected chunk offset ${row.received_size}, received ${input.offset}.`,
        );
      }

      const nextSize = row.received_size + data.length;
      if (nextSize > this.config.artifactMaxFileBytes) {
        throw new ArtifactError(
          "file_too_large",
          `Artifact exceeds the ${this.config.artifactMaxFileBytes}-byte file limit.`,
        );
      }
      if (row.expected_size !== null && nextSize > row.expected_size) {
        throw new ArtifactError(
          "declared_size_exceeded",
          `Chunk would exceed the declared ${row.expected_size}-byte size.`,
        );
      }
      this.assertQuotaAvailable(data.length);

      const handle = await open(row.temp_path, fsConstants.O_WRONLY | NO_FOLLOW);
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile()) {
          throw new ArtifactError("unsafe_partial", "Upload partial is not a regular file.");
        }
        const resolvedPath = await realpath(row.temp_path);
        assertRealContainment(this.rootRealPath, resolvedPath);
        assertLexicalContainment(this.uploadsRoot, row.temp_path);
        const { bytesWritten } = await handle.write(data, 0, data.length, input.offset);
        if (bytesWritten !== data.length) {
          throw new ArtifactError("short_write", "The artifact chunk was not fully written.");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      this.database.sqlite.prepare(`
        update artifact_uploads
        set received_size = ?, last_chunk_offset = ?, last_chunk_size = ?, last_chunk_sha256 = ?
        where id = ? and client_id = ? and status = 'active'
      `).run(nextSize, input.offset, data.length, chunkSha256, row.id, clientId);

      const hashState = this.incrementalHashes.get(row.id);
      if (hashState && hashState.receivedSize === row.received_size) {
        hashState.hash.update(data);
        hashState.receivedSize = nextSize;
      } else {
        this.incrementalHashes.delete(row.id);
      }

      return {
        uploadId: row.id,
        receivedBytes: nextSize,
        nextOffset: nextSize,
        retry: false,
      };
    });
  }

  commitUpload(
    clientId: string,
    uploadId: string,
    options: ArtifactCommitOptions = {},
  ): Promise<ArtifactRecord> {
    return this.withMutation(async () => {
      const row = this.requireUpload(clientId, uploadId);
      this.assertUploadActive(row);
      this.assertUploadNotExpired(row);
      const source = normalizeArtifactSource(options.source);
      const pinned = options.pinned === true;
      const partialStat = await assertExistingFileContained(
        row.temp_path,
        this.uploadsRoot,
        this.rootRealPath,
      );
      if (partialStat.size !== row.received_size) {
        throw new ArtifactError(
          "partial_size_mismatch",
          `Partial file size ${partialStat.size} does not match recorded size ${row.received_size}.`,
        );
      }
      if (row.expected_size !== null && row.received_size !== row.expected_size) {
        throw new ArtifactError(
          "size_mismatch",
          `Received ${row.received_size} bytes, expected ${row.expected_size}.`,
        );
      }
      if (row.received_size > this.config.artifactMaxFileBytes) {
        throw new ArtifactError("file_too_large", "Artifact exceeds the configured file limit.");
      }

      const digest = await this.uploadDigest(row);
      if (row.expected_sha256 && digest !== row.expected_sha256) {
        throw new ArtifactError(
          "sha256_mismatch",
          "Artifact SHA-256 does not match the declared digest.",
        );
      }

      try {
        return await this.promoteStagedFile({
          clientId,
          workspaceId: row.workspace_id ?? undefined,
          name: row.original_name,
          mimeType: row.mime_type ?? undefined,
          size: row.received_size,
          digest,
          tempPath: row.temp_path,
          source,
          ttlHours: row.artifact_ttl_hours,
          pinned,
          afterInsert: () => {
            this.database.sqlite.prepare(
              "delete from artifact_uploads where id = ? and client_id = ?",
            ).run(row.id, clientId);
          },
        });
      } finally {
        this.incrementalHashes.delete(row.id);
      }
    });
  }

  importFile(clientId: string, input: ArtifactImportFileInput): Promise<ArtifactRecord> {
    return this.withMutation(async () => {
      const name = normalizeArtifactFilename(input.filename);
      const mimeType = normalizeMimeType(input.mimeType);
      const ttlHours = normalizeTtlHours(input.ttlHours, this.config.artifactDefaultTtlHours);
      const staged = await this.stageExternalFile(input.path, input.expectedFile);
      try {
        return await this.promoteStagedFile({
          clientId,
          workspaceId: input.workspaceId,
          name,
          mimeType,
          size: staged.size,
          digest: staged.digest,
          tempPath: staged.tempPath,
          source: input.source,
          ttlHours,
          pinned: false,
        });
      } catch (error) {
        await unlink(staged.tempPath).catch(() => undefined);
        throw error;
      }
    });
  }

  abortUpload(clientId: string, uploadId: string): Promise<{ uploadId: string; aborted: boolean }> {
    return this.withMutation(async () => {
      const row = this.requireUpload(clientId, uploadId);
      let unsafePathError: unknown;
      try {
        await removeManagedFile(row.temp_path, this.uploadsRoot, this.rootRealPath);
      } catch (error) {
        unsafePathError = error;
      }
      this.database.sqlite.prepare("delete from artifact_uploads where id = ? and client_id = ?")
        .run(row.id, clientId);
      this.incrementalHashes.delete(row.id);
      if (unsafePathError) throw unsafePathError;
      return { uploadId: row.id, aborted: true };
    });
  }

  async statArtifact(clientId: string, artifactId: string): Promise<ArtifactRecord> {
    const row = this.requireAvailableArtifact(clientId, artifactId);
    const hostPath = await this.ensureMaterializedArtifact(row);
    const now = this.now().toISOString();
    this.database.sqlite.prepare(
      "update artifacts set last_used_at = ? where id = ? and client_id = ?",
    ).run(now, artifactId, clientId);
    return artifactRowToRecord(row, hostPath);
  }

  async openArtifactReadHandle(
    clientId: string,
    artifactId: string,
  ): Promise<ArtifactReadHandle> {
    const row = this.requireAvailableArtifact(clientId, artifactId);
    const expectedEntry = await assertExistingFileContained(
      row.storage_path,
      this.objectsRoot,
      this.rootRealPath,
    );
    const handle = await open(row.storage_path, fsConstants.O_RDONLY | NO_FOLLOW);
    try {
      const openedEntry = await handle.stat();
      const currentEntry = await lstat(row.storage_path);
      if (
        !openedEntry.isFile()
        || currentEntry.isSymbolicLink()
        || !currentEntry.isFile()
        || openedEntry.dev !== expectedEntry.dev
        || openedEntry.ino !== expectedEntry.ino
        || currentEntry.dev !== openedEntry.dev
        || currentEntry.ino !== openedEntry.ino
      ) {
        throw new ArtifactError(
          "artifact_integrity_failed",
          "Artifact object changed while it was being opened.",
        );
      }
      assertRealContainment(this.rootRealPath, await realpath(row.storage_path));
      if (openedEntry.size !== row.size || await hashFileHandle(handle) !== row.sha256) {
        throw new ArtifactError(
          "artifact_integrity_failed",
          "Artifact object failed size or SHA-256 verification.",
        );
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }

    this.database.sqlite.prepare(
      "update artifacts set last_used_at = ? where id = ? and client_id = ?",
    ).run(this.now().toISOString(), artifactId, clientId);
    return {
      artifactId: row.id,
      name: row.original_name,
      mimeType: row.mime_type ?? undefined,
      size: row.size,
      sha256: `sha256:${row.sha256}`,
      path: row.storage_path,
      handle,
    };
  }

  deleteArtifact(clientId: string, artifactId: string): Promise<ArtifactDeleteResult> {
    return this.withMutation(async () => {
      const row = this.requireArtifact(clientId, artifactId);
      await this.removeMaterializedArtifact(row);
      this.database.sqlite.prepare("delete from artifacts where id = ? and client_id = ?")
        .run(row.id, clientId);
      const objectDeleted = await this.deleteObjectIfUnreferenced(row);
      return { artifactId: row.id, deleted: true, objectDeleted };
    });
  }

  cleanupExpired(): Promise<ArtifactCleanupResult> {
    return this.withMutation(async () => {
      const now = this.now().toISOString();
      let remaining = this.cleanupLimit;
      let uploadsDeleted = 0;
      let artifactsDeleted = 0;
      let objectsDeleted = 0;
      let skippedUnsafePaths = 0;

      const expiredUploads = this.database.sqlite.prepare(`
        select * from artifact_uploads
        where status = 'active' and expires_at <= ?
        order by expires_at asc
        limit ?
      `).all(now, remaining) as UploadRow[];
      for (const row of expiredUploads) {
        try {
          await removeManagedFile(row.temp_path, this.uploadsRoot, this.rootRealPath);
        } catch {
          skippedUnsafePaths += 1;
        }
        this.database.sqlite.prepare("delete from artifact_uploads where id = ?").run(row.id);
        this.incrementalHashes.delete(row.id);
        uploadsDeleted += 1;
        remaining -= 1;
      }

      if (remaining > 0) {
        const expiredArtifacts = this.database.sqlite.prepare(`
          select * from artifacts
          where status = 'available' and pinned = 0 and expires_at is not null and expires_at <= ?
          order by expires_at asc
          limit ?
        `).all(now, remaining) as ArtifactRow[];
        for (const row of expiredArtifacts) {
          try {
            await this.removeMaterializedArtifact(row);
          } catch {
            skippedUnsafePaths += 1;
          }
          this.database.sqlite.prepare("delete from artifacts where id = ?").run(row.id);
          artifactsDeleted += 1;
          try {
            if (await this.deleteObjectIfUnreferenced(row)) objectsDeleted += 1;
          } catch {
            skippedUnsafePaths += 1;
          }
        }
      }

      return {
        uploadsDeleted,
        artifactsDeleted,
        objectsDeleted,
        skippedUnsafePaths,
      };
    });
  }

  health(): ArtifactStorageHealth {
    const storedBytes = this.objectBytes();
    const pendingUploads = Number(
      this.database.sqlite.prepare(
        "select count(*) from artifact_uploads where status = 'active'",
      ).pluck().get() ?? 0,
    );
    const expiredArtifacts = Number(
      this.database.sqlite.prepare(`
        select count(*) from artifacts
        where status = 'available' and pinned = 0
          and expires_at is not null and expires_at <= ?
      `).pluck().get(this.now().toISOString()) ?? 0,
    );
    return {
      root: this.root,
      storedBytes,
      maxTotalBytes: this.config.artifactMaxTotalBytes,
      pendingUploads,
      expiredArtifacts,
    };
  }

  private async stageExternalFile(
    path: string,
    expectedFile?: ArtifactFileIdentity,
  ): Promise<{
    tempPath: string;
    size: number;
    digest: string;
  }> {
    const sourceEntry = await lstat(path);
    if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
      throw new ArtifactError(
        "workspace_export_not_regular",
        "Only regular, non-symlink workspace files can be exported.",
      );
    }
    if (expectedFile && !sameFileIdentity(sourceEntry, expectedFile)) {
      throw new ArtifactError(
        "workspace_export_changed",
        "Workspace file changed after containment validation.",
      );
    }
    if (sourceEntry.size > this.config.artifactMaxFileBytes) {
      throw new ArtifactError("file_too_large", "Artifact exceeds the configured file limit.");
    }
    this.assertQuotaAvailable(sourceEntry.size);

    const tempPath = join(this.uploadsRoot, `upl_export_${randomUUID()}.partial`);
    assertLexicalContainment(this.uploadsRoot, tempPath);
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    let copiedSize = 0;
    let failure: unknown;

    try {
      sourceHandle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
      destinationHandle = await open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      const openedSource = await sourceHandle.stat();
      if (
        !openedSource.isFile()
        || openedSource.dev !== sourceEntry.dev
        || openedSource.ino !== sourceEntry.ino
      ) {
        throw new ArtifactError(
          "workspace_export_changed",
          "Workspace file changed while it was being opened for export.",
        );
      }

      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        await writeAll(destinationHandle, chunk, copiedSize);
        hash.update(chunk);
        copiedSize += bytesRead;
        position += bytesRead;
        if (copiedSize > this.config.artifactMaxFileBytes) {
          throw new ArtifactError("file_too_large", "Artifact exceeds the configured file limit.");
        }
      }
      await destinationHandle.sync();

      const closedSource = await sourceHandle.stat();
      if (
        copiedSize !== sourceEntry.size
        || closedSource.size !== sourceEntry.size
        || closedSource.mtimeMs !== sourceEntry.mtimeMs
        || closedSource.ctimeMs !== sourceEntry.ctimeMs
      ) {
        throw new ArtifactError(
          "workspace_export_changed",
          "Workspace file changed while it was being exported.",
        );
      }
    } catch (error) {
      failure = error;
    } finally {
      await destinationHandle?.close().catch(() => undefined);
      await sourceHandle?.close().catch(() => undefined);
    }

    if (failure) {
      await unlink(tempPath).catch(() => undefined);
      throw failure;
    }

    await chmod(tempPath, 0o600);
    const staged = await assertExistingFileContained(
      tempPath,
      this.uploadsRoot,
      this.rootRealPath,
    );
    if (staged.size !== copiedSize) {
      await unlink(tempPath).catch(() => undefined);
      throw new ArtifactError(
        "workspace_export_size_mismatch",
        "Exported artifact staging size did not match the copied byte count.",
      );
    }

    return {
      tempPath,
      size: copiedSize,
      digest: hash.digest("hex"),
    };
  }

  private async promoteStagedFile(input: {
    clientId: string;
    workspaceId?: string;
    name: string;
    mimeType?: string;
    size: number;
    digest: string;
    tempPath: string;
    source: string;
    ttlHours: number;
    pinned: boolean;
    afterInsert?: () => void;
  }): Promise<ArtifactRecord> {
    const staged = await assertExistingFileContained(
      input.tempPath,
      this.uploadsRoot,
      this.rootRealPath,
    );
    if (staged.size !== input.size || await hashFile(input.tempPath) !== input.digest) {
      throw new ArtifactError(
        "staged_artifact_integrity_failed",
        "Staged artifact failed size or SHA-256 verification.",
      );
    }

    const objectDirectory = join(
      this.objectsRoot,
      input.digest.slice(0, 2),
      input.digest.slice(2, 4),
    );
    await ensureSecureDirectory(objectDirectory, this.rootRealPath);
    const objectPath = join(objectDirectory, input.digest);
    assertLexicalContainment(this.objectsRoot, objectPath);

    let createdObject = false;
    const existingObject = await lstatOrUndefined(objectPath);
    if (existingObject) {
      if (existingObject.isSymbolicLink() || !existingObject.isFile()) {
        throw new ArtifactError("unsafe_object", "Artifact object path is not a regular file.");
      }
      await assertExistingFileContained(objectPath, this.objectsRoot, this.rootRealPath);
      if (existingObject.size !== input.size || await hashFile(objectPath) !== input.digest) {
        throw new ArtifactError("object_collision", "Existing artifact object failed digest verification.");
      }
      await unlink(input.tempPath);
    } else {
      await rename(input.tempPath, objectPath);
      createdObject = true;
      await chmod(objectPath, 0o600);
      await assertExistingFileContained(objectPath, this.objectsRoot, this.rootRealPath);
    }

    const now = this.now();
    const artifactId = `art_${randomUUID()}`;
    const expiresAt = addHours(now, input.ttlHours).toISOString();
    let materializedPath: string | undefined;

    try {
      materializedPath = await this.writeMaterializedArtifact({
        id: artifactId,
        original_name: input.name,
        storage_path: objectPath,
        size: input.size,
        sha256: input.digest,
      });
      const insert = this.database.sqlite.transaction(() => {
        this.database.sqlite.prepare(`
          insert into artifacts (
            id, client_id, workspace_id, original_name, mime_type,
            size, sha256, storage_path, source, status,
            created_at, expires_at, pinned, last_used_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?)
        `).run(
          artifactId,
          input.clientId,
          input.workspaceId ?? null,
          input.name,
          input.mimeType ?? null,
          input.size,
          input.digest,
          objectPath,
          input.source,
          now.toISOString(),
          expiresAt,
          input.pinned ? 1 : 0,
          now.toISOString(),
        );
        input.afterInsert?.();
      });
      insert.immediate();
    } catch (error) {
      if (materializedPath) {
        await this.removeMaterializedPath(artifactId, input.name).catch(() => undefined);
      }
      if (createdObject) {
        await unlink(objectPath).catch(() => undefined);
      }
      throw error;
    }

    return {
      artifactId,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      sha256: `sha256:${input.digest}`,
      hostPath: materializedPath!,
      source: input.source,
      workspaceId: input.workspaceId,
      createdAt: now.toISOString(),
      expiresAt,
      pinned: input.pinned,
    };
  }

  private async ensureMaterializedArtifact(row: ArtifactRow): Promise<string> {
    return this.writeMaterializedArtifact(row);
  }

  private async writeMaterializedArtifact(row: Pick<
    ArtifactRow,
    "id" | "original_name" | "storage_path" | "size" | "sha256"
  >): Promise<string> {
    await assertExistingFileContained(row.storage_path, this.objectsRoot, this.rootRealPath);
    const directory = join(this.materializedRoot, row.id);
    assertLexicalContainment(this.materializedRoot, directory);
    await ensureSecureDirectory(directory, this.rootRealPath);
    const outputPath = join(directory, row.original_name);
    assertLexicalContainment(this.materializedRoot, outputPath);

    const existing = await lstatOrUndefined(outputPath);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new ArtifactError(
          "unsafe_materialized_artifact",
          "Materialized artifact path is not a regular file.",
        );
      }
      await assertExistingFileContained(outputPath, this.materializedRoot, this.rootRealPath);
      if (existing.size === row.size && await hashFile(outputPath) === row.sha256) {
        await chmod(outputPath, 0o600);
        return outputPath;
      }
      await unlink(outputPath);
    }

    const tempPath = join(directory, `.materialize-${randomUUID()}.partial`);
    try {
      await copyFile(
        row.storage_path,
        tempPath,
        fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
      );
      await chmod(tempPath, 0o600);
      const copied = await assertExistingFileContained(
        tempPath,
        this.materializedRoot,
        this.rootRealPath,
      );
      if (copied.size !== row.size || await hashFile(tempPath) !== row.sha256) {
        throw new ArtifactError(
          "materialized_artifact_integrity_failed",
          "Materialized artifact failed size or SHA-256 verification.",
        );
      }
      await rename(tempPath, outputPath);
      await chmod(outputPath, 0o600);
      return outputPath;
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async removeMaterializedArtifact(row: ArtifactRow): Promise<void> {
    await this.removeMaterializedPath(row.id, row.original_name);
  }

  private async removeMaterializedPath(artifactId: string, name: string): Promise<void> {
    const directory = join(this.materializedRoot, artifactId);
    const outputPath = join(directory, name);
    assertLexicalContainment(this.materializedRoot, directory);
    assertLexicalContainment(this.materializedRoot, outputPath);

    const directoryEntry = await lstatOrUndefined(directory);
    if (!directoryEntry) return;
    if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
      throw new ArtifactError(
        "unsafe_materialized_artifact",
        "Materialized artifact directory is not a real directory.",
      );
    }
    assertRealContainment(this.rootRealPath, await realpath(directory));

    const output = await lstatOrUndefined(outputPath);
    if (output) {
      if (!output.isFile() && !output.isSymbolicLink()) {
        throw new ArtifactError(
          "unsafe_materialized_artifact",
          "Refusing to remove a non-file materialized artifact path.",
        );
      }
      await unlink(outputPath);
    }
    await rmdir(directory);
  }

  private requireUpload(clientId: string, uploadId: string): UploadRow {
    const row = this.database.sqlite.prepare(
      "select * from artifact_uploads where id = ? and client_id = ?",
    ).get(uploadId, clientId) as UploadRow | undefined;
    if (!row) {
      throw new ArtifactError("upload_not_found", "Artifact upload was not found.");
    }
    return row;
  }

  private requireArtifact(clientId: string, artifactId: string): ArtifactRow {
    const row = this.database.sqlite.prepare(
      "select * from artifacts where id = ? and client_id = ?",
    ).get(artifactId, clientId) as ArtifactRow | undefined;
    if (!row) {
      throw new ArtifactError("artifact_not_found", "Artifact was not found.");
    }
    return row;
  }

  private requireAvailableArtifact(clientId: string, artifactId: string): ArtifactRow {
    const row = this.requireArtifact(clientId, artifactId);
    if (row.status !== "available") {
      throw new ArtifactError("artifact_unavailable", "Artifact is not available.");
    }
    return row;
  }

  private assertUploadActive(row: UploadRow): void {
    if (row.status !== "active") {
      throw new ArtifactError("upload_inactive", "Artifact upload is not active.");
    }
  }

  private assertUploadNotExpired(row: UploadRow): void {
    if (row.expires_at <= this.now().toISOString()) {
      throw new ArtifactError("upload_expired", "Artifact upload has expired.");
    }
  }

  private assertQuotaAvailable(additionalBytes: number): void {
    const used = this.objectBytes() + this.pendingUploadBytes();
    if (used + additionalBytes > this.config.artifactMaxTotalBytes) {
      throw new ArtifactError(
        "artifact_quota_exceeded",
        `Artifact storage would exceed the ${this.config.artifactMaxTotalBytes}-byte total limit.`,
      );
    }
  }

  private objectBytes(): number {
    return Number(
      this.database.sqlite.prepare(`
        select coalesce(sum(size), 0)
        from (
          select storage_path, max(size) as size
          from artifacts
          where status = 'available'
          group by storage_path
        )
      `).pluck().get() ?? 0,
    );
  }

  private pendingUploadBytes(): number {
    return Number(
      this.database.sqlite.prepare(`
        select coalesce(sum(received_size), 0)
        from artifact_uploads
        where status = 'active'
      `).pluck().get() ?? 0,
    );
  }

  private async uploadDigest(row: UploadRow): Promise<string> {
    const state = this.incrementalHashes.get(row.id);
    if (state && state.receivedSize === row.received_size) {
      return state.hash.copy().digest("hex");
    }
    return hashFile(row.temp_path);
  }

  private async deleteObjectIfUnreferenced(row: ArtifactRow): Promise<boolean> {
    const referenceCount = Number(
      this.database.sqlite.prepare(`
        select count(*) from artifacts
        where status = 'available' and storage_path = ?
      `).pluck().get(row.storage_path) ?? 0,
    );
    if (referenceCount > 0) return false;
    await removeManagedFile(row.storage_path, this.objectsRoot, this.rootRealPath);
    return true;
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function normalizeArtifactFilename(value: string): string {
  if (typeof value !== "string") {
    throw new ArtifactError("invalid_filename", "Artifact filename must be a string.");
  }
  const normalized = value.normalize("NFC");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new ArtifactError("invalid_filename", "Artifact filename is empty or reserved.");
  }
  if (normalized.startsWith(".")) {
    throw new ArtifactError("invalid_filename", "Artifact filename must not start with a dot.");
  }
  if (/[\\/]/u.test(normalized) || basename(normalized) !== normalized) {
    throw new ArtifactError("invalid_filename", "Artifact filename must contain one basename only.");
  }
  if(/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new ArtifactError("invalid_filename", "Artifact filename contains control characters.");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_FILENAME_BYTES) {
    throw new ArtifactError(
      "invalid_filename",
      `Artifact filename exceeds ${MAX_FILENAME_BYTES} UTF-8 bytes.`,
    );
  }
  return normalized;
}

function normalizeArtifactSource(value: string | undefined): string {
  const source = value ?? "chunked";
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/u.test(source)) {
    throw new ArtifactError(
      "invalid_artifact_source",
      "Artifact source must be a short lowercase identifier.",
    );
  }
  return source;
}

export function normalizeSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/^sha256:/u, "");
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new ArtifactError("invalid_sha256", "SHA-256 must contain exactly 64 hexadecimal characters.");
  }
  return normalized;
}

export function decodeBase64Strict(value: string): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ArtifactError("invalid_base64", "Chunk data is not valid canonical base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new ArtifactError("invalid_base64", "Chunk data is not valid canonical base64.");
  }
  return decoded;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$/u, "")} ${units[unit]}`;
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const mimeType = value?.trim();
  if (!mimeType) return undefined;
  if (mimeType.length > 255 || /[\u0000-\u001f\u007f]/u.test(mimeType)) {
    throw new ArtifactError("invalid_mime_type", "Artifact MIME type is invalid.");
  }
  return mimeType;
}

function normalizeExpectedSize(value: number | undefined, maxFileBytes: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactError("invalid_size", "Artifact size must be a non-negative safe integer.");
  }
  if (value > maxFileBytes) {
    throw new ArtifactError("file_too_large", `Artifact exceeds the ${maxFileBytes}-byte file limit.`);
  }
  return value;
}

function normalizeTtlHours(value: number | undefined, fallback: number): number {
  const ttlHours = value ?? fallback;
  if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
    throw new ArtifactError(
      "invalid_ttl",
      `Artifact TTL must be an integer between 1 and ${MAX_TTL_HOURS} hours.`,
    );
  }
  return ttlHours;
}

function artifactRowToRecord(row: ArtifactRow, hostPath: string): ArtifactRecord {
  return {
    artifactId: row.id,
    name: row.original_name,
    mimeType: row.mime_type ?? undefined,
    size: row.size,
    sha256: `sha256:${row.sha256}`,
    hostPath,
    source: row.source,
    workspaceId: row.workspace_id ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    pinned: row.pinned === 1,
  };
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1_000);
}

function ensureSecureDirectorySync(path: string, containingRootRealPath?: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ArtifactError("unsafe_artifact_root", `Artifact directory is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
  const realPath = realpathSync(path);
  if (containingRootRealPath) assertRealContainment(containingRootRealPath, realPath);
  return realPath;
}

async function ensureSecureDirectory(path: string, rootRealPath: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ArtifactError("unsafe_artifact_path", `Artifact directory is not a real directory: ${path}`);
  }
  await chmod(path, 0o700);
  assertRealContainment(rootRealPath, await realpath(path));
}

async function assertExistingFileContained(
  path: string,
  lexicalRoot: string,
  rootRealPath: string,
) {
  assertLexicalContainment(lexicalRoot, path);
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ArtifactError("unsafe_artifact_path", "Artifact path is not a regular file.");
  }
  assertRealContainment(rootRealPath, await realpath(path));
  return entry;
}

async function removeManagedFile(
  path: string,
  lexicalRoot: string,
  rootRealPath: string,
): Promise<void> {
  assertLexicalContainment(lexicalRoot, path);
  const entry = await lstatOrUndefined(path);
  if (!entry) return;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ArtifactError("unsafe_artifact_path", "Refusing to delete a non-regular artifact path.");
  }
  assertRealContainment(rootRealPath, await realpath(path));
  await unlink(path);
}

function assertLexicalContainment(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ArtifactError("artifact_path_escape", "Artifact path escapes the configured storage root.");
  }
}

function assertRealContainment(rootRealPath: string, candidateRealPath: string): void {
  const relativePath = relative(rootRealPath, candidateRealPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ArtifactError("artifact_path_escape", "Artifact path resolves outside the configured storage root.");
  }
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function hashFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function sameFileIdentity(
  left: ArtifactFileIdentity,
  right: ArtifactFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new ArtifactError("short_write", "The artifact file was not fully written.");
    }
    offset += bytesWritten;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
