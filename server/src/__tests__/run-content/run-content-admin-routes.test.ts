import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { runContentAdminRoutes } from "../../routes/run-content-admin.js";
import { runContentGate } from "../../services/run-content-gate.js";
import { agentRoutes } from "../../routes/agents.js";
import { CANARY_A, seedCompanyRuns } from "./fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("run content admin routes (AC1/AC5/AC7)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-content-admin-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
  });

  const board = (companyId: string, over: Record<string, unknown> = {}) => ({
    type: "board", userId: "operator-1", companyIds: [companyId], isInstanceAdmin: true, source: "session",
    memberships: [{ companyId, membershipRole: "owner", status: "active" }], ...over,
  });
  const app = (actor: Record<string, unknown>, enabled = true) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as any).actor = actor; next(); });
    a.use("/api", runContentAdminRoutes(db, { adminEnabled: enabled }));
    a.use("/api", agentRoutes(db));
    a.use(errorHandler);
    return a;
  };

  it("is disabled by default (no production activation) and requires instance admin", async () => {
    const s = await seedCompanyRuns(db);
    const url = `/api/companies/${s.company.id}/heartbeat-runs/${s.runA.id}/content-restriction`;
    const body = { reasonCode: "x", authorizationRef: "SYN-A1" };
    expect((await request(app(board(s.company.id), false)).put(url).send(body)).status).toBe(404);
    expect((await request(app(board(s.company.id, { isInstanceAdmin: false }))).put(url).send(body)).status).toBe(403);
    expect((await request(app({ type: "agent", agentId: s.agent.id, companyId: s.company.id, source: "agent_key" })).put(url).send(body)).status).toBe(403);
  });

  it("activates with a receipt, reports non-success on incomplete cutover, reads state back, and releases with risk acceptance", async () => {
    const s = await seedCompanyRuns(db);
    const base = `/api/companies/${s.company.id}/heartbeat-runs/${s.runA.id}/content-restriction`;
    const http = request(app(board(s.company.id)));

    const missing = await http.put(base).send({ reasonCode: "x" });
    expect(missing.status).toBe(400);

    const stuckGate = runContentGate(db, { instanceId: "stuck", tickMs: 600_000 });
    const stuck = await stuckGate.acquireLease({ companyId: s.company.id, runId: s.runA.id, actorId: "user:x", routePurpose: "read_events", kind: "stream" });
    const incomplete = await http.put(base).send({ reasonCode: "x", authorizationRef: "SYN-A2", drainTimeoutMs: 200 });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.outcome).toBe("incomplete");
    expect(incomplete.body.state).toBe("restricting");
    await stuck.release("operator_ack");

    const ok = await http.put(base).send({ reasonCode: "x", authorizationRef: "SYN-A2", drainTimeoutMs: 2000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ outcome: "restricted", state: "restricted", storageCustody: "not_attested_by_server" });
    expect(JSON.stringify(ok.body)).not.toContain(CANARY_A);

    const read = await http.get(base);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ runId: s.runA.id, state: "restricted", authorizationRef: "SYN-A2" });
    expect(read.headers["cache-control"]).toContain("no-store");

    const noRisk = await http.delete(base).send({ authorizationRef: "SYN-A3" });
    expect(noRisk.status).toBe(400);
    const released = await http.delete(base).send({ authorizationRef: "SYN-A3", riskAcceptanceRef: "REZ-SYN" });
    expect(released.status).toBe(200);
    expect(released.body.outcome).toBe("released");
    expect((await http.get(`/api/heartbeat-runs/${s.runA.id}/events`)).status).toBe(200);
    await stuckGate.stop();
  });

  it("creates, lists (metadata only) and revokes named forensic grants; admin role alone reads nothing", async () => {
    const s = await seedCompanyRuns(db);
    const base = `/api/companies/${s.company.id}/heartbeat-runs/${s.runA.id}`;
    const http = request(app(board(s.company.id)));
    await http.put(`${base}/content-restriction`).send({ reasonCode: "x", authorizationRef: "SYN-G0" });
    expect((await http.get(`/api/heartbeat-runs/${s.runA.id}/events`)).status).toBe(403);

    const created = await http.post(`${base}/forensic-grants`).send({
      granteeActorId: "user:named", purpose: "review", authorizationRef: "SYN-G1", allowedOperations: ["read_log"], ttlMs: 60_000,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ granteeActorId: "user:named", issuedBy: "user:operator-1" });
    const self = await http.post(`${base}/forensic-grants`).send({
      granteeActorId: "user:operator-1", purpose: "p", authorizationRef: "SYN-G2", allowedOperations: ["read_log"], ttlMs: 60_000,
    });
    expect(self.status).toBe(400);
    const list = await http.get(`${base}/forensic-grants`);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(CANARY_A);
    const revoked = await http.delete(`${base}/forensic-grants/${created.body.id}`).send({ reason: "done" });
    expect(revoked.status).toBe(200);
    const audit = await http.get(`${base}/content-audit`);
    expect(audit.status).toBe(200);
    expect(audit.body.map((e: { eventKind: string }) => e.eventKind)).toEqual(expect.arrayContaining(["transition", "grant_created", "grant_revoked"]));
    expect(JSON.stringify(audit.body)).not.toContain(CANARY_A);
  });
});
