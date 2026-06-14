import { resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  authToken?: string;
  allowedRoots: string[];
  allowedHosts: string[];
}

function parsePort(value: string | undefined): number {
  if (!value) return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | undefined): string[] {
  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(root));
}

function parseAllowedHosts(value: string | undefined): string[] {
  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return rawHosts.length > 0 ? rawHosts : ["localhost", "127.0.0.1"];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePort(env.PORT),
    authToken: env.PI_ON_MCP_TOKEN,
    allowedRoots: parseAllowedRoots(env.PI_ON_MCP_ALLOWED_ROOTS),
    allowedHosts: parseAllowedHosts(env.PI_ON_MCP_ALLOWED_HOSTS),
  };
}
