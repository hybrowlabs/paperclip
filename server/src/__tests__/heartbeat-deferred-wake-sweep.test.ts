import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
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
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred wake sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

describeEmbeddedPostgres("deferred wake sweep (HYBA-2946 AC3, AC4)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-deferred-wake-sweep-");
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

  async function seed(input: { issueStatus?: string; executionState?: Record<string, unknown> | null } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Nova",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded wake",
      status: input.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: input.executionState ?? null,
    });
    return { companyId, agentId, issueId };
  }

  async function insertDeferred(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    reason: string;
    source?: string;
    actor?: "agent" | "system" | "user";
    payload?: Record<string, unknown>;
    context?: Record<string, unknown>;
    ageHours?: number;
    runId?: string | null;
    status?: string;
  }) {
    const at = hoursAgo(input.ageHours ?? 5);
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.source ?? "automation",
      triggerDetail: "system",
      reason: input.reason,
      status: input.status ?? "deferred_issue_execution",
      requestedByActorType: input.actor ?? "agent",
      requestedByActorId: randomUUID(),
      runId: input.runId ?? null,
      payload: {
        issueId: input.issueId,
        ...(input.payload ?? {}),
        _paperclipWakeContext: {
          issueId: input.issueId,
          taskId: input.issueId,
          wakeReason: input.reason,
          ...(input.context ?? {}),
        },
      },
      requestedAt: at,
      updatedAt: at,
      finishedAt: input.status && input.status !== "deferred_issue_execution" ? at : null,
    }).returning();
    return row!;
  }

  async function wake(id: string) {
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    return row!;
  }

  async function runsFor(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  it.each([
    ["an assignment wake", { reason: "issue_assigned", source: "assignment", actor: "system" as const, payload: { mutation: "update" } }],
    ["an agent comment wake", { reason: "issue_commented", actor: "agent" as const }],
    ["an unmarked stage wake", {
      reason: "execution_review_requested",
      source: "assignment",
      actor: "agent" as const,
      payload: { mutation: "update" },
    }],
  ])("AC3: promotes %s that nobody revisited once the issue lock is free", async (_name, wakeInput) => {
    const { companyId, agentId, issueId } = await seed();
    const row = await insertDeferred({ companyId, agentId, issueId, ...wakeInput });

    const result = await heartbeat.resumeDeferredIssueWakes();
    expect(result.resumed).toBe(1);

    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId, wakeReason: wakeInput.reason });
    const after = await wake(row.id);
    expect(after.status).toBe("coalesced");
    expect(after.runId).toBe(runs[0]!.id);
  });

  it("AC3: the periodic resumeQueuedRuns sweep reaches the same rows", async () => {
    const { companyId, agentId, issueId } = await seed();
    const row = await insertDeferred({ companyId, agentId, issueId, reason: "issue_assigned", source: "assignment", actor: "system" });
    await heartbeat.resumeQueuedRuns();
    expect((await wake(row.id)).status).toBe("coalesced");
    expect(await runsFor(agentId)).toHaveLength(1);
  });

  it("AC3: leaves the row deferred while the issue lock is held by a live run", async () => {
    const { companyId, agentId, issueId } = await seed();
    const [live] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", invocationSource: "assignment",
      contextSnapshot: { issueId }, startedAt: new Date(),
    }).returning();
    await db.update(issues).set({ executionRunId: live!.id }).where(eq(issues.id, issueId));
    const row = await insertDeferred({ companyId, agentId, issueId, reason: "issue_commented" });

    expect((await heartbeat.resumeDeferredIssueWakes()).resumed).toBe(0);
    expect((await wake(row.id)).status).toBe("deferred_issue_execution");
  });

  it("AC3: keeps the recovery hold, the row stays deferred", async () => {
    const { companyId, agentId, issueId } = await seed();
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "execution_reconciliation", status: "active", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `fp-${randomUUID()}`,
      evidence: { runId: randomUUID() }, nextAction: "Record a reconciliation.",
    });
    const row = await insertDeferred({ companyId, agentId, issueId, reason: "issue_assigned", source: "assignment", actor: "system" });

    expect((await heartbeat.resumeDeferredIssueWakes()).resumed).toBe(0);
    expect((await wake(row.id)).status).toBe("deferred_issue_execution");
    expect(await runsFor(agentId)).toHaveLength(0);
  });

  it("AC3: keeps the operator Stop, an acknowledged Stop is not revived by the sweep", async () => {
    const { companyId, agentId, issueId } = await seed();
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "cancelled", invocationSource: "assignment", runtimeMode: "legacy",
      finishedAt: new Date(), errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" }, cancelledByActorType: "user", cancelledByUserId: "board-user" },
      contextSnapshot: { issueId },
    });
    const row = await insertDeferred({ companyId, agentId, issueId, reason: "issue_commented" });

    expect((await heartbeat.resumeDeferredIssueWakes()).resumed).toBe(0);
    expect((await wake(row.id)).status).toBe("deferred_issue_execution");
  });

  it("AC3: a stage wake for a stage the issue already left is cancelled, not run", async () => {
    const { companyId, agentId, issueId } = await seed({ issueStatus: "in_review" });
    await db.update(issues).set({
      executionState: {
        status: "pending", currentStageId: randomUUID(), currentStageIndex: 1, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: null, completedStageIds: [],
        lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issueId));
    const row = await insertDeferred({
      companyId, agentId, issueId, reason: "execution_review_requested", source: "assignment",
      payload: { executionStage: { stageId: randomUUID(), stageType: "review", wakeRole: "reviewer" } },
    });
    expect((await heartbeat.resumeDeferredIssueWakes()).resumed).toBe(0);
    expect((await wake(row.id)).status).toBe("cancelled");
    expect(await runsFor(agentId)).toHaveLength(0);
  });

  it("AC3: does not touch a user's saved comment row, its own delivery path owns it", async () => {
    const { companyId, agentId, issueId } = await seed();
    const commentId = randomUUID();
    const row = await insertDeferred({
      companyId, agentId, issueId, reason: "issue_commented", actor: "user",
      context: { wakeCommentId: commentId, wakeCommentIds: [commentId] },
    });
    expect((await heartbeat.resumeDeferredIssueWakes()).resumed).toBe(0);
    expect((await wake(row.id)).status).toBe("deferred_issue_execution");
  });

  it("AC4: closes older deferred rows once a newer wake for the same agent and issue has run", async () => {
    const { companyId, agentId, issueId } = await seed();
    const [ranRun] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", invocationSource: "automation",
      finishedAt: new Date(), contextSnapshot: { issueId },
    }).returning();
    const stale = await insertDeferred({ companyId, agentId, issueId, reason: "issue_assigned", source: "assignment", actor: "system", ageHours: 200 });
    await insertDeferred({ companyId, agentId, issueId, reason: "issue_commented", ageHours: 1, status: "completed", runId: ranRun!.id });
    const newest = await insertDeferred({ companyId, agentId, issueId, reason: "issue_commented", ageHours: 0.001 });

    const result = await heartbeat.resumeDeferredIssueWakes();
    expect(result.closedSuperseded).toBe(1);
    expect(result.resumed).toBe(1);
    const closed = await wake(stale.id);
    expect(closed.status).toBe("coalesced");
    expect(closed.finishedAt).not.toBeNull();
    expect(closed.error).toContain(ranRun!.id);
    const promoted = await wake(newest.id);
    expect(promoted.status).toBe("coalesced");
    expect(promoted.runId).not.toBeNull();
    expect(promoted.runId).not.toBe(ranRun!.id);
  });

  it("AC4: a newer wake that never ran does not close an older one", async () => {
    const { companyId, agentId, issueId } = await seed();
    const [live] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", invocationSource: "assignment",
      contextSnapshot: { issueId }, startedAt: new Date(),
    }).returning();
    await db.update(issues).set({ executionRunId: live!.id }).where(eq(issues.id, issueId));
    const older = await insertDeferred({ companyId, agentId, issueId, reason: "issue_assigned", source: "assignment", actor: "system", ageHours: 10 });
    await insertDeferred({ companyId, agentId, issueId, reason: "issue_commented", ageHours: 2 });
    expect((await heartbeat.resumeDeferredIssueWakes()).closedSuperseded).toBe(0);
    expect((await wake(older.id)).status).toBe("deferred_issue_execution");
  });

  it("AC4: a wake for another agent on the same issue is not superseded", async () => {
    const { companyId, agentId, issueId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId, name: "Sentinel", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [ranRun] = await db.insert(heartbeatRuns).values({
      companyId, agentId: otherAgentId, status: "succeeded", invocationSource: "automation",
      finishedAt: new Date(), contextSnapshot: { issueId },
    }).returning();
    const mine = await insertDeferred({ companyId, agentId, issueId, reason: "issue_commented", ageHours: 10 });
    await insertDeferred({ companyId, agentId: otherAgentId, issueId, reason: "issue_commented", ageHours: 1, status: "completed", runId: ranRun!.id });
    expect((await heartbeat.resumeDeferredIssueWakes()).closedSuperseded).toBe(0);
    expect(["deferred_issue_execution", "coalesced"]).toContain((await wake(mine.id)).status);
    expect((await wake(mine.id)).error ?? "").not.toContain(ranRun!.id);
  });
});
