import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue review attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Attention Co",
      issuePrefix: "RVA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertReview(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    assigneeUserId?: string | null;
    executionState?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.assigneeUserId ? null : input.agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      executionState: input.executionState ?? null,
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      executionPolicy: input.executionPolicy ?? null,
    });
    return id;
  }

  it("surfaces a pathless agent-owned review as stalled and a queued recovery as covered", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-1" });

    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "stalled",
      paths: [],
    });
    expect(row?.reviewAttention?.reason).toContain("no participant, interaction, approval");

    const recoveryIdempotencyKey = `issue_review_path_lost:${issueId}:fingerprint`;
    const recoveryWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId },
      idempotencyKey: recoveryIdempotencyKey,
    };
    await db.insert(agentWakeupRequests).values(recoveryWake);
    await expect(db.insert(agentWakeupRequests).values(recoveryWake)).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      },
    });

    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "queued_wake", responder: "Review Agent" })],
    });
  });

  it("reports every healthy review path as covered", async () => {
    const { companyId, agentId } = await seed();
    const interactionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2" });
    const humanOnlyInteractionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2H" });
    const approvalIssueId = await insertReview({ companyId, agentId, identifier: "RVA-3" });
    const monitorIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-4",
      monitorNextCheckAt: new Date(Date.now() + 60_000),
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    const humanIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-5",
      assigneeUserId: "board-user",
    });
    const participantIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-6",
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId } },
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      reason: "execution_review_requested",
      status: "queued",
      payload: { issueId: participantIssueId },
    });
    const activeRunIssueId = await insertReview({ companyId, agentId, identifier: "RVA-7" });
    const recoveryIssueId = await insertReview({ companyId, agentId, identifier: "RVA-8" });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: interactionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve?" },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: humanOnlyInteractionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Human review?" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Review" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: approvalIssueId, approvalId });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: activeRunIssueId },
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "review_path_lost",
      fingerprint: "review-path",
      evidence: {},
      nextAction: "Restore review path",
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    const expectedKinds = new Map([
      [interactionIssueId, "interaction"],
      [humanOnlyInteractionIssueId, "interaction"],
      [approvalIssueId, "approval"],
      [monitorIssueId, "monitor"],
      [humanIssueId, "human_reviewer"],
      [participantIssueId, "execution_participant"],
      [activeRunIssueId, "active_run"],
      [recoveryIssueId, "recovery"],
    ]);

    for (const [issueId, kind] of expectedKinds) {
      expect(byId.get(issueId), kind).toMatchObject({
        state: "covered",
        paths: expect.arrayContaining([expect.objectContaining({ kind })]),
      });
    }
    expect(byId.get(interactionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Review Agent" }),
    ]));
    expect(byId.get(humanOnlyInteractionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
  });

  it("does not let a transiently skipped recovery consume its fingerprint", async () => {
    const { companyId, agentId } = await seed();
    const idempotencyKey = `issue_review_path_lost:${randomUUID()}:fingerprint`;
    const baseWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      payload: {},
      idempotencyKey,
    };

    await db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "skipped",
      finishedAt: new Date(),
    });

    await expect(db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "queued",
    })).resolves.toBeDefined();
  });

  const participantState = (agentId: string) => ({
    status: "pending",
    currentParticipant: { type: "agent", agentId },
  });
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  async function attention(companyId: string, issueId: string) {
    const rows = await svc.list(companyId, { status: "in_review" });
    return rows.find((row) => row.id === issueId)?.reviewAttention;
  }

  it("AC1: a named participant with no wake, run, monitor, interaction or approval is stalled", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({
      companyId, agentId, identifier: "RVA-10", executionState: participantState(agentId),
    });
    const result = await attention(companyId, issueId);
    expect(result).toMatchObject({ state: "stalled", paths: [] });
    expect(result?.reason).toContain("participant named, no delivery path");
    expect(result?.deliveryFailures).toEqual([
      expect.objectContaining({ kind: "participant_without_delivery_path", responder: "Review Agent" }),
    ]);
  });

  it("AC1: a fresh deferred wake for the participant keeps the review covered", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({
      companyId, agentId, identifier: "RVA-11", executionState: participantState(agentId),
    });
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "assignment", reason: "execution_review_requested",
      status: "deferred_issue_execution", payload: { issueId },
    });
    const result = await attention(companyId, issueId);
    expect(result?.state).toBe("covered");
    expect(result?.paths.map((path) => path.kind)).toEqual(
      expect.arrayContaining(["execution_participant", "queued_wake"]),
    );
  });

  it("AC2b: an old deferred wake with no run and a free issue lock stops counting (HYBA-1916 shape)", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({
      companyId, agentId, identifier: "RVA-12", executionState: participantState(agentId),
    });
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "assignment", reason: "issue_assigned",
      status: "deferred_issue_execution", payload: { issueId }, requestedAt: hoursAgo(312),
    });
    const result = await attention(companyId, issueId);
    expect(result).toMatchObject({ state: "stalled", paths: [] });
    expect(result?.deliveryFailures?.map((failure) => failure.kind)).toEqual(
      expect.arrayContaining(["stale_deferred_wake", "participant_without_delivery_path"]),
    );
  });

  it("AC2b: an old deferred wake still counts while a live run holds the issue lock", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-13" });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() },
    }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", reason: "issue_commented",
      status: "deferred_issue_execution", payload: { issueId }, requestedAt: hoursAgo(5),
    });
    const result = await attention(companyId, issueId);
    expect(result?.state).toBe("covered");
    expect(result?.paths).toEqual([expect.objectContaining({ kind: "queued_wake" })]);
  });

  it("AC2c: a claimed wake whose run is terminal is a delivery failure (HYBA-1185 shape)", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-14" });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "failed", contextSnapshot: { issueId },
    }).returning();
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", reason: "issue_commented", status: "claimed",
      payload: { issueId }, runId: run!.id, claimedAt: hoursAgo(77), requestedAt: hoursAgo(77),
    });
    const result = await attention(companyId, issueId);
    expect(result).toMatchObject({ state: "stalled", paths: [] });
    expect(result?.deliveryFailures).toEqual([
      expect.objectContaining({ kind: "claimed_wake_terminal_run" }),
    ]);
  });

  it("AC2a: an execution-reconciliation hold reports held with the recovery action id, not covered", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({
      companyId, agentId, identifier: "RVA-15", executionState: participantState(agentId),
    });
    const stoppedRunId = randomUUID();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "execution_reconciliation",
      status: "active",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `hold-${randomUUID()}`,
      evidence: { runId: stoppedRunId },
      nextAction: "Record a reconciliation.",
    }).returning();
    for (let index = 0; index < 7; index += 1) {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", reason: "issue_commented",
        status: "deferred_issue_execution", payload: { issueId },
      });
    }
    const result = await attention(companyId, issueId);
    expect(result?.state).toBe("held");
    expect(result?.paths).toEqual([]);
    expect(result?.hold).toMatchObject({
      recoveryActionId: action!.id,
      runId: stoppedRunId,
      cause: "legacy_execution_requires_reconciliation",
      reason: "held: execution reconciliation needed",
    });
    expect(result?.reason).toContain("held: execution reconciliation needed");
    expect(result?.reason).toContain(action!.id);
  });

  it("AC2a: a hold does not mask a pending interaction", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-16" });
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "execution_reconciliation", status: "active",
      ownerType: "board", cause: "uncertain_provider_action", fingerprint: `hold-${randomUUID()}`,
      evidence: {}, nextAction: "Record a reconciliation.",
    });
    await db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Approve?" },
    });
    const result = await attention(companyId, issueId);
    expect(result?.state).toBe("covered");
    expect(result?.hold).toMatchObject({ cause: "uncertain_provider_action" });
  });
});
