import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  ArtifactError,
  type ArtifactReadHandle,
  type ArtifactStore,
} from "./artifacts.js";

const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_DOWNLOAD_MIME_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "audio/mpeg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
]);

export interface ArtifactDownloadHandlerOptions {
  store: ArtifactStore;
  resourceServerUrl: URL;
}

export function artifactDownloadUrl(publicBaseUrl: string, artifactId: string): string {
  return `${publicBaseUrl.replace(/\/+$/u, "")}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function safeArtifactDownloadMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && SAFE_DOWNLOAD_MIME_TYPES.has(normalized)
    ? normalized
    : "application/octet-stream";
}

export function artifactContentDisposition(filename: string): string {
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/gu, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function handleArtifactDownload(
  req: Request,
  res: Response,
  { store, resourceServerUrl }: ArtifactDownloadHandlerOptions,
): Promise<void> {
  const auth = req.auth;
  if (
    !auth?.clientId
    || !auth.resource
    || !checkResourceAllowed({
      requestedResource: auth.resource,
      configuredResource: resourceServerUrl,
    })
  ) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const artifactId = req.params.artifactId;
  if (typeof artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(artifactId)) {
    res.status(404).json({ error: "artifact_not_found" });
    return;
  }

  let artifact: ArtifactReadHandle | undefined;
  try {
    artifact = await store.openArtifactReadHandle(auth.clientId, artifactId);
    res.status(200);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", artifactContentDisposition(artifact.name));
    res.setHeader("Content-Length", String(artifact.size));
    res.setHeader("Content-Type", safeArtifactDownloadMimeType(artifact.mimeType));
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    await pipeline(artifact.handle.createReadStream({ autoClose: false }), res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (
      error instanceof ArtifactError
      && ["artifact_not_found", "artifact_unavailable"].includes(error.code)
    ) {
      res.status(404).json({ error: "artifact_not_found" });
      return;
    }
    if (error instanceof ArtifactError) {
      res.status(409).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: "internal_error" });
  } finally {
    await artifact?.handle.close().catch(() => undefined);
  }
}
