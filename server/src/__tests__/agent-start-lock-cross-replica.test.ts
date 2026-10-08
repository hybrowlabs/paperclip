import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * (e) The agent-start lock must hold across replicas.
 *
 * Two heartbeat services (two connection pools, as two server pods would
 * have) race to start queued runs for agents limited to one concurrent run.
 * The in-memory start lock cannot see the other pool, so before the advisory
 * lock both replicas counted zero running runs and each claimed a different
 * queued run, overrunning maxConcurrentRuns.
 */

const execution = vi.hoisted(() => ({
  started: new Map<string, number>(),
  active: new Map<string, number>(),
  maxActive: new Map<string, number>(),
  gate: null as Promise<void> | null,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: async (ctx: { agent: { id: string } }) => {
        const agentId = ctx.agent.id;
        execution.started.set(agentId, (execution.started.get(agentId) ?? 0) + 1);
        const active = (execution.active.get(agentId) ?? 0) + 1;
        execution.active.set(agentId, active);
        execution.maxActive.set(agentId, Math.max(execution.maxActive.get(agentId) ?? 0, active));
        try {
          await execution.gate;
        } finally {
          execution.active.set(agentId, (execution.active.get(agentId) ?? 1) - 1);
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "cross-replica start lock test",
          provider: "test",
          model: "test-model",
        };
      },
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent start lock across replicas", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dbA!: ReturnType<typeof createDb>;
  let dbB!: ReturnType<typeof createDb>;
  let replicaA!: ReturnType<typeof heartbeatService>;
  let replicaB!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-start-lock-cross-replica-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
    replicaA = heartbeatService(dbA);
    // A second pod has its own copy of every module-level singleton, including
    // the in-memory agent-start lock. A fresh module graph reproduces that;
    // two services built from the same graph would share the lock and hide
    // the cross-replica race.
    vi.resetModules();
    const secondGraph = await import("../services/heartbeat.ts");
    replicaB = secondGraph.heartbeatService(dbB);
  }, 60_000);

  afterEach(async () => {
    await Promise.all([replicaA.drainActiveRunExecutions(), replicaB.drainActiveRunExecutions()]);
    runningProcesses.clear();
    execution.started.clear();
    execution.active.clear();
    execution.maxActive.clear();
    execution.gate = null;
    await dbA.execute(sql`truncate table ${companies} cascade`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedAgentWithQueuedRuns(queuedCount: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await dbA.insert(companies).values({
      id: companyId,
      name: "Start Lock Co",
      status: "active",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await dbA.insert(agents).values({
      id: agentId,
      companyId,
      name: "Start Lock Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    for (let index = 0; index < queuedCount; index += 1) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      await dbA.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        runId,
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        payload: { manualUserWake: true },
      });
      await dbA.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId,
        createdAt: new Date(Date.now() - 60_000 + index),
      });
    }
    return { companyId, agentId };
  }

  it("never runs more than maxConcurrentRuns for an agent when two replicas start runs at once", async () => {
    let release!: () => void;
    execution.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const seeded = [];
    for (let index = 0; index < 8; index += 1) seeded.push(await seedAgentWithQueuedRuns(2));

    try {
      await Promise.all([replicaA.resumeQueuedRuns(), replicaB.resumeQueuedRuns()]);
      const deadline = Date.now() + 30_000;
      while (seeded.some(({ agentId }) => (execution.started.get(agentId) ?? 0) < 1) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      for (const { agentId } of seeded) {
        expect(execution.started.get(agentId) ?? 0).toBe(1);
        expect(execution.maxActive.get(agentId) ?? 0).toBe(1);
      }
      const running = await dbA
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} = 'running'`);
      const perAgent = new Map<string, number>();
      for (const row of running) perAgent.set(row.agentId, (perAgent.get(row.agentId) ?? 0) + 1);
      for (const { agentId } of seeded) expect(perAgent.get(agentId) ?? 0).toBeLessThanOrEqual(1);

    } finally {
      release();
    }
    await Promise.all([replicaA.drainActiveRunExecutions(), replicaB.drainActiveRunExecutions()]);
  }, 120_000);

  it("a replica that loses the lock skips instead of blocking, and the queue still drains on the next pass", async () => {
    const { agentId } = await seedAgentWithQueuedRuns(2);

    await Promise.all([replicaA.resumeQueuedRuns(), replicaB.resumeQueuedRuns()]);
    await Promise.all([replicaA.drainActiveRunExecutions(), replicaB.drainActiveRunExecutions()]);
    await replicaA.resumeQueuedRuns();
    await Promise.all([replicaA.drainActiveRunExecutions(), replicaB.drainActiveRunExecutions()]);

    expect(execution.started.get(agentId)).toBe(2);
    expect(execution.maxActive.get(agentId)).toBe(1);
    const statuses = await dbA
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.agentId} = ${agentId}`);
    expect(statuses.map((row) => row.status).sort()).toEqual(["succeeded", "succeeded"]);
  }, 120_000);
});
