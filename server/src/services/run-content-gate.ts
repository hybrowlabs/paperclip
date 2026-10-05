import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  runContentAuditEvents,
  runContentCapabilities,
  runContentForensicGrants,
  runContentRestrictions,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const RUN_CONTENT_POLICY_VERSION = 1;
export const RUN_CONTENT_MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export const RUN_CONTENT_PURPOSES = [
  "list_runs",
  "read_run",
  "live_runs",
  "issue_runs",
  "read_events",
  "read_log",
  "list_workspace_operations",
  "read_workspace_operation",
  "read_workspace_operation_log",
  "inspect_provider_trace",
  "reveal_provider_trace_frame",
  "download_provider_trace",
  "failed_run_report",
  "sentry_report",
  "export",
  "live_stream",
  "derive_issue_comment",
  "feedback_export",
  "tool_decisions",
  "plugin_stream",
] as const;
export type RunContentPurpose = (typeof RUN_CONTENT_PURPOSES)[number];
export const RUN_CONTENT_MUTATION_PURPOSES = ["delete_provider_trace", "reproject_provider_trace", "retry_failed_run"] as const;
export type RunContentMutationPurpose = (typeof RUN_CONTENT_MUTATION_PURPOSES)[number];

export type RunContentLeaseKind =
  | "http_read"
  | "stream"
  | "download"
  | "egress"
  | "internal_read"
  | "company_watch";

export type RunContentTombstone = {
  runId: string;
  companyId: string;
  state: "restricted";
  createdAt: string | null;
  contentWithheld: true;
};

export type RunContentDecision =
  | { decision: "ordinary"; epoch: number; policyVersion: number }
  | { decision: "forensic"; epoch: number; policyVersion: number; grantId: string }
  | { decision: "deny"; reason: RunContentDenyReason; tombstone: RunContentTombstone | null };

export type RunContentDenyReason =
  | "unknown_run"
  | "restricted"
  | "restricting"
  | "releasing"
  | "unknown_state"
  | "unrecognized_policy_version"
  | "lookup_error"
  | "audit_failure"
  | "lease_error"
  | "lease_expired"
  | "lease_revoked"
  | "lease_released"
  | "unclassifiable_job"
  | "grant_not_valid";

export class RunContentDeniedError extends Error {
  readonly status = 403;
  constructor(
    readonly reason: RunContentDenyReason,
    readonly tombstone: RunContentTombstone | null = null,
  ) {
    super(`run_content_denied:${reason}`);
    this.name = "RunContentDeniedError";
  }
}

export type RunContentGateOptions = {
  enabled?: boolean;
  instanceId?: string;
  leaseTtlMs?: number;
  clockSkewMs?: number;
  tickMs?: number;
  drainPollMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
};

export type AuthorizeInput = {
  companyId: string;
  runId: string;
  actorId: string | null;
  routePurpose: RunContentPurpose;
};

export type RunContentLease = {
  id: string;
  grantId: string | null;
  decision: "ordinary" | "forensic";
  runIds: string[];
  signal: AbortSignal;
  checkpoint(): Promise<void>;
  emit<T>(write: () => T): T;
  release(reason?: string): Promise<void>;
};

export type TransitionReceipt = { from: string; to: string; epoch: number; at: string };

export type ActivationReceipt = {
  outcome: "restricted" | "incomplete" | "released";
  state: string;
  epoch: number;
  transitions: TransitionReceipt[];
  drained: {
    revoked: number;
    releasedByHolder: number;
    revokedAcked: number;
    expiredReaped: number;
    restartReaped: number;
    stillOpen: number;
  };
  capabilities: {
    inventoried: number;
    revoked: number;
    residual: Array<{
      id: string;
      kind: string;
      issuer: string;
      destinationClass: string;
      expiresAt: string | null;
    }>;
  };
  containment: "full" | "partial" | "none";
  storageCustody: "not_attested_by_server";
  gateMode: "enforcing" | "bypass_for_unrestricted";
};

type SqlLike = Pick<Db, "execute" | "select" | "insert" | "update">;

type LocalLease = {
  id: string;
  companyId: string;
  runIds: string[];
  grantId: string | null;
  deadlineMono: number;
  fenced: RunContentDenyReason | null;
  released: boolean;
  controller: AbortController;
  kind: RunContentLeaseKind;
};

type LocalWatcher = {
  id: string;
  companyId: string;
  deadlineMono: number;
  restricted: Set<string>;
  closed: boolean;
};

const KNOWN_STATES = new Set(["restricting", "restricted", "releasing", "released"]);

function companyLockKey(companyId: string) {
  return `paperclip:run-content:${companyId}`;
}

function lockCompany(tx: SqlLike, companyId: string, mode: "shared" | "exclusive") {
  return mode === "shared"
    ? tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${companyLockKey(companyId)}, 0))`)
    : tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyLockKey(companyId)}, 0))`);
}

function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function tombstone(companyId: string, runId: string, createdAt: Date | null): RunContentTombstone {
  return { runId, companyId, state: "restricted", createdAt: createdAt ? createdAt.toISOString() : null, contentWithheld: true };
}

export function sha256Hex(input: Buffer | string) {
  return createHash("sha256").update(input).digest("hex");
}

export function runContentGate(db: Db, options: RunContentGateOptions = {}) {
  const enabled = options.enabled ?? true;
  const instanceId = options.instanceId ?? randomUUID();
  const bootId = randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? 15_000;
  const clockSkewMs = options.clockSkewMs ?? 2_000;
  const tickMs = options.tickMs ?? 2_000;
  const drainPollMs = options.drainPollMs ?? 100;
  const now = options.now ?? (() => new Date());
  const mono = options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const dbx = db as unknown as SqlLike & Db;

  const local = new Map<string, LocalLease>();
  const watchers = new Map<string, LocalWatcher>();
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let stopped = false;

  async function audit(
    exec: Pick<Db, "insert">,
    input: {
      companyId: string;
      runId: string;
      eventKind: string;
      result: string;
      actorId?: string | null;
      grantId?: string | null;
      authorizationRef?: string | null;
      operation?: string | null;
      epoch?: number | null;
      byteCount?: number | null;
      sha256?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    await exec.insert(runContentAuditEvents).values({
      companyId: input.companyId,
      runId: input.runId,
      eventKind: input.eventKind,
      result: input.result,
      actorId: input.actorId ?? null,
      grantId: input.grantId ?? null,
      authorizationRef: input.authorizationRef ?? null,
      operation: input.operation ?? null,
      epoch: input.epoch ?? null,
      policyVersion: RUN_CONTENT_POLICY_VERSION,
      byteCount: input.byteCount ?? null,
      sha256: input.sha256 ?? null,
      metadata: input.metadata ?? null,
    });
  }

  async function lookup(exec: Pick<Db, "select">, companyId: string, runId: string) {
    const rows = await exec
      .select({
        runId: heartbeatRuns.id,
        runCreatedAt: heartbeatRuns.createdAt,
        state: runContentRestrictions.state,
        epoch: runContentRestrictions.epoch,
        policyVersion: runContentRestrictions.policyVersion,
      })
      .from(heartbeatRuns)
      .leftJoin(
        runContentRestrictions,
        and(
          eq(runContentRestrictions.companyId, heartbeatRuns.companyId),
          eq(runContentRestrictions.runId, heartbeatRuns.id),
        ),
      )
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function findLiveGrant(
    exec: Pick<Db, "select">,
    input: { companyId: string; runId: string; actorId: string | null; operation: string },
  ) {
    if (!input.actorId) return null;
    const rows = await exec
      .select()
      .from(runContentForensicGrants)
      .where(
        and(
          eq(runContentForensicGrants.companyId, input.companyId),
          eq(runContentForensicGrants.runId, input.runId),
          eq(runContentForensicGrants.granteeActorId, input.actorId),
          sql`${runContentForensicGrants.revokedAt} is null`,
          sql`${runContentForensicGrants.expiresAt} > ${now().toISOString()}::timestamptz`,
          sql`${input.operation} = any(${runContentForensicGrants.allowedOperations})`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function decide(
    exec: Pick<Db, "select" | "insert">,
    input: AuthorizeInput,
    opts: { allowForensic?: boolean } = {},
  ): Promise<RunContentDecision> {
    const allowForensic = opts.allowForensic ?? true;
    let row: Awaited<ReturnType<typeof lookup>>;
    try {
      row = await lookup(exec, input.companyId, input.runId);
    } catch (error) {
      logger.warn({ err: error, runId: input.runId }, "run content restriction lookup failed; denying content");
      return { decision: "deny", reason: "lookup_error", tombstone: null };
    }
    if (!row) return { decision: "deny", reason: "unknown_run", tombstone: null };
    if (row.state === null) return { decision: "ordinary", epoch: 0, policyVersion: RUN_CONTENT_POLICY_VERSION };
    const epoch = Number(row.epoch ?? 0);
    if (!KNOWN_STATES.has(row.state)) {
      return { decision: "deny", reason: "unknown_state", tombstone: tombstone(input.companyId, input.runId, row.runCreatedAt) };
    }
    if ((row.policyVersion ?? 0) > RUN_CONTENT_POLICY_VERSION) {
      return { decision: "deny", reason: "unrecognized_policy_version", tombstone: tombstone(input.companyId, input.runId, row.runCreatedAt) };
    }
    if (row.state === "released") return { decision: "ordinary", epoch, policyVersion: row.policyVersion ?? 1 };
    const tomb = tombstone(input.companyId, input.runId, row.runCreatedAt);
    if (row.state === "restricted" && allowForensic) {
      try {
        const grant = await findLiveGrant(exec, { ...input, operation: input.routePurpose });
        if (grant) {
          await audit(exec, {
            companyId: input.companyId,
            runId: input.runId,
            eventKind: "access_granted",
            result: "forensic",
            actorId: input.actorId,
            grantId: grant.id,
            authorizationRef: grant.authorizationRef,
            operation: input.routePurpose,
            epoch,
          });
          return { decision: "forensic", epoch, policyVersion: row.policyVersion ?? 1, grantId: grant.id };
        }
      } catch (error) {
        logger.warn({ err: error, runId: input.runId }, "forensic grant lookup/audit failed; denying content");
        return { decision: "deny", reason: "audit_failure", tombstone: tomb };
      }
    }
    await audit(exec, {
      companyId: input.companyId,
      runId: input.runId,
      eventKind: "access_denied",
      result: row.state,
      actorId: input.actorId,
      operation: input.routePurpose,
      epoch,
    }).catch(() => {});
    return { decision: "deny", reason: row.state as RunContentDenyReason, tombstone: tomb };
  }

  async function authorizeRunMutation(input: {
    companyId: string;
    runId: string;
    actorId: string | null;
    routePurpose: RunContentMutationPurpose;
  }): Promise<{ allowed: true } | { allowed: false; error: RunContentDeniedError }> {
    try {
      const row = await lookup(dbx, input.companyId, input.runId);
      if (!row) return { allowed: false, error: new RunContentDeniedError("unknown_run") };
      if (row.state === null || row.state === "released") return { allowed: true };
      await audit(dbx, {
        companyId: input.companyId,
        runId: input.runId,
        eventKind: "mutation_denied",
        result: row.state,
        actorId: input.actorId,
        operation: input.routePurpose,
        epoch: Number(row.epoch ?? 0),
      }).catch(() => {});
      return {
        allowed: false,
        error: new RunContentDeniedError(
          KNOWN_STATES.has(row.state) ? (row.state as RunContentDenyReason) : "unknown_state",
          tombstone(input.companyId, input.runId, row.runCreatedAt),
        ),
      };
    } catch (error) {
      logger.warn({ err: error, runId: input.runId }, "run mutation decision failed; denying");
      return { allowed: false, error: new RunContentDeniedError("lookup_error") };
    }
  }

  async function authorizeRunContent(input: AuthorizeInput): Promise<RunContentDecision> {
    try {
      return await decide(dbx, input);
    } catch (error) {
      logger.warn({ err: error, runId: input.runId }, "run content decision failed; denying content");
      return { decision: "deny", reason: "lookup_error", tombstone: null };
    }
  }

  function ensureTicker() {
    if (!enabled || timer || stopped) return;
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.();
  }

  function fence(lease: LocalLease, reason: RunContentDenyReason) {
    if (lease.fenced) return;
    lease.fenced = reason;
    lease.controller.abort(new RunContentDeniedError(reason));
  }

  async function ackRelease(lease: LocalLease, reason: string) {
    if (lease.released) return;
    lease.released = true;
    local.delete(lease.id);
    await dbx
      .execute(sql`update run_content_leases set released_at = now(), release_reason = ${reason} where id = ${lease.id} and released_at is null`)
      .catch((error) => logger.warn({ err: error, leaseId: lease.id }, "run content lease release failed"));
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    const started = mono();
    try {
      const mine = [...local.values()].filter((l) => !l.released);
      if (mine.length > 0) {
        const renewed = rowsOf<{ id: string }>(
          await dbx.execute(sql`
            update run_content_leases
               set expires_at = now() + (${leaseTtlMs} * interval '1 millisecond')
             where holder_instance_id = ${instanceId}
               and holder_boot_id = ${bootId}
               and released_at is null
               and revoked_at is null
               and kind <> 'company_watch'
            returning id`),
        );
        const renewedIds = new Set(renewed.map((r) => r.id));
        for (const lease of mine) {
          if (lease.kind === "company_watch" || lease.id.startsWith("bypass:")) continue;
          if (renewedIds.has(lease.id)) {
            lease.deadlineMono = started + leaseTtlMs - clockSkewMs;
          } else {
            fence(lease, "lease_revoked");
          }
        }
        const grantLeases = mine.filter((l) => l.grantId && !l.fenced);
        for (const lease of grantLeases) {
          const live = rowsOf(
            await dbx.execute(sql`
              select 1 from run_content_forensic_grants
               where id = ${lease.grantId}
                 and revoked_at is null
                 and expires_at > ${now().toISOString()}::timestamptz`),
          );
          if (live.length === 0) {
            await dbx.execute(sql`update run_content_leases set revoked_at = now(), revoke_reason = 'grant_not_valid' where id = ${lease.id} and released_at is null`);
            fence(lease, "grant_not_valid");
          }
        }
      }
      for (const watcher of watchers.values()) {
        if (watcher.closed) continue;
        const restricted = await loadRestrictedMap(dbx, watcher.companyId);
        const ack = Object.fromEntries(restricted);
        const updated = rowsOf(
          await dbx.execute(sql`
            update run_content_leases
               set expires_at = now() + (${leaseTtlMs} * interval '1 millisecond'),
                   epochs = ${JSON.stringify(ack)}::jsonb
             where id = ${watcher.id} and released_at is null
            returning id`),
        );
        if (updated.length === 0) {
          watcher.restricted = new Set(["*"]);
          watcher.deadlineMono = -Infinity;
          continue;
        }
        watcher.restricted = new Set(restricted.keys());
        watcher.deadlineMono = started + leaseTtlMs - clockSkewMs;
      }
    } catch (error) {
      logger.warn({ err: error }, "run content lease maintenance failed; holders will lapse fail-closed");
    } finally {
      ticking = false;
    }
  }

  async function loadRestrictedMap(exec: SqlLike, companyId: string) {
    const rows = rowsOf<{ run_id: string; epoch: string | number }>(
      await exec.execute(sql`
        select run_id, epoch from run_content_restrictions
         where company_id = ${companyId} and state <> 'released'`),
    );
    return new Map(rows.map((r) => [r.run_id, Number(r.epoch)]));
  }

  function makeLease(row: {
    id: string;
    companyId: string;
    runIds: string[];
    decision: "ordinary" | "forensic";
    grantId: string | null;
    kind: LocalLeaseKindInput;
    startedMono: number;
  }): RunContentLease {
    const controller = new AbortController();
    const state: LocalLease = {
      id: row.id,
      companyId: row.companyId,
      runIds: row.runIds,
      grantId: row.grantId,
      deadlineMono: row.startedMono + leaseTtlMs - clockSkewMs,
      fenced: null,
      released: false,
      controller,
      kind: row.kind,
    };
    local.set(row.id, state);
    ensureTicker();

    function assertLive(): void {
      if (state.released && !state.fenced) throw new RunContentDeniedError("lease_released");
      if (state.fenced) {
        void ackRelease(state, "revoked_ack");
        throw new RunContentDeniedError(state.fenced);
      }
      if (mono() > state.deadlineMono) {
        fence(state, "lease_expired");
        void ackRelease(state, "revoked_ack");
        throw new RunContentDeniedError("lease_expired");
      }
    }

    return {
      id: row.id,
      grantId: row.grantId,
      decision: row.decision,
      runIds: row.runIds,
      signal: controller.signal,
      async checkpoint() {
        assertLive();
        if (row.id.startsWith("bypass:")) return;
        try {
          const rows = rowsOf<{ fenced: boolean }>(
            await dbx.execute(sql`
              select (
                l.revoked_at is not null
                or l.released_at is not null
                or exists (
                  select 1 from run_content_restrictions r
                   where r.company_id = l.company_id
                     and r.run_id = any(l.run_ids)
                     and r.state <> 'released'
                     and r.epoch > l.epoch_floor
                     and l.grant_id is null
                )
              ) as fenced
              from (
                select id, company_id, run_ids, revoked_at, released_at, grant_id,
                       coalesce((epochs ->> 'floor')::bigint, 0) as epoch_floor
                  from run_content_leases where id = ${row.id}
              ) l`),
          );
          if (rows.length === 0 || rows[0]!.fenced) {
            fence(state, "lease_revoked");
          }
        } catch (error) {
          logger.warn({ err: error, leaseId: row.id }, "run content checkpoint failed; denying emission");
          fence(state, "lease_error");
        }
        assertLive();
      },
      emit<T>(write: () => T): T {
        assertLive();
        return write();
      },
      async release(reason = "complete") {
        await ackRelease(state, state.fenced ? "revoked_ack" : reason);
      },
    };
  }

  type LocalLeaseKindInput = RunContentLeaseKind;

  async function acquireLease(
    input: AuthorizeInput & { kind: RunContentLeaseKind },
  ): Promise<RunContentLease> {
    try {
      const result = await dbx.transaction(async (tx) => {
        const txx = tx as unknown as SqlLike & Db;
        await lockCompany(txx, input.companyId, "shared");
        const decision = await decide(txx, input);
        if (decision.decision === "deny") return { decision, leaseId: null as string | null, started: mono() };
        const started = mono();
        if (!enabled) return { decision, leaseId: null as string | null, started };
        const grantId = decision.decision === "forensic" ? decision.grantId : null;
        const inserted = rowsOf<{ id: string }>(
          await txx.execute(sql`
            insert into run_content_leases
              (company_id, run_ids, epochs, kind, purpose, actor_id, grant_id, holder_instance_id, holder_boot_id, expires_at)
            values
              (${input.companyId}, ${sql`array[${input.runId}]::uuid[]`}, ${JSON.stringify({ floor: decision.epoch })}::jsonb, ${input.kind}, ${input.routePurpose},
               ${input.actorId}, ${grantId}, ${instanceId}, ${bootId},
               now() + (${leaseTtlMs} * interval '1 millisecond'))
            returning id`),
        );
        return { decision, leaseId: inserted[0]!.id, started };
      });
      if (result.decision.decision === "deny") {
        throw new RunContentDeniedError(result.decision.reason, result.decision.tombstone);
      }
      const leaseId = result.leaseId ?? `bypass:${randomUUID()}`;
      return makeLease({
        id: leaseId,
        companyId: input.companyId,
        runIds: [input.runId],
        decision: result.decision.decision,
        grantId: result.decision.decision === "forensic" ? result.decision.grantId : null,
        kind: input.kind,
        startedMono: result.started,
      });
    } catch (error) {
      if (error instanceof RunContentDeniedError) throw error;
      logger.warn({ err: error, runId: input.runId }, "run content lease acquisition failed; denying content");
      throw new RunContentDeniedError("lease_error");
    }
  }

  async function acquireListLease(input: {
    companyId: string;
    runIds: string[];
    actorId: string | null;
    routePurpose: RunContentPurpose;
    kind?: RunContentLeaseKind;
  }) {
    const kind = input.kind ?? "http_read";
    try {
      const result = await dbx.transaction(async (tx) => {
        const txx = tx as unknown as SqlLike & Db;
        await lockCompany(txx, input.companyId, "shared");
        const decisions = new Map<string, RunContentDecision>();
        for (const runId of input.runIds) {
          decisions.set(runId, await decide(txx, { companyId: input.companyId, runId, actorId: input.actorId, routePurpose: input.routePurpose }, { allowForensic: false }));
        }
        const allowed = input.runIds.filter((id) => decisions.get(id)!.decision !== "deny");
        const started = mono();
        let leaseId: string | null = null;
        if (enabled && allowed.length > 0) {
          const inserted = rowsOf<{ id: string }>(
            await txx.execute(sql`
              insert into run_content_leases
                (company_id, run_ids, epochs, kind, purpose, actor_id, holder_instance_id, holder_boot_id, expires_at)
              values
                (${input.companyId}, ${sql`array[${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}]::uuid[]`},
                 ${JSON.stringify({ floor: 0 })}::jsonb, ${kind}, ${input.routePurpose}, ${input.actorId},
                 ${instanceId}, ${bootId}, now() + (${leaseTtlMs} * interval '1 millisecond'))
              returning id`),
          );
          leaseId = inserted[0]!.id;
        }
        return { decisions, allowed, leaseId, started };
      });
      const restricted = new Map<string, RunContentTombstone | null>();
      for (const runId of input.runIds) {
        const d = result.decisions.get(runId)!;
        if (d.decision === "deny") restricted.set(runId, d.tombstone);
      }
      const lease = result.allowed.length === 0
        ? null
        : makeLease({
            id: result.leaseId ?? `bypass:${randomUUID()}`,
            companyId: input.companyId,
            runIds: result.allowed,
            decision: "ordinary",
            grantId: null,
            kind,
            startedMono: result.started,
          });
      return { lease, allowed: new Set(result.allowed), restricted };
    } catch (error) {
      logger.warn({ err: error }, "run content list lease acquisition failed; denying content");
      throw new RunContentDeniedError("lease_error");
    }
  }

  async function workspaceRunAssociation(companyId: string, workspaceIds: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (workspaceIds.length === 0) return out;
    const wsArray = sql`array[${sql.join(workspaceIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
    try {
      const rows = rowsOf<{ ws: string; run_id: string }>(
        await dbx.execute(sql`
          select ws, run_id from (
            select hr.context_snapshot ->> 'executionWorkspaceId' as ws, hr.id::text as run_id
              from heartbeat_runs hr
             where hr.company_id = ${companyId}
               and hr.context_snapshot ->> 'executionWorkspaceId' = any(${wsArray})
            union
            select wo.execution_workspace_id::text as ws, wo.heartbeat_run_id::text as run_id
              from workspace_operations wo
             where wo.company_id = ${companyId}
               and wo.heartbeat_run_id is not null
               and wo.execution_workspace_id::text = any(${wsArray})
          ) assoc`),
      );
      for (const row of rows) {
        const set = out.get(row.ws) ?? new Set<string>();
        set.add(row.run_id);
        out.set(row.ws, set);
      }
      return out;
    } catch (error) {
      logger.warn({ err: error, companyId }, "workspace/run association lookup failed; denying content");
      throw new RunContentDeniedError("lookup_error");
    }
  }

  async function restrictedRunIds(companyId: string): Promise<Set<string>> {
    try {
      return new Set((await loadRestrictedMap(dbx, companyId)).keys());
    } catch (error) {
      logger.warn({ err: error, companyId }, "run content restricted-set lookup failed; denying content");
      throw new RunContentDeniedError("lookup_error");
    }
  }

  async function tombstonesFor(companyId: string, runIds: string[]): Promise<Map<string, RunContentTombstone>> {
    const out = new Map<string, RunContentTombstone>();
    if (runIds.length === 0) return out;
    const rows = await dbx
      .select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id} = any(${sql`array[${sql.join(runIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]`})`));
    for (const row of rows) out.set(row.id, tombstone(companyId, row.id, row.createdAt));
    return out;
  }

  async function watchCompany(input: { companyId: string; kind: "live_socket" }) {
    const startedMono = mono();
    const restricted = await loadRestrictedMap(dbx, input.companyId);
    const inserted = rowsOf<{ id: string }>(
      await dbx.execute(sql`
        insert into run_content_leases
          (company_id, run_ids, epochs, kind, purpose, holder_instance_id, holder_boot_id, expires_at)
        values
          (${input.companyId}, array[]::uuid[], ${JSON.stringify(Object.fromEntries(restricted))}::jsonb,
           'company_watch', ${input.kind}, ${instanceId}, ${bootId},
           now() + (${leaseTtlMs} * interval '1 millisecond'))
        returning id`),
    );
    const watcher: LocalWatcher = {
      id: inserted[0]!.id,
      companyId: input.companyId,
      deadlineMono: startedMono + leaseTtlMs - clockSkewMs,
      restricted: new Set(restricted.keys()),
      closed: false,
    };
    watchers.set(watcher.id, watcher);
    ensureTicker();
    return {
      id: watcher.id,
      isRestricted(runId: string) {
        if (watcher.closed || mono() > watcher.deadlineMono) return true;
        return watcher.restricted.has("*") || watcher.restricted.has(runId);
      },
      async close() {
        watcher.closed = true;
        watchers.delete(watcher.id);
        await dbx.execute(sql`update run_content_leases set released_at = now(), release_reason = 'watcher_closed' where id = ${watcher.id} and released_at is null`).catch(() => {});
      },
    };
  }

  async function reapOwnPreviousBoots() {
    const rows = rowsOf<{ id: string }>(
      await dbx.execute(sql`
        update run_content_leases
           set released_at = now(), release_reason = 'holder_restarted'
         where holder_instance_id = ${instanceId}
           and holder_boot_id <> ${bootId}
           and released_at is null
        returning id`),
    );
    return rows.length;
  }

  async function start() {
    const reapedLeases = enabled ? await reapOwnPreviousBoots() : 0;
    ensureTicker();
    return { reapedLeases };
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    await dbx
      .execute(sql`
        update run_content_leases
           set released_at = now(), release_reason = 'holder_stopped'
         where holder_instance_id = ${instanceId} and holder_boot_id = ${bootId} and released_at is null`)
      .catch(() => {});
    local.clear();
    watchers.clear();
  }

  async function registerCapability(input: {
    companyId: string;
    runId: string;
    kind: string;
    issuer: string;
    destinationClass: string;
    revocationSupported: boolean;
    expiresAt?: Date | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const [row] = await dbx
      .insert(runContentCapabilities)
      .values({
        companyId: input.companyId,
        runId: input.runId,
        kind: input.kind,
        issuer: input.issuer,
        destinationClass: input.destinationClass,
        revocationSupported: input.revocationSupported,
        expiresAt: input.expiresAt ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();
    return row!;
  }

  async function capabilityUsable(input: { companyId: string; capabilityId: string }) {
    const rows = await dbx
      .select()
      .from(runContentCapabilities)
      .where(and(eq(runContentCapabilities.id, input.capabilityId), eq(runContentCapabilities.companyId, input.companyId)))
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== "active") return false;
    if (row.expiresAt && row.expiresAt.getTime() <= now().getTime()) return false;
    const decision = await authorizeRunContent({ companyId: input.companyId, runId: row.runId, actorId: null, routePurpose: "export" });
    return decision.decision === "ordinary";
  }

  async function authorizeEgress(input: {
    companyId: string;
    runId: string | null;
    jobKind: string;
    destinationClass: string;
  }): Promise<{ allowed: true; lease: RunContentLease | null } | { allowed: false; reason: RunContentDenyReason }> {
    if (!input.runId) return { allowed: false, reason: "unclassifiable_job" };
    try {
      const lease = await acquireLease({
        companyId: input.companyId,
        runId: input.runId,
        actorId: null,
        routePurpose: input.jobKind === "sentry_failed_run_report" ? "sentry_report" : "export",
        kind: "egress",
      });
      return { allowed: true, lease };
    } catch (error) {
      if (error instanceof RunContentDeniedError) return { allowed: false, reason: error.reason };
      return { allowed: false, reason: "lease_error" };
    }
  }

  async function createForensicGrant(input: {
    companyId: string;
    runId: string;
    granteeActorId: string;
    purpose: string;
    authorizationRef: string;
    allowedOperations: string[];
    ttlMs: number;
    issuedBy: string;
  }) {
    const grantee = input.granteeActorId.trim();
    if (!grantee || /[*?%]/.test(grantee) || grantee === "anonymous") {
      throw new Error("forensic grant must name an individual recipient");
    }
    if (grantee === input.issuedBy) throw new Error("forensic grant cannot be self-issued");
    if (input.allowedOperations.length === 0) throw new Error("forensic grant requires at least one allowed operation");
    const unknownOps = input.allowedOperations.filter((op) => !(RUN_CONTENT_PURPOSES as readonly string[]).includes(op));
    if (unknownOps.length > 0) throw new Error(`forensic grant has unknown operation: ${unknownOps.join(",")}`);
    if (!input.authorizationRef.trim() || !input.purpose.trim()) throw new Error("forensic grant requires purpose and authorization reference");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > RUN_CONTENT_MAX_GRANT_TTL_MS) {
      throw new Error(`forensic grant ttl must be positive and at most ${RUN_CONTENT_MAX_GRANT_TTL_MS}ms`);
    }
    const run = await lookup(dbx, input.companyId, input.runId);
    if (!run) throw new Error("forensic grant target run not found in company");
    const issuedAt = now();
    return dbx.transaction(async (tx) => {
      const [grant] = await tx
        .insert(runContentForensicGrants)
        .values({
          companyId: input.companyId,
          runId: input.runId,
          granteeActorId: grantee,
          purpose: input.purpose,
          authorizationRef: input.authorizationRef,
          allowedOperations: input.allowedOperations,
          issuedBy: input.issuedBy,
          issuedAt,
          expiresAt: new Date(issuedAt.getTime() + input.ttlMs),
        })
        .returning();
      await audit(tx, {
        companyId: input.companyId,
        runId: input.runId,
        eventKind: "grant_created",
        result: "ok",
        actorId: input.issuedBy,
        grantId: grant!.id,
        authorizationRef: input.authorizationRef,
        metadata: { grantee, operations: input.allowedOperations, expiresAt: grant!.expiresAt.toISOString() },
      });
      return grant!;
    });
  }

  async function revokeForensicGrant(input: { companyId: string; grantId: string; revokedBy: string; reason: string }) {
    await dbx.transaction(async (tx) => {
      const rows = await tx
        .update(runContentForensicGrants)
        .set({ revokedAt: now(), revokedBy: input.revokedBy, revokeReason: input.reason })
        .where(
          and(
            eq(runContentForensicGrants.id, input.grantId),
            eq(runContentForensicGrants.companyId, input.companyId),
            sql`${runContentForensicGrants.revokedAt} is null`,
          ),
        )
        .returning();
      const grant = rows[0];
      if (!grant) return;
      await tx.execute(sql`
        update run_content_leases set revoked_at = now(), revoke_reason = 'grant_revoked'
         where grant_id = ${input.grantId} and released_at is null and revoked_at is null`);
      await audit(tx, {
        companyId: input.companyId,
        runId: grant.runId,
        eventKind: "grant_revoked",
        result: "ok",
        actorId: input.revokedBy,
        grantId: grant.id,
        authorizationRef: grant.authorizationRef,
        metadata: { reason: input.reason },
      });
    });
  }

  async function recordForensicRead(input: {
    companyId: string;
    runId: string;
    actorId: string | null;
    grantId: string;
    operation: RunContentPurpose;
    bytes: Buffer | string | null;
  }) {
    const buffer = input.bytes === null ? null : Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    await audit(dbx, {
      companyId: input.companyId,
      runId: input.runId,
      eventKind: "forensic_read",
      result: "ok",
      actorId: input.actorId,
      grantId: input.grantId,
      operation: input.operation,
      byteCount: buffer?.byteLength ?? null,
      sha256: buffer ? sha256Hex(buffer) : null,
    });
  }

  async function drain(input: {
    companyId: string;
    runId: string;
    floorEpoch: number;
    revokedIds: string[];
    timeoutMs: number;
  }) {
    const deadline = Date.now() + input.timeoutMs;
    let expiredReaped = 0;
    for (;;) {
      const reaped = rowsOf<{ id: string }>(
        await dbx.execute(sql`
          update run_content_leases
             set released_at = now(), release_reason = 'expired_reaped'
           where company_id = ${input.companyId}
             and released_at is null
             and expires_at < now() - (${clockSkewMs} * interval '1 millisecond')
             and (run_ids @> array[${input.runId}]::uuid[] or kind = 'company_watch')
          returning id`),
      );
      expiredReaped += reaped.length;
      const open = rowsOf<{ n: string | number }>(
        await dbx.execute(sql`
          select count(*) as n from run_content_leases
           where company_id = ${input.companyId}
             and released_at is null
             and (
               (kind <> 'company_watch' and run_ids @> array[${input.runId}]::uuid[])
               or (kind = 'company_watch' and coalesce((epochs ->> ${input.runId})::bigint, 0) < ${input.floorEpoch})
             )`),
      );
      const stillOpen = Number(open[0]?.n ?? 0);
      if (stillOpen === 0) return { stillOpen: 0, expiredReaped };
      if (Date.now() >= deadline) return { stillOpen, expiredReaped };
      await new Promise((resolve) => setTimeout(resolve, drainPollMs));
    }
  }

  async function summarizeDrain(revokedIds: string[], stillOpen: number): Promise<ActivationReceipt["drained"]> {
    const summary: ActivationReceipt["drained"] = {
      revoked: revokedIds.length,
      releasedByHolder: 0,
      revokedAcked: 0,
      expiredReaped: 0,
      restartReaped: 0,
      stillOpen,
    };
    if (revokedIds.length === 0) return summary;
    const rows = rowsOf<{ release_reason: string | null; n: string | number }>(
      await dbx.execute(sql`
        select release_reason, count(*) as n from run_content_leases
         where id = any(${sql`array[${sql.join(revokedIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]`})
           and released_at is not null
         group by release_reason`),
    );
    for (const row of rows) {
      const n = Number(row.n);
      if (row.release_reason === "revoked_ack") summary.revokedAcked += n;
      else if (row.release_reason === "expired_reaped") summary.expiredReaped += n;
      else if (row.release_reason === "holder_restarted") summary.restartReaped += n;
      else summary.releasedByHolder += n;
    }
    return summary;
  }

  async function inventoryCapabilities(companyId: string, runId: string, actorId: string) {
    const rows = await dbx
      .select()
      .from(runContentCapabilities)
      .where(
        and(
          eq(runContentCapabilities.companyId, companyId),
          eq(runContentCapabilities.runId, runId),
          eq(runContentCapabilities.status, "active"),
        ),
      );
    const current = now().getTime();
    const live = rows.filter((row) => !row.expiresAt || row.expiresAt.getTime() > current);
    const revocable = live.filter((row) => row.revocationSupported);
    const residual = live.filter((row) => !row.revocationSupported);
    if (revocable.length > 0) {
      await dbx.execute(sql`
        update run_content_capabilities set status = 'revoked', revoked_at = now()
         where id = any(${sql`array[${sql.join(revocable.map((r) => sql`${r.id}`), sql`, `)}]::uuid[]`})`);
    }
    if (residual.length > 0) {
      await dbx.execute(sql`
        update run_content_capabilities set status = 'residual_unrevocable'
         where id = any(${sql`array[${sql.join(residual.map((r) => sql`${r.id}`), sql`, `)}]::uuid[]`})`);
    }
    await audit(dbx, {
      companyId,
      runId,
      eventKind: "capability_inventory",
      result: residual.length > 0 ? "partial" : "full",
      actorId,
      metadata: {
        inventoried: live.length,
        revoked: revocable.length,
        residual: residual.map((r) => ({ id: r.id, kind: r.kind, destinationClass: r.destinationClass, expiresAt: r.expiresAt?.toISOString() ?? null })),
      },
    });
    return {
      inventoried: live.length,
      revoked: revocable.length,
      residual: residual.map((r) => ({
        id: r.id,
        kind: r.kind,
        issuer: r.issuer,
        destinationClass: r.destinationClass,
        expiresAt: r.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  async function transition(input: {
    companyId: string;
    runId: string;
    actorId: string;
    authorizationRef: string;
    reasonCode: string;
    expectFrom: Array<string | "none">;
    to: "restricting" | "releasing";
    extra?: Record<string, unknown>;
  }) {
    return dbx.transaction(async (tx) => {
      const txx = tx as unknown as SqlLike & Db;
      await lockCompany(txx, input.companyId, "exclusive");
      const run = await lookup(txx, input.companyId, input.runId);
      if (!run) throw new Error("run not found in company");
      const from = run.state ?? "none";
      if (!input.expectFrom.includes(from)) {
        throw new Error(`run is not ${input.expectFrom.join("|")} (state: ${from})`);
      }
      let epoch = Number(run.epoch ?? 0);
      const transitions: TransitionReceipt[] = [];
      if (from !== input.to) {
        epoch += 1;
        if (from === "none") {
          await txx.insert(runContentRestrictions).values({
            companyId: input.companyId,
            runId: input.runId,
            state: input.to,
            epoch,
            policyVersion: RUN_CONTENT_POLICY_VERSION,
            reasonCode: input.reasonCode,
            authorizationRef: input.authorizationRef,
            actorId: input.actorId,
            priorState: null,
          });
        } else {
          await txx
            .update(runContentRestrictions)
            .set({
              state: input.to,
              epoch,
              priorState: from,
              reasonCode: input.reasonCode,
              authorizationRef: input.authorizationRef,
              actorId: input.actorId,
              acknowledgedAt: null,
              updatedAt: new Date(),
            })
            .where(and(eq(runContentRestrictions.companyId, input.companyId), eq(runContentRestrictions.runId, input.runId)));
        }
        transitions.push({ from, to: input.to, epoch, at: new Date().toISOString() });
        await audit(txx, {
          companyId: input.companyId,
          runId: input.runId,
          eventKind: "transition",
          result: "committed",
          actorId: input.actorId,
          authorizationRef: input.authorizationRef,
          epoch,
          metadata: { from, to: input.to, reasonCode: input.reasonCode, ...(input.extra ?? {}) },
        });
      }
      const revoked = rowsOf<{ id: string }>(
        await txx.execute(sql`
          update run_content_leases
             set revoked_at = now(), revoke_reason = ${`transition_${input.to}`}
           where company_id = ${input.companyId}
             and released_at is null
             and revoked_at is null
             and kind <> 'company_watch'
             and run_ids @> array[${input.runId}]::uuid[]
          returning id`),
      );
      if (input.to === "releasing") {
        await txx.execute(sql`
          update run_content_forensic_grants
             set revoked_at = now(), revoked_by = ${input.actorId}, revoke_reason = 'run_released'
           where company_id = ${input.companyId} and run_id = ${input.runId} and revoked_at is null`);
      }
      return { transitions, epoch, revokedIds: revoked.map((r) => r.id) };
    });
  }

  async function finalize(input: {
    companyId: string;
    runId: string;
    actorId: string;
    authorizationRef: string;
    to: "restricted" | "released";
    transitions: TransitionReceipt[];
    epoch: number;
  }) {
    return dbx.transaction(async (tx) => {
      const txx = tx as unknown as SqlLike & Db;
      await lockCompany(txx, input.companyId, "exclusive");
      const epoch = input.epoch + 1;
      const from = input.to === "restricted" ? "restricting" : "releasing";
      const updated = await txx
        .update(runContentRestrictions)
        .set({ state: input.to, epoch, priorState: from, acknowledgedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(runContentRestrictions.companyId, input.companyId),
            eq(runContentRestrictions.runId, input.runId),
            eq(runContentRestrictions.state, from),
          ),
        )
        .returning();
      if (updated.length === 0) throw new Error(`run left ${from} state during drain`);
      await audit(txx, {
        companyId: input.companyId,
        runId: input.runId,
        eventKind: "transition",
        result: "committed",
        actorId: input.actorId,
        authorizationRef: input.authorizationRef,
        epoch,
        metadata: { from, to: input.to },
      });
      return [...input.transitions, { from, to: input.to, epoch, at: new Date().toISOString() }];
    }).then((transitions) => ({ transitions, epoch: input.epoch + 1 }));
  }

  async function activateRestriction(input: {
    companyId: string;
    runId: string;
    actorId: string;
    reasonCode: string;
    authorizationRef: string;
    drainTimeoutMs?: number;
  }): Promise<ActivationReceipt> {
    const first = await transition({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
      authorizationRef: input.authorizationRef,
      reasonCode: input.reasonCode,
      expectFrom: ["none", "released", "restricting", "restricted"],
      to: "restricting",
    });
    const current = await lookup(dbx, input.companyId, input.runId);
    if (current?.state === "restricted" && first.transitions.length === 0) {
      return {
        outcome: "restricted",
        state: "restricted",
        epoch: Number(current.epoch),
        transitions: [],
        drained: { revoked: 0, releasedByHolder: 0, revokedAcked: 0, expiredReaped: 0, restartReaped: 0, stillOpen: 0 },
        capabilities: { inventoried: 0, revoked: 0, residual: [] },
        containment: "full",
        storageCustody: "not_attested_by_server",
        gateMode: enabled ? "enforcing" : "bypass_for_unrestricted",
      };
    }
    const drained = await drain({
      companyId: input.companyId,
      runId: input.runId,
      floorEpoch: first.epoch,
      revokedIds: first.revokedIds,
      timeoutMs: input.drainTimeoutMs ?? 30_000,
    });
    const summary = await summarizeDrain(first.revokedIds, drained.stillOpen);
    summary.expiredReaped = Math.max(summary.expiredReaped, drained.expiredReaped);
    if (drained.stillOpen > 0) {
      await audit(dbx, {
        companyId: input.companyId,
        runId: input.runId,
        eventKind: "activation_incomplete",
        result: "fail_closed",
        actorId: input.actorId,
        authorizationRef: input.authorizationRef,
        epoch: first.epoch,
        metadata: { stillOpen: drained.stillOpen },
      });
      return {
        outcome: "incomplete",
        state: "restricting",
        epoch: first.epoch,
        transitions: first.transitions,
        drained: summary,
        capabilities: { inventoried: 0, revoked: 0, residual: [] },
        containment: "none",
        storageCustody: "not_attested_by_server",
        gateMode: enabled ? "enforcing" : "bypass_for_unrestricted",
      };
    }
    const capabilities = await inventoryCapabilities(input.companyId, input.runId, input.actorId);
    const done = await finalize({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
      authorizationRef: input.authorizationRef,
      to: "restricted",
      transitions: first.transitions,
      epoch: first.epoch,
    });
    return {
      outcome: "restricted",
      state: "restricted",
      epoch: done.epoch,
      transitions: done.transitions,
      drained: summary,
      capabilities,
      containment: capabilities.residual.length > 0 ? "partial" : "full",
      storageCustody: "not_attested_by_server",
      gateMode: enabled ? "enforcing" : "bypass_for_unrestricted",
    };
  }

  async function releaseRestriction(input: {
    companyId: string;
    runId: string;
    actorId: string;
    authorizationRef: string;
    riskAcceptanceRef: string;
    drainTimeoutMs?: number;
  }): Promise<ActivationReceipt> {
    if (!input.riskAcceptanceRef.trim()) throw new Error("release requires an independent risk acceptance reference");
    const first = await transition({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
      authorizationRef: input.authorizationRef,
      reasonCode: "release",
      expectFrom: ["restricted", "releasing"],
      to: "releasing",
      extra: { riskAcceptanceRef: input.riskAcceptanceRef },
    }).catch((error: Error) => {
      if (/is not restricted/.test(error.message) || /run is not/.test(error.message)) {
        throw new Error(`run is not restricted: ${error.message}`);
      }
      throw error;
    });
    const drained = await drain({
      companyId: input.companyId,
      runId: input.runId,
      floorEpoch: first.epoch,
      revokedIds: first.revokedIds,
      timeoutMs: input.drainTimeoutMs ?? 30_000,
    });
    const summary = await summarizeDrain(first.revokedIds, drained.stillOpen);
    if (drained.stillOpen > 0) {
      return {
        outcome: "incomplete",
        state: "releasing",
        epoch: first.epoch,
        transitions: first.transitions,
        drained: summary,
        capabilities: { inventoried: 0, revoked: 0, residual: [] },
        containment: "full",
        storageCustody: "not_attested_by_server",
        gateMode: enabled ? "enforcing" : "bypass_for_unrestricted",
      };
    }
    const done = await finalize({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
      authorizationRef: input.authorizationRef,
      to: "released",
      transitions: first.transitions,
      epoch: first.epoch,
    });
    return {
      outcome: "released",
      state: "released",
      epoch: done.epoch,
      transitions: done.transitions,
      drained: summary,
      capabilities: { inventoried: 0, revoked: 0, residual: [] },
      containment: "none",
      storageCustody: "not_attested_by_server",
      gateMode: enabled ? "enforcing" : "bypass_for_unrestricted",
    };
  }

  return {
    instanceId,
    bootId,
    enabled,
    authorizeRunContent,
    authorizeRunMutation,
    acquireLease,
    acquireListLease,
    restrictedRunIds,
    workspaceRunAssociation,
    tombstonesFor,
    watchCompany,
    authorizeEgress,
    registerCapability,
    capabilityUsable,
    createForensicGrant,
    revokeForensicGrant,
    recordForensicRead,
    activateRestriction,
    releaseRestriction,
    start,
    stop,
  };
}

export type RunContentGate = ReturnType<typeof runContentGate>;

/**
 * Evidence-preservation check for retention/cleanup jobs. A run that has any
 * non-released restriction row (or whose state cannot be read) must not have
 * its originals (DB rows, local NDJSON, S3 mirror, traces) deleted or mutated.
 */
export async function isRunRetentionHeld(db: Pick<Db, "select">, companyId: string, runId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ state: runContentRestrictions.state })
      .from(runContentRestrictions)
      .where(and(eq(runContentRestrictions.companyId, companyId), eq(runContentRestrictions.runId, runId)))
      .limit(1);
    const state = rows[0]?.state;
    return state !== undefined && state !== "released";
  } catch (error) {
    logger.warn({ err: error, runId }, "run retention-hold lookup failed; preserving originals");
    return true;
  }
}

const gateByDb = new WeakMap<object, RunContentGate>();

export function runContentGateOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RunContentGateOptions {
  const disabled = env.PAPERCLIP_RUN_CONTENT_GATE_MODE === "bypass_for_unrestricted";
  return {
    enabled: !disabled,
    instanceId: env.PAPERCLIP_INSTANCE_ID || env.HOSTNAME || undefined,
    leaseTtlMs: env.PAPERCLIP_RUN_CONTENT_LEASE_TTL_MS ? Number(env.PAPERCLIP_RUN_CONTENT_LEASE_TTL_MS) : undefined,
    clockSkewMs: env.PAPERCLIP_RUN_CONTENT_CLOCK_SKEW_MS ? Number(env.PAPERCLIP_RUN_CONTENT_CLOCK_SKEW_MS) : undefined,
  };
}

export function getRunContentGate(db: Db): RunContentGate {
  let gate = gateByDb.get(db as unknown as object);
  if (!gate) {
    gate = runContentGate(db, runContentGateOptionsFromEnv());
    gateByDb.set(db as unknown as object, gate);
  }
  return gate;
}

export async function readRunContentState(db: Db, companyId: string, runId: string) {
  const [row] = await db
    .select()
    .from(runContentRestrictions)
    .where(and(eq(runContentRestrictions.companyId, companyId), eq(runContentRestrictions.runId, runId)))
    .limit(1);
  return row ?? null;
}

export async function listRunContentGrants(db: Db, companyId: string, runId: string) {
  return db
    .select()
    .from(runContentForensicGrants)
    .where(and(eq(runContentForensicGrants.companyId, companyId), eq(runContentForensicGrants.runId, runId)));
}

export async function listRunContentAudit(db: Db, companyId: string, runId: string, limit = 500) {
  return db
    .select()
    .from(runContentAuditEvents)
    .where(and(eq(runContentAuditEvents.companyId, companyId), eq(runContentAuditEvents.runId, runId)))
    .orderBy(runContentAuditEvents.id)
    .limit(Math.max(1, Math.min(limit, 1000)));
}
