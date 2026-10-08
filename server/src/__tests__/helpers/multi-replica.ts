import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRET = "multi-replica-test-secret-0123456789abcdef";

export type Replica = {
  name: string;
  port: number;
  baseUrl: string;
  home: string;
  env: Record<string, string>;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  logs: () => string;
};

export type ReplicaOptions = {
  name: string;
  databaseUrl: string;
  env?: Record<string, string>;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export async function spawnReplica(options: ReplicaOptions): Promise<Replica> {
  const port = await freePort();
  const home = await mkdtemp(path.join(tmpdir(), `paperclip-replica-${options.name}-`));
  const env: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )),
    NODE_ENV: "development",
    PORT: String(port),
    PAPERCLIP_HOME: home,
    PAPERCLIP_INSTANCE_ID: `replica-${options.name}`,
    DATABASE_URL: options.databaseUrl,
    PAPERCLIP_BIND: "loopback",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_DB_BACKUP_DIR: path.join(home, "backups"),
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    PAPERCLIP_STORAGE_PROVIDER: "local_disk",
    PAPERCLIP_STORAGE_LOCAL_DIR: path.join(home, "storage"),
    PAPERCLIP_SECRETS_PROVIDER: "local_encrypted",
    SERVE_UI: "false",
    PAPERCLIP_AGENT_JWT_SECRET: SECRET,
    BETTER_AUTH_SECRET: SECRET,
    PAPERCLIP_DECISION_SIGNING_SECRET: SECRET,
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: SECRET,
    LOG_LEVEL: "info",
    ...options.env,
  };

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  const keep = (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
    if (chunks.length > 4000) chunks.splice(0, chunks.length - 2000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    name: options.name,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    home,
    env,
    child,
    exited,
    logs: () => chunks.join(""),
  };
}

export async function waitUntil<T>(
  describe: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  { timeoutMs = 60_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${describe}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

export async function getJson<T = any>(replica: Replica, pathname: string): Promise<T> {
  const res = await fetch(`${replica.baseUrl}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} on ${replica.name} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function sendJson(
  replica: Replica,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${replica.baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", origin: replica.baseUrl },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

export async function waitForReady(replica: Replica, timeoutMs = 240_000) {
  const earlyExit = replica.exited.then((result) => {
    throw new Error(
      `replica ${replica.name} exited during boot (${JSON.stringify(result)}). Last logs:\n${replica.logs().slice(-4000)}`,
    );
  });
  await Promise.race([
    waitUntil(
      `replica ${replica.name} /api/health ok`,
      async () => {
        const res = await fetch(`${replica.baseUrl}/api/health`).catch(() => null);
        if (!res || !res.ok) return false;
        const body = (await res.json()) as { status?: string };
        return body.status === "ok";
      },
      { timeoutMs, intervalMs: 500 },
    ),
    earlyExit,
  ]);
}

export async function stopReplica(replica: Replica, signal: "SIGTERM" | "SIGKILL") {
  if (replica.child.exitCode !== null || replica.child.signalCode !== null) return;
  replica.child.kill(signal);
  await Promise.race([
    replica.exited,
    new Promise((resolve) => setTimeout(resolve, 60_000)),
  ]);
  if (replica.child.exitCode === null && replica.child.signalCode === null) {
    replica.child.kill("SIGKILL");
    await replica.exited;
  }
}

export async function disposeReplica(replica: Replica) {
  await stopReplica(replica, "SIGKILL");
  await rm(replica.home, { recursive: true, force: true }).catch(() => {});
}

export function replicaRunning(replica: Replica) {
  return replica.child.exitCode === null && replica.child.signalCode === null;
}
