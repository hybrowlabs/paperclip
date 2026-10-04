import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  environments,
  heartbeatRuns,
  issues,
  secretAccessEvents,
  wardenRecipientCheckGrants,
  wardenRecipientCheckReceipts,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { wardenRecipientCheckRoutes, type WardenCheckRunner } from "../routes/warden-recipient-checks.js";
import { secretService } from "../services/secrets.js";
import {
  WARDEN_RECIPE_VERSION,
  wardenRecipientCheckService,
  type WardenCheckReceiptInput,
  type WardenServerPorts,
} from "../services/warden-recipient-check.js";
import { createWardenRecipientRuntime, readWardenRunnerConfig } from "../services/warden-recipient-runtime.js";
import { runWardenRecipientCheck, WARDEN_RECIPE } from "../../../packages/plugins/sandbox-providers/kubernetes/src/warden-recipient/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SECRET_AK = "AKIA_SYNTHETIC_ACCESS_KEY_VALUE";
const SECRET_SK = "synthetic-secret-key-value-do-not-leak";
const NAME_AK = "aws/warden-uat-validate/id";
const NAME_SK = "aws/warden-uat-validate/secret";

describeEmbeddedPostgres("warden recipient check server adapters", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-warden-check-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("warden-recipient-check");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(wardenRecipientCheckReceipts);
    await db.delete(wardenRecipientCheckGrants);
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agentConfigRevisions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seed(opts: { revisions?: number; withSecrets?: boolean; names?: [string, string]; extraBindingName?: string } = {}) {
    const companyId = randomUUID();
    const checkerId = randomUUID();
    const recipientId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Warden check",
      issuePrefix: `W${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    const env: Record<string, unknown> = {};
    const svc = secretService(db);
    const secretIds: { ak?: string; sk?: string } = {};
    if (opts.withSecrets) {
      const [akName, skName] = opts.names ?? [NAME_AK, NAME_SK];
      const ak = await svc.create(companyId, { key: "WARDEN_AK", name: akName, provider: "local_encrypted", value: SECRET_AK });
      const sk = await svc.create(companyId, { key: "WARDEN_SK", name: skName, provider: "local_encrypted", value: SECRET_SK });
      secretIds.ak = ak.id;
      secretIds.sk = sk.id;
      env.AWS_ACCESS_KEY_ID = { type: "secret_ref", secretId: ak.id, version: "latest" };
      env.AWS_SECRET_ACCESS_KEY = { type: "secret_ref", secretId: sk.id, version: "latest" };
    }
    await db.insert(agents).values([
      { id: checkerId, companyId, name: "Sentinel", role: "qa", adapterType: "codex_local", adapterConfig: {}, status: "idle" },
      { id: recipientId, companyId, name: "Warden", role: "engineer", adapterType: "codex_local", adapterConfig: { env }, status: "idle" },
    ]);
    if (opts.withSecrets) {
      await svc.createBinding({ companyId, secretId: secretIds.ak!, targetType: "agent", targetId: recipientId, configPath: "env.AWS_ACCESS_KEY_ID" });
      await svc.createBinding({ companyId, secretId: secretIds.sk!, targetType: "agent", targetId: recipientId, configPath: "env.AWS_SECRET_ACCESS_KEY" });
      if (opts.extraBindingName) {
        const old = await svc.create(companyId, { key: "OLD_AK", name: opts.extraBindingName, provider: "local_encrypted", value: "old-value" });
        await svc.createBinding({ companyId, secretId: old.id, targetType: "agent", targetId: recipientId, configPath: "env.OLD_ALIAS" });
      }
    }
    await db.insert(issues).values({ id: issueId, companyId, title: "UAT verification", status: "in_progress", priority: "medium" });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: checkerId,
      status: "running",
      contextSnapshot: { issueId },
    });
    const revisionIds: string[] = [];
    for (let i = 0; i < (opts.revisions ?? 1); i += 1) {
      const id = randomUUID();
      revisionIds.push(id);
      await db.insert(agentConfigRevisions).values({
        id,
        companyId,
        agentId: recipientId,
        beforeConfig: {},
        afterConfig: {},
        createdAt: new Date(Date.now() - 60_000 + i * 1000),
      });
    }
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "approved",
      decidedByUserId: "board-user",
      decidedAt: new Date(),
      payload: { recipe: WARDEN_RECIPE_VERSION, issueId, checkerAgentId: checkerId, recipientAgentId: recipientId },
    });
    return { companyId, checkerId, recipientId, issueId, runId, approvalId, revisionIds, secretIds };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;
  const service = (f: Fixture) =>
    wardenRecipientCheckService(db, secretService(db), { wardenRecipientAgentId: f.recipientId });
  const actorOf = (f: Fixture) => ({ agentId: f.checkerId, runId: f.runId, companyId: f.companyId });
  const portsOf = (f: Fixture, grantId = randomUUID()) => service(f).buildPorts(actorOf(f), f.issueId, grantId);
  const mkGrant = (f: Fixture, extra: Partial<Parameters<ReturnType<typeof service>["createGrant"]>[0]> = {}) =>
    service(f).createGrant({
      companyId: f.companyId,
      issueId: f.issueId,
      checkerAgentId: f.checkerId,
      recipientAgentId: f.recipientId,
      approvalId: f.approvalId,
      createdByUserId: "board-user",
      ...extra,
    });
  const consumeInput = (f: Fixture, grantId: string, revision: string, over: Record<string, unknown> = {}) => ({
    grantId,
    checkerAgentId: f.checkerId,
    checkerRunId: f.runId,
    issueId: f.issueId,
    recipientAgentId: f.recipientId,
    configRevision: revision,
    recipe: WARDEN_RECIPE_VERSION,
    now: new Date(),
    ...over,
  });
  const resolveReq = (f: Fixture, grantId: string, revision: string) => ({
    selector: "warden-uat-aws" as const,
    issueId: f.issueId,
    grantId,
    expectedConfigRevision: revision,
  });
  const goodReceipt = (over: Partial<WardenCheckReceiptInput> = {}): WardenCheckReceiptInput => ({
    checkId: randomUUID(),
    recipeVersion: WARDEN_RECIPE_VERSION,
    configRevision: "ignored-by-server",
    aliasNamesMatch: "PASS",
    expectedPrincipalMatch: "PASS",
    codebuildProjectFound: "PASS",
    eksClusterActive: "PASS",
    overall: "PASS",
    outcome: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    leaseAttestation: { freshLease: true, jobUidDigest: "abcdef0123456789", egressVerified: true, destroyed: true, destroyVerifiedAbsent: true },
    ...over,
  });

  describe("grant issuance", () => {
    it("binds to the current Warden revision and credential fingerprint, caps lifetime at 15 minutes, and requires a matching approved approval", async () => {
      const f = await seed({ revisions: 3, withSecrets: true });
      const grant = await mkGrant(f, { expiresInSeconds: 99_999 });
      expect(grant.configRevision).toBe(f.revisionIds[2]);
      expect(grant.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(900_000 + 1000);
      expect(grant.recipe).toBe(WARDEN_RECIPE_VERSION);
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 409 });
    });

    it("rejects an unapproved, mismatched, or cross-agent approval", async () => {
      const f = await seed({ withSecrets: true });
      await db.update(approvals).set({ status: "pending" });
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 422 });
      await db.update(approvals).set({ status: "approved", payload: { recipe: "other", issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.recipientId } });
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 422 });
      await db.update(approvals).set({ payload: { recipe: WARDEN_RECIPE_VERSION, issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.checkerId } });
      await expect(mkGrant(f, { recipientAgentId: f.checkerId })).rejects.toMatchObject({ status: 422 });
    });

    it.each([
      ["wrong approval type", { type: "hire_agent" }],
      ["no decision timestamp", { decidedAt: null }],
      ["no deciding user", { decidedByUserId: null }],
      ["blank deciding user", { decidedByUserId: "  " }],
      ["decision older than 60 minutes", { decidedAt: new Date(Date.now() - 61 * 60_000) }],
      ["decision in the future", { decidedAt: new Date(Date.now() + 5 * 60_000) }],
    ])("rejects an approval with %s", async (_n, patch) => {
      const f = await seed({ withSecrets: true });
      await db.update(approvals).set(patch as never);
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 422 });
      expect(await db.select().from(wardenRecipientCheckGrants)).toHaveLength(0);
    });

    it("accepts a decision made 59 minutes ago", async () => {
      const f = await seed({ withSecrets: true });
      await db.update(approvals).set({ decidedAt: new Date(Date.now() - 59 * 60_000) });
      await expect(mkGrant(f)).resolves.toMatchObject({ recipe: WARDEN_RECIPE_VERSION });
    });

    it("rejects a recipient that is not the server-configured Warden id and fails closed when unset", async () => {
      const f = await seed({ withSecrets: true });
      const other = wardenRecipientCheckService(db, secretService(db), { wardenRecipientAgentId: randomUUID() });
      await expect(
        other.createGrant({ companyId: f.companyId, issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.recipientId, approvalId: f.approvalId, createdByUserId: "u" }),
      ).rejects.toMatchObject({ status: 422 });
      const unset = wardenRecipientCheckService(db, secretService(db), {});
      await expect(
        unset.createGrant({ companyId: f.companyId, issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.recipientId, approvalId: f.approvalId, createdByUserId: "u" }),
      ).rejects.toMatchObject({ status: 503 });
    });

    it("rejects an agent with no recorded revision or no valid credential bindings (fail closed)", async () => {
      const noRevision = await seed({ revisions: 0, withSecrets: true });
      await expect(mkGrant(noRevision)).rejects.toMatchObject({ status: 422 });
      const noSecrets = await seed();
      await expect(mkGrant(noSecrets)).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("atomic one-use consumption and credential binding", () => {
    it("lets exactly one of many concurrent consumers win and records consumption", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const ports = portsOf(f, grant.id);
      const results = await Promise.all(Array.from({ length: 8 }, () => ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))));
      expect(results.filter((r) => r === "consumed")).toHaveLength(1);
      expect(results.filter((r) => r === "already_consumed")).toHaveLength(7);
      const audit = await service(f).getGrantAudit(f.companyId, grant.id);
      expect(audit?.consumedAt).not.toBeNull();
      const [row] = await db.select().from(wardenRecipientCheckGrants);
      expect(row.consumedByRunId).toBe(f.runId);
    });

    it.each([
      ["wrong checker", (f: Fixture) => ({ checkerAgentId: f.recipientId })],
      ["wrong issue", () => ({ issueId: randomUUID() })],
      ["wrong recipient", (f: Fixture) => ({ recipientAgentId: f.checkerId })],
      ["stale revision", () => ({ configRevision: randomUUID() })],
      ["different recipe", () => ({ recipe: "warden-uat-aws-v2" })],
    ])("denies %s without consuming the grant", async (_name, over) => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const ports = portsOf(f, grant.id);
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision, over(f)))).toBe("mismatch");
      expect((await service(f).getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("consumed");
    });

    it("denies expired and revoked grants and unknown grants", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const ports = portsOf(f, grant.id);
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision, { now: new Date(grant.expiresAt.getTime() + 1) }))).toBe("expired");
      expect(await ports.grants.consume(consumeInput(f, randomUUID(), grant.configRevision))).toBe("not_found");
      await service(f).revokeGrant(f.companyId, grant.id, "board-user");
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("mismatch");
      await expect(service(f).revokeGrant(f.companyId, grant.id, "board-user")).rejects.toMatchObject({ status: 409 });
    });

    it("does not allow revoking a consumed grant", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await portsOf(f, grant.id).grants.consume(consumeInput(f, grant.id, grant.configRevision));
      await expect(service(f).revokeGrant(f.companyId, grant.id, "board-user")).rejects.toMatchObject({ status: 409 });
    });

    it("denies consumption after the secret is rotated, without consuming the grant", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await secretService(db).rotate(f.secretIds.ak!, { value: "rotated-value" });
      expect(await portsOf(f, grant.id).grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("mismatch");
      expect((await service(f).getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
    });

    it("denies consumption after a binding is moved to another secret or removed", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, f.secretIds.sk!));
      expect(await portsOf(f, grant.id).grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("mismatch");
      expect((await service(f).getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
    });

    it("denies consumption when an old pw-hrms alias binding appears after the grant", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const old = await secretService(db).create(f.companyId, { key: "OLD_AK", name: "pw-hrms/ACCESS_KEY_ID", provider: "local_encrypted", value: "old" });
      await secretService(db).createBinding({ companyId: f.companyId, secretId: old.id, targetType: "agent", targetId: f.recipientId, configPath: "env.OLD_ALIAS" });
      expect(await portsOf(f, grant.id).grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("mismatch");
    });
  });

  describe("preflight", () => {
    it("reports the current revision, the run's issue and the fixed Kubernetes driver", async () => {
      const f = await seed({ revisions: 2, withSecrets: true });
      const grant = await mkGrant(f);
      const target = await portsOf(f, grant.id).preflight.resolve(actorOf(f), resolveReq(f, grant.id, grant.configRevision));
      expect(target).toEqual({
        recipientAgentId: f.recipientId,
        currentConfigRevision: f.revisionIds[1],
        checkerAgentId: f.checkerId,
        checkerRunId: f.runId,
        issueId: f.issueId,
        environmentDriver: "kubernetes",
      });
    });

    it("does not depend on the recipient's default environment", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const envId = randomUUID();
      await db.insert(environments).values({ id: envId, name: `env-${envId}`, driver: "local", config: {} });
      await db.update(agents).set({ defaultEnvironmentId: envId }).where(eq(agents.id, f.recipientId));
      const target = await portsOf(f, grant.id).preflight.resolve(actorOf(f), resolveReq(f, grant.id, grant.configRevision));
      expect(target?.environmentDriver).toBe("kubernetes");
    });

    it.each([
      ["run belongs to another agent", (f: Fixture) => db.update(heartbeatRuns).set({ agentId: f.recipientId })],
      ["run is not running", () => db.update(heartbeatRuns).set({ status: "succeeded" })],
    ])("blanks the checker identity when %s", async (_n, mutate) => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await mutate(f);
      const target = await portsOf(f, grant.id).preflight.resolve(actorOf(f), resolveReq(f, grant.id, grant.configRevision));
      expect(target?.checkerAgentId).toBe("");
      expect(target?.checkerRunId).toBe("");
    });

    it("reports a different issue when the run is not on the case issue, and null for a foreign grant", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } });
      const req = resolveReq(f, grant.id, grant.configRevision);
      const target = await portsOf(f, grant.id).preflight.resolve(actorOf(f), req);
      expect(target?.issueId).not.toBe(f.issueId);
      const other = await seed({ withSecrets: true });
      expect(await portsOf(other).preflight.resolve(actorOf(other), req)).toBeNull();
    });

    it("moves to a new current revision after a Warden config change", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await db.insert(agentConfigRevisions).values({ companyId: f.companyId, agentId: f.recipientId, beforeConfig: {}, afterConfig: {} });
      const target = await portsOf(f, grant.id).preflight.resolve(actorOf(f), resolveReq(f, grant.id, grant.configRevision));
      expect(target?.currentConfigRevision).not.toBe(grant.configRevision);
    });

    it("returns null for a grant whose recipient is not the configured Warden", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const wrong = wardenRecipientCheckService(db, secretService(db), { wardenRecipientAgentId: randomUUID() });
      expect(await wrong.buildPorts(actorOf(f), f.issueId, grant.id).preflight.resolve(actorOf(f), resolveReq(f, grant.id, grant.configRevision))).toBeNull();
    });
  });

  describe("delivery", () => {
    async function consumed(f: Fixture) {
      const grant = await mkGrant(f);
      const ports = portsOf(f, grant.id);
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("consumed");
      const input = { companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision };
      return { grant, ports, input };
    }

    it("resolves exactly the two bound secret refs through normal secret delivery and records the checker in access events", async () => {
      const f = await seed({ withSecrets: true });
      const { ports, input } = await consumed(f);
      const env = await ports.delivery.resolveRecipientEnv(input);
      expect(env).toEqual({ AWS_ACCESS_KEY_ID: SECRET_AK, AWS_SECRET_ACCESS_KEY: SECRET_SK });
      const events = await db.select().from(secretAccessEvents);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.consumerType === "agent" && e.consumerId === f.recipientId && e.outcome === "success")).toBe(true);
      expect(events.every((e) => e.actorType === "agent" && e.actorId === f.checkerId && e.heartbeatRunId === f.runId && e.issueId === f.issueId)).toBe(true);
    });

    it("refuses delivery before the grant is consumed, by another run, or for another revision", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const ports = portsOf(f, grant.id);
      const input = { companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision };
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
      await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision));
      expect(await ports.delivery.resolveRecipientEnv({ ...input, configRevision: randomUUID() })).toBeNull();
      const otherRun = wardenRecipientCheckService(db, secretService(db), { wardenRecipientAgentId: f.recipientId }).buildPorts(
        { ...actorOf(f), runId: randomUUID() }, f.issueId, grant.id,
      );
      expect(await otherRun.delivery.resolveRecipientEnv(input)).toBeNull();
      expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    });

    it("returns null for non-secret-ref values or missing keys", async () => {
      const f = await seed({ withSecrets: true });
      const { ports, input } = await consumed(f);
      await db.update(agents).set({ adapterConfig: { env: { AWS_ACCESS_KEY_ID: "plain", AWS_SECRET_ACCESS_KEY: "plain" } } });
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
      await db.update(agents).set({ adapterConfig: {} });
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
    });

    it("denies delivery when the secret was rotated between grant and consume, and never reads a value", async () => {
      const f = await seed({ withSecrets: true });
      const { ports, input } = await consumed(f);
      await secretService(db).rotate(f.secretIds.sk!, { value: "rotated-after-consume" });
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
      expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    });

    it("denies delivery when a binding is rebound to a different secret after consume", async () => {
      const f = await seed({ withSecrets: true });
      const { ports, input } = await consumed(f);
      const other = await secretService(db).create(f.companyId, { key: "OTHER", name: "other", provider: "local_encrypted", value: "other-value" });
      await db.update(companySecretBindings).set({ secretId: other.id }).where(eq(companySecretBindings.secretId, f.secretIds.ak!));
      await db.update(agents).set({ adapterConfig: { env: {
        AWS_ACCESS_KEY_ID: { type: "secret_ref", secretId: other.id, version: "latest" },
        AWS_SECRET_ACCESS_KEY: { type: "secret_ref", secretId: f.secretIds.sk!, version: "latest" },
      } } }).where(eq(agents.id, f.recipientId));
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
    });

    it("denies and discards when the credential changes between resolution and the recheck", async () => {
      const f = await seed({ withSecrets: true });
      const { grant } = await consumed(f);
      const real = secretService(db);
      const racing = {
        resolveEnvBindings: async (...args: Parameters<typeof real.resolveEnvBindings>) => {
          const out = await real.resolveEnvBindings(...args);
          await real.rotate(f.secretIds.ak!, { value: "rotated-mid-flight" });
          return out;
        },
      };
      const ports = wardenRecipientCheckService(db, racing, { wardenRecipientAgentId: f.recipientId }).buildPorts(actorOf(f), f.issueId, grant.id);
      expect(await ports.delivery.resolveRecipientEnv({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision })).toBeNull();
    });

    it("denies delivery when the bound secret names are not the approved aliases", async () => {
      const f = await seed({ withSecrets: true, names: ["pw-hrms/ACCESS_KEY_ID", "pw-hrms/ACCESS_KEY_SECRET"] });
      const { ports, input } = await consumed(f);
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
      expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    });

    it("denies delivery when an old pw-hrms alias binding is present", async () => {
      const f = await seed({ withSecrets: true, extraBindingName: "pw-hrms/ACCESS_KEY_ID" });
      const { ports, input } = await consumed(f);
      expect(await ports.delivery.resolveRecipientEnv(input)).toBeNull();
    });
  });

  describe("alias projection (values-free)", () => {
    it("reports fixed approved names with authority only when every lookup succeeds", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const projection = await portsOf(f, grant.id).aliases.project({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision });
      expect(projection).toEqual({
        authority: true,
        accessKeyId: { name: NAME_AK, delivery: "env" },
        secretAccessKey: { name: NAME_SK, delivery: "env" },
        oldMappingsPresent: false,
      });
    });

    it("reports a mismatch sentinel instead of the real secret name, and flags old mappings", async () => {
      const f = await seed({ withSecrets: true, names: ["pw-hrms/ACCESS_KEY_ID", NAME_SK], extraBindingName: "pw-hrms/ACCESS_KEY_SECRET" });
      const projection = await portsOf(f).aliases.project({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: (await service(f).currentConfigRevision(f.companyId, f.recipientId))! });
      expect(projection.authority).toBe(true);
      expect(projection.accessKeyId?.name).toBe("<mismatch>");
      expect(projection.oldMappingsPresent).toBe(true);
      expect(JSON.stringify(projection)).not.toContain("pw-hrms");
    });

    it("has no authority on a stale revision or an unresolvable binding set", async () => {
      const f = await seed({ withSecrets: true });
      const stale = await portsOf(f).aliases.project({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: randomUUID() });
      expect(stale).toEqual({ authority: false, accessKeyId: null, secretAccessKey: null, oldMappingsPresent: false });
      await db.update(agents).set({ adapterConfig: {} });
      const none = await portsOf(f).aliases.project({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: f.revisionIds[0] });
      expect(none.authority).toBe(false);
    });
  });

  describe("audit and receipts", () => {
    it("writes values-free activity rows that name the checker", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await portsOf(f, grant.id).audit.record({
        checkId: randomUUID(), event: "grant_consumed", at: new Date().toISOString(), recipe: WARDEN_RECIPE_VERSION,
        actorAgentId: f.checkerId, actorRunId: f.runId, issueId: f.issueId, recipientAgentId: f.recipientId,
        configRevision: grant.configRevision, grantId: grant.id,
      });
      const rows = await db.select().from(activityLog);
      expect(rows.map((r) => r.action)).toEqual(["warden_recipient_check.grant_consumed"]);
      expect((rows[0].details as Record<string, unknown>).checkerAgentId).toBe(f.checkerId);
      expect(JSON.stringify(rows)).not.toContain(SECRET_AK);
      expect(JSON.stringify(rows)).not.toContain(SECRET_SK);
    });

    it("persists one immutable values-free receipt bound to the consumed grant", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await portsOf(f, grant.id).grants.consume(consumeInput(f, grant.id, grant.configRevision));
      const row = await service(f).recordReceipt(actorOf(f), f.issueId, grant.id, goodReceipt());
      expect(row).toMatchObject({
        grantId: grant.id,
        configRevision: grant.configRevision,
        credentialFingerprint: grant.credentialFingerprint,
        aliasNamesMatch: "PASS",
        overall: "PASS",
        leaseDestroyVerifiedAbsent: true,
        leaseJobUidDigest: "abcdef0123456789",
      });
      const dump = JSON.stringify(await db.select().from(wardenRecipientCheckReceipts));
      for (const secret of [SECRET_AK, SECRET_SK, NAME_AK, NAME_SK, "pw-hrms"]) expect(dump).not.toContain(secret);
      await expect(db.update(wardenRecipientCheckReceipts).set({ overall: "FAIL" })).rejects.toThrow();
      await expect(service(f).recordReceipt(actorOf(f), f.issueId, grant.id, goodReceipt())).rejects.toThrow();
    });

    it("normalises unexpected predicate text to INCONCLUSIVE and rejects receipts for an unconsumed grant or another actor", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await expect(service(f).recordReceipt(actorOf(f), f.issueId, grant.id, goodReceipt())).rejects.toMatchObject({ status: 403 });
      await portsOf(f, grant.id).grants.consume(consumeInput(f, grant.id, grant.configRevision));
      await expect(service(f).recordReceipt({ ...actorOf(f), runId: randomUUID() }, f.issueId, grant.id, goodReceipt())).rejects.toMatchObject({ status: 403 });
      const row = await service(f).recordReceipt(actorOf(f), f.issueId, grant.id, goodReceipt({ eksClusterActive: `leak ${SECRET_SK}`, overall: "MAYBE" }));
      expect(row.eksClusterActive).toBe("INCONCLUSIVE");
      expect(row.overall).toBe("INCONCLUSIVE");
    });
  });

  describe("runtime wiring", () => {
    const env = {
      PAPERCLIP_WARDEN_RECIPIENT_AGENT_ID: "417a37a1-46fe-4741-924c-856829c4bbcc",
      PAPERCLIP_WARDEN_RECIPIENT_NAMESPACE: "warden-recipient",
      PAPERCLIP_WARDEN_RECIPIENT_IMAGE: `registry.example/warden@sha256:${"a".repeat(64)}`,
      PAPERCLIP_WARDEN_RECIPIENT_IMAGE_ALLOW_PREFIXES: "registry.example/warden@",
      PAPERCLIP_WARDEN_RECIPIENT_PLUGIN_DIST: "/opt/plugin-kubernetes/dist",
    };

    it("stays disabled unless every setting is present", async () => {
      expect(readWardenRunnerConfig({})).toBeNull();
      for (const key of Object.keys(env)) {
        const partial: Record<string, string | undefined> = { ...env };
        delete partial[key];
        expect(readWardenRunnerConfig(partial)).toBeNull();
        expect(await createWardenRecipientRuntime({ env: partial })).toBeNull();
      }
    });

    it("pins expectedRecipientAgentId from the same server constant, starts the sweeper, and stops it", async () => {
      let seenDeps: Record<string, unknown> | null = null;
      let sweeperStarted: { namespace: string } | null = null;
      let stopped = false;
      const runtime = await createWardenRecipientRuntime({
        env,
        loader: {
          loadRunner: async () => ({
            runWardenRecipientCheck: async (deps) => { seenDeps = deps; return { ok: true }; },
            startRecipientLeaseSweeper: (_clients, input) => { sweeperStarted = input; return { stop: () => { stopped = true; } }; },
          }),
          loadKube: async () => ({ createKubeConfig: () => ({}), makeKubeClients: () => ({ fake: true }) }),
        },
      });
      expect(runtime?.wardenRecipientAgentId).toBe(env.PAPERCLIP_WARDEN_RECIPIENT_AGENT_ID);
      expect(sweeperStarted).toMatchObject({ namespace: "warden-recipient" });
      const ports = {} as WardenServerPorts;
      await runtime!.createRunner(ports)({ agentId: "a", runId: "r", companyId: "c" }, {});
      expect((seenDeps!.config as Record<string, unknown>).expectedRecipientAgentId).toBe(env.PAPERCLIP_WARDEN_RECIPIENT_AGENT_ID);
      expect(Object.keys(seenDeps!).sort()).toEqual(["aliases", "audit", "clients", "config", "delivery", "grants", "preflight"]);
      runtime!.stop();
      expect(stopped).toBe(true);
    });

    it("stays disabled without throwing when the plugin cannot be loaded", async () => {
      const warnings: unknown[] = [];
      const runtime = await createWardenRecipientRuntime({
        env,
        logger: { warn: (o) => { warnings.push(o); } },
        loader: { loadRunner: async () => { throw new Error(`missing ${SECRET_SK}`); }, loadKube: async () => ({ createKubeConfig: () => ({}), makeKubeClients: () => ({}) }) },
      });
      expect(runtime).toBeNull();
      expect(JSON.stringify(warnings)).not.toContain(SECRET_SK);
    });
  });

  describe("real runner with server ports (fake Kubernetes clients)", () => {
    const IMAGE = `registry.example/warden-recipient@sha256:${"a".repeat(64)}`;
    const notFoundErr = () => Object.assign(new Error("nf"), { code: 404 });

    function fakeKube() {
      const state = { job: false, secret: false, policy: false, leases: 0, secretBody: null as unknown };
      let policyBody: unknown = null;
      let checkId = "";
      const clients: any = {
        custom: {
          createNamespacedCustomObject: async ({ body }: any) => { state.policy = true; policyBody = body; },
          listNamespacedCustomObject: async () => ({ items: state.policy ? [policyBody] : [] }),
          listClusterCustomObject: async () => ({ items: [] }),
          deleteNamespacedCustomObject: async () => { state.policy = false; },
          getNamespacedCustomObject: async () => { if (!state.policy) throw notFoundErr(); return policyBody; },
        },
        networking: { listNamespacedNetworkPolicy: async () => ({ items: [] }) },
        core: {
          createNamespacedSecret: async ({ body }: any) => { state.secret = true; state.secretBody = body; checkId = body.metadata.labels["paperclip.io/check-id"]; },
          deleteNamespacedSecret: async () => { state.secret = false; },
          readNamespacedSecret: async () => { if (!state.secret) throw notFoundErr(); return {}; },
          deleteCollectionNamespacedPod: async () => {},
          listNamespacedPod: async () => ({ items: state.job ? [{ metadata: { name: "pod-1" }, status: { phase: "Running" } }] : [] }),
          readNamespacedPod: async () => ({
            status: { containerStatuses: [{ name: "recipient", state: { terminated: { message: JSON.stringify({
              v: 1, recipe: WARDEN_RECIPE.version, checkId, expectedPrincipalMatch: "PASS", codebuildProjectFound: "PASS", eksClusterActive: "PASS",
            }) } } }] },
          }),
        },
        batch: {
          createNamespacedJob: async () => { state.job = true; state.leases += 1; return { metadata: { uid: "job-uid" } }; },
          readNamespacedJobStatus: async () => ({ status: { succeeded: 1 } }),
          deleteNamespacedJob: async () => { state.job = false; },
          readNamespacedJob: async () => { if (!state.job) throw notFoundErr(); return {}; },
        },
      };
      return { clients, state };
    }

    const makeRunner = (f: Fixture, grantId: string, kube: ReturnType<typeof fakeKube>, svc = service(f)) => {
      const ports = svc.buildPorts(actorOf(f), f.issueId, grantId);
      return (raw: unknown) =>
        runWardenRecipientCheck(
          {
            clients: kube.clients,
            preflight: ports.preflight,
            grants: ports.grants,
            delivery: ports.delivery,
            aliases: ports.aliases,
            audit: ports.audit,
            config: {
              expectedRecipientAgentId: f.recipientId,
              driver: "kubernetes",
              backend: "job",
              egressMode: "cilium",
              namespace: "wr-ns",
              image: IMAGE,
              imageAllowPrefixes: ["registry.example/"],
              deadlineSeconds: 30,
              pollMs: 1,
            },
            sleep: async () => {},
          },
          actorOf(f),
          raw,
        );
    };

    it("runs one fresh lease, delivers only the two env keys, and produces a PASS receipt we can persist", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const kube = fakeKube();
      const receipt = await makeRunner(f, grant.id, kube)(resolveReq(f, grant.id, grant.configRevision));
      expect(receipt.overall).toBe("PASS");
      expect(receipt.aliasNamesMatch).toBe("PASS");
      expect(receipt.leaseAttestation?.destroyVerifiedAbsent).toBe(true);
      expect(kube.state).toMatchObject({ job: false, secret: false, policy: false, leases: 1 });
      expect(Object.keys((kube.state.secretBody as any).stringData).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
      const row = await service(f).recordReceipt(actorOf(f), f.issueId, grant.id, receipt as never);
      expect(row.overall).toBe("PASS");
      expect(JSON.stringify(receipt)).not.toContain(SECRET_SK);
    });

    it("creates no second lease on replay", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const kube = fakeKube();
      const run = makeRunner(f, grant.id, kube);
      await run(resolveReq(f, grant.id, grant.configRevision));
      await expect(run(resolveReq(f, grant.id, grant.configRevision))).rejects.toMatchObject({ name: "CheckDenied", code: "grant_already_consumed" });
      expect(kube.state.leases).toBe(1);
    });

    it("denies a rotated secret before any lease exists and leaves the grant unconsumed", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await secretService(db).rotate(f.secretIds.ak!, { value: "rotated" });
      const kube = fakeKube();
      await expect(makeRunner(f, grant.id, kube)(resolveReq(f, grant.id, grant.configRevision))).rejects.toMatchObject({ name: "CheckDenied", code: "grant_mismatch" });
      expect(kube.state).toMatchObject({ leases: 0, secret: false, policy: false });
      expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    });

    it("denies a non-Warden recipient configuration before any lease", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const kube = fakeKube();
      const wrongSvc = wardenRecipientCheckService(db, secretService(db), { wardenRecipientAgentId: randomUUID() });
      await expect(makeRunner(f, grant.id, kube, wrongSvc)(resolveReq(f, grant.id, grant.configRevision))).rejects.toMatchObject({ name: "CheckDenied", code: "wrong_recipient" });
      expect(kube.state.leases).toBe(0);
    });

    it("denies delivery (delivery_unavailable) when bound names mismatch, with no lease and no secret read", async () => {
      const f = await seed({ withSecrets: true, names: ["pw-hrms/ACCESS_KEY_ID", "pw-hrms/ACCESS_KEY_SECRET"] });
      const grant = await mkGrant(f);
      const kube = fakeKube();
      await expect(makeRunner(f, grant.id, kube)(resolveReq(f, grant.id, grant.configRevision))).rejects.toMatchObject({ name: "CheckDenied", code: "delivery_unavailable" });
      expect(kube.state.leases).toBe(0);
      expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    });

    it("never exposes secret names, ids or versions in the receipt or audit rows", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const receipt = await makeRunner(f, grant.id, fakeKube())(resolveReq(f, grant.id, grant.configRevision));
      const dump = JSON.stringify([receipt, await db.select().from(activityLog)]);
      for (const needle of [SECRET_AK, SECRET_SK, NAME_AK, NAME_SK, f.secretIds.ak!, f.secretIds.sk!]) expect(dump).not.toContain(needle);
    });
  });

  describe("routes", () => {
    const boardActor = (f: Fixture, isInstanceAdmin = true) => ({
      type: "board" as const, source: "session" as const, userId: "board-user", companyIds: [f.companyId],
      memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin,
    });
    const agentActor = (f: Fixture, over: Record<string, unknown> = {}) => ({
      type: "agent" as const, agentId: f.checkerId, companyId: f.companyId, runId: f.runId, source: "agent_jwt" as const, ...over,
    });
    function app(f: Fixture, actor: Record<string, unknown>, createRunner?: (ports: WardenServerPorts) => WardenCheckRunner, configured = true) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      a.use("/api", wardenRecipientCheckRoutes(db, {
        secrets: secretService(db),
        wardenRecipientAgentId: configured ? f.recipientId : null,
        createRunner,
      }));
      a.use(errorHandler);
      return a;
    }
    const checkPath = (f: Fixture) => `/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`;
    const payload = (grant: { id: string; configRevision: string }) => ({ selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision });

    it("lets an instance admin issue and revoke a grant, but not an agent or a non-admin board member", async () => {
      const f = await seed({ withSecrets: true });
      const body = { approvalId: f.approvalId, issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.recipientId };
      const base = `/api/companies/${f.companyId}/warden-recipient-check-grants`;
      expect((await request(app(f, agentActor(f))).post(base).send(body)).status).toBe(403);
      expect((await request(app(f, boardActor(f, false))).post(base).send(body)).status).toBe(403);
      const created = await request(app(f, boardActor(f))).post(base).send(body);
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ grantId: expect.any(String), configRevision: f.revisionIds[0], recipe: WARDEN_RECIPE_VERSION, expiresAt: expect.any(String) });
      expect((await request(app(f, boardActor(f, false))).post(`${base}/${created.body.grantId}/revoke`).send({})).status).toBe(403);
      const revoked = await request(app(f, boardActor(f))).post(`${base}/${created.body.grantId}/revoke`).send({});
      expect(revoked.status).toBe(200);
      expect((await db.select().from(activityLog)).map((r) => r.action).sort()).toEqual([
        "warden_recipient_check.grant_created",
        "warden_recipient_check.grant_revoked",
      ]);
    });

    it("rejects extra fields on the check selector (input-free)", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      for (const extra of [{ command: "id" }, { recipientAgentId: f.checkerId }, { awsProfile: "x" }, { issueId: f.issueId }]) {
        const res = await request(app(f, agentActor(f), () => async () => ({})))
          .post(checkPath(f))
          .send({ ...payload(grant), ...extra });
        expect(res.status).toBe(400);
      }
    });

    it("returns 501 without a configured runner or Warden id and never consumes the grant", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      expect((await request(app(f, agentActor(f))).post(checkPath(f)).send(payload(grant))).status).toBe(501);
      expect((await request(app(f, agentActor(f), () => async () => ({}), false)).post(checkPath(f)).send(payload(grant))).status).toBe(501);
      expect((await service(f).getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
    });

    it("requires a run-bound agent JWT, a current run and company access", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const run = () => async () => ({});
      expect((await request(app(f, boardActor(f), run)).post(checkPath(f)).send(payload(grant))).status).toBe(403);
      expect((await request(app(f, agentActor(f, { runId: undefined }), run)).post(checkPath(f)).send(payload(grant))).status).toBe(403);
      expect((await request(app(f, agentActor(f, { source: "agent_key" }), run)).post(checkPath(f)).send(payload(grant))).status).toBe(403);
      expect((await request(app(f, agentActor(f, { source: undefined }), run)).post(checkPath(f)).send(payload(grant))).status).toBe(403);
      const other = await seed();
      expect((await request(app(f, agentActor(other), run)).post(checkPath(f)).send(payload(grant))).status).toBe(403);
      expect((await service(f).getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
    });

    it("forwards a fixed request to the runner, persists the receipt and returns receipt plus authorization audit", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      let seen: unknown;
      const res = await request(
        app(f, agentActor(f), (ports) => async (actor, raw) => {
          seen = raw;
          const target = await ports.preflight.resolve(actor, raw as never);
          const consumed = await ports.grants.consume(consumeInput(f, grant.id, target!.currentConfigRevision));
          return { ...goodReceipt({ overall: "INCONCLUSIVE", aliasNamesMatch: "INCONCLUSIVE" }), consumed };
        }),
      )
        .post(checkPath(f))
        .send(payload(grant));
      expect(res.status).toBe(200);
      expect(seen).toEqual({ selector: "warden-uat-aws", issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision });
      expect(res.body.receipt.consumed).toBe("consumed");
      expect(res.body.authorization).toMatchObject({ grantId: grant.id, approvalId: f.approvalId, recipe: WARDEN_RECIPE_VERSION, revokedAt: null });
      expect(res.body.authorization.consumedAt).toEqual(expect.any(String));
      const stored = await db.select().from(wardenRecipientCheckReceipts);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ grantId: grant.id, overall: "INCONCLUSIVE", credentialFingerprint: grant.credentialFingerprint });
    });

    it("denies a replay with no second runner lease and no second receipt", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      let leases = 0;
      const runner = (ports: WardenServerPorts): WardenCheckRunner => async (actor, raw) => {
        const target = await ports.preflight.resolve(actor, raw as never);
        const consumed = await ports.grants.consume(consumeInput(f, grant.id, target!.currentConfigRevision));
        if (consumed !== "consumed") throw Object.assign(new Error(consumed), { name: "CheckDenied", code: "grant_already_consumed" });
        leases += 1;
        return goodReceipt();
      };
      expect((await request(app(f, agentActor(f), runner)).post(checkPath(f)).send(payload(grant))).status).toBe(200);
      const replay = await request(app(f, agentActor(f), runner)).post(checkPath(f)).send(payload(grant));
      expect(replay.status).toBe(403);
      expect(replay.body).toEqual({ error: "denied", code: "grant_already_consumed" });
      expect(leases).toBe(1);
      expect(await db.select().from(wardenRecipientCheckReceipts)).toHaveLength(1);
    });

    it("consumes only after preflight: a wrong-actor preflight leaves the grant unconsumed", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      await db.update(heartbeatRuns).set({ status: "succeeded" });
      const res = await request(
        app(f, agentActor(f), (ports) => async (actor, raw) => {
          const target = await ports.preflight.resolve(actor, raw as never);
          if (target!.checkerRunId !== actor.runId) throw Object.assign(new Error("x"), { name: "CheckDenied", code: "wrong_actor" });
          await ports.grants.consume(consumeInput(f, grant.id, target!.currentConfigRevision));
          return goodReceipt();
        }),
      ).post(checkPath(f)).send(payload(grant));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "denied", code: "wrong_actor" });
      expect((await service(f).getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
    });

    it("maps unexpected runner errors to a generic failure without leaking the message", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const res = await request(app(f, agentActor(f), () => async () => { throw new Error(`boom ${SECRET_SK}`); }))
        .post(checkPath(f))
        .send(payload(grant));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SK);
      expect(res.body).toEqual({ error: "check_failed" });
    });

    it("does not return a receipt it could not persist and leaks nothing", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const res = await request(app(f, agentActor(f), () => async () => goodReceipt({ finishedAt: `not-a-date ${SECRET_SK}` })))
        .post(checkPath(f))
        .send(payload(grant));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "receipt_not_persisted" });
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SK);
    });
  });
});
