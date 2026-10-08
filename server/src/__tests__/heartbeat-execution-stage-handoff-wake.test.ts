import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-stage handoff wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution-stage handoff while the deciding run is still releasing", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-execution-stage-handoff-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts: { makerAdapterConfig?: Record<string, unknown> } = {}) {
    const companyId = randomUUID();
    const stageId = randomUUID();
    const makerAgentId = randomUUID();
    const checkerAgentId = randomUUID();
    const issueId = randomUUID();
    const stoppedRunId = randomUUID();
    const leaseId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: makerAgentId, companyId, name: "Reviewer", role: "engineer", status: "idle",
        adapterType: "process", adapterConfig: opts.makerAdapterConfig ?? {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } }, permissions: {},
      },
      {
        id: checkerAgentId, companyId, name: "Checker", role: "engineer", status: "idle",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
    ]);
    // The first reviewer approved from inside its own run. The route stopped
    // that run, but its environment lease is not released yet.
    await db.insert(heartbeatRuns).values({
      id: stoppedRunId,
      companyId,
      agentId: makerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: "issue_reassigned",
      runtimeMode: "legacy",
      finishedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
      resultJson: {
        executionCancellation: { state: "acknowledged" },
        conversationContinuation: "continue_conversation_v1",
        reassignmentStopConfirmed: true,
      },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested" },
    });
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      heartbeatRunId: stoppedRunId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Two review stages then approval",
      status: "in_review",
      priority: "high",
      assigneeAgentId: checkerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: checkerAgentId },
        returnAssignee: { type: "agent", agentId: makerAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    return { companyId, makerAgentId, checkerAgentId, issueId, issuePrefix, stageId, stoppedRunId, leaseId };
  }

  function stageWake(issueId: string, interruptedRunId: string, stageId: string = randomUUID()) {
    const executionStage = {
      wakeRole: "reviewer",
      stageId,
      stageType: "review",
      allowedActions: ["approve", "request_changes"],
    };
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "execution_review_requested",
      payload: { issueId, mutation: "update", executionStage, interruptedRunId },
      requestedByActorType: "agent" as const,
      requestedByActorId: randomUUID(),
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "execution_review_requested",
        source: "issue.execution_stage",
        executionStage,
        interruptedRunId,
      },
    };
  }

  it("parks the next participant's wake instead of skipping it, then starts it once cleanup finishes", async () => {
    const { companyId, checkerAgentId, issueId, stageId, stoppedRunId, leaseId } = await seed();

    const first = await heartbeat.wakeup(checkerAgentId, stageWake(issueId, stoppedRunId, stageId));
    expect(first).toBeNull();

    const parked = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, checkerAgentId)));
    expect(parked).toHaveLength(1);
    expect(parked[0]!.status).toBe("deferred_issue_execution");
    expect(parked[0]!.reason).toBe("execution_review_requested");
    expect((parked[0]!.payload as Record<string, any>).executionWait).toMatchObject({
      cause: "execution_owner_active",
      recoveryActionId: null,
    });

    // Still held: the sweep must not start the next participant early.
    expect((await heartbeat.resumeExecutionStageWaits({ companyId, issueId })).resumed).toBe(0);

    await db.update(environmentLeases)
      .set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, leaseId));

    expect((await heartbeat.resumeExecutionStageWaits({ companyId, issueId })).resumed).toBe(1);

    const checkerRuns = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, checkerAgentId)));
    expect(checkerRuns).toHaveLength(1);
    expect(checkerRuns[0]!.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "execution_review_requested",
    });

    const [original] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked[0]!.id));
    expect(original!.status).toBe("coalesced");
    expect(original!.runId).toBe(checkerRuns[0]!.id);
  });

  it("drops a parked stage wake when the stage has moved to someone else", async () => {
    const { companyId, checkerAgentId, issueId, stageId, stoppedRunId, leaseId } = await seed();
    await heartbeat.wakeup(checkerAgentId, stageWake(issueId, stoppedRunId, stageId));
    await db.update(issues).set({ assigneeAgentId: null, status: "todo" }).where(eq(issues.id, issueId));
    await db.update(environmentLeases)
      .set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, leaseId));

    expect((await heartbeat.resumeExecutionStageWaits({ companyId, issueId })).resumed).toBe(0);
    const rows = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, checkerAgentId)));
    expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, checkerAgentId));
    expect(runs).toHaveLength(0);
  });

  async function releaseLease(leaseId: string) {
    await db.update(environmentLeases)
      .set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, leaseId));
  }

  async function wakeRows(companyId: string, agentId: string) {
    return db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
  }

  it("drops a parked stage wake when the same assignee is now on a different stage", async () => {
    const { companyId, checkerAgentId, issueId, stageId, stoppedRunId, leaseId } = await seed();
    await heartbeat.wakeup(checkerAgentId, stageWake(issueId, stoppedRunId, stageId));
    // The same agent still owns the issue, but the policy has advanced to a
    // later stage. The parked wake belongs to the old stage and is stale.
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 2,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: checkerAgentId },
        returnAssignee: null,
        completedStageIds: [stageId],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issueId));
    await releaseLease(leaseId);

    expect((await heartbeat.resumeExecutionStageWaits({ companyId, issueId })).resumed).toBe(0);
    expect((await wakeRows(companyId, checkerAgentId)).map((row) => row.status)).toEqual(["cancelled"]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, checkerAgentId));
    expect(runs).toHaveLength(0);
  });

  it("keeps a parked wake whose recovery hold is real, even after the lease is released", async () => {
    const { companyId, checkerAgentId, issueId, stageId, stoppedRunId, leaseId } = await seed();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "execution_reconciliation",
      cause: "uncertain_provider_action",
      fingerprint: `fp-${randomUUID()}`,
      nextAction: "Confirm whether the provider action happened.",
      evidence: { runId: stoppedRunId },
    }).returning();
    const wake = stageWake(issueId, stoppedRunId, stageId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: checkerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      status: "deferred_issue_execution",
      payload: {
        ...wake.payload,
        executionWait: { recoveryActionId: action!.id, cause: "uncertain_provider_action" },
        _paperclipWakeContext: wake.contextSnapshot,
      },
    });
    await releaseLease(leaseId);

    expect((await heartbeat.resumeExecutionStageWaits({ companyId, issueId })).resumed).toBe(0);
    expect((await heartbeat.resumeExecutionStageWaits()).resumed).toBe(0);
    expect((await wakeRows(companyId, checkerAgentId)).map((row) => row.status))
      .toEqual(["deferred_issue_execution"]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, checkerAgentId));
    expect(runs).toHaveLength(0);
  });

  it("does not let 50 older still-blocked parked wakes starve a newer resumable one", async () => {
    const blocked = await seed();
    const ready = await seed();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const wake = stageWake(blocked.issueId, blocked.stoppedRunId, blocked.stageId);
    await db.insert(agentWakeupRequests).values(Array.from({ length: 55 }, (_, index) => ({
      companyId: blocked.companyId,
      agentId: blocked.checkerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      status: "deferred_issue_execution",
      idempotencyKey: `old-${index}-${randomUUID()}`,
      payload: {
        ...wake.payload,
        executionWait: { recoveryActionId: null, cause: "execution_owner_active" },
        _paperclipWakeContext: wake.contextSnapshot,
      },
      requestedAt: new Date(old.getTime() + index),
      updatedAt: new Date(old.getTime() + index),
    })));
    await heartbeat.wakeup(ready.checkerAgentId, stageWake(ready.issueId, ready.stoppedRunId, ready.stageId));
    await releaseLease(ready.leaseId);

    // Unscoped periodic sweep: the blocked issue keeps its lease, so all of
    // its wakes stay parked; the newer issue must still get its run.
    expect((await heartbeat.resumeExecutionStageWaits()).resumed).toBe(1);
    const readyRuns = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, ready.companyId), eq(heartbeatRuns.agentId, ready.checkerAgentId)));
    expect(readyRuns).toHaveLength(1);
    const stillParked = (await wakeRows(blocked.companyId, blocked.checkerAgentId))
      .filter((row) => row.status === "deferred_issue_execution");
    expect(stillParked).toHaveLength(55);
  });

  it("starts the parked next participant from the deciding run's own cleanup, without a sweep", async () => {
    const { companyId, makerAgentId, checkerAgentId, issueId, stageId, leaseId } = await seed({
      makerAdapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 1500)"] },
    });
    await releaseLease(leaseId);
    // The maker is mid-run on the issue when a stage decision hands it on.
    await db.update(issues).set({ assigneeAgentId: makerAgentId, status: "in_progress" }).where(eq(issues.id, issueId));
    const makerRun = await heartbeat.wakeup(makerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });
    expect(makerRun).not.toBeNull();
    for (let i = 0; i < 100; i += 1) {
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, makerRun!.id));
      if (row?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await db.update(issues).set({ assigneeAgentId: checkerAgentId, status: "in_review" }).where(eq(issues.id, issueId));
    const wake = stageWake(issueId, makerRun!.id, stageId);
    const [parked] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: checkerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      status: "deferred_issue_execution",
      payload: {
        ...wake.payload,
        executionWait: { recoveryActionId: null, cause: "execution_owner_active" },
        _paperclipWakeContext: wake.contextSnapshot,
      },
    }).returning();

    // Only the maker run's own completion path runs here: no resumeQueuedRuns
    // and no direct resumeExecutionStageWaits call.
    await heartbeat.drainActiveRunExecutions();

    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked!.id));
    expect(after!.status).toBe("coalesced");
    const checkerRuns = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, checkerAgentId)));
    expect(checkerRuns).toHaveLength(1);
    expect(after!.runId).toBe(checkerRuns[0]!.id);
  }, 30_000);

  it("does not let parked wakes whose issue is gone starve a newer resumable one", async () => {
    const ready = await seed();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const orphanWake = stageWake(randomUUID(), ready.stoppedRunId);
    await db.insert(agentWakeupRequests).values(Array.from({ length: 60 }, (_, index) => ({
      companyId: ready.companyId,
      agentId: ready.checkerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      status: "deferred_issue_execution",
      idempotencyKey: `orphan-${index}-${randomUUID()}`,
      payload: index < 55
        ? {
          ...orphanWake.payload,
          issueId: randomUUID(),
          executionWait: { recoveryActionId: null, cause: "execution_owner_active" },
        }
        : { executionWait: { recoveryActionId: null, cause: "execution_owner_active" } },
      requestedAt: new Date(old.getTime() + index),
      updatedAt: new Date(old.getTime() + index),
    })));
    await heartbeat.wakeup(ready.checkerAgentId, stageWake(ready.issueId, ready.stoppedRunId, ready.stageId));
    await releaseLease(ready.leaseId);

    expect((await heartbeat.resumeExecutionStageWaits()).resumed).toBe(1);
    const readyRuns = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, ready.companyId), eq(heartbeatRuns.agentId, ready.checkerAgentId)));
    expect(readyRuns).toHaveLength(1);
  });

  it("rotates a held issue with more than 50 parked wakes behind a newer resumable one", async () => {
    const blocked = await seed();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const wake = stageWake(blocked.issueId, blocked.stoppedRunId, blocked.stageId);
    await db.insert(agentWakeupRequests).values(Array.from({ length: 120 }, (_, index) => ({
      companyId: blocked.companyId,
      agentId: blocked.checkerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      status: "deferred_issue_execution",
      idempotencyKey: `held-${index}-${randomUUID()}`,
      payload: {
        ...wake.payload,
        executionWait: { recoveryActionId: null, cause: "execution_owner_active" },
        _paperclipWakeContext: wake.contextSnapshot,
      },
      requestedAt: new Date(old.getTime() + index),
      updatedAt: new Date(old.getTime() + index),
    })));

    // First sweep: the held issue is checked and rotated.
    expect((await heartbeat.resumeExecutionStageWaits()).resumed).toBe(0);
    const parked = (await wakeRows(blocked.companyId, blocked.checkerAgentId))
      .filter((row) => row.status === "deferred_issue_execution");
    expect(parked).toHaveLength(120);
    expect(parked.every((row) => row.updatedAt.getTime() > old.getTime() + 1_000)).toBe(true);
  });

  it("still resumes a changes_requested wake whose stage id matches the current stage", async () => {
    const { companyId, checkerAgentId, issueId, stageId, stoppedRunId, leaseId } = await seed();
    await db.update(issues).set({
      status: "in_progress",
      executionState: {
        status: "changes_requested",
        currentStageId: stageId,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: randomUUID() },
        returnAssignee: { type: "agent", agentId: checkerAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: "changes_requested",
      },
    }).where(eq(issues.id, issueId));
    const base = stageWake(issueId, stoppedRunId, stageId);
    const executionStage = { ...base.payload.executionStage, wakeRole: "executor", allowedActions: [] };
    const first = await heartbeat.wakeup(checkerAgentId, {
      ...base,
      reason: "execution_changes_requested",
      payload: { ...base.payload, executionStage },
      contextSnapshot: { ...base.contextSnapshot, wakeReason: "execution_changes_requested", executionStage },
    });
    expect(first).toBeNull();
    const parked = await wakeRows(companyId, checkerAgentId);
    expect(parked.map((row) => row.status)).toEqual(["deferred_issue_execution"]);

    await releaseLease(leaseId);
    expect((await heartbeat.resumeExecutionStageWaits({ companyId, issueId })).resumed).toBe(1);
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked[0]!.id));
    expect(after!.status).toBe("coalesced");
  });
});
