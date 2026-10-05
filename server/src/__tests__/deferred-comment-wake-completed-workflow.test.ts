import { describe, expect, it, vi } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import type {
  DeferredWakeCandidate,
  IssueSnapshot,
  WakeQueueHost,
  WakeQueueTransaction,
} from "../modules/wake-queue/application/ports.js";

const makerId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const approverId = "33333333-3333-4333-8333-333333333333";
const boardUserId = "board-user";

type IssueRow = {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: ReturnType<typeof normalizeIssueExecutionPolicy>;
  executionState: Record<string, any> | null;
  completedAt: Date | null;
};

function transition(issue: IssueRow, requestedStatus: string, actor: { agentId?: string; userId?: string }, commentBody = "ok") {
  const result = applyIssueExecutionPolicyTransition({
    issue,
    policy: issue.executionPolicy,
    requestedStatus,
    requestedAssigneePatch: {},
    actor,
    commentBody,
  });
  const next = { ...issue, ...(result.patch as Partial<IssueRow>) };
  if (requestedStatus === "done" && next.status === "done" && !issue.completedAt) next.completedAt = new Date("2026-10-05T15:25:07.000Z");
  return next as IssueRow;
}

function snapshotOf(issue: IssueRow): IssueSnapshot {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "HYBA-1287",
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    hiddenAt: null,
    completedAt: issue.completedAt,
    cancelledAt: null,
    originKind: null,
    monitorNextCheckAt: null,
    executionState: issue.executionState,
    responsibleUserId: null,
    parentId: null,
    originId: null,
    originRunId: null,
  };
}

function boardCommentWake(): DeferredWakeCandidate {
  return {
    id: "wake-1",
    companyId: "company-1",
    agentId: makerId,
    reason: "issue_commented",
    source: "automation",
    triggerDetail: null,
    requestedByActorType: "user",
    requestedByActorId: boardUserId,
    payload: {},
    queuedCommentIds: ["board-comment"],
    preservesIndependentContinuation: false,
    deferredContextSeed: {},
    deferredCommentIds: ["board-comment"],
    wakeReason: "issue_commented",
  };
}

function drain(issue: IssueRow, commentAt: Date) {
  const queue = [boardCommentWake()];
  let current = issue;
  const transaction = {
    findInvokableAgent: vi.fn(async () => ({ id: makerId, companyId: "company-1", name: "Maker", invokable: true })),
    isCompletedOnboardingHandoffWake: vi.fn(async () => false),
    findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
    getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: ["board-comment"], containedSelfAuthoredComment: false })),
    cancelDeferredWake: vi.fn(async () => true),
    normalizeDeferredWakeCommentIds: vi.fn(),
    failDeferredWake: vi.fn(async () => true),
    getPauseHoldFacts: vi.fn(async () => ({
      activePauseHold: false, treeHoldInteractionWake: false, holdId: null, rootIssueId: null, mode: null, reason: null, releasePolicy: null,
    })),
    getCommentSelfAuthorship: vi.fn(async () => ({ allSelfAuthored: false })),
    getLatestCommentCreatedAt: vi.fn(async () => commentAt),
    isCompletedDelegationMention: vi.fn(async () => false),
    reopenIssue: vi.fn(async ({ keepExecutionState }: { keepExecutionState?: boolean }) => {
      current = {
        ...current,
        status: "todo",
        completedAt: null,
        executionState: keepExecutionState ? current.executionState : null,
      };
      return snapshotOf(current);
    }),
    claimDeferredWakeForPromotion: vi.fn(async () => true),
    finalizePromotedWake: vi.fn(async () => ({
      id: "run-new", companyId: "company-1", agentId: makerId, invocationSource: "automation", triggerDetail: null, wakeupRequestId: "w",
    })),
    hasExistingExecutionPath: vi.fn(async () => false),
    hasExplicitBlockerPath: vi.fn(async () => false),
    isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
    isImmediateRecoverySourceBlocked: vi.fn(async () => false),
    queueReviewParticipantRecoveryRun: vi.fn(),
    queueImmediateRecoveryRun: vi.fn(),
  } as unknown as WakeQueueTransaction;
  const host = {
    resolveResponsibleUserId: vi.fn(async () => "user-1"),
    getRoutineEnv: vi.fn(async () => ({ routineId: null, env: null, responsibleUserId: null })),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
  } as unknown as WakeQueueHost;
  const run = {
    id: "run-1", companyId: "company-1", agentId: reviewerId, status: "succeeded", runtimeMode: "process", errorCode: null,
    responsibleUserId: "user-1", contextSnapshot: {}, configurationIncompletePayload: null,
  };
  const release = createReleaseIssueExecution({
    issueLock: {
      withIssueExecutionLock: vi.fn(async (_input, fn) => {
        const result = await fn({ primaryIssue: snapshotOf(issue), run }, { host, transaction });
        return { ...result, run };
      }),
    } as any,
    recovery: { escalateReviewParticipantRecovery: vi.fn() } as any,
  });
  return { transaction, release: async () => ({ result: await release({ companyId: "company-1", runId: "run-1", now: new Date() }), issue: current }) };
}

function twoStageIssueInReview(): IssueRow {
  const policy = normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: reviewerId }] },
      { type: "approval", participants: [{ type: "agent", agentId: approverId }] },
    ],
  })!;
  const submitted = transition({
    status: "in_progress", assigneeAgentId: makerId, assigneeUserId: null, executionPolicy: policy, executionState: null, completedAt: null,
  }, "in_review", { agentId: makerId });
  return submitted;
}

function approveAll(issue: IssueRow): IssueRow {
  const reviewed = transition(issue, "done", { agentId: reviewerId }, "review approved");
  expect(reviewed.executionState?.currentStageType).toBe("approval");
  const done = transition({ ...reviewed }, "done", { agentId: approverId }, "final approval");
  return { ...done, status: "done", assigneeAgentId: makerId, completedAt: new Date("2026-10-05T15:25:07.000Z") };
}

describe("HYBA-1287 sequence: board comment while in_review, deferred wake promoted after completion", () => {
  it("a comment posted before the final approval does not reopen the issue or reset the finished stages", async () => {
    const finished = approveAll(twoStageIssueInReview());
    expect(finished.status).toBe("done");
    expect(finished.executionState?.status).toBe("completed");
    const stagesBefore = [...finished.executionState!.completedStageIds];
    expect(stagesBefore).toHaveLength(2);

    const { transaction, release } = drain(finished, new Date("2026-10-05T15:23:50.000Z"));
    const { result, issue } = await release();

    expect(transaction.reopenIssue).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe("promoted");
    expect(issue.status).toBe("done");
    expect(issue.executionState?.completedStageIds).toEqual(stagesBefore);
  });

  it("a comment posted after completion still reopens, and setting done again keeps the finished stages", async () => {
    const finished = approveAll(twoStageIssueInReview());
    const stagesBefore = [...finished.executionState!.completedStageIds];

    const { transaction, release } = drain(finished, new Date("2026-10-05T15:25:55.000Z"));
    const { result, issue: reopened } = await release();

    expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
    expect(result.postCommitEffects).toContainEqual(expect.objectContaining({ kind: "issue_reopened", reopenedFrom: "done" }));
    expect(reopened.status).toBe("todo");
    expect(reopened.executionState?.completedStageIds).toEqual(stagesBefore);

    const doneAgain = transition(reopened, "done", { userId: boardUserId }, "back to done");
    expect(doneAgain.status).toBe("todo");
    expect(doneAgain.executionState?.status).toBe("completed");
    expect(doneAgain.executionState?.completedStageIds).toEqual(stagesBefore);
    expect(doneAgain.executionState?.currentStageId).toBeNull();
  });

  it("a real resubmission after the reopen starts the workflow again at the first stage", async () => {
    const finished = approveAll(twoStageIssueInReview());
    const { release } = drain(finished, new Date("2026-10-05T15:25:55.000Z"));
    const { issue: reopened } = await release();

    const resubmitted = transition({ ...reopened, status: "in_progress" }, "in_review", { agentId: makerId });
    expect(resubmitted.status).toBe("in_review");
    expect(resubmitted.executionState?.status).toBe("pending");
    expect(resubmitted.executionState?.currentStageType).toBe("review");
    expect(resubmitted.executionState?.completedStageIds).toEqual([]);
    expect(resubmitted.assigneeAgentId).toBe(reviewerId);
  });
});
