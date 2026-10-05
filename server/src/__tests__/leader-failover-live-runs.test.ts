import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * Review finding M2 (HYBA-1317): a replica that becomes scheduler leader
 * replays startup recovery (native restart recovery + a zero-threshold orphan
 * reap). That must never take over a run that is still alive on another
 * replica. Two heartbeat services from two module graphs stand in for two
 * pods: each has its own controller boot id, in-memory run tables and pool.
 */

const execution = vi.hoisted(() => ({
  started: new Set<string>(),
  gate: null as Promise<void> | null,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: async (ctx: { agent: { id: string } }) => {
        execution.started.add(ctx.agent.id);
        await execution.gate;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "live on replica A",
          provider: "test",
          model: "test-model",
        };
      },
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("leader failover keeps runs that are alive on another replica", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dbA!: ReturnType<typeof createDb>;
  let dbB!: ReturnType<typeof createDb>;
  let replicaA!: ReturnType<typeof heartbeatService>;
  let replicaB!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("leader-failover-live-runs-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
    replicaA = heartbeatService(dbA);
    vi.resetModules();
    const secondGraph = await import("../services/heartbeat.ts");
    replicaB = secondGraph.heartbeatService(dbB);
  }, 60_000);

  afterEach(async () => {
    await Promise.all([replicaA.drainActiveRunExecutions(), replicaB.drainActiveRunExecutions()]);
    runningProcesses.clear();
    execution.started.clear();
    execution.gate = null;
    await dbA.execute(sql`truncate table ${companies} cascade`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await dbA.insert(companies).values({
      id: companyId,
      name: "Failover Co",
      status: "active",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await dbA.insert(agents).values({
      id: agentId,
      companyId,
      name: "Failover Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
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
      createdAt: new Date(Date.now() - 60_000),
    });
    return { agentId, runId };
  }

  async function runStatus(runId: string) {
    const [row] = await dbA.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(sql`${heartbeatRuns.id} = ${runId}`);
    return row?.status;
  }

  async function startOnReplicaA() {
    let release!: () => void;
    execution.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seeded = await seedQueuedRun();
    await replicaA.resumeQueuedRuns();
    const deadline = Date.now() + 30_000;
    while (!execution.started.has(seeded.agentId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(execution.started.has(seeded.agentId)).toBe(true);
    expect(await runStatus(seeded.runId)).toBe("running");
    return { ...seeded, release };
  }

  it("a new leader's startup recovery does not reap or fail a legacy run whose lease replica A still holds", async () => {
    const { runId, release } = await startOnReplicaA();
    try {
      await replicaB.recoverNativeRunsAfterRestart();
      const reaped = await replicaB.reapOrphanedRuns();
      expect(reaped).toEqual({ reaped: 0, runIds: [] });
      expect(await runStatus(runId)).toBe("running");
    } finally {
      release();
    }
  }, 120_000);

  it("takes the run over only after replica A's lease has expired (A crashed)", async () => {
    const { runId, release } = await startOnReplicaA();
    try {
      await dbA.execute(
        sql`update heartbeat_runs set controller_lease_expires_at = clock_timestamp() - interval '1 second' where id = ${runId}`,
      );
      const reaped = await replicaB.reapOrphanedRuns();
      expect(reaped.runIds).toContain(runId);
      expect(await runStatus(runId)).not.toBe("running");
    } finally {
      release();
    }
  }, 120_000);

  describe("native runner runs (PAPERCLIP_MULTI_REPLICA=true fences takeover on the controller lease)", () => {
    const FOREIGN_BOOT_ID = "replica-a-boot-id";

    async function seedNativeRunHeldByAnotherReplica(leaseExpiresInMs: number) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const issueId = randomUUID();
      const wakeupRequestId = randomUUID();
      const prefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await dbA.insert(companies).values({
        id: companyId,
        name: "Native Failover Co",
        status: "active",
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });
      await dbA.insert(agents).values({
        id: agentId,
        companyId,
        name: "Native Agent",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await dbA.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "claimed",
        runId,
        claimedAt: new Date(),
      });
      await dbA.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId,
        contextSnapshot: { issueId },
        processPid: 2_000_000_000,
        runtimeMode: "native",
        nativeIssueId: issueId,
        nativePhase: "observed",
        nextEventSeq: 2,
        startedAt: new Date(),
      });
      await dbA.insert(issues).values({
        id: issueId,
        companyId,
        title: "Native run owned by replica A",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      });
      await dbA.insert(nativeRunFinalizations).values({
        runId,
        companyId,
        issueId,
        phase: "observed",
        attempt: 1,
        leaseOwner: `${FOREIGN_BOOT_ID}:1:owner`,
        leaseExpiresAt: new Date(Date.now() + leaseExpiresInMs),
        controllerBootId: FOREIGN_BOOT_ID,
        controllerPid: 2_000_000_001,
        controllerProcessStartedAt: new Date(Date.now() - 3_600_000),
        controllerGeneration: 1,
      });
      return { runId, issueId };
    }

    async function nativeState(runId: string) {
      const [run] = await dbA
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.id} = ${runId}`);
      const [coordinator] = await dbA
        .select({
          controllerBootId: nativeRunFinalizations.controllerBootId,
          recoveryState: nativeRunFinalizations.recoveryState,
          leaseOwner: nativeRunFinalizations.leaseOwner,
        })
        .from(nativeRunFinalizations)
        .where(sql`${nativeRunFinalizations.runId} = ${runId}`);
      return { run, coordinator };
    }

    it("a new leader neither claims nor reaps a native run whose controller lease is live on another replica", async () => {
      process.env.PAPERCLIP_MULTI_REPLICA = "true";
      try {
        const { runId } = await seedNativeRunHeldByAnotherReplica(15 * 60_000);
        const recovery = await replicaB.recoverNativeRunsAfterRestart();
        expect(recovery.claims).toEqual([]);
        const reaped = await replicaB.reapOrphanedRuns();
        expect(reaped.runIds).not.toContain(runId);
        const state = await nativeState(runId);
        expect(state.run?.status).toBe("running");
        expect(state.coordinator?.controllerBootId).toBe(FOREIGN_BOOT_ID);
        expect(state.coordinator?.leaseOwner).toBe(`${FOREIGN_BOOT_ID}:1:owner`);
      } finally {
        delete process.env.PAPERCLIP_MULTI_REPLICA;
      }
    }, 120_000);

    it("replica B shutting down does not suspend a native run that replica A controls", async () => {
      process.env.PAPERCLIP_MULTI_REPLICA = "true";
      try {
        const { runId } = await seedNativeRunHeldByAnotherReplica(15 * 60_000);
        await replicaB.drainRunningRunsForShutdown("SIGTERM");
        const state = await nativeState(runId);
        expect(state.run?.status).toBe("running");
        expect(state.coordinator?.recoveryState).not.toBe("awaiting_runner_reattach");
      } finally {
        delete process.env.PAPERCLIP_MULTI_REPLICA;
      }
    }, 120_000);

    it("takes a native run over once the other replica's lease has expired", async () => {
      process.env.PAPERCLIP_MULTI_REPLICA = "true";
      try {
        const { runId } = await seedNativeRunHeldByAnotherReplica(-5_000);
        const recovery = await replicaB.recoverNativeRunsAfterRestart();
        const touched = recovery.dispositions.map((entry) => entry.runId);
        expect(touched).toContain(runId);
      } finally {
        delete process.env.PAPERCLIP_MULTI_REPLICA;
      }
    }, 120_000);
  });
});
