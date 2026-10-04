import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentConfigRevisions,
  agents,
  approvals,
  companySecretBindings,
  companySecrets,
  heartbeatRuns,
  issues,
  wardenRecipientCheckGrants,
  wardenRecipientCheckReceipts,
} from "@paperclipai/db";
import { envBindingSchema } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export const WARDEN_RECIPE_VERSION = "warden-uat-aws-v1";
export const WARDEN_GRANT_MAX_SECONDS = 900;
export const WARDEN_APPROVAL_MAX_AGE_MS = 60 * 60 * 1000;
export const WARDEN_APPROVAL_TYPE = "request_board_approval";
export const WARDEN_ALLOWED_ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;
export const WARDEN_APPROVED_SECRET_NAMES = Object.freeze({
  AWS_ACCESS_KEY_ID: "aws/warden-uat-validate/id",
  AWS_SECRET_ACCESS_KEY: "aws/warden-uat-validate/secret",
} as const);
export const WARDEN_OLD_ALIAS_PREFIX = "pw-hrms/ACCESS_KEY_";
const ALIAS_MISMATCH_SENTINEL = "<mismatch>";

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

export interface WardenAliasProjection {
  authority: boolean;
  accessKeyId: { name: string; delivery: string } | null;
  secretAccessKey: { name: string; delivery: string } | null;
  oldMappingsPresent: boolean;
}

export interface WardenSecretResolver {
  resolveEnvBindings: (
    companyId: string,
    envValue: unknown,
    context?: {
      consumerType: "agent";
      consumerId: string;
      actorType: "agent";
      actorId: string;
      actorSource: "agent_jwt";
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
  aliases: {
    project(input: { companyId: string; recipientAgentId: string; configRevision: string }): Promise<WardenAliasProjection>;
  };
  audit: { record(event: WardenRecipientAuditEvent): Promise<void> };
}

export interface WardenCheckReceiptInput {
  checkId: string;
  recipeVersion: string;
  configRevision: string;
  aliasNamesMatch: string;
  expectedPrincipalMatch: string;
  codebuildProjectFound: string;
  eksClusterActive: string;
  overall: string;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  leaseAttestation: {
    freshLease: boolean;
    jobUidDigest: string;
    egressVerified: boolean;
    destroyed: boolean;
    destroyVerifiedAbsent: boolean;
  } | null;
}

interface CredentialSnapshot {
  revision: string;
  fingerprint: string;
  entries: Array<{
    key: (typeof WARDEN_ALLOWED_ENV_KEYS)[number];
    secretId: string;
    version: number;
    name: string;
  }>;
  oldMappingsPresent: boolean;
}

export interface WardenRecipientCheckOptions {
  wardenRecipientAgentId?: string | null;
}

const TRI = new Set(["PASS", "FAIL", "INCONCLUSIVE"]);

export function wardenRecipientCheckService(db: Db, secrets: WardenSecretResolver, options: WardenRecipientCheckOptions = {}) {
  const configuredWardenId = options.wardenRecipientAgentId?.trim() || null;

  function requireWardenId(): string {
    if (!configuredWardenId) throw new HttpError(503, "Warden recipient is not configured");
    return configuredWardenId;
  }

  async function currentConfigRevision(companyId: string, agentId: string, source: Pick<Db, "select"> = db): Promise<string | null> {
    const row = await source
      .select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, companyId), eq(agentConfigRevisions.agentId, agentId)))
      .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  async function readCredentialSnapshot(companyId: string, recipientAgentId: string): Promise<CredentialSnapshot | null> {
    return db.transaction(
      async (tx) => {
        const source = tx as unknown as Db;
        const revision = await currentConfigRevision(companyId, recipientAgentId, source);
        if (!revision) return null;
        const agent = await source
          .select({ adapterConfig: agents.adapterConfig })
          .from(agents)
          .where(and(eq(agents.id, recipientAgentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        const configEnv = (agent?.adapterConfig as Record<string, unknown> | undefined)?.env;
        if (!configEnv || typeof configEnv !== "object" || Array.isArray(configEnv)) return null;
        const bindingRows = await source
          .select({
            bindingId: companySecretBindings.id,
            configPath: companySecretBindings.configPath,
            secretId: companySecretBindings.secretId,
            secretName: companySecrets.name,
            secretStatus: companySecrets.status,
            secretScope: companySecrets.scope,
            secretCompanyId: companySecrets.companyId,
            latestVersion: companySecrets.latestVersion,
          })
          .from(companySecretBindings)
          .innerJoin(companySecrets, eq(companySecretBindings.secretId, companySecrets.id))
          .where(
            and(
              eq(companySecretBindings.companyId, companyId),
              eq(companySecretBindings.targetType, "agent"),
              eq(companySecretBindings.targetId, recipientAgentId),
            ),
          );
        const entries: CredentialSnapshot["entries"] = [];
        const parts: unknown[] = [revision];
        for (const key of WARDEN_ALLOWED_ENV_KEYS) {
          const parsed = envBindingSchema.safeParse((configEnv as Record<string, unknown>)[key]);
          if (!parsed.success || typeof parsed.data === "string" || parsed.data.type !== "secret_ref") return null;
          const refSecretId = parsed.data.secretId;
          const binding = bindingRows.find((row) => row.configPath === `env.${key}` && row.secretId === refSecretId);
          if (!binding) return null;
          if (binding.secretCompanyId !== companyId || binding.secretScope !== "company" || binding.secretStatus !== "active") return null;
          const selector = parsed.data.version ?? "latest";
          const version = selector === "latest" ? binding.latestVersion : selector;
          entries.push({ key, secretId: binding.secretId, version, name: binding.secretName });
          parts.push([key, binding.secretId, binding.bindingId, selector, version, binding.secretName]);
        }
        const oldMappingsPresent = bindingRows.some((row) => row.secretName.startsWith(WARDEN_OLD_ALIAS_PREFIX));
        parts.push(oldMappingsPresent);
        const fingerprint = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
        return { revision, fingerprint, entries, oldMappingsPresent };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  function projectionFromSnapshot(snapshot: CredentialSnapshot | null, configRevision: string): WardenAliasProjection {
    if (!snapshot || snapshot.revision !== configRevision) {
      return { authority: false, accessKeyId: null, secretAccessKey: null, oldMappingsPresent: false };
    }
    const shape = (key: (typeof WARDEN_ALLOWED_ENV_KEYS)[number]) => {
      const entry = snapshot.entries.find((e) => e.key === key);
      if (!entry) return null;
      return {
        name: entry.name === WARDEN_APPROVED_SECRET_NAMES[key] ? WARDEN_APPROVED_SECRET_NAMES[key] : ALIAS_MISMATCH_SENTINEL,
        delivery: "env",
      };
    };
    return {
      authority: true,
      accessKeyId: shape("AWS_ACCESS_KEY_ID"),
      secretAccessKey: shape("AWS_SECRET_ACCESS_KEY"),
      oldMappingsPresent: snapshot.oldMappingsPresent,
    };
  }

  function aliasesMatch(projection: WardenAliasProjection): boolean {
    return (
      projection.authority &&
      projection.accessKeyId?.name === WARDEN_APPROVED_SECRET_NAMES.AWS_ACCESS_KEY_ID &&
      projection.secretAccessKey?.name === WARDEN_APPROVED_SECRET_NAMES.AWS_SECRET_ACCESS_KEY &&
      !projection.oldMappingsPresent
    );
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
    const wardenId = requireWardenId();
    const now = input.now ?? new Date();
    const seconds = Math.min(Math.max(input.expiresInSeconds ?? WARDEN_GRANT_MAX_SECONDS, 60), WARDEN_GRANT_MAX_SECONDS);
    if (input.recipientAgentId !== wardenId) throw unprocessable("Recipient is not the configured Warden agent");
    const approval = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!approval) throw notFound("Approval not found");
    if (approval.type !== WARDEN_APPROVAL_TYPE) throw unprocessable("Approval has the wrong type");
    if (approval.status !== "approved") throw unprocessable("Approval must be approved before a grant is issued");
    if (!approval.decidedAt || !approval.decidedByUserId?.trim()) {
      throw unprocessable("Approval has no recorded decision");
    }
    const ageMs = now.getTime() - approval.decidedAt.getTime();
    if (ageMs < 0 || ageMs > WARDEN_APPROVAL_MAX_AGE_MS) throw unprocessable("Approval decision is stale");
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
    const snapshot = await readCredentialSnapshot(input.companyId, input.recipientAgentId);
    if (!snapshot) throw unprocessable("Recipient has no recorded revision or a valid credential binding");
    try {
      const [row] = await db
        .insert(wardenRecipientCheckGrants)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          checkerAgentId: input.checkerAgentId,
          recipientAgentId: input.recipientAgentId,
          configRevision: snapshot.revision,
          credentialFingerprint: snapshot.fingerprint,
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

  async function recordReceipt(actor: CheckerActor, issueId: string, grantId: string, receipt: WardenCheckReceiptInput) {
    const grant = await db
      .select()
      .from(wardenRecipientCheckGrants)
      .where(and(eq(wardenRecipientCheckGrants.id, grantId), eq(wardenRecipientCheckGrants.companyId, actor.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!grant || grant.issueId !== issueId || grant.checkerAgentId !== actor.agentId || grant.consumedByRunId !== actor.runId) {
      throw forbidden("Receipt does not match the consumed grant");
    }
    const tri = (value: string) => (TRI.has(value) ? value : "INCONCLUSIVE");
    const lease = receipt.leaseAttestation;
    const [row] = await db
      .insert(wardenRecipientCheckReceipts)
      .values({
        companyId: actor.companyId,
        grantId: grant.id,
        issueId: grant.issueId,
        checkerAgentId: grant.checkerAgentId,
        recipientAgentId: grant.recipientAgentId,
        checkId: receipt.checkId,
        recipe: grant.recipe,
        configRevision: grant.configRevision,
        credentialFingerprint: grant.credentialFingerprint,
        aliasNamesMatch: tri(receipt.aliasNamesMatch),
        expectedPrincipalMatch: tri(receipt.expectedPrincipalMatch),
        codebuildProjectFound: tri(receipt.codebuildProjectFound),
        eksClusterActive: tri(receipt.eksClusterActive),
        overall: tri(receipt.overall),
        outcome: receipt.outcome,
        leaseFresh: lease?.freshLease === true,
        leaseEgressVerified: lease?.egressVerified === true,
        leaseDestroyed: lease?.destroyed === true,
        leaseDestroyVerifiedAbsent: lease?.destroyVerifiedAbsent === true,
        leaseJobUidDigest: lease?.jobUidDigest ?? "none",
        startedAt: new Date(receipt.startedAt),
        finishedAt: new Date(receipt.finishedAt),
      })
      .returning();
    return row;
  }

  function buildPorts(actor: CheckerActor, issueId: string, grantId: string): WardenServerPorts {
    return {
      preflight: {
        async resolve(a, request) {
          const grant = await db
            .select()
            .from(wardenRecipientCheckGrants)
            .where(and(eq(wardenRecipientCheckGrants.id, request.grantId), eq(wardenRecipientCheckGrants.companyId, a.companyId)))
            .then((rows) => rows[0] ?? null);
          if (!grant) return null;
          if (!configuredWardenId || grant.recipientAgentId !== configuredWardenId) return null;
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
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, grant.recipientAgentId), eq(agents.companyId, a.companyId)))
            .then((rows) => rows[0] ?? null);
          if (!recipient) return null;
          const revision = await currentConfigRevision(a.companyId, recipient.id);
          if (!revision) return null;
          return {
            recipientAgentId: recipient.id,
            currentConfigRevision: revision,
            checkerAgentId: runValid ? run.agentId : "",
            checkerRunId: runValid ? run.id : "",
            issueId: runValid ? (run.runIssueId ?? "") : "",
            environmentDriver: "kubernetes",
          };
        },
      },
      grants: {
        async consume(input) {
          const snapshot = await readCredentialSnapshot(actor.companyId, input.recipientAgentId);
          if (!snapshot) return "mismatch";
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
                eq(wardenRecipientCheckGrants.credentialFingerprint, snapshot.fingerprint),
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
          const grant = await db
            .select()
            .from(wardenRecipientCheckGrants)
            .where(and(eq(wardenRecipientCheckGrants.id, grantId), eq(wardenRecipientCheckGrants.companyId, input.companyId)))
            .then((rows) => rows[0] ?? null);
          if (
            !grant ||
            !grant.consumedAt ||
            grant.consumedByRunId !== actor.runId ||
            grant.recipientAgentId !== input.recipientAgentId ||
            grant.configRevision !== input.configRevision
          ) {
            return null;
          }
          const first = await readCredentialSnapshot(input.companyId, input.recipientAgentId);
          if (!first || first.revision !== input.configRevision || first.fingerprint !== grant.credentialFingerprint) return null;
          const projection = projectionFromSnapshot(first, input.configRevision);
          if (projection.authority && !aliasesMatch(projection)) return null;
          const pinned: Record<string, unknown> = {};
          for (const entry of first.entries) {
            pinned[entry.key] = { type: "secret_ref", secretId: entry.secretId, version: entry.version };
          }
          const resolved = await secrets.resolveEnvBindings(input.companyId, pinned, {
            consumerType: "agent",
            consumerId: input.recipientAgentId,
            actorType: "agent",
            actorId: actor.agentId,
            actorSource: "agent_jwt",
            issueId,
            heartbeatRunId: actor.runId,
          });
          const second = await readCredentialSnapshot(input.companyId, input.recipientAgentId);
          if (!second || second.revision !== first.revision || second.fingerprint !== first.fingerprint) return null;
          return resolved.env;
        },
      },
      aliases: {
        async project(input) {
          return projectionFromSnapshot(await readCredentialSnapshot(input.companyId, input.recipientAgentId), input.configRevision);
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
              checkerAgentId: actor.agentId,
              recipientAgentId: event.recipientAgentId,
              configRevision: event.configRevision,
              grantId: event.grantId ?? grantId,
              code: event.code ?? null,
              outcome: event.outcome ?? null,
            },
          });
        },
      },
    };
  }

  return {
    currentConfigRevision,
    readCredentialSnapshot,
    createGrant,
    revokeGrant,
    getGrantAudit,
    recordReceipt,
    buildPorts,
  };
}

export function assertAgentChecker(actor: { type: string; agentId?: string; runId?: string; companyId?: string; source?: string }) {
  if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
    throw forbidden("Agent authentication required");
  }
  if (actor.source !== "agent_jwt") throw forbidden("A run-bound agent token is required");
  if (!actor.runId) throw forbidden("A current run is required");
  return { agentId: actor.agentId, runId: actor.runId, companyId: actor.companyId } satisfies CheckerActor;
}
