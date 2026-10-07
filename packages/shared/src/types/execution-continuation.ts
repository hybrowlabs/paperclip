/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  objectiveSource?: {
    kind: "comment" | "description" | "title";
    id: string;
    revision: string | null;
  };
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
    /** Set when the body was shortened to fit the wake payload budget. */
    bodyTruncated?: boolean;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  /** Present only when older comments were dropped to fit the wake payload budget. */
  truncation?: {
    reason: "wake_payload_budget";
    budgetBytes: number;
    totalMessageCount: number;
    includedMessageCount: number;
    droppedMessageCount: number;
    bodyTruncatedMessageCount: number;
    readHint: string;
  };
  coverage: {
    kind: "full_task_history" | "task_history_delta" | "task_history_truncated";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}
