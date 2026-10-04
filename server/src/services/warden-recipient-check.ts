import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentConfigRevisions,
  agents,
  approvals,
  environments,
  heartbeatRuns,
  issues,
  wardenRecipientCheckGrants,
} from "@paperclipai/db";
import { envBindingSchema } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export const WARDEN_RECIPE_VERSION = "warden-uat-aws-v1";
export const WARDEN_GRANT_MAX_SECONDS = 900;
export const WARDEN_ALLOWED_ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;

export interface CheckerActor {
  agentId: string;
  runId: string;
  companyId: string;
}

export interface CheckerRequest {
  selector: "warden-uat-aws";
  issueId: string;
  grantId: string;
  expectedConfigRevision: string;
}

export interface WardenRecipientTarget {
  recipientAgentId: string;
  currentConfigRevision: string;
  checkerAgentId: string;
  checkerRunId: string;
  issueId: string;
  environmentDriver: string;
}

export type WardenGrantOutcome = "consumed" | "not_found" | "expired" | "already_consumed" | "mismatch";

export interface WardenRecipientAuditEvent {
  checkId: string;
  event: string;
  at: string;
  recipe: string;
  actorAgentId: string;
  actorRunId: string;
  issueId: string;
  recipientAgentId: string | null;
  configRevision: string | null;
  grantId: string | null;
  code?: string;
  outcome?: string;
}

export interface WardenSecretResolver {
  resolveEnvBindings: (
    companyId: string,
    envValue: unknown,
    context?: {
      consumerType: "agent";
      consumerId: string;
      actorType: "system";
      actorId: string;
      issueId: string;
      heartbeatRunId: string;
    },
  ) => Promise<{ env: Record<string, string> }>;
}

export interface WardenServerPorts {
  preflight: { resolve(actor: CheckerActor, request: CheckerRequest): Promise<WardenRecipientTarget | null> };
  grants: {
    consume(input: {
      grantId: string;
      checkerAgentId: string;
      checkerRunId: string;
      issueId: string;
      recipientAgentId: string;
      configRevision: string;
      recipe: string;
      now: Date;
    }): Promise<WardenGrantOutcome>;
  };
  delivery: {
    resolveRecipientEnv(input: {
      companyId: string;
      recipientAgentId: string;
      configRevision: string;
    }): Promise<Record<string, string> | null>;
  };
  audit: { record(event: WardenRecipientAuditEvent): Promise<void> };
}

export function wardenRecipientCheckService(db: Db, secrets: WardenSecretResolver) {
  async function currentConfigRevision(companyId: string, agentId: string): Promise<string | null> {
    const row = await db
      .select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, companyId), eq(agentConfigRevisions.agentId, agentId)))
      .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  async function createGrant(input: {
    companyId: string;
    issueId: string;
    checkerAgentId: string;
    recipientAgentId: string;
    approvalId: string;
    createdByUserId: string;
    expiresInSeconds?: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const seconds = Math.min(Math.max(input.expiresInSeconds ?? WARDEN_GRANT_MAX_SECONDS, 60), WARDEN_GRANT_MAX_SECONDS);
    const approval = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!approval) throw notFound("Approval not found");
    if (approval.status !== "approved") throw unprocessable("Approval must be approved before a grant is issued");
    const payload = approval.payload as Record<string, unknown>;
    if (
      payload.recipe !== WARDEN_RECIPE_VERSION ||
      payload.issueId !== input.issueId ||
      payload.checkerAgentId !== input.checkerAgentId ||
      payload.recipientAgentId !== input.recipientAgentId
    ) {
      throw unprocessable("Approval payload does not match the exact recipe, issue, checker and recipient");
    }
    const [issue, checker, recipient] = await Promise.all([
      db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, input.issueId)).then((r) => r[0] ?? null),
      db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, input.checkerAgentId)).then((r) => r[0] ?? null),
      db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, input.recipientAgentId)).then((r) => r[0] ?? null),
    ]);
    if (!issue || issue.companyId !== input.companyId) throw notFound("Issue not found");
    if (!checker || checker.companyId !== input.companyId) throw notFound("Checker agent not found");
    if (!recipient || recipient.companyId !== input.companyId) throw notFound("Recipient agent not found");
    if (input.checkerAgentId === input.recipientAgentId) throw unprocessable("Checker and recipient must differ");
    const revision = await currentConfigRevision(input.companyId, input.recipientAgentId);
    if (!revision) throw unprocessable("Recipient has no recorded configuration revision");
    try {
      const [row] = await db
        .insert(wardenRecipientCheckGrants)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          checkerAgentId: input.checkerAgentId,
          recipientAgentId: input.recipientAgentId,
          configRevision: revision,
          recipe: WARDEN_RECIPE_VERSION,
          approvalId: input.approvalId,
          createdByUserId: input.createdByUserId,
          expiresAt: new Date(now.getTime() + seconds * 1000),
        })
        .returning();
      return row;
    } catch (err) {
      const pgCode = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (pgCode === "23505") throw conflict("Approval already backs a grant");
      throw err;
    }
  }

  async function revokeGrant(companyId: string, grantId: string, revokedByUserId: string, now = new Date()) {
    const rows = await db
      .update(wardenRecipientCheckGrants)
      .set({ revokedAt: now, revokedByUserId })
      .where(
        and(
          eq(wardenRecipientCheckGrants.id, grantId),
          eq(wardenRecipientCheckGrants.companyId, companyId),
          isNull(wardenRecipientCheckGrants.consumedAt),
          isNull(wardenRecipientCheckGrants.revokedAt),
        ),
      )
      .returning();
    if (rows.length === 0) throw conflict("Grant is missing, consumed or already revoked");
    return rows[0];
  }

  async function getGrantAudit(companyId: string, grantId: string) {
    const row = await db
      .select()
      .from(wardenRecipientCheckGrants)
      .where(and(eq(wardenRecipientCheckGrants.id, grantId), eq(wardenRecipientCheckGrants.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      grantId: row.id,
      approvalId: row.approvalId,
      recipe: row.recipe,
      expiresAt: row.expiresAt.toISOString(),
      consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    };
  }

  function buildPorts(actor: CheckerActor, issueId: string): WardenServerPorts {
    return {
      preflight: {
        async resolve(a, request) {
          const grant = await db
            .select()
            .from(wardenRecipientCheckGrants)
            .where(and(eq(wardenRecipientCheckGrants.id, request.grantId), eq(wardenRecipientCheckGrants.companyId, a.companyId)))
            .then((rows) => rows[0] ?? null);
          if (!grant) return null;
          const run = await db
            .select({
              id: heartbeatRuns.id,
              agentId: heartbeatRuns.agentId,
              status: heartbeatRuns.status,
              runIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
            })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.id, a.runId), eq(heartbeatRuns.companyId, a.companyId)))
            .then((rows) => rows[0] ?? null);
          const runValid = run !== null && run.agentId === a.agentId && run.status === "running";
          const recipient = await db
            .select({ id: agents.id, defaultEnvironmentId: agents.defaultEnvironmentId })
            .from(agents)
            .where(and(eq(agents.id, grant.recipientAgentId), eq(agents.companyId, a.companyId)))
            .then((rows) => rows[0] ?? null);
          if (!recipient) return null;
          const revision = await currentConfigRevision(a.companyId, recipient.id);
          if (!revision) return null;
          let environmentDriver = "local";
          if (recipient.defaultEnvironmentId) {
            const env = await db
              .select({ driver: environments.driver, config: environments.config })
              .from(environments)
              .where(eq(environments.id, recipient.defaultEnvironmentId))
              .then((rows) => rows[0] ?? null);
            const provider = (env?.config as Record<string, unknown> | undefined)?.provider;
            environmentDriver = env?.driver === "sandbox" && provider === "kubernetes" ? "kubernetes" : (env?.driver ?? "local");
          }
          return {
            recipientAgentId: recipient.id,
            currentConfigRevision: revision,
            checkerAgentId: runValid ? run.agentId : "",
            checkerRunId: runValid ? run.id : "",
            issueId: runValid ? (run.runIssueId ?? "") : "",
            environmentDriver,
          };
        },
      },
      grants: {
        async consume(input) {
          const rows = await db
            .update(wardenRecipientCheckGrants)
            .set({ consumedAt: input.now, consumedByRunId: input.checkerRunId })
            .where(
              and(
                eq(wardenRecipientCheckGrants.id, input.grantId),
                eq(wardenRecipientCheckGrants.companyId, actor.companyId),
                eq(wardenRecipientCheckGrants.issueId, input.issueId),
                eq(wardenRecipientCheckGrants.checkerAgentId, input.checkerAgentId),
                eq(wardenRecipientCheckGrants.recipientAgentId, input.recipientAgentId),
                eq(wardenRecipientCheckGrants.configRevision, input.configRevision),
                eq(wardenRecipientCheckGrants.recipe, input.recipe),
                isNull(wardenRecipientCheckGrants.consumedAt),
                isNull(wardenRecipientCheckGrants.revokedAt),
                gt(wardenRecipientCheckGrants.expiresAt, input.now),
              ),
            )
            .returning({ id: wardenRecipientCheckGrants.id });
          if (rows.length === 1) return "consumed";
          const row = await db
            .select()
            .from(wardenRecipientCheckGrants)
            .where(and(eq(wardenRecipientCheckGrants.id, input.grantId), eq(wardenRecipientCheckGrants.companyId, actor.companyId)))
            .then((r) => r[0] ?? null);
          if (!row) return "not_found";
          if (row.consumedAt) return "already_consumed";
          if (row.revokedAt) return "mismatch";
          if (row.expiresAt.getTime() <= input.now.getTime()) return "expired";
          return "mismatch";
        },
      },
      delivery: {
        async resolveRecipientEnv(input) {
          const latest = await currentConfigRevision(input.companyId, input.recipientAgentId);
          if (latest !== input.configRevision) return null;
          const agent = await db
            .select({ adapterConfig: agents.adapterConfig })
            .from(agents)
            .where(and(eq(agents.id, input.recipientAgentId), eq(agents.companyId, input.companyId)))
            .then((rows) => rows[0] ?? null);
          const configEnv = (agent?.adapterConfig as Record<string, unknown> | undefined)?.env;
          if (!configEnv || typeof configEnv !== "object" || Array.isArray(configEnv)) return null;
          const selected: Record<string, unknown> = {};
          for (const key of WARDEN_ALLOWED_ENV_KEYS) {
            const parsed = envBindingSchema.safeParse((configEnv as Record<string, unknown>)[key]);
            if (!parsed.success || typeof parsed.data === "string" || parsed.data.type !== "secret_ref") return null;
            selected[key] = parsed.data;
          }
          const resolved = await secrets.resolveEnvBindings(input.companyId, selected, {
            consumerType: "agent",
            consumerId: input.recipientAgentId,
            actorType: "system",
            actorId: "warden-recipient-check",
            issueId,
            heartbeatRunId: actor.runId,
          });
          return resolved.env;
        },
      },
      audit: {
        async record(event) {
          await logActivity(db, {
            companyId: actor.companyId,
            actorType: "agent",
            actorId: actor.agentId,
            agentId: actor.agentId,
            runId: actor.runId,
            issueId,
            action: `warden_recipient_check.${event.event}`,
            entityType: "issue",
            entityId: issueId,
            details: {
              checkId: event.checkId,
              recipe: event.recipe,
              recipientAgentId: event.recipientAgentId,
              configRevision: event.configRevision,
              grantId: event.grantId,
              code: event.code ?? null,
              outcome: event.outcome ?? null,
            },
          });
        },
      },
    };
  }

  return { currentConfigRevision, createGrant, revokeGrant, getGrantAudit, buildPorts };
}

export function assertAgentChecker(actor: { type: string; agentId?: string; runId?: string; companyId?: string }) {
  if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
    throw forbidden("Agent authentication required");
  }
  if (!actor.runId) throw forbidden("A current run is required");
  return { agentId: actor.agentId, runId: actor.runId, companyId: actor.companyId } satisfies CheckerActor;
}
