/**
 * Scheduled-job health for a plugin.
 *
 * A plugin's worker can stay `ready` with no `last_error` while every
 * scheduled run fails (HYBA-876). This turns recent run history into one health
 * check so that failure is visible on `/health` and `/dashboard`.
 */

export const SCHEDULED_JOB_FAILURE_THRESHOLD = 3;

const MAX_ERROR_CHARS = 160;

export interface ScheduledJobRunSummary {
  jobId: string;
  status: string;
  error: string | null;
  createdAt: Date | string;
}

export interface ScheduledJobHealthCheck {
  name: "scheduled_jobs";
  passed: boolean;
  message: string;
}

function toMillis(value: Date | string): number {
  return new Date(value).getTime();
}

function shorten(error: string | null): string {
  if (!error) return "no error recorded";
  const flat = error.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}...` : flat;
}

/**
 * Fails when any job's most recent finished runs, counted from the newest, are
 * all failures and there are at least `threshold` of them. Pending and running
 * runs are ignored. One success ends the streak.
 */
export function evaluateScheduledJobHealth(
  runs: readonly ScheduledJobRunSummary[],
  jobKeys: ReadonlyMap<string, string>,
  threshold: number = SCHEDULED_JOB_FAILURE_THRESHOLD,
): ScheduledJobHealthCheck {
  const byJob = new Map<string, ScheduledJobRunSummary[]>();
  for (const run of runs) {
    if (run.status !== "failed" && run.status !== "succeeded") continue;
    const group = byJob.get(run.jobId);
    if (group) group.push(run);
    else byJob.set(run.jobId, [run]);
  }

  const failing: string[] = [];
  for (const [jobId, group] of byJob) {
    group.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    let streak = 0;
    for (const run of group) {
      if (run.status !== "failed") break;
      streak += 1;
    }
    if (streak >= threshold) {
      failing.push(
        `${jobKeys.get(jobId) ?? jobId}: ${streak} consecutive failed runs (latest: ${shorten(group[0]?.error ?? null)})`,
      );
    }
  }

  if (failing.length === 0) {
    return { name: "scheduled_jobs", passed: true, message: "No scheduled job is failing repeatedly" };
  }
  return { name: "scheduled_jobs", passed: false, message: failing.join("; ") };
}

export interface JobFailureLogInput {
  pluginId: string;
  companyId?: string | null;
  jobId: string;
  jobKey: string;
  runId?: string;
  trigger: string;
  durationMs: number;
  error: string;
}

export interface JobFailureLogRow {
  pluginId: string;
  companyId: string | null;
  level: "error";
  message: string;
  meta: Record<string, unknown>;
}

/**
 * Build the `plugin_logs` row for a failed scheduled or manual run. The row
 * carries identifiers and the error text only, never job params or payloads.
 */
export function buildJobFailureLogRow(input: JobFailureLogInput): JobFailureLogRow {
  return {
    pluginId: input.pluginId,
    companyId: input.companyId ?? null,
    level: "error",
    message: `Scheduled job "${input.jobKey}" failed: ${shorten(input.error)}`,
    meta: {
      source: "plugin-job-scheduler",
      jobId: input.jobId,
      jobKey: input.jobKey,
      runId: input.runId ?? null,
      trigger: input.trigger,
      durationMs: input.durationMs,
    },
  };
}
