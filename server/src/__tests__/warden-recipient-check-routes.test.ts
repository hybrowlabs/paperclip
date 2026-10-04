import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { wardenRecipientCheckRoutes, type WardenCheckRunner } from "../routes/warden-recipient-checks.js";
import { secretService } from "../services/secrets.js";
import {
  WARDEN_RECIPE_VERSION,
  wardenRecipientCheckService,
  type WardenServerPorts,
} from "../services/warden-recipient-check.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SECRET_AK = "AKIA_SYNTHETIC_ACCESS_KEY_VALUE";
const SECRET_SK = "synthetic-secret-key-value-do-not-leak";

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

  async function seed(opts: { revisions?: number; withSecrets?: boolean; envDriver?: "k8s" | "local" } = {}) {
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
    let environmentId: string | null = null;
    if (opts.envDriver) {
      environmentId = randomUUID();
      await db.insert(environments).values({
        id: environmentId,
        name: `env-${environmentId}`,
        driver: opts.envDriver === "k8s" ? "sandbox" : "local",
        config: opts.envDriver === "k8s" ? { provider: "kubernetes" } : {},
      });
    }
    const env: Record<string, unknown> = {};
    const svc = secretService(db);
    if (opts.withSecrets) {
      const ak = await svc.create(companyId, { key: "WARDEN_AK", name: "ak", provider: "local_encrypted", value: SECRET_AK });
      const sk = await svc.create(companyId, { key: "WARDEN_SK", name: "sk", provider: "local_encrypted", value: SECRET_SK });
      env.AWS_ACCESS_KEY_ID = { type: "secret_ref", secretId: ak.id, version: "latest" };
      env.AWS_SECRET_ACCESS_KEY = { type: "secret_ref", secretId: sk.id, version: "latest" };
    }
    await db.insert(agents).values([
      { id: checkerId, companyId, name: "Sentinel", role: "qa", adapterType: "codex_local", adapterConfig: {}, status: "idle" },
      {
        id: recipientId,
        companyId,
        name: "Warden",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: { env },
        status: "idle",
        defaultEnvironmentId: environmentId,
      },
    ]);
    if (opts.withSecrets) {
      await svc.createBinding({ companyId, secretId: (env.AWS_ACCESS_KEY_ID as any).secretId, targetType: "agent", targetId: recipientId, configPath: "env.AWS_ACCESS_KEY_ID" });
      await svc.createBinding({ companyId, secretId: (env.AWS_SECRET_ACCESS_KEY as any).secretId, targetType: "agent", targetId: recipientId, configPath: "env.AWS_SECRET_ACCESS_KEY" });
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
      payload: { recipe: WARDEN_RECIPE_VERSION, issueId, checkerAgentId: checkerId, recipientAgentId: recipientId },
    });
    return { companyId, checkerId, recipientId, issueId, runId, approvalId, revisionIds };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;
  const service = () => wardenRecipientCheckService(db, secretService(db));
  const actorOf = (f: Fixture) => ({ agentId: f.checkerId, runId: f.runId, companyId: f.companyId });
  const mkGrant = (f: Fixture, extra: Partial<Parameters<ReturnType<typeof service>["createGrant"]>[0]> = {}) =>
    service().createGrant({
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

  describe("grant issuance", () => {
    it("binds to the current Warden revision, caps lifetime at 15 minutes, and requires a matching approved approval", async () => {
      const f = await seed({ revisions: 3 });
      const grant = await mkGrant(f, { expiresInSeconds: 99_999 });
      expect(grant.configRevision).toBe(f.revisionIds[2]);
      expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(900_000 + 1000);
      expect(grant.recipe).toBe(WARDEN_RECIPE_VERSION);
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 409 });
    });

    it("rejects an unapproved, mismatched, or cross-agent approval", async () => {
      const f = await seed();
      await db.update(approvals).set({ status: "pending" });
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 422 });
      await db.update(approvals).set({ status: "approved", payload: { recipe: "other", issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.recipientId } });
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 422 });
      await db.update(approvals).set({ payload: { recipe: WARDEN_RECIPE_VERSION, issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.checkerId } });
      await expect(mkGrant(f, { recipientAgentId: f.checkerId })).rejects.toMatchObject({ status: 422 });
    });

    it("rejects an agent with no recorded revision (fail closed)", async () => {
      const f = await seed({ revisions: 0 });
      await expect(mkGrant(f)).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("atomic one-use consumption", () => {
    it("lets exactly one of many concurrent consumers win and records consumption", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      const ports = service().buildPorts(actorOf(f), f.issueId);
      const results = await Promise.all(Array.from({ length: 8 }, () => ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))));
      expect(results.filter((r) => r === "consumed")).toHaveLength(1);
      expect(results.filter((r) => r === "already_consumed")).toHaveLength(7);
      const audit = await service().getGrantAudit(f.companyId, grant.id);
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
      const f = await seed();
      const grant = await mkGrant(f);
      const ports = service().buildPorts(actorOf(f), f.issueId);
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision, over(f)))).toBe("mismatch");
      expect((await service().getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("consumed");
    });

    it("denies expired and revoked grants and unknown grants", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      const ports = service().buildPorts(actorOf(f), f.issueId);
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision, { now: new Date(grant.expiresAt.getTime() + 1) }))).toBe("expired");
      expect(await ports.grants.consume(consumeInput(f, randomUUID(), grant.configRevision))).toBe("not_found");
      await service().revokeGrant(f.companyId, grant.id, "board-user");
      expect(await ports.grants.consume(consumeInput(f, grant.id, grant.configRevision))).toBe("mismatch");
      await expect(service().revokeGrant(f.companyId, grant.id, "board-user")).rejects.toMatchObject({ status: 409 });
    });

    it("does not allow revoking a consumed grant", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      await service().buildPorts(actorOf(f), f.issueId).grants.consume(consumeInput(f, grant.id, grant.configRevision));
      await expect(service().revokeGrant(f.companyId, grant.id, "board-user")).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("preflight", () => {
    it("reports the current revision, the run's issue and the recipient environment driver", async () => {
      const f = await seed({ revisions: 2, envDriver: "k8s" });
      const grant = await mkGrant(f);
      const target = await service().buildPorts(actorOf(f), f.issueId).preflight.resolve(actorOf(f), {
        selector: "warden-uat-aws", issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision,
      });
      expect(target).toEqual({
        recipientAgentId: f.recipientId,
        currentConfigRevision: f.revisionIds[1],
        checkerAgentId: f.checkerId,
        checkerRunId: f.runId,
        issueId: f.issueId,
        environmentDriver: "kubernetes",
      });
    });

    it("treats a missing environment or local driver as host execution", async () => {
      const f = await seed({ envDriver: "local" });
      const grant = await mkGrant(f);
      const req = { selector: "warden-uat-aws" as const, issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision };
      const target = await service().buildPorts(actorOf(f), f.issueId).preflight.resolve(actorOf(f), req);
      expect(target?.environmentDriver).toBe("local");
      const g = await seed();
      const grant2 = await mkGrant(g);
      const t2 = await service().buildPorts(actorOf(g), g.issueId).preflight.resolve(actorOf(g), { ...req, grantId: grant2.id });
      expect(t2?.environmentDriver).toBe("local");
    });

    it.each([
      ["run belongs to another agent", (f: Fixture) => db.update(heartbeatRuns).set({ agentId: f.recipientId })],
      ["run is not running", () => db.update(heartbeatRuns).set({ status: "succeeded" })],
    ])("blanks the checker identity when %s", async (_n, mutate) => {
      const f = await seed();
      const grant = await mkGrant(f);
      await mutate(f);
      const target = await service().buildPorts(actorOf(f), f.issueId).preflight.resolve(actorOf(f), {
        selector: "warden-uat-aws", issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision,
      });
      expect(target?.checkerAgentId).toBe("");
      expect(target?.checkerRunId).toBe("");
    });

    it("reports a different issue when the run is not on the case issue, and null for a foreign grant", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } });
      const req = { selector: "warden-uat-aws" as const, issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision };
      const target = await service().buildPorts(actorOf(f), f.issueId).preflight.resolve(actorOf(f), req);
      expect(target?.issueId).not.toBe(f.issueId);
      const other = await seed();
      expect(await service().buildPorts(actorOf(other), other.issueId).preflight.resolve(actorOf(other), req)).toBeNull();
    });

    it("moves to a new current revision after a Warden config change", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      await db.insert(agentConfigRevisions).values({ companyId: f.companyId, agentId: f.recipientId, beforeConfig: {}, afterConfig: {} });
      const target = await service().buildPorts(actorOf(f), f.issueId).preflight.resolve(actorOf(f), {
        selector: "warden-uat-aws", issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision,
      });
      expect(target?.currentConfigRevision).not.toBe(grant.configRevision);
    });
  });

  describe("delivery", () => {
    it("resolves exactly the two bound secret refs through normal secret delivery and records access events", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const env = await service().buildPorts(actorOf(f), f.issueId).delivery.resolveRecipientEnv({
        companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision,
      });
      expect(env).toEqual({ AWS_ACCESS_KEY_ID: SECRET_AK, AWS_SECRET_ACCESS_KEY: SECRET_SK });
      const events = await db.select().from(secretAccessEvents);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.consumerType === "agent" && e.consumerId === f.recipientId && e.outcome === "success")).toBe(true);
    });

    it("returns null on stale revision, non-secret-ref values, or missing keys", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const ports = service().buildPorts(actorOf(f), f.issueId);
      expect(await ports.delivery.resolveRecipientEnv({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: randomUUID() })).toBeNull();
      await db.update(agents).set({ adapterConfig: { env: { AWS_ACCESS_KEY_ID: "plain", AWS_SECRET_ACCESS_KEY: "plain" } } });
      expect(await ports.delivery.resolveRecipientEnv({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision })).toBeNull();
      await db.update(agents).set({ adapterConfig: {} });
      expect(await ports.delivery.resolveRecipientEnv({ companyId: f.companyId, recipientAgentId: f.recipientId, configRevision: grant.configRevision })).toBeNull();
    });
  });

  describe("audit", () => {
    it("writes values-free activity rows", async () => {
      const f = await seed({ withSecrets: true });
      const grant = await mkGrant(f);
      const ports = service().buildPorts(actorOf(f), f.issueId);
      await ports.audit.record({
        checkId: randomUUID(), event: "grant_consumed", at: new Date().toISOString(), recipe: WARDEN_RECIPE_VERSION,
        actorAgentId: f.checkerId, actorRunId: f.runId, issueId: f.issueId, recipientAgentId: f.recipientId,
        configRevision: grant.configRevision, grantId: grant.id,
      });
      const rows = await db.select().from(activityLog);
      expect(rows.map((r) => r.action)).toEqual(["warden_recipient_check.grant_consumed"]);
      expect(JSON.stringify(rows)).not.toContain(SECRET_AK);
      expect(JSON.stringify(rows)).not.toContain(SECRET_SK);
    });
  });

  describe("routes", () => {
    const boardActor = (f: Fixture) => ({
      type: "board" as const, source: "session" as const, userId: "board-user", companyIds: [f.companyId],
      memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false,
    });
    const agentActor = (f: Fixture, agentId = f.checkerId) => ({
      type: "agent" as const, agentId, companyId: f.companyId, runId: f.runId, source: "agent_jwt" as const,
    });
    function app(actor: Record<string, unknown>, createRunner?: (ports: WardenServerPorts) => WardenCheckRunner) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      a.use("/api", wardenRecipientCheckRoutes(db, { secrets: secretService(db), createRunner }));
      a.use(errorHandler);
      return a;
    }

    it("lets a board user issue and revoke a grant, but not an agent", async () => {
      const f = await seed();
      const body = { approvalId: f.approvalId, issueId: f.issueId, checkerAgentId: f.checkerId, recipientAgentId: f.recipientId };
      const denied = await request(app(agentActor(f))).post(`/api/companies/${f.companyId}/warden-recipient-check-grants`).send(body);
      expect(denied.status).toBe(403);
      const created = await request(app(boardActor(f))).post(`/api/companies/${f.companyId}/warden-recipient-check-grants`).send(body);
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ grantId: expect.any(String), configRevision: f.revisionIds[0], recipe: WARDEN_RECIPE_VERSION, expiresAt: expect.any(String) });
      const revoked = await request(app(boardActor(f))).post(`/api/companies/${f.companyId}/warden-recipient-check-grants/${created.body.grantId}/revoke`).send({});
      expect(revoked.status).toBe(200);
      expect((await db.select().from(activityLog)).map((r) => r.action).sort()).toEqual([
        "warden_recipient_check.grant_created",
        "warden_recipient_check.grant_revoked",
      ]);
    });

    it("rejects extra fields on the check selector (input-free)", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      for (const extra of [{ command: "id" }, { recipientAgentId: f.checkerId }, { awsProfile: "x" }, { issueId: f.issueId }]) {
        const res = await request(app(agentActor(f), () => async () => ({})))
          .post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`)
          .send({ selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision, ...extra });
        expect(res.status).toBe(400);
      }
    });

    it("returns 501 without a configured runner and never consumes the grant", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      const res = await request(app(agentActor(f)))
        .post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`)
        .send({ selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision });
      expect(res.status).toBe(501);
      expect((await service().getGrantAudit(f.companyId, grant.id))?.consumedAt).toBeNull();
    });

    it("requires an agent run actor and company access", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      const payload = { selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision };
      expect((await request(app(boardActor(f), () => async () => ({}))).post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`).send(payload)).status).toBe(403);
      const noRun = { ...agentActor(f), runId: undefined };
      expect((await request(app(noRun, () => async () => ({}))).post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`).send(payload)).status).toBe(403);
      const other = await seed();
      expect((await request(app(agentActor(other), () => async () => ({}))).post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`).send(payload)).status).toBe(403);
    });

    it("forwards a fixed request to the runner with server-bound issue id and returns receipt plus authorization audit", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      let seen: unknown;
      const res = await request(
        app(agentActor(f), (ports) => async (actor, raw) => {
          seen = raw;
          const target = await ports.preflight.resolve(actor, raw as never);
          const consumed = await ports.grants.consume(consumeInput(f, grant.id, target!.currentConfigRevision));
          return { overall: "INCONCLUSIVE", consumed };
        }),
      )
        .post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`)
        .send({ selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision });
      expect(res.status).toBe(200);
      expect(seen).toEqual({ selector: "warden-uat-aws", issueId: f.issueId, grantId: grant.id, expectedConfigRevision: grant.configRevision });
      expect(res.body.receipt).toEqual({ overall: "INCONCLUSIVE", consumed: "consumed" });
      expect(res.body.authorization).toMatchObject({ grantId: grant.id, approvalId: f.approvalId, recipe: WARDEN_RECIPE_VERSION, revokedAt: null });
      expect(res.body.authorization.consumedAt).toEqual(expect.any(String));
      const replay = await request(
        app(agentActor(f), (ports) => async (actor, raw) => {
          const target = await ports.preflight.resolve(actor, raw as never);
          const consumed = await ports.grants.consume(consumeInput(f, grant.id, target!.currentConfigRevision));
          if (consumed !== "consumed") throw Object.assign(new Error(consumed), { name: "CheckDenied", code: "grant_already_consumed" });
          return {};
        }),
      )
        .post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`)
        .send({ selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision });
      expect(replay.status).toBe(403);
      expect(replay.body).toEqual({ error: "denied", code: "grant_already_consumed" });
    });

    it("maps unexpected runner errors to a generic failure without leaking the message", async () => {
      const f = await seed();
      const grant = await mkGrant(f);
      const res = await request(app(agentActor(f), () => async () => { throw new Error(`boom ${SECRET_SK}`); }))
        .post(`/api/issues/${f.issueId}/recipient-checks/warden-uat-aws`)
        .send({ selector: "warden-uat-aws", grantId: grant.id, expectedConfigRevision: grant.configRevision });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SK);
      expect(res.body).toEqual({ error: "check_failed" });
    });
  });
});
