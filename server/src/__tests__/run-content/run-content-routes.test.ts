import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  providerTraceRecords,
  workspaceOperations,
  type Db,
} from "@paperclipai/db";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-content-routes-"));
process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(root, "ws-op-logs");
process.env.PROVIDER_TRACE_BASE_PATH = path.join(root, "traces");

const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import("../helpers/embedded-postgres.js");
const { errorHandler } = await import("../../middleware/index.js");
const { agentRoutes } = await import("../../routes/agents.js");
const { activityRoutes } = await import("../../routes/activity.js");
const { executionWorkspaceRoutes } = await import("../../routes/execution-workspaces.js");
const { runContentGate } = await import("../../services/run-content-gate.js");
const { CANARY_A, CANARY_B, seedCompanyRuns } = await import("./fixtures.js");
const { ensureHumanRoleDefaultGrants } = await import("../../services/principal-access-compatibility.js");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

type Seed = Awaited<ReturnType<typeof seedCompanyRuns>>;

d("run content routes (real routers, embedded postgres, synthetic canaries)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const admin = (companyIds: string[]) => ({
    type: "board" as const,
    userId: "ordinary-admin",
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })),
    isInstanceAdmin: true,
    source: "local_implicit" as const,
  });

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as any).actor = actor; next(); });
    a.use("/api", agentRoutes(db));
    a.use("/api", activityRoutes(db));
    a.use("/api", executionWorkspaceRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function seedContent(): Promise<Seed & { opA: string; opB: string; issueId: string; ws: string }> {
    const s = await seedCompanyRuns(db, "Routes");
    const [project] = await db.insert(projects).values({ companyId: s.company.id, name: "P" }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: s.company.id, identifier: `${s.company.issuePrefix}-1`, title: "T", status: "in_progress", priority: "medium",
      projectId: project!.id, assigneeAgentId: s.agent.id,
    }).returning();
    const [ws] = await db.insert(executionWorkspaces).values({
      companyId: s.company.id, projectId: project!.id, mode: "isolated_workspace", strategyType: "git_worktree", name: "ws", status: "active",
    }).returning();
    for (const [run, canary] of [[s.runA, CANARY_A], [s.runB, CANARY_B]] as const) {
      await db.update(heartbeatRuns).set({
        status: "running",
        contextSnapshot: { issueId: issue!.id, executionWorkspaceId: ws!.id, note: canary },
        nextAction: `next ${canary}`,
        logStore: "local_file",
        logRef: `${s.company.id}/${run.id}.ndjson`,
      }).where(eq(heartbeatRuns.id, run.id));
      await db.insert(heartbeatRunEvents).values({
        companyId: s.company.id, runId: run.id, agentId: s.agent.id, seq: 1, eventType: "log", message: `event ${canary}`, payload: { secret: canary },
      });
      const logDir = path.join(process.env.RUN_LOG_BASE_PATH!, s.company.id);
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(path.join(logDir, `${run.id}.ndjson`), `${JSON.stringify({ ts: new Date().toISOString(), stream: "stdout", chunk: `log ${canary}` })}\n`);
    }
    const ops: string[] = [];
    for (const [run, canary] of [[s.runA, CANARY_A], [s.runB, CANARY_B]] as const) {
      const opId = randomUUID();
      const logRef = `${s.company.id}/${opId}.ndjson`;
      await fs.mkdir(path.join(process.env.WORKSPACE_OPERATION_LOG_BASE_PATH!, s.company.id), { recursive: true });
      await fs.writeFile(path.join(process.env.WORKSPACE_OPERATION_LOG_BASE_PATH!, logRef), `op-log ${canary}\n`);
      await db.insert(workspaceOperations).values({
        id: opId, companyId: s.company.id, heartbeatRunId: run.id, executionWorkspaceId: ws!.id, phase: "provision",
        command: `cmd ${canary}`, status: "succeeded", logStore: "local_file", logRef, stdoutExcerpt: `out ${canary}`, stderrExcerpt: `err ${canary}`,
      });
      ops.push(opId);
    }
    await fs.mkdir(process.env.PROVIDER_TRACE_BASE_PATH!, { recursive: true });
    for (const [run, canary] of [[s.runA, CANARY_A], [s.runB, CANARY_B]] as const) {
      const traceRef = `${randomUUID()}.ndjson`;
      const frame = { kind: "frame", schema: "paperclip.provider_trace_frame.v1", frameId: 1, rawBase64: Buffer.from(JSON.stringify({ message: canary })).toString("base64") };
      await fs.writeFile(path.join(process.env.PROVIDER_TRACE_BASE_PATH!, traceRef), `${JSON.stringify(frame)}\n`);
      await db.insert(providerTraceRecords).values({
        companyId: s.company.id, runId: run.id, status: "complete", provider: "codex", traceRef, frameCount: 1, byteCount: 10,
        requestedBy: "test", expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    return { ...s, opA: ops[0]!, opB: ops[1]!, issueId: issue!.id, ws: ws!.id };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-content-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("serves unrestricted runs normally and withholds every restricted-run content route with a no-store tombstone", async () => {
    const s = await seedContent();
    const c = s.company.id;
    const http = request(app(admin([c])));
    const reads = (runId: string, opId: string) => [
      ["detail", `/api/heartbeat-runs/${runId}`],
      ["events", `/api/heartbeat-runs/${runId}/events`],
      ["log", `/api/heartbeat-runs/${runId}/log`],
      ["log-offset", `/api/heartbeat-runs/${runId}/log?offset=5&limitBytes=40`],
      ["workspace-operations", `/api/heartbeat-runs/${runId}/workspace-operations`],
      ["workspace-operation-log", `/api/workspace-operations/${opId}/log`],
      ["workspace-operation-log-offset", `/api/workspace-operations/${opId}/log?offset=3`],
      ["provider-trace", `/api/heartbeat-runs/${runId}/provider-trace`],
      ["provider-trace-download", `/api/heartbeat-runs/${runId}/provider-trace/download`],
    ] as const;

    for (const [name, url] of reads(s.runB.id, s.opB)) {
      const res = await http.get(url);
      expect(res.status, `unrestricted ${name}`).toBe(200);
    }
    expect((await http.get(`/api/heartbeat-runs/${s.runB.id}/events`)).text).toContain(CANARY_B);

    const gate = runContentGate(db);
    const receipt = await gate.activateRestriction({ companyId: c, runId: s.runA.id, actorId: "user:custodian", reasonCode: "synthetic", authorizationRef: "SYN-1" });
    expect(receipt.outcome).toBe("restricted");

    for (const [name, url] of reads(s.runA.id, s.opA)) {
      const res = await http.get(url);
      expect(res.status, `restricted ${name}`).toBe(403);
      expect(res.headers["cache-control"], `restricted ${name} cache`).toContain("no-store");
      expect(res.text, `restricted ${name} leaks`).not.toContain(CANARY_A);
      expect(res.body.tombstone, `restricted ${name} tombstone`).toMatchObject({ runId: s.runA.id, companyId: c, state: "restricted" });
    }
    const reveal = await http.post(`/api/heartbeat-runs/${s.runA.id}/provider-trace/frames/1/reveal`);
    expect(reveal.status).toBe(403);
    expect(reveal.text).not.toContain(CANARY_A);
    expect((await http.post(`/api/heartbeat-runs/${s.runB.id}/provider-trace/frames/1/reveal`)).status).toBe(200);
    await gate.stop();
  });

  it("list, live-run and issue-associated projections omit restricted content before serialization and keep B intact", async () => {
    const s = await seedContent();
    const c = s.company.id;
    const http = request(app(admin([c])));
    const gate = runContentGate(db);
    await gate.activateRestriction({ companyId: c, runId: s.runA.id, actorId: "user:custodian", reasonCode: "synthetic", authorizationRef: "SYN-2" });
    const urls = [
      `/api/companies/${c}/heartbeat-runs`,
      `/api/companies/${c}/heartbeat-runs?summary=true`,
      `/api/companies/${c}/heartbeat-runs?limit=1`,
      `/api/companies/${c}/live-runs`,
      `/api/companies/${c}/live-runs?minCount=10`,
      `/api/issues/${s.issueId}/live-runs`,
      `/api/issues/${s.issueId}/runs`,
      `/api/issues/${s.issueId}/active-run`,
      `/api/issues/${s.issueId}/execution`,
      `/api/execution-workspaces/${s.ws}/workspace-operations`,
    ];
    for (const url of urls) {
      const res = await http.get(url);
      expect(res.status, url).toBeLessThan(500);
      expect(res.text, `${url} leaks A`).not.toContain(CANARY_A);
    }
    const list = await http.get(`/api/companies/${c}/heartbeat-runs`);
    const entryA = (list.body as Array<Record<string, any>>).find((r) => r.id === s.runA.id);
    expect(entryA).toMatchObject({ id: s.runA.id, state: "restricted", contentWithheld: true });
    expect(Object.keys(entryA!).sort()).toEqual(["companyId", "contentWithheld", "createdAt", "id", "state"]);
    const entryB = (list.body as Array<Record<string, any>>).find((r) => r.id === s.runB.id);
    expect(entryB?.error ?? JSON.stringify(entryB)).toContain(CANARY_B);
    const wsOps = await http.get(`/api/execution-workspaces/${s.ws}/workspace-operations`);
    expect(wsOps.text).toContain(CANARY_B);
    await gate.stop();
  });

  it("cross-company actors get no restricted tombstone detail and ordinary 404", async () => {
    const s = await seedContent();
    const other = await seedCompanyRuns(db, "Other");
    const outsider = { ...admin([other.company.id]), userId: "outsider", isInstanceAdmin: false, source: "session" as const };
    const http = request(app(outsider));
    const gate = runContentGate(db);
    await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-3" });
    const res = await http.get(`/api/heartbeat-runs/${s.runA.id}/events`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(CANARY_A);
    await gate.stop();
  });

  it("restricted run originals are not mutated by trace delete, reproject, or expiry cleanup", async () => {
    const s = await seedContent();
    const c = s.company.id;
    const http = request(app(admin([c])));
    const gate = runContentGate(db);
    await gate.activateRestriction({ companyId: c, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-4" });
    const traceBefore = await db.select().from(providerTraceRecords).where(eq(providerTraceRecords.runId, s.runA.id)).then((r) => r[0]!);
    const filePath = path.join(process.env.PROVIDER_TRACE_BASE_PATH!, traceBefore.traceRef);
    const bytesBefore = await fs.readFile(filePath);
    expect((await http.delete(`/api/heartbeat-runs/${s.runA.id}/provider-trace`)).status).toBe(403);
    expect((await http.post(`/api/heartbeat-runs/${s.runA.id}/provider-trace/reproject-workspace-diffs`)).status).toBe(403);
    await db.update(providerTraceRecords).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(providerTraceRecords.runId, s.runA.id));
    const { providerTraceStore } = await import("../../services/provider-trace-store.js");
    await providerTraceStore(db).cleanupExpired();
    const bytesAfter = await fs.readFile(filePath);
    expect(Buffer.compare(bytesBefore, bytesAfter)).toBe(0);
    const traceAfter = await db.select().from(providerTraceRecords).where(eq(providerTraceRecords.runId, s.runA.id)).then((r) => r[0]!);
    expect(traceAfter.deletedAt).toBeNull();
    await gate.stop();
  });

  it("named forensic grant recovers byte-identical originals through the audited route; admin alone cannot; revoke denies", async () => {
    const s = await seedContent();
    const c = s.company.id;
    const gate = runContentGate(db);
    const logPath = path.join(process.env.RUN_LOG_BASE_PATH!, c, `${s.runA.id}.ndjson`);
    const before = await fs.readFile(logPath);
    await gate.activateRestriction({ companyId: c, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-5" });
    const forensicActor = { ...admin([c]), userId: "named-forensic", isInstanceAdmin: false, source: "session" as const };
    await db.insert(companyMemberships).values({ companyId: c, principalType: "user", principalId: "named-forensic", status: "active", membershipRole: "owner", updatedAt: new Date() });
    await ensureHumanRoleDefaultGrants(db, { companyId: c, principalId: "named-forensic", membershipRole: "owner", grantedByUserId: null });
    expect((await request(app(admin([c]))).get(`/api/heartbeat-runs/${s.runA.id}/log`)).status).toBe(403);
    const grant = await gate.createForensicGrant({
      companyId: c, runId: s.runA.id, granteeActorId: "user:named-forensic", purpose: "review", authorizationRef: "SYN-5g",
      allowedOperations: ["read_log"], ttlMs: 60_000, issuedBy: "user:custodian",
    });
    const ok = await request(app(forensicActor)).get(`/api/heartbeat-runs/${s.runA.id}/log`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.headers["cache-control"]).toContain("no-store");
    expect(ok.body.content).toContain(CANARY_A);
    expect(Buffer.from(ok.body.content).byteLength).toBeGreaterThan(0);
    expect((await request(app(forensicActor)).get(`/api/heartbeat-runs/${s.runA.id}/events`)).status).toBe(403);
    await gate.revokeForensicGrant({ companyId: c, grantId: grant.id, revokedBy: "user:custodian", reason: "done" });
    expect((await request(app(forensicActor)).get(`/api/heartbeat-runs/${s.runA.id}/log`)).status).toBe(403);
    const after = await fs.readFile(logPath);
    expect(Buffer.compare(before, after)).toBe(0);
    await gate.stop();
  });
});
