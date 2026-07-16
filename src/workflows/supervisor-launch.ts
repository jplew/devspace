import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { filterWorkflowEnvironment } from "./policy.js";
import { WorkflowStore } from "./store.js";

export interface EnsureSupervisorResult {
  requestedWakeGeneration: number;
  spawned: boolean;
  ownerEpoch?: number;
}

export async function ensureSupervisor(input: {
  stateDir: string;
  cliEntrypoint?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}): Promise<EnsureSupervisorResult> {
  const store = new WorkflowStore(input.stateDir);
  try {
    const requestedWakeGeneration = store.requestSupervisorWake();
    const current = store.getSupervisor();
    if (current?.leaseExpiresAt && current.leaseExpiresAt > new Date().toISOString()) {
      if (current.ownerPid !== undefined && !isProcessRunning(current.ownerPid)) {
        store.releaseSupervisor(current);
      } else {
        return {
          requestedWakeGeneration,
          spawned: false,
          ownerEpoch: current.ownerEpoch,
        };
      }
    }

    const cliEntrypoint = input.cliEntrypoint ?? fileURLToPath(new URL("../cli.js", import.meta.url));
    const sourceEnvironment = input.env ?? process.env;
    const environment: NodeJS.ProcessEnv = {
      ...filterWorkflowEnvironment(sourceEnvironment),
      DEVSPACE_STATE_DIR: input.stateDir,
    };
    for (const key of [
      "DEVSPACE_WORKFLOW_FAKE_PROVIDER",
      "DEVSPACE_WORKFLOW_FAKE_BEHAVIOR",
      "DEVSPACE_WORKFLOW_FAKE_DELAY_MS",
    ]) {
      if (sourceEnvironment[key]) environment[key] = sourceEnvironment[key];
    }

    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        cliEntrypoint,
        "workflows",
        "__supervisor",
        "--state-dir",
        input.stateDir,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: environment,
        shell: false,
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();

    const deadline = Date.now() + (input.startupTimeoutMs ?? 2_000);
    while (Date.now() < deadline) {
      const supervisor = store.getSupervisor();
      if (supervisor?.leaseExpiresAt && supervisor.leaseExpiresAt > new Date().toISOString()) {
        return {
          requestedWakeGeneration,
          spawned: true,
          ownerEpoch: supervisor.ownerEpoch,
        };
      }
      await delay(20);
    }
    throw new Error("Workflow supervisor did not acquire its durable lease.");
  } finally {
    store.close();
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
