import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  getRunContentGate,
  RunContentDeniedError,
  type RunContentGate,
  type RunContentLease,
  type RunContentLeaseKind,
  type RunContentPurpose,
  type RunContentTombstone,
} from "../services/run-content-gate.js";

export function runContentActorId(req: Request): string | null {
  const actor = req.actor;
  if (!actor) return null;
  if (actor.type === "board" && actor.userId) return `user:${actor.userId}`;
  if (actor.type === "agent" && actor.agentId) return `agent:${actor.agentId}`;
  return null;
}

export function sendRunContentTombstone(
  res: Response,
  error: RunContentDeniedError,
  fallback: { companyId: string; runId: string | null },
) {
  res.set("Cache-Control", "no-store");
  res.status(error.status).json({
    error: "run_content_restricted",
    reason: error.reason === "restricted" || error.reason === "restricting" ? error.reason : "unavailable",
    tombstone:
      error.tombstone ??
      (fallback.runId
        ? ({
            runId: fallback.runId,
            companyId: fallback.companyId,
            state: "restricted",
            createdAt: null,
            contentWithheld: true,
          } satisfies RunContentTombstone)
        : null),
  });
}

export function whenResponseDone(res: Response, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (res.writableFinished || res.destroyed) return resolve();
    const onAbort = () => {
      res.destroy();
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    res.once("close", done);
    res.once("finish", done);
  });
}

type ServeOptions<T> = {
  db: Db;
  req: Request;
  res: Response;
  companyId: string;
  runId: string;
  purpose: RunContentPurpose;
  kind?: RunContentLeaseKind;
  produce: (lease: RunContentLease) => Promise<T>;
  send?: (res: Response, payload: T, lease: RunContentLease) => void;
  onForensicRead?: (input: { grantId: string; payload: T }) => Promise<void> | void;
  gate?: RunContentGate;
};

export async function serveRunContent<T>(options: ServeOptions<T>): Promise<boolean> {
  const gate = options.gate ?? getRunContentGate(options.db);
  const actorId = runContentActorId(options.req);
  let lease: RunContentLease;
  try {
    lease = await gate.acquireLease({
      companyId: options.companyId,
      runId: options.runId,
      actorId,
      routePurpose: options.purpose,
      kind: options.kind ?? "http_read",
    });
  } catch (error) {
    if (error instanceof RunContentDeniedError) {
      sendRunContentTombstone(options.res, error, { companyId: options.companyId, runId: options.runId });
      return false;
    }
    throw error;
  }
  let emitted = false;
  try {
    const payload = await options.produce(lease);
    await lease.checkpoint();
    lease.emit(() => {
      emitted = true;
      if (lease.decision === "forensic") options.res.set("Cache-Control", "no-store");
      if (options.send) options.send(options.res, payload, lease);
      else options.res.json(payload);
    });
    if (lease.decision === "forensic" && options.onForensicRead) {
      if (lease.grantId) await options.onForensicRead({ grantId: lease.grantId, payload });
    }
    await whenResponseDone(options.res, lease.signal);
    return true;
  } catch (error) {
    if (error instanceof RunContentDeniedError && !emitted) {
      sendRunContentTombstone(options.res, error, { companyId: options.companyId, runId: options.runId });
      return false;
    }
    throw error;
  } finally {
    await lease.release(emitted ? "complete" : "not_emitted");
  }
}

export type RunListMeta = { id: string; createdAt: Date | string | null };

export function runTombstoneEntry(companyId: string, meta: RunListMeta) {
  return {
    id: meta.id,
    companyId,
    createdAt: meta.createdAt,
    state: "restricted" as const,
    contentWithheld: true as const,
  };
}

/**
 * Gate a run-bearing list. `listMeta` must select ids only. `fetchContent`
 * runs only for the runs the gate admitted, so no restricted run's content
 * column is ever selected. The lease is held until the response is flushed.
 */
export async function serveRunList<TRow extends { id: string }>(options: {
  db: Db;
  req: Request;
  res: Response;
  companyId: string;
  purpose: RunContentPurpose;
  listMeta: () => Promise<RunListMeta[]>;
  fetchContent: (allowedRunIds: string[]) => Promise<TRow[]>;
  shape?: (rows: Array<TRow | ReturnType<typeof runTombstoneEntry>>) => Promise<unknown> | unknown;
  gate?: RunContentGate;
}): Promise<void> {
  const gate = options.gate ?? getRunContentGate(options.db);
  const metas = await options.listMeta();
  let leaseResult: Awaited<ReturnType<RunContentGate["acquireListLease"]>>;
  try {
    leaseResult = await gate.acquireListLease({
      companyId: options.companyId,
      runIds: metas.map((m) => m.id),
      actorId: runContentActorId(options.req),
      routePurpose: options.purpose,
    });
  } catch (error) {
    if (error instanceof RunContentDeniedError) {
      sendRunContentTombstone(options.res, error, { companyId: options.companyId, runId: null });
      return;
    }
    throw error;
  }
  const { lease, allowed, restricted } = leaseResult;
  let emitted = false;
  try {
    const rows = allowed.size > 0 ? await options.fetchContent([...allowed]) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const merged: Array<TRow | ReturnType<typeof runTombstoneEntry>> = [];
    for (const meta of metas) {
      if (restricted.has(meta.id)) {
        merged.push(runTombstoneEntry(options.companyId, meta));
        continue;
      }
      const row = byId.get(meta.id);
      if (row) merged.push(row);
    }
    const body = options.shape ? await options.shape(merged) : merged;
    if (restricted.size > 0) options.res.set("Cache-Control", "no-store");
    if (lease) {
      await lease.checkpoint();
      lease.emit(() => {
        emitted = true;
        options.res.json(body);
      });
      await whenResponseDone(options.res, lease.signal);
    } else {
      emitted = true;
      options.res.json(body);
    }
  } catch (error) {
    if (error instanceof RunContentDeniedError && !emitted) {
      sendRunContentTombstone(options.res, error, { companyId: options.companyId, runId: null });
      return;
    }
    throw error;
  } finally {
    await lease?.release(emitted ? "complete" : "not_emitted");
  }
}

/** Mutations that read or destroy retained content (delete trace, reproject). */
export async function denyRestrictedMutation(options: {
  db: Db;
  req: Request;
  res: Response;
  companyId: string;
  runId: string;
  purpose: "delete_provider_trace" | "reproject_provider_trace" | "retry_failed_run";
  gate?: RunContentGate;
}): Promise<boolean> {
  const gate = options.gate ?? getRunContentGate(options.db);
  const result = await gate.authorizeRunMutation({
    companyId: options.companyId,
    runId: options.runId,
    actorId: runContentActorId(options.req),
    routePurpose: options.purpose,
  });
  if (result.allowed) return false;
  sendRunContentTombstone(options.res, result.error, { companyId: options.companyId, runId: options.runId });
  return true;
}

type OpMeta = {
  id: string;
  companyId: string;
  heartbeatRunId: string | null;
  executionWorkspaceId: string | null;
};

async function operationProvenance(gate: RunContentGate, companyId: string, metas: OpMeta[]) {
  const nullWorkspaces = [
    ...new Set(metas.filter((m) => !m.heartbeatRunId && m.executionWorkspaceId).map((m) => m.executionWorkspaceId!)),
  ];
  const assoc = await gate.workspaceRunAssociation(companyId, nullWorkspaces);
  const provenance = new Map<string, string[]>();
  for (const meta of metas) {
    if (meta.heartbeatRunId) provenance.set(meta.id, [meta.heartbeatRunId]);
    else provenance.set(meta.id, meta.executionWorkspaceId ? [...(assoc.get(meta.executionWorkspaceId) ?? [])] : []);
  }
  return provenance;
}

/**
 * Gate a list of workspace operations. Run-produced operations follow their
 * run. Operations without run provenance are withheld when their workspace is
 * associated with any restricted run (ambiguous association defaults to deny),
 * and stay available when no associated run is restricted.
 */
export async function serveWorkspaceOperationList<TRow extends { id: string }>(options: {
  db: Db;
  req: Request;
  res: Response;
  companyId: string;
  purpose: RunContentPurpose;
  listMeta: () => Promise<OpMeta[]>;
  fetchContent: (allowedIds: string[]) => Promise<TRow[]>;
  shape?: (rows: Array<TRow | { id: string; companyId: string; state: "restricted"; contentWithheld: true }>) => Promise<unknown> | unknown;
  gate?: RunContentGate;
}): Promise<void> {
  const gate = options.gate ?? getRunContentGate(options.db);
  try {
    const metas = await options.listMeta();
    const provenance = await operationProvenance(gate, options.companyId, metas);
    const runIds = [...new Set([...provenance.values()].flat())];
    const { lease, restricted } = await gate.acquireListLease({
      companyId: options.companyId,
      runIds,
      actorId: runContentActorId(options.req),
      routePurpose: options.purpose,
    });
    let emitted = false;
    try {
      const withheld = new Set(
        metas.filter((m) => (provenance.get(m.id) ?? []).some((runId) => restricted.has(runId))).map((m) => m.id),
      );
      const allowedIds = metas.filter((m) => !withheld.has(m.id)).map((m) => m.id);
      const rows = allowedIds.length > 0 ? await options.fetchContent(allowedIds) : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const merged: Array<TRow | { id: string; companyId: string; state: "restricted"; contentWithheld: true }> = [];
      for (const meta of metas) {
        if (withheld.has(meta.id)) {
          merged.push({ id: meta.id, companyId: options.companyId, state: "restricted", contentWithheld: true });
        } else {
          const row = byId.get(meta.id);
          if (row) merged.push(row);
        }
      }
      const body = options.shape ? await options.shape(merged) : merged;
      if (withheld.size > 0) options.res.set("Cache-Control", "no-store");
      if (lease) {
        await lease.checkpoint();
        lease.emit(() => {
          emitted = true;
          options.res.json(body);
        });
        await whenResponseDone(options.res, lease.signal);
      } else {
        emitted = true;
        options.res.json(body);
      }
    } finally {
      await lease?.release(emitted ? "complete" : "not_emitted");
    }
  } catch (error) {
    if (error instanceof RunContentDeniedError) {
      sendRunContentTombstone(options.res, error, { companyId: options.companyId, runId: null });
      return;
    }
    throw error;
  }
}

/** By-ID workspace operation read: resolves provenance first, denies if any associated run is restricted. */
export async function serveWorkspaceOperation<T>(options: {
  db: Db;
  req: Request;
  res: Response;
  companyId: string;
  purpose: RunContentPurpose;
  getMeta: () => Promise<OpMeta | null>;
  produce: (lease: RunContentLease | null) => Promise<T>;
  send?: (res: Response, payload: T) => void;
  gate?: RunContentGate;
}): Promise<void> {
  const gate = options.gate ?? getRunContentGate(options.db);
  try {
    const meta = await options.getMeta();
    if (!meta || meta.companyId !== options.companyId) {
      options.res.status(404).json({ error: "Workspace operation not found" });
      return;
    }
    if (meta.heartbeatRunId) {
      await serveRunContent({
        db: options.db,
        req: options.req,
        res: options.res,
        companyId: options.companyId,
        runId: meta.heartbeatRunId,
        purpose: options.purpose,
        produce: (lease) => options.produce(lease),
        send: options.send ? (res, payload) => options.send!(res, payload) : undefined,
        gate,
      });
      return;
    }
    const provenance = await operationProvenance(gate, options.companyId, [meta]);
    const runIds = provenance.get(meta.id) ?? [];
    const { lease, restricted } = await gate.acquireListLease({
      companyId: options.companyId,
      runIds,
      actorId: runContentActorId(options.req),
      routePurpose: options.purpose,
    });
    let emitted = false;
    try {
      if (restricted.size > 0) {
        throw new RunContentDeniedError("restricted", [...restricted.values()][0] ?? null);
      }
      const payload = await options.produce(lease);
      if (lease) {
        await lease.checkpoint();
        lease.emit(() => {
          emitted = true;
          if (options.send) options.send(options.res, payload);
          else options.res.json(payload);
        });
        await whenResponseDone(options.res, lease.signal);
      } else {
        emitted = true;
        if (options.send) options.send(options.res, payload);
        else options.res.json(payload);
      }
    } finally {
      await lease?.release(emitted ? "complete" : "not_emitted");
    }
  } catch (error) {
    if (error instanceof RunContentDeniedError) {
      sendRunContentTombstone(options.res, error, { companyId: options.companyId, runId: null });
      return;
    }
    throw error;
  }
}
