import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import {
  getRunContentGate,
  listRunContentAudit,
  listRunContentGrants,
  readRunContentState,
  RUN_CONTENT_PURPOSES,
} from "../services/run-content-gate.js";
import { runContentActorId } from "./run-content-guard.js";
import { heartbeatRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

export function runContentAdminEnabledFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return env.PAPERCLIP_RUN_CONTENT_ADMIN === "enabled";
}

const text = (value: unknown, field: string, max = 512) => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw badRequest(`${field} is required`);
  }
  return value.trim();
};

/**
 * Operator surface for the per-run content restriction. Disabled unless
 * PAPERCLIP_RUN_CONTENT_ADMIN=enabled, so shipping this code activates nothing.
 * Responses carry metadata only and never run content.
 */
export function runContentAdminRoutes(db: Db, options: { adminEnabled?: boolean } = {}) {
  const router = Router();
  const enabled = options.adminEnabled ?? runContentAdminEnabledFromEnv();
  const gate = () => getRunContentGate(db);

  async function resolve(req: import("express").Request) {
    if (!enabled) throw notFound("Not found");
    assertInstanceAdmin(req);
    const companyId = req.params.companyId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, companyId);
    const [run] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");
    const actorId = runContentActorId(req);
    if (!actorId) throw badRequest("A named human actor is required");
    return { companyId, runId, actorId };
  }

  const base = "/companies/:companyId/heartbeat-runs/:runId";

  router.put(`${base}/content-restriction`, async (req, res) => {
    const { companyId, runId, actorId } = await resolve(req);
    const receipt = await gate().activateRestriction({
      companyId,
      runId,
      actorId,
      reasonCode: text(req.body?.reasonCode, "reasonCode", 128),
      authorizationRef: text(req.body?.authorizationRef, "authorizationRef"),
      drainTimeoutMs: Number.isFinite(Number(req.body?.drainTimeoutMs)) ? Number(req.body.drainTimeoutMs) : undefined,
    });
    res.set("Cache-Control", "no-store");
    res.status(receipt.outcome === "restricted" ? 200 : 409).json(receipt);
  });

  router.get(`${base}/content-restriction`, async (req, res) => {
    const { companyId, runId } = await resolve(req);
    const row = await readRunContentState(db, companyId, runId);
    res.set("Cache-Control", "no-store");
    res.json(row ?? { runId, companyId, state: "none" });
  });

  router.delete(`${base}/content-restriction`, async (req, res) => {
    const { companyId, runId, actorId } = await resolve(req);
    const receipt = await gate().releaseRestriction({
      companyId,
      runId,
      actorId,
      authorizationRef: text(req.body?.authorizationRef, "authorizationRef"),
      riskAcceptanceRef: text(req.body?.riskAcceptanceRef, "riskAcceptanceRef"),
      drainTimeoutMs: Number.isFinite(Number(req.body?.drainTimeoutMs)) ? Number(req.body.drainTimeoutMs) : undefined,
    }).catch((error: Error) => {
      if (/not restricted/i.test(error.message)) throw badRequest(error.message);
      throw error;
    });
    res.set("Cache-Control", "no-store");
    res.status(receipt.outcome === "released" ? 200 : 409).json(receipt);
  });

  router.post(`${base}/forensic-grants`, async (req, res) => {
    const { companyId, runId, actorId } = await resolve(req);
    const operations = Array.isArray(req.body?.allowedOperations) ? req.body.allowedOperations.map(String) : [];
    const grant = await gate().createForensicGrant({
      companyId,
      runId,
      granteeActorId: text(req.body?.granteeActorId, "granteeActorId", 256),
      purpose: text(req.body?.purpose, "purpose"),
      authorizationRef: text(req.body?.authorizationRef, "authorizationRef"),
      allowedOperations: operations,
      ttlMs: Number(req.body?.ttlMs),
      issuedBy: actorId,
    }).catch((error: Error) => {
      throw badRequest(error.message);
    });
    res.set("Cache-Control", "no-store");
    res.status(201).json(grant);
  });

  router.get(`${base}/forensic-grants`, async (req, res) => {
    const { companyId, runId } = await resolve(req);
    res.set("Cache-Control", "no-store");
    res.json(await listRunContentGrants(db, companyId, runId));
  });

  router.delete(`${base}/forensic-grants/:grantId`, async (req, res) => {
    const { companyId, actorId } = await resolve(req);
    await gate().revokeForensicGrant({
      companyId,
      grantId: req.params.grantId as string,
      revokedBy: actorId,
      reason: text(req.body?.reason, "reason"),
    });
    res.set("Cache-Control", "no-store");
    res.json({ revoked: true });
  });

  router.get(`${base}/content-audit`, async (req, res) => {
    const { companyId, runId } = await resolve(req);
    res.set("Cache-Control", "no-store");
    res.json(await listRunContentAudit(db, companyId, runId));
  });

  router.get("/run-content/purposes", (req, res) => {
    if (!enabled) throw notFound("Not found");
    assertInstanceAdmin(req);
    res.json({ purposes: RUN_CONTENT_PURPOSES });
  });

  return router;
}
