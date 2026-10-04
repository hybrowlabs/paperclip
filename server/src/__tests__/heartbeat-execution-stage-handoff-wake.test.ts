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
    await db.delete(issues);
    await db.delete(agentRuntimeState);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
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
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
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
    });
    return { companyId, checkerAgentId, issueId, stoppedRunId, leaseId };
  }

  function stageWake(issueId: string, interruptedRunId: string) {
    const executionStage = {
      wakeRole: "reviewer",
      stageId: randomUUID(),
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
    const { companyId, checkerAgentId, issueId, stoppedRunId, leaseId } = await seed();

    const first = await heartbeat.wakeup(checkerAgentId, stageWake(issueId, stoppedRunId));
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
    const { companyId, checkerAgentId, issueId, stoppedRunId, leaseId } = await seed();
    await heartbeat.wakeup(checkerAgentId, stageWake(issueId, stoppedRunId));
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
});
