import { getAgentWorkEligibility, isAgentInvokable } from "@paperclipai/shared";
import { buildIssueGraphLivenessIncidentKey } from "./origins.js";

export type IssueLivenessSeverity = "warning" | "critical";

export type IssueLivenessState =
  | "blocked_by_unassigned_issue"
  | "blocked_by_assigned_backlog_issue"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_issue"
  | "invalid_review_participant"
  | "in_review_without_action_path";

export interface IssueLivenessIssueInput {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  conversationState?: string | null;
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
  monitorNextCheckAt?: Date | string | null;
  monitorAttemptCount?: number | null;
  executionRunId?: string | null;
  executionBlocker?: IssueLivenessExecutionHold | null;
}

export interface IssueLivenessExecutionHold {
  recoveryActionId: string | null;
  runId: string | null;
  cause: string;
}

export interface IssueLivenessRelationInput {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
}

export interface IssueLivenessAgentInput {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
}

export interface IssueLivenessExecutionPathInput {
  id?: string | null;
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
  createdAt?: Date | string | null;
  runId?: string | null;
  runStatus?: string | null;
}

export interface IssueLivenessWaitingPathInput {
  id?: string | null;
  companyId: string;
  issueId: string;
  status: string;
  createdAt?: Date | string | null;
}

export type IssueReviewPathFactKind =
  | "execution_participant"
  | "interaction"
  | "approval"
  | "monitor"
  | "human_reviewer"
  | "active_run"
  | "queued_wake"
  | "recovery";

export interface IssueReviewPathFact {
  kind: IssueReviewPathFactKind;
  ref: string | null;
  agentId: string | null;
  userId: string | null;
  since: Date | string | null;
}

export type IssueReviewDeliveryFailureKind =
  | "participant_without_delivery_path"
  | "execution_blocker_hold"
  | "stale_deferred_wake"
  | "stale_wake"
  | "claimed_wake_terminal_run";

export interface IssueReviewDeliveryFailureFact {
  kind: IssueReviewDeliveryFailureKind;
  reason: string;
  ref: string | null;
  responderAgentId: string | null;
}

export interface IssueReviewDeliveryFacts {
  paths: IssueReviewPathFact[];
  failures: IssueReviewDeliveryFailureFact[];
  hold: IssueLivenessExecutionHold | null;
}

/** A wake row older than this, with no run and no lock holder, no longer counts as a delivery path. */
export const DEFAULT_REVIEW_WAKE_MAX_AGE_MS = 30 * 60_000;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export interface IssueLivenessDependencyPathEntry {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
}

export type IssueLivenessOwnerCandidateReason =
  | "stalled_blocker_assignee"
  | "assignee_reporting_chain"
  | "creator_reporting_chain"
  | "root_agent"
  | "ordered_invokable_fallback";

export interface IssueLivenessOwnerCandidate {
  agentId: string;
  reason: IssueLivenessOwnerCandidateReason;
  sourceIssueId: string;
}

export interface IssueLivenessFinding {
  issueId: string;
  companyId: string;
  identifier: string | null;
  state: IssueLivenessState;
  severity: IssueLivenessSeverity;
  reason: string;
  dependencyPath: IssueLivenessDependencyPathEntry[];
  recoveryIssueId: string;
  recommendedOwnerAgentId: string | null;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedOwnerCandidates: IssueLivenessOwnerCandidate[];
  recommendedAction: string;
  incidentKey: string;
}

export interface IssueGraphLivenessInput {
  issues: IssueLivenessIssueInput[];
  relations: IssueLivenessRelationInput[];
  agents: IssueLivenessAgentInput[];
  activeRuns?: IssueLivenessExecutionPathInput[];
  queuedWakeRequests?: IssueLivenessExecutionPathInput[];
  pendingInteractions?: IssueLivenessWaitingPathInput[];
  pendingApprovals?: IssueLivenessWaitingPathInput[];
  openRecoveryIssues?: IssueLivenessWaitingPathInput[];
  now?: Date | string;
  wakeMaxAgeMs?: number;
}

function issueLabel(issue: IssueLivenessIssueInput) {
  return issue.identifier ?? issue.id;
}

function pathEntry(issue: IssueLivenessIssueInput): IssueLivenessDependencyPathEntry {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
  };
}

function isInvokableAgent(
  agent: IssueLivenessAgentInput | null | undefined,
  agentsById: Map<string, IssueLivenessAgentInput>,
) {
  return Boolean(agent && isAgentInvokable({ agent, agents: [...agentsById.values()] }));
}

function hasActiveExecutionPath(
  issue: IssueLivenessIssueInput,
  input: IssueGraphLivenessInput,
) {
  const matches = (entry: IssueLivenessExecutionPathInput) =>
    entry.companyId === issue.companyId && entry.issueId === issue.id;
  if ((input.activeRuns ?? []).some(matches)) return true;
  const nowMs = readDateMs(input.now ?? new Date()) ?? Date.now();
  return (input.queuedWakeRequests ?? []).some(
    (entry) => matches(entry) && evaluateWake(entry, issue, nowMs, input.wakeMaxAgeMs).live,
  );
}

type WakeEvaluation =
  | { live: true }
  | { live: false; failure: IssueReviewDeliveryFailureFact | null };

function evaluateWake(
  entry: IssueLivenessExecutionPathInput,
  issue: IssueLivenessIssueInput,
  nowMs: number,
  maxAgeMs: number | undefined,
): WakeEvaluation {
  if (issue.executionBlocker) return { live: false, failure: null };
  const responderAgentId = entry.agentId ?? null;
  if (entry.status === "claimed") {
    if (entry.runStatus && TERMINAL_RUN_STATUSES.has(entry.runStatus)) {
      return {
        live: false,
        failure: {
          kind: "claimed_wake_terminal_run",
          reason: `A claimed wake points at run ${entry.runId ?? "(unknown)"}, which is ${entry.runStatus}. Nothing will finish it.`,
          ref: entry.id ?? null,
          responderAgentId,
        },
      };
    }
    return { live: true };
  }
  const queuedOrDeferred = entry.status === "queued" || entry.status === "deferred_issue_execution";
  if (queuedOrDeferred && !entry.runId && !issue.executionRunId) {
    const createdMs = readDateMs(entry.createdAt);
    const bound = maxAgeMs ?? DEFAULT_REVIEW_WAKE_MAX_AGE_MS;
    if (createdMs !== null && nowMs - createdMs > bound) {
      const deferred = entry.status === "deferred_issue_execution";
      return {
        live: false,
        failure: {
          kind: deferred ? "stale_deferred_wake" : "stale_wake",
          reason: deferred
            ? "A deferred wake has no run, the issue lock is free and it is older than the delivery bound. Nothing will promote it."
            : "A queued wake has no run and is older than the delivery bound.",
          ref: entry.id ?? null,
          responderAgentId,
        },
      };
    }
  }
  return { live: true };
}

function hasWaitingPath(
  companyId: string,
  issueId: string,
  waitingPaths: IssueLivenessWaitingPathInput[],
) {
  return waitingPaths.some((entry) => entry.companyId === companyId && entry.issueId === issueId);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readDateMs(value: unknown): number | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function monitorFromIssue(issue: IssueLivenessIssueInput) {
  const policyMonitor = readRecord(readRecord(issue.executionPolicy)?.monitor);
  const stateMonitor = readRecord(readRecord(issue.executionState)?.monitor);
  return { policyMonitor, stateMonitor };
}

export function hasScheduledIssueMonitorPath(issue: IssueLivenessIssueInput, now: Date | string | number) {
  const nowMs = typeof now === "number" ? now : readDateMs(now) ?? Date.now();
  const nextCheckAtMs = readDateMs(issue.monitorNextCheckAt);
  if (nextCheckAtMs === null || nextCheckAtMs <= nowMs) return false;

  const { policyMonitor, stateMonitor } = monitorFromIssue(issue);
  const timeoutAtMs = readDateMs(policyMonitor?.timeoutAt ?? stateMonitor?.timeoutAt);
  if (timeoutAtMs !== null && timeoutAtMs <= nowMs) return false;

  const maxAttempts = readPositiveInteger(policyMonitor?.maxAttempts ?? stateMonitor?.maxAttempts);
  const stateAttemptCount = readPositiveInteger(stateMonitor?.attemptCount) ?? 0;
  const attemptCount = issue.monitorAttemptCount ?? stateAttemptCount;
  if (maxAttempts !== null && attemptCount >= maxAttempts) return false;

  return true;
}

export function classifyIssueReviewPaths(
  input: IssueGraphLivenessInput,
  issue: IssueLivenessIssueInput,
): IssueReviewPathFact[] {
  return classifyIssueReviewDelivery(input, issue).paths;
}

export function classifyIssueReviewDelivery(
  input: IssueGraphLivenessInput,
  issue: IssueLivenessIssueInput,
): IssueReviewDeliveryFacts {
  const hold = issue.executionBlocker ?? null;
  const facts: IssueReviewDeliveryFacts = { paths: [], failures: [], hold };
  if (issue.status !== "in_review") return facts;
  const nowMs = readDateMs(input.now ?? new Date()) ?? Date.now();
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  if (issue.conversationAgentId && issue.conversationUserId && issue.conversationState === "waiting") {
    facts.paths = [{ kind: "human_reviewer", ref: issue.conversationUserId, userId: issue.conversationUserId, agentId: null, since: null }];
    return facts;
  }

  const supporting: IssueReviewPathFact[] = [];
  const wakes: IssueReviewPathFact[] = [];

  if (issue.assigneeUserId) {
    supporting.push({
      kind: "human_reviewer",
      ref: issue.assigneeUserId,
      agentId: null,
      userId: issue.assigneeUserId,
      since: null,
    });
  }

  if (hasScheduledIssueMonitorPath(issue, nowMs)) {
    supporting.push({ kind: "monitor", ref: null, agentId: issue.assigneeAgentId ?? null, userId: null, since: null });
  }

  for (const entry of input.activeRuns ?? []) {
    if (entry.companyId !== issue.companyId || entry.issueId !== issue.id) continue;
    supporting.push({
      kind: "active_run",
      ref: entry.id ?? null,
      agentId: entry.agentId ?? null,
      userId: null,
      since: entry.createdAt ?? null,
    });
  }

  for (const entry of input.queuedWakeRequests ?? []) {
    if (entry.companyId !== issue.companyId || entry.issueId !== issue.id) continue;
    const evaluation = evaluateWake(entry, issue, nowMs, input.wakeMaxAgeMs);
    if (!evaluation.live) {
      if (evaluation.failure) facts.failures.push(evaluation.failure);
      continue;
    }
    wakes.push({
      kind: "queued_wake",
      ref: entry.id ?? null,
      agentId: entry.agentId ?? null,
      userId: null,
      since: entry.createdAt ?? null,
    });
  }

  const appendWaitingPaths = (
    entries: IssueLivenessWaitingPathInput[],
    kind: "interaction" | "approval" | "recovery",
  ) => {
    for (const entry of entries) {
      if (entry.companyId !== issue.companyId || entry.issueId !== issue.id) continue;
      supporting.push({
        kind,
        ref: entry.id ?? null,
        agentId: null,
        userId: null,
        since: entry.createdAt ?? null,
      });
    }
  };
  appendWaitingPaths(input.pendingInteractions ?? [], "interaction");
  appendWaitingPaths(input.pendingApprovals ?? [], "approval");
  appendWaitingPaths(input.openRecoveryIssues ?? [], "recovery");

  if (hold) {
    facts.failures.unshift({
      kind: "execution_blocker_hold",
      reason: "held: execution reconciliation needed",
      ref: hold.recoveryActionId,
      responderAgentId: null,
    });
  }

  const participant = issue.executionState?.status === "pending"
    ? issue.executionState.currentParticipant
    : null;
  const participantAgentId = readPrincipalAgentId(participant);
  if (participantAgentId) {
    const participantAgent = agentsById.get(participantAgentId);
    if (participantAgent?.companyId === issue.companyId && isInvokableAgent(participantAgent, agentsById)) {
      const participantWakes = wakes.filter((wake) => wake.agentId === participantAgentId);
      const delivered = [...supporting, ...participantWakes];
      if (delivered.length === 0) {
        facts.failures.push({
          kind: "participant_without_delivery_path",
          reason: "participant named, no delivery path",
          ref: participantAgentId,
          responderAgentId: participantAgentId,
        });
        return facts;
      }
      facts.paths = [
        {
          kind: "execution_participant",
          ref: participantAgentId,
          agentId: participantAgentId,
          userId: null,
          since: null,
        },
        ...delivered,
      ];
      return facts;
    }
    facts.paths = [...supporting, ...wakes];
    return facts;
  }
  if (principalIsResolvableUser(participant)) {
    const userId = (participant as Record<string, unknown>).userId as string;
    facts.paths = [
      { kind: "execution_participant", ref: userId, agentId: null, userId, since: null },
      ...supporting,
      ...wakes,
    ];
    return facts;
  }

  facts.paths = [...supporting, ...wakes];
  return facts;
}

function readPrincipalAgentId(principal: unknown): string | null {
  if (!principal || typeof principal !== "object") return null;
  const value = principal as Record<string, unknown>;
  return value.type === "agent" && typeof value.agentId === "string" && value.agentId.length > 0
    ? value.agentId
    : null;
}

function principalIsResolvableUser(principal: unknown): boolean {
  if (!principal || typeof principal !== "object") return false;
  const value = principal as Record<string, unknown>;
  return value.type === "user" && typeof value.userId === "string" && value.userId.length > 0;
}

function addOwnerCandidate(
  candidates: IssueLivenessOwnerCandidate[],
  seen: Set<string>,
  agentsById: Map<string, IssueLivenessAgentInput>,
  companyId: string,
  agentId: string | null | undefined,
  reason: IssueLivenessOwnerCandidateReason,
  sourceIssueId: string,
) {
  if (!agentId || seen.has(agentId)) return;
  const agent = agentsById.get(agentId);
  if (!agent || agent.companyId !== companyId || !isInvokableAgent(agent, agentsById)) return;
  seen.add(agentId);
  candidates.push({ agentId, reason, sourceIssueId });
}

function addAgentChainCandidates(
  candidates: IssueLivenessOwnerCandidate[],
  seen: Set<string>,
  startAgentId: string | null | undefined,
  agentsById: Map<string, IssueLivenessAgentInput>,
  companyId: string,
  reason: IssueLivenessOwnerCandidateReason,
  sourceIssueId: string,
) {
  const chainSeen = new Set<string>();
  let current = startAgentId ? agentsById.get(startAgentId) : null;

  while (current?.reportsTo) {
    if (chainSeen.has(current.reportsTo)) break;
    chainSeen.add(current.reportsTo);
    const manager = agentsById.get(current.reportsTo);
    if (!manager || manager.companyId !== companyId) break;
    addOwnerCandidate(candidates, seen, agentsById, companyId, manager.id, reason, sourceIssueId);
    current = manager;
  }
}

function orderedInvokableAgents(
  agents: IssueLivenessAgentInput[],
  agentsById: Map<string, IssueLivenessAgentInput>,
  companyId: string,
) {
  return agents
    .filter((agent) => agent.companyId === companyId && isInvokableAgent(agent, agentsById))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function ownerCandidatesForRecoveryIssue(
  issue: IssueLivenessIssueInput,
  agents: IssueLivenessAgentInput[],
  agentsById: Map<string, IssueLivenessAgentInput>,
  options: {
    includeStalledAssignee?: boolean;
  } = {},
) {
  const candidates: IssueLivenessOwnerCandidate[] = [];
  const seen = new Set<string>();

  if (options.includeStalledAssignee && issue.status !== "cancelled" && issue.status !== "done") {
    addOwnerCandidate(
      candidates,
      seen,
      agentsById,
      issue.companyId,
      issue.assigneeAgentId,
      "stalled_blocker_assignee",
      issue.id,
    );
  }

  addAgentChainCandidates(
    candidates,
    seen,
    issue.assigneeAgentId,
    agentsById,
    issue.companyId,
    "assignee_reporting_chain",
    issue.id,
  );
  addAgentChainCandidates(
    candidates,
    seen,
    issue.createdByAgentId,
    agentsById,
    issue.companyId,
    "creator_reporting_chain",
    issue.id,
  );

  const invokableAgents = orderedInvokableAgents(agents, agentsById, issue.companyId);
  for (const agent of invokableAgents) {
    if (!agent.reportsTo) {
      addOwnerCandidate(candidates, seen, agentsById, issue.companyId, agent.id, "root_agent", issue.id);
    }
  }
  for (const agent of invokableAgents) {
    addOwnerCandidate(
      candidates,
      seen,
      agentsById,
      issue.companyId,
      agent.id,
      "ordered_invokable_fallback",
      issue.id,
    );
  }

  return candidates;
}

function incidentKey(input: {
  companyId: string;
  issueId: string;
  state: IssueLivenessState;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}) {
  return buildIssueGraphLivenessIncidentKey(input);
}

function finding(input: {
  issue: IssueLivenessIssueInput;
  state: IssueLivenessState;
  severity?: IssueLivenessSeverity;
  reason: string;
  dependencyPath: IssueLivenessIssueInput[];
  recoveryIssue: IssueLivenessIssueInput;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedOwnerCandidates: IssueLivenessOwnerCandidate[];
  recommendedAction: string;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}): IssueLivenessFinding {
  return {
    issueId: input.issue.id,
    companyId: input.issue.companyId,
    identifier: input.issue.identifier,
    state: input.state,
    severity: input.severity ?? "critical",
    reason: input.reason,
    dependencyPath: input.dependencyPath.map(pathEntry),
    recoveryIssueId: input.recoveryIssue.id,
    recommendedOwnerAgentId: input.recommendedOwnerCandidateAgentIds[0] ?? null,
    recommendedOwnerCandidateAgentIds: input.recommendedOwnerCandidateAgentIds,
    recommendedOwnerCandidates: input.recommendedOwnerCandidates,
    recommendedAction: input.recommendedAction,
    incidentKey: incidentKey({
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      state: input.state,
      blockerIssueId: input.blockerIssueId,
      participantAgentId: input.participantAgentId,
    }),
  };
}

export function classifyIssueGraphLiveness(input: IssueGraphLivenessInput): IssueLivenessFinding[] {
  const nowMs = readDateMs(input.now ?? new Date()) ?? Date.now();
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const blockersByBlockedIssueId = new Map<string, IssueLivenessRelationInput[]>();
  const unresolvedBlockers = new Set<string>();
  const findings: IssueLivenessFinding[] = [];
  const pendingInteractions = input.pendingInteractions ?? [];
  const pendingApprovals = input.pendingApprovals ?? [];
  const openRecoveryIssues = input.openRecoveryIssues ?? [];

  for (const relation of input.relations) {
    const list = blockersByBlockedIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation);
    blockersByBlockedIssueId.set(relation.blockedIssueId, list);

    const blocker = issuesById.get(relation.blockerIssueId);
    const blocked = issuesById.get(relation.blockedIssueId);
    if (
      blocker &&
      blocked &&
      blocker.companyId === relation.companyId &&
      blocked.companyId === relation.companyId &&
      blocker.status !== "done" &&
      blocker.status !== "cancelled" &&
      blocked.status === "blocked"
    ) {
      unresolvedBlockers.add(blocker.id);
    }
  }

  for (const relations of blockersByBlockedIssueId.values()) {
    relations.sort((left, right) => {
      const leftIssue = issuesById.get(left.blockerIssueId);
      const rightIssue = issuesById.get(right.blockerIssueId);
      const leftLabel = leftIssue ? issueLabel(leftIssue) : left.blockerIssueId;
      const rightLabel = rightIssue ? issueLabel(rightIssue) : right.blockerIssueId;
      return leftLabel.localeCompare(rightLabel);
    });
  }

  function hasExplicitWaitingPath(issue: IssueLivenessIssueInput) {
    return Boolean(issue.assigneeUserId) ||
      hasScheduledIssueMonitorPath(issue, nowMs) ||
      hasActiveExecutionPath(issue, input) ||
      hasWaitingPath(issue.companyId, issue.id, pendingInteractions) ||
      hasWaitingPath(issue.companyId, issue.id, pendingApprovals) ||
      hasWaitingPath(issue.companyId, issue.id, openRecoveryIssues);
  }

  function reviewFinding(
    source: IssueLivenessIssueInput,
    reviewIssue: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
  ): IssueLivenessFinding | null {
    if (reviewIssue.status !== "in_review") return null;
    const delivery = classifyIssueReviewDelivery(input, reviewIssue);
    if (delivery.paths.length > 0) return null;
    if (delivery.hold) return null;

    const ownerCandidates = ownerCandidatesForRecoveryIssue(reviewIssue, input.agents, agentsById, {
      includeStalledAssignee: true,
    });

    const hasPendingExecutionState = reviewIssue.executionState?.status === "pending";
    const participant = hasPendingExecutionState
      ? reviewIssue.executionState?.currentParticipant
      : null;
    const participantAgentId = readPrincipalAgentId(participant);
    if (participantAgentId) {
      const participantAgent = agentsById.get(participantAgentId);
      if (isInvokableAgent(participantAgent, agentsById) && participantAgent?.companyId === reviewIssue.companyId) {
        const failure = delivery.failures.find((entry) => entry.kind === "participant_without_delivery_path");
        if (!failure) return null;
        return finding({
          issue: source,
          state: "in_review_without_action_path",
          reason: `${issueLabel(reviewIssue)} is in review, participant named, no delivery path: no active run, wake that can still deliver, monitor, interaction or approval reaches ${participantAgent?.name ?? participantAgentId}.`,
          dependencyPath,
          recoveryIssue: reviewIssue,
          recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
          recommendedOwnerCandidates: ownerCandidates,
          recommendedAction:
            `Re-wake ${participantAgent?.name ?? participantAgentId} for ${issueLabel(reviewIssue)}'s current review stage, or return the issue to its maker with a clear change request.`,
          blockerIssueId: reviewIssue.id,
          participantAgentId,
        });
      }

      return finding({
        issue: source,
        state: "invalid_review_participant",
        reason: participantAgent
          ? `${issueLabel(reviewIssue)} is in review, but current participant agent is ${participantAgent.status}.`
          : `${issueLabel(reviewIssue)} is in review, but current participant agent cannot be resolved.`,
        dependencyPath,
        recoveryIssue: reviewIssue,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${issueLabel(reviewIssue)}'s review participant or return the issue to an active assignee with a clear change request.`,
        participantAgentId,
      });
    }

    if (principalIsResolvableUser(participant)) return null;

    if (hasPendingExecutionState) {
      return finding({
        issue: source,
        state: "invalid_review_participant",
        reason: `${issueLabel(reviewIssue)} is in review, but its current participant cannot be resolved.`,
        dependencyPath,
        recoveryIssue: reviewIssue,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${issueLabel(reviewIssue)}'s review participant or return the issue to an active assignee with a clear change request.`,
      });
    }

    if (!reviewIssue.assigneeAgentId || reviewIssue.assigneeUserId) return null;

    return finding({
      issue: source,
      state: "in_review_without_action_path",
      reason: `${issueLabel(reviewIssue)} is in review with an agent assignee but no participant, interaction, approval, user owner, wake, active run, or recovery issue owning the next action.`,
      dependencyPath,
      recoveryIssue: reviewIssue,
      recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
      recommendedOwnerCandidates: ownerCandidates,
      recommendedAction:
        `Review ${issueLabel(reviewIssue)} and make the next action explicit: add a reviewer/interaction, return it to active work with a change request, mark it done if accepted, or open a bounded recovery issue.`,
      blockerIssueId: reviewIssue.id,
    });
  }

  function blockedFindingForLeaf(
    source: IssueLivenessIssueInput,
    blocker: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
  ): IssueLivenessFinding | null {
    const ownerCandidates = ownerCandidatesForRecoveryIssue(blocker, input.agents, agentsById, {
      includeStalledAssignee: true,
    });

    if (blocker.status === "cancelled") {
      return finding({
        issue: source,
        state: "blocked_by_cancelled_issue",
        reason: `${issueLabel(source)} is still blocked by cancelled issue ${issueLabel(blocker)}.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Inspect ${issueLabel(blocker)} and either remove it from ${issueLabel(source)}'s blockers or replace it with an actionable unblock issue.`,
        blockerIssueId: blocker.id,
      });
    }

    if (hasExplicitWaitingPath(blocker)) return null;

    if (blocker.status === "in_review") {
      return reviewFinding(source, blocker, dependencyPath);
    }

    if (blocker.status === "backlog" && blocker.assigneeAgentId) {
      return finding({
        issue: source,
        state: "blocked_by_assigned_backlog_issue",
        reason: `${issueLabel(source)} is blocked by assigned backlog issue ${issueLabel(blocker)} with no wake, active run, human owner, interaction, approval, monitor, or recovery issue owning the next action.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Review ${issueLabel(blocker)} and either move it to todo so the assignee wakes, assign a human owner or interaction if it is intentionally parked, or remove it from ${issueLabel(source)}'s blockers if it is no longer required.`,
        blockerIssueId: blocker.id,
      });
    }

    if (!blocker.assigneeAgentId && !blocker.assigneeUserId) {
      return finding({
        issue: source,
        state: "blocked_by_unassigned_issue",
        reason: `${issueLabel(source)} is blocked by unassigned issue ${issueLabel(blocker)} with no user owner.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Assign ${issueLabel(blocker)} to an owner who can complete it, or remove it from ${issueLabel(source)}'s blockers if it is no longer required.`,
        blockerIssueId: blocker.id,
      });
    }

    if (!blocker.assigneeAgentId) return null;

    const blockerAgent = agentsById.get(blocker.assigneeAgentId);
    const blockerEligibility = blockerAgent
      ? getAgentWorkEligibility({ agent: blockerAgent, agents: input.agents })
      : null;
    if (!blockerAgent || blockerAgent.companyId !== source.companyId || !blockerEligibility?.invokable) {
      return finding({
        issue: source,
        state: "blocked_by_uninvokable_assignee",
        reason: blockerAgent
          ? `${issueLabel(source)} is blocked by ${issueLabel(blocker)}, but its assignee is ${blockerEligibility?.invokabilityReason === "invalid_org_chain" ? "in an invalid org chain" : blockerAgent.status}.`
          : `${issueLabel(source)} is blocked by ${issueLabel(blocker)}, but its assignee no longer exists.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Review ${issueLabel(blocker)} and assign it to an active owner or replace the blocker with an actionable issue.`,
        blockerIssueId: blocker.id,
      });
    }

    return null;
  }

  function firstBlockedChainFinding(
    source: IssueLivenessIssueInput,
    current: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
    seen: Set<string>,
  ): IssueLivenessFinding | null {
    if (seen.has(current.id)) return null;
    seen.add(current.id);

    const relations = blockersByBlockedIssueId.get(current.id) ?? [];
    for (const relation of relations) {
      if (relation.companyId !== current.companyId || relation.companyId !== source.companyId) continue;
      const blocker = issuesById.get(relation.blockerIssueId);
      if (!blocker || blocker.companyId !== source.companyId || blocker.status === "done") continue;
      const path = [...dependencyPath, blocker];

      if (blocker.status === "blocked") {
        const nested = firstBlockedChainFinding(source, blocker, path, new Set(seen));
        if (nested) return nested;
        if (hasExplicitWaitingPath(blocker)) continue;
      }

      const leafFinding = blockedFindingForLeaf(source, blocker, path);
      if (leafFinding) return leafFinding;
    }

    return null;
  }

  for (const issue of input.issues) {
    const hasUnresolvedBlockerEdge = (blockersByBlockedIssueId.get(issue.id) ?? []).some((relation) => {
      if (relation.companyId !== issue.companyId) return false;
      const blocker = issuesById.get(relation.blockerIssueId);
      return Boolean(blocker && blocker.companyId === issue.companyId && blocker.status !== "done");
    });
    const shouldInspectBlockedChain = issue.status === "blocked" || (
      issue.status !== "done" &&
      issue.status !== "cancelled" &&
      Boolean(issue.assigneeAgentId) &&
      hasUnresolvedBlockerEdge
    );

    let chainFinding: IssueLivenessFinding | null = null;
    if (shouldInspectBlockedChain) {
      if (unresolvedBlockers.has(issue.id)) continue;
      chainFinding = firstBlockedChainFinding(issue, issue, [issue], new Set());
      if (chainFinding) findings.push(chainFinding);
    }

    if (issue.status === "in_review" && !chainFinding && !unresolvedBlockers.has(issue.id)) {
      const review = reviewFinding(issue, issue, [issue]);
      if (review) findings.push(review);
    }
  }

  return findings;
}
