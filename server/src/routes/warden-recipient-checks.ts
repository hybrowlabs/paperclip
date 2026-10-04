import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import {
  assertAgentChecker,
  wardenRecipientCheckService,
  type CheckerActor,
  type WardenSecretResolver,
  type WardenServerPorts,
} from "../services/warden-recipient-check.js";

const createGrantSchema = z
  .object({
    approvalId: z.string().uuid(),
    issueId: z.string().uuid(),
    checkerAgentId: z.string().uuid(),
    recipientAgentId: z.string().uuid(),
    expiresInSeconds: z.number().int().min(60).max(900).optional(),
  })
  .strict();

const checkRequestSchema = z
  .object({
    selector: z.literal("warden-uat-aws"),
    grantId: z.string().uuid(),
    expectedConfigRevision: z.string().min(1).max(128),
  })
  .strict();

export type WardenCheckRunner = (
  actor: CheckerActor,
  rawRequest: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface WardenRecipientCheckRouteDeps {
  secrets: WardenSecretResolver;
  createRunner?: (ports: WardenServerPorts) => WardenCheckRunner;
}

export function wardenRecipientCheckRoutes(db: Db, deps: WardenRecipientCheckRouteDeps) {
  const router = Router();
  const svc = wardenRecipientCheckService(db, deps.secrets);

  router.post("/companies/:companyId/warden-recipient-check-grants", validate(createGrantSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const grant = await svc.createGrant({ companyId, createdByUserId: userId, ...req.body });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "warden_recipient_check.grant_created",
      entityType: "issue",
      entityId: grant.issueId,
      issueId: grant.issueId,
      details: {
        grantId: grant.id,
        approvalId: grant.approvalId,
        checkerAgentId: grant.checkerAgentId,
        recipientAgentId: grant.recipientAgentId,
        configRevision: grant.configRevision,
        recipe: grant.recipe,
        expiresAt: grant.expiresAt.toISOString(),
      },
    });
    res.status(201).json({
      grantId: grant.id,
      configRevision: grant.configRevision,
      recipe: grant.recipe,
      expiresAt: grant.expiresAt.toISOString(),
    });
  });

  router.post("/companies/:companyId/warden-recipient-check-grants/:grantId/revoke", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const grant = await svc.revokeGrant(companyId, req.params.grantId as string, userId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "warden_recipient_check.grant_revoked",
      entityType: "issue",
      entityId: grant.issueId,
      issueId: grant.issueId,
      details: { grantId: grant.id },
    });
    res.json({ grantId: grant.id, revokedAt: grant.revokedAt?.toISOString() ?? null });
  });

  router.post("/issues/:issueId/recipient-checks/warden-uat-aws", validate(checkRequestSchema), async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await db
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const actor = assertAgentChecker(req.actor);
    if (!deps.createRunner) {
      res.status(501).json({ error: "Recipient runner is not configured" });
      return;
    }
    const run = deps.createRunner(svc.buildPorts(actor, issueId));
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const receipt = await run(actor, { ...req.body, issueId }, controller.signal);
      const authorization = await svc.getGrantAudit(actor.companyId, req.body.grantId);
      res.json({ receipt, authorization });
    } catch (err) {
      const named = err as { name?: string; code?: unknown };
      if (named?.name === "CheckDenied" && typeof named.code === "string") {
        res.status(403).json({ error: "denied", code: named.code });
        return;
      }
      res.status(500).json({ error: "check_failed" });
    }
  });

  return router;
}
