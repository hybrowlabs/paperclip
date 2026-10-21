import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness } from "../services/issue-liveness.ts";
import { classifyIssueReviewDelivery } from "../services/recovery/issue-graph-liveness.ts";

const companyId = "company-1";
const managerId = "manager-1";
const coderId = "coder-1";
const blockerId = "blocker-1";
const blockedId = "blocked-1";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: blockedId,
    companyId,
    identifier: "PAP-1703",
    title: "Parent work",
    status: "blocked",
    assigneeAgentId: coderId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionState: null,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: coderId,
    companyId,
    name: "Coder",
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: managerId,
    ...overrides,
  };
}

const manager = agent({
  id: managerId,
  name: "CTO",
  role: "cto",
  reportsTo: null,
});

const blocks = [{ companyId, blockerIssueId: blockerId, blockedIssueId: blockedId }];

describe("issue graph liveness classifier", () => {
  it("detects a PAP-1703-style blocked chain with an unassigned blocker and stable incident key", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_unassigned_issue",
      recoveryIssueId: blockerId,
      recommendedOwnerAgentId: managerId,
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_unassigned_issue:${blockerId}`,
    });
  });

  it("does not use free-form executive role or name matching for recovery ownership", () => {
    const rootAgentId = "root-agent";
    const spoofedExecutiveId = "spoofed-executive";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [
        agent({
          id: spoofedExecutiveId,
          name: "Chief Executive Recovery",
          role: "cto",
          title: "CEO",
          reportsTo: rootAgentId,
        }),
        agent({
          id: rootAgentId,
          name: "Root Operator",
          role: "operator",
          title: null,
          reportsTo: null,
        }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.recommendedOwnerAgentId).toBe(rootAgentId);
    expect(findings[0]?.recommendedOwnerCandidates[0]).toMatchObject({
      agentId: rootAgentId,
      reason: "root_agent",
      sourceIssueId: blockerId,
    });
    expect(findings[0]?.recommendedOwnerCandidateAgentIds).toEqual([
      rootAgentId,
      spoofedExecutiveId,
    ]);
  });

  it("does not flag a live blocked chain with an active assignee and wake path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Live unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
      queuedWakeRequests: [{ companyId, issueId: blockerId, agentId: "blocker-agent", status: "queued" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects an assigned backlog blocker leaf with no action path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Parked assigned unblock work",
          status: "backlog",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_assigned_backlog_issue",
      recoveryIssueId: blockerId,
      recommendedOwnerAgentId: "blocker-agent",
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId, status: "backlog" }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_assigned_backlog_issue:${blockerId}`,
    });
  });

  it("does not flag an assigned backlog blocker that has an explicit waiting path", () => {
    const backlogBlocker = issue({
      id: blockerId,
      identifier: "PAP-1704",
      title: "Explicitly parked unblock work",
      status: "backlog",
      assigneeAgentId: "blocker-agent",
    });
    const baseInput = {
      issues: [issue(), backlogBlocker],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
    };

    expect(classifyIssueGraphLiveness({
      ...baseInput,
      issues: [issue(), { ...backlogBlocker, assigneeAgentId: null, assigneeUserId: "board-user-1" }],
    })).toEqual([]);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      activeRuns: [{ companyId, issueId: blockerId, agentId: "blocker-agent", status: "running" }],
    })).toEqual([]);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      openRecoveryIssues: [{ companyId, issueId: blockerId, status: "todo" }],
    })).toEqual([]);
  });

  it("does not flag an unassigned blocker that already has an active execution path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Unassigned but already running",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
      activeRuns: [{ companyId, issueId: blockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects cancelled blockers and uninvokable blocker assignees deterministically", () => {
    const cancelled = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(cancelled[0]?.state).toBe("blocked_by_cancelled_issue");

    const paused = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Paused unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(paused[0]?.state).toBe("blocked_by_uninvokable_assignee");
  });

  it("detects a cancelled blocker on an assigned todo source", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({ status: "todo" }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Cancelled owner" })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      state: "blocked_by_cancelled_issue",
      recoveryIssueId: blockerId,
    });
  });

  it("prefers the blocker finding for an in-review source with a cancelled blocker", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({ status: "in_review" }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Cancelled owner" })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.state).toBe("blocked_by_cancelled_issue");
  });

  it("detects blocker assignees under terminated org ancestors as uninvokable", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Invalid tree unblock work",
          status: "todo",
          assigneeAgentId: "qa-2",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "qa-2", name: "QA 2", status: "active", reportsTo: "cto-2" }),
        agent({ id: "cto-2", name: "CTO 2", status: "terminated", reportsTo: "ceo-2" }),
        agent({ id: "ceo-2", name: "CEO 2", status: "terminated", reportsTo: null }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "blocked_by_uninvokable_assignee",
      reason: "PAP-1703 is blocked by PAP-1704, but its assignee is in an invalid org chain.",
      recommendedOwnerAgentId: managerId,
    });
  });

  it("detects invalid in_review execution participant", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          status: "in_review",
          executionState: {
            status: "pending",
            currentStageId: "stage-1",
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: "missing-agent" },
            returnAssignee: { type: "agent", agentId: coderId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        }),
      ],
      relations: [],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "invalid_review_participant",
      incidentKey: `harness_liveness:${companyId}:${blockedId}:invalid_review_participant:missing-agent`,
    });
  });

  it("detects the PAP-2239-style blocked chain at the first stalled in_review leaf without duplicate findings", () => {
    const phaseIssueId = "phase-issue-1";
    const reviewLeafId = "review-leaf-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: "pap-2239",
          identifier: "PAP-2239",
          title: "External object reference project",
          status: "blocked",
        }),
        issue({
          id: phaseIssueId,
          identifier: "PAP-2276",
          title: "UX acceptance review phase",
          status: "blocked",
          assigneeAgentId: coderId,
        }),
        issue({
          id: reviewLeafId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [
        { companyId, blockerIssueId: phaseIssueId, blockedIssueId: "pap-2239" },
        { companyId, blockerIssueId: reviewLeafId, blockedIssueId: phaseIssueId },
      ],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: "pap-2239",
      identifier: "PAP-2239",
      state: "in_review_without_action_path",
      recoveryIssueId: reviewLeafId,
      recommendedOwnerAgentId: coderId,
      dependencyPath: [
        expect.objectContaining({ issueId: "pap-2239" }),
        expect.objectContaining({ issueId: phaseIssueId }),
        expect.objectContaining({ issueId: reviewLeafId }),
      ],
      incidentKey: `harness_liveness:${companyId}:pap-2239:in_review_without_action_path:${reviewLeafId}`,
    });
  });

  it("skips paused stalled review assignees when choosing recovery owner candidates", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent({ status: "paused" }), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recommendedOwnerAgentId: managerId,
    });
    expect(findings[0]?.recommendedOwnerCandidates).toEqual([
      {
        agentId: managerId,
        reason: "assignee_reporting_chain",
        sourceIssueId: reviewIssueId,
      },
    ]);
  });

  it("does not flag healthy in_review issues with an explicit action path", () => {
    const reviewIssueId = "review-1";
    const baseReviewIssue = issue({
      id: reviewIssueId,
      identifier: "PAP-2279",
      title: "Screenshot acceptance review",
      status: "in_review",
      assigneeAgentId: coderId,
      executionState: null,
    });

    const cases = [
      {
        name: "typed agent participant with a fresh wake",
        issue: {
          ...baseReviewIssue,
          executionState: {
            status: "pending",
            currentParticipant: { type: "agent", agentId: coderId },
          },
        },
        queuedWakeRequests: [
          { companyId, issueId: reviewIssueId, agentId: coderId, status: "queued", createdAt: new Date() },
        ],
      },
      {
        name: "typed user participant",
        issue: {
          ...baseReviewIssue,
          executionState: {
            status: "pending",
            currentParticipant: { type: "user", userId: "board-user-1" },
          },
        },
      },
      {
        name: "user owner",
        issue: { ...baseReviewIssue, assigneeAgentId: null, assigneeUserId: "board-user-1" },
      },
      {
        name: "active run",
        issue: baseReviewIssue,
        activeRuns: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "running" }],
      },
      {
        name: "queued wake",
        issue: baseReviewIssue,
        queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "queued" }],
      },
      {
        name: "pending interaction",
        issue: baseReviewIssue,
        pendingInteractions: [{ companyId, issueId: reviewIssueId, status: "pending" }],
      },
      {
        name: "pending approval",
        issue: baseReviewIssue,
        pendingApprovals: [{ companyId, issueId: reviewIssueId, status: "pending" }],
      },
      {
        name: "open recovery issue",
        issue: baseReviewIssue,
        openRecoveryIssues: [{ companyId, issueId: reviewIssueId, status: "todo" }],
      },
    ];

    for (const testCase of cases) {
      const findings = classifyIssueGraphLiveness({
        issues: [testCase.issue],
        relations: [],
        agents: [agent(), manager],
        activeRuns: testCase.activeRuns,
        queuedWakeRequests: testCase.queuedWakeRequests,
        pendingInteractions: testCase.pendingInteractions,
        pendingApprovals: testCase.pendingApprovals,
        openRecoveryIssues: testCase.openRecoveryIssues,
      });

      expect(findings, testCase.name).toEqual([]);
    }
  });

  it("does not treat a participant retained after changes are requested as an active review path", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: {
            status: "changes_requested",
            currentParticipant: { type: "agent", agentId: coderId },
          },
        }),
      ],
      relations: [],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: reviewIssueId,
      state: "in_review_without_action_path",
    });
  });

  it("still flags a stalled in_review issue when its blocker has an active run", () => {
    const reviewIssueId = "review-1";
    const activeBlockerId = "active-blocker-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
        issue({
          id: activeBlockerId,
          identifier: "PAP-2280",
          title: "Active blocker",
          status: "in_progress",
          assigneeAgentId: coderId,
        }),
      ],
      relations: [{ companyId, blockerIssueId: activeBlockerId, blockedIssueId: reviewIssueId }],
      agents: [agent(), manager],
      activeRuns: [{ companyId, issueId: activeBlockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: reviewIssueId,
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
  });

  it("ignores cross-company waiting paths for stalled in_review issues", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent(), manager],
      pendingInteractions: [{ companyId: "other-company", issueId: reviewIssueId, status: "pending" }],
      openRecoveryIssues: [{ companyId: "other-company", issueId: reviewIssueId, status: "todo" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
  });
});

describe("review delivery paths (HYBA-2946)", () => {
  const reviewIssueId = "review-1";
  const now = new Date("2026-10-21T15:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const participantState = {
    status: "pending",
    currentParticipant: { type: "agent", agentId: coderId },
  };

  function reviewIssue(overrides: Record<string, unknown> = {}) {
    return issue({
      id: reviewIssueId,
      identifier: "PAP-2946",
      title: "Review delivery",
      status: "in_review",
      assigneeAgentId: coderId,
      executionState: participantState,
      executionRunId: null,
      ...overrides,
    });
  }

  function classify(
    reviewOverrides: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const input = {
      issues: [reviewIssue(reviewOverrides)],
      relations: [],
      agents: [agent(), manager],
      now,
      ...extra,
    };
    return {
      findings: classifyIssueGraphLiveness(input as never),
      delivery: classifyIssueReviewDelivery(input as never, input.issues[0] as never),
    };
  }

  it("AC1: a participant with no second live path is stalled with a named reason", () => {
    const { findings, delivery } = classify({});
    expect(delivery.paths).toEqual([]);
    expect(delivery.failures).toEqual([
      expect.objectContaining({ kind: "participant_without_delivery_path", responderAgentId: coderId }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "in_review_without_action_path", issueId: reviewIssueId });
    expect(findings[0]?.reason).toContain("participant named, no delivery path");
  });

  it.each([
    ["an active run", { activeRuns: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "running" }] }],
    ["a fresh queued wake", { queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "queued", createdAt: minutesAgo(5) }] }],
    ["a fresh deferred wake", { queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "deferred_issue_execution", createdAt: minutesAgo(5) }] }],
    ["a pending interaction", { pendingInteractions: [{ companyId, issueId: reviewIssueId, status: "pending" }] }],
    ["a pending approval", { pendingApprovals: [{ companyId, issueId: reviewIssueId, status: "pending" }] }],
  ])("AC1: a participant covered by %s is not flagged", (_name, extra) => {
    const { findings, delivery } = classify({}, extra);
    expect(findings).toEqual([]);
    expect(delivery.paths.map((path) => path.kind)).toContain("execution_participant");
  });

  it("AC1: an armed monitor or a human reviewer is a second live path", () => {
    const monitor = classify({
      monitorNextCheckAt: new Date(now.getTime() + 60_000),
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    expect(monitor.findings).toEqual([]);
    expect(monitor.delivery.paths.map((path) => path.kind)).toEqual(expect.arrayContaining(["monitor", "execution_participant"]));
    const human = classify({ assigneeAgentId: null, assigneeUserId: "board-user" });
    expect(human.findings).toEqual([]);
  });

  it("AC1: a wake that belongs to a different agent is not a delivery path for the participant", () => {
    const { findings } = classify({}, {
      queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: managerId, status: "queued", createdAt: minutesAgo(1) }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("participant named, no delivery path");
  });

  it("AC1: a participant wake older than the bound is not a delivery path", () => {
    const { findings } = classify({}, {
      queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "queued", createdAt: minutesAgo(90) }],
    });
    expect(findings).toHaveLength(1);
  });

  it("AC2b: an orphaned deferred wake older than the bound stops counting as coverage", () => {
    const stale = [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "deferred_issue_execution", createdAt: minutesAgo(312 * 60), runId: null }];
    const { findings, delivery } = classify({ executionState: null }, { queuedWakeRequests: stale });
    expect(delivery.paths).toEqual([]);
    expect(delivery.failures).toEqual([expect.objectContaining({ kind: "stale_deferred_wake" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "in_review_without_action_path" });
  });

  it("AC2b: a deferred wake waiting behind a live execution lock still counts, whatever its age", () => {
    const waiting = [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "deferred_issue_execution", createdAt: minutesAgo(600), runId: null }];
    const { findings, delivery } = classify({ executionState: null, executionRunId: "run-live" }, { queuedWakeRequests: waiting });
    expect(findings).toEqual([]);
    expect(delivery.paths.map((path) => path.kind)).toEqual(["queued_wake"]);
  });

  it("AC2b: the age bound is configurable", () => {
    const wakes = [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "deferred_issue_execution", createdAt: minutesAgo(10), runId: null }];
    const tight = classify({ executionState: null }, { queuedWakeRequests: wakes, wakeMaxAgeMs: 5 * 60_000 });
    expect(tight.findings).toHaveLength(1);
    const loose = classify({ executionState: null }, { queuedWakeRequests: wakes, wakeMaxAgeMs: 60 * 60_000 });
    expect(loose.findings).toEqual([]);
  });

  it("AC2c: a claimed wake whose run is terminal is a delivery failure, not coverage", () => {
    const claimed = [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "claimed", createdAt: minutesAgo(77 * 60), runId: "run-dead", runStatus: "failed" }];
    const { findings, delivery } = classify({ executionState: null }, { queuedWakeRequests: claimed });
    expect(delivery.failures).toEqual([expect.objectContaining({ kind: "claimed_wake_terminal_run", ref: null })]);
    expect(findings).toHaveLength(1);
    const live = classify({ executionState: null }, {
      queuedWakeRequests: [{ ...claimed[0]!, runStatus: "running" }],
    });
    expect(live.findings).toEqual([]);
  });

  it("AC2a: an execution hold is reported as held, never as covered, and wakes do not count", () => {
    const hold = { recoveryActionId: "action-1", runId: "run-9", cause: "legacy_execution_requires_reconciliation" };
    const wakes = Array.from({ length: 7 }, () => ({
      companyId, issueId: reviewIssueId, agentId: coderId, status: "deferred_issue_execution", createdAt: minutesAgo(2), runId: null,
    }));
    const { findings, delivery } = classify({ executionBlocker: hold }, { queuedWakeRequests: wakes });
    expect(delivery.paths).toEqual([]);
    expect(delivery.hold).toEqual(hold);
    expect(delivery.failures).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "execution_blocker_hold", ref: "action-1" })]));
    expect(findings).toEqual([]);
  });

  it("AC2a: a hold does not hide a human reviewer or a pending interaction", () => {
    const hold = { recoveryActionId: "action-1", runId: null, cause: "uncertain_provider_action" };
    const human = classify({ executionBlocker: hold, executionState: null, assigneeAgentId: null, assigneeUserId: "board-user" });
    expect(human.delivery.hold).toEqual(hold);
    expect(human.delivery.paths.map((path) => path.kind)).toEqual(["human_reviewer"]);
    const interaction = classify({ executionBlocker: hold, executionState: null }, {
      pendingInteractions: [{ companyId, issueId: reviewIssueId, status: "pending" }],
    });
    expect(interaction.delivery.paths.map((path) => path.kind)).toEqual(["interaction"]);
  });

  it("a user participant stays a path on its own", () => {
    const { findings } = classify({
      executionState: { status: "pending", currentParticipant: { type: "user", userId: "board-user-1" } },
    });
    expect(findings).toEqual([]);
  });
});
