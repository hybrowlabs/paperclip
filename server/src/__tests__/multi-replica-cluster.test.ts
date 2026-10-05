import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { sql } from "drizzle-orm";
import { createDb, ensurePostgresDatabase } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  disposeReplica,
  getJson,
  replicaRunning,
  sendJson,
  spawnReplica,
  stopReplica,
  waitForReady,
  waitUntil,
  type Replica,
} from "./helpers/multi-replica.js";

/**
 * Multi-replica acceptance suite (Hybrow scale-out, Phase A).
 *
 * Every test boots two or more REAL server processes against ONE real
 * Postgres and asserts cross-replica behaviour through their public HTTP,
 * WebSocket and SQL surfaces. Nothing in here mocks the database or the
 * coordination layer.
 *
 * Acceptance map (HYBA-1317):
 *   (a) one scheduler leader, failover on graceful stop and on crash
 *   (b) event published on replica A reaches a WebSocket client on replica B
 *   (c) concurrent boot applies migrations exactly once
 *   (d) backups do not run twice (plugin jobs: plugin-job-scheduler-claim.test.ts)
 *   (e) agent-start lock across replicas: agent-start-lock-cross-replica.test.ts
 */

const support = await getEmbeddedPostgresTestSupport();
const describeCluster = support.supported ? describe : describe.skip;

// Pinned on purpose: replicas on different versions must agree on the lock
// keyspace during a rolling deploy, so this value must never change.
const PAPERCLIP_LOCK_NAMESPACE = 0x70_63_6c_70;

type HealthBody = {
  status: string;
  scheduler?: { candidate: boolean; isLeader: boolean; leader?: { leaderId: string } };
};

async function queryRows<T = Record<string, unknown>>(databaseUrl: string, statement: ReturnType<typeof sql>) {
  const db = createDb(databaseUrl);
  try {
    return (await db.execute(statement)) as unknown as T[];
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function schedulerState(replica: Replica) {
  if (!replicaRunning(replica)) return null;
  const body = await getJson<HealthBody>(replica, "/api/health").catch(() => null);
  return body?.scheduler ?? null;
}

async function leaders(replicas: Replica[]) {
  const states = await Promise.all(replicas.map(async (replica) => ({ replica, state: await schedulerState(replica) })));
  return states.filter((entry) => entry.state?.isLeader === true).map((entry) => entry.replica);
}

describeCluster("multi-replica cluster (real processes, one Postgres)", () => {
  let cluster: EmbeddedPostgresTestDatabase | null = null;
  let adminUrl = "";
  const replicas: Replica[] = [];

  async function freshDatabase(name: string) {
    await ensurePostgresDatabase(adminUrl, name);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return url.toString();
  }

  async function boot(databaseUrl: string, name: string, env: Record<string, string> = {}) {
    const replica = await spawnReplica({ name, databaseUrl, env });
    replicas.push(replica);
    return replica;
  }

  beforeAll(async () => {
    cluster = await startEmbeddedPostgresTestDatabase("paperclip-multi-replica-");
    const url = new URL(cluster.connectionString);
    url.pathname = "/postgres";
    adminUrl = url.toString();
  }, 120_000);

  afterEach(async () => {
    await Promise.all(replicas.splice(0).map((replica) => disposeReplica(replica)));
  }, 120_000);

  afterAll(async () => {
    await cluster?.cleanup();
  }, 120_000);

  describe("(a) scheduler leader election", () => {
    it("elects exactly one leader among three replicas and fails over on graceful stop and on crash", async () => {
      const databaseUrl = await freshDatabase("leader_election");
      const first = await boot(databaseUrl, "a");
      await waitForReady(first);
      const second = await boot(databaseUrl, "b");
      const third = await boot(databaseUrl, "c");
      await Promise.all([waitForReady(second), waitForReady(third)]);
      const all = [first, second, third];

      await waitUntil("exactly one scheduler leader", async () => (await leaders(all)).length === 1);
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      const initial = await leaders(all);
      expect(initial).toHaveLength(1);

      const rows = await queryRows(databaseUrl, sql`SELECT leader_id FROM scheduler_leader`);
      expect(rows).toHaveLength(1);

      const gracefulVictim = initial[0]!;
      await stopReplica(gracefulVictim, "SIGTERM");
      const survivors = all.filter((replica) => replica !== gracefulVictim);
      const afterGraceful = await waitUntil(
        "a surviving replica to take over after graceful stop",
        async () => {
          const current = await leaders(survivors);
          return current.length === 1 ? current[0] : null;
        },
        { timeoutMs: 30_000 },
      );

      const crashed = afterGraceful;
      await stopReplica(crashed, "SIGKILL");
      const lastSurvivor = survivors.filter((replica) => replica !== crashed);
      await waitUntil(
        "the last replica to take over after a crash (lease expiry)",
        async () => (await leaders(lastSurvivor)).length === 1,
        { timeoutMs: 60_000 },
      );
    }, 420_000);

    it("a single replica becomes leader on its own (single-replica behaviour unchanged)", async () => {
      const databaseUrl = await freshDatabase("leader_single");
      const only = await boot(databaseUrl, "solo");
      await waitForReady(only);
      await waitUntil("the lone replica to become leader", async () => (await leaders([only])).length === 1, {
        timeoutMs: 30_000,
      });
    }, 300_000);

    it("HEARTBEAT_SCHEDULER_ENABLED=false serves traffic but never becomes leader", async () => {
      const databaseUrl = await freshDatabase("leader_optout");
      const trafficOnly = await boot(databaseUrl, "traffic", { HEARTBEAT_SCHEDULER_ENABLED: "false" });
      await waitForReady(trafficOnly);
      const candidate = await boot(databaseUrl, "candidate");
      await waitForReady(candidate);

      await waitUntil("the enabled replica to become leader", async () => (await leaders([candidate])).length === 1, {
        timeoutMs: 30_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      const state = await schedulerState(trafficOnly);
      expect(state).toEqual(expect.objectContaining({ candidate: false, isLeader: false }));
      expect(await leaders([trafficOnly, candidate])).toEqual([candidate]);

      await stopReplica(candidate, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      expect(await leaders([trafficOnly])).toHaveLength(0);
    }, 300_000);
  });

  describe("(b) live events across replicas", () => {
    it("delivers an event published on replica A to a WebSocket client on replica B", async () => {
      const databaseUrl = await freshDatabase("live_events");
      const a = await boot(databaseUrl, "a");
      await waitForReady(a);
      const b = await boot(databaseUrl, "b");
      await waitForReady(b);

      const created = await sendJson(a, "POST", "/api/companies", { name: `Replica Co ${randomUUID().slice(0, 8)}` });
      expect(created.status).toBe(201);
      const companyId = created.json.id as string;

      const received: Array<{ type: string; companyId: string; payload: Record<string, unknown> }> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${b.port}/api/companies/${companyId}/events/ws`);
      socket.on("message", (data) => {
        try {
          received.push(JSON.parse(data.toString()));
        } catch {
          // ignore non-JSON frames
        }
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });

      try {
        await waitUntil(
          "an activity event published on replica A to arrive on replica B's socket",
          async () => {
            const patched = await sendJson(a, "PATCH", `/api/companies/${companyId}`, {
              description: `cross-replica ${randomUUID()}`,
            });
            if (patched.status >= 400) throw new Error(`PATCH failed: ${patched.status}`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            return received.find((event) => event.companyId === companyId && event.type === "activity.logged");
          },
          { timeoutMs: 30_000, intervalMs: 500 },
        );
      } finally {
        socket.close();
      }
    }, 300_000);
  });

  describe("(c) concurrent boot", () => {
    it("applies migrations exactly once when three replicas boot together against an empty database", async () => {
      const databaseUrl = await freshDatabase("concurrent_boot");
      const booted = await Promise.all([boot(databaseUrl, "a"), boot(databaseUrl, "b"), boot(databaseUrl, "c")]);
      await Promise.all(booted.map((replica) => waitForReady(replica, 300_000)));

      const duplicates = await queryRows(
        databaseUrl,
        sql`SELECT hash, count(*)::int AS n FROM drizzle.__drizzle_migrations GROUP BY hash HAVING count(*) > 1`,
      );
      expect(duplicates).toHaveLength(0);
      const [counts] = await queryRows<{ total: number; distinct: number }>(
        databaseUrl,
        sql`SELECT count(*)::int AS total, count(DISTINCT hash)::int AS distinct FROM drizzle.__drizzle_migrations`,
      );
      expect(counts!.total).toBe(counts!.distinct);
      expect(counts!.total).toBeGreaterThan(200);

      for (const replica of booted) {
        expect(replicaRunning(replica)).toBe(true);
        expect(replica.logs()).not.toMatch(/Paperclip server failed to start/);
      }
    }, 600_000);
  });

  describe("(d) backups do not run twice", () => {
    it("refuses a backup while another replica holds the cluster-wide backup lock, and runs it once the lock is free", async () => {
      const databaseUrl = await freshDatabase("backup_lock");
      const a = await boot(databaseUrl, "a");
      await waitForReady(a);
      const b = await boot(databaseUrl, "b");
      await waitForReady(b);

      // An open transaction holding the advisory lock is what another replica's
      // in-flight backup looks like to Postgres (xact and session advisory locks
      // share one keyspace).
      const holderDb = createDb(databaseUrl);
      let releaseHolder!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => {
        holderAcquired = resolve;
      });
      const holder = holderDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PAPERCLIP_LOCK_NAMESPACE}, hashtext('database-backup'))`);
        holderAcquired();
        await hold;
      });
      try {
        await acquired;

        const blocked = await sendJson(a, "POST", "/api/instance/database-backups");
        expect(blocked.status).toBe(409);

        const backupDir = a.env.PAPERCLIP_DB_BACKUP_DIR!;
        await mkdir(backupDir, { recursive: true });
        const duringLock = (await readdir(backupDir)).filter((name) => name.endsWith(".sql") || name.endsWith(".sql.gz"));
        expect(duringLock).toHaveLength(0);
      } finally {
        releaseHolder();
        await holder;
        await holderDb.$client.end({ timeout: 5 });
      }

      const allowed = await sendJson(b, "POST", "/api/instance/database-backups");
      expect(allowed.status).toBe(201);
      const backupDir = b.env.PAPERCLIP_DB_BACKUP_DIR!;
      const files = (await readdir(path.resolve(backupDir))).filter((name) => name.endsWith(".sql") || name.endsWith(".sql.gz"));
      expect(files).toHaveLength(1);
    }, 400_000);
  });
});
