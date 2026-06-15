import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.close();
} catch (error) {
  if (!isNativeModuleMismatch(error)) {
    throw error;
  }

  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("better-sqlite3 must be rebuilt for this Node version. Run: npm rebuild better-sqlite3");
  }

  console.error("Rebuilding better-sqlite3 for the active Node runtime...");
  execFileSync(process.execPath, [npmCli, "rebuild", "better-sqlite3"], {
    stdio: "inherit",
  });
}

function isNativeModuleMismatch(error) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("NODE_MODULE_VERSION") || error.message.includes("ERR_DLOPEN_FAILED");
}
