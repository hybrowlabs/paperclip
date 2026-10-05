import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  runContentAuditEvents,
  runContentLeases,
  runContentRestrictions,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import {
  runContentGate,
  runContentGateOptionsFromEnv,
  RunContentDeniedError,
  isRunRetentionHeld,
} from "../../services/run-content-gate.js";
import { CANARY_A, seedCompanyRuns } from "./fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const ctx = (companyId: string, runId: string, extra: Record<string, unknown> = {}) => ({
  companyId,
  runId,
  actorId: "user:ordinary",
  routePurpose: "read_events" as const,
  ...extra,
});

d("run content gate (embedded postgres, synthetic canaries)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const fast = { leaseTtlMs: 600, clockSkewMs: 50, tickMs: 25, drainPollMs: 20 };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-content-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
  });

  describe("authorizeRunContent (AC1)", () => {
    it("admits ordinary reads for an unrestricted run and denies cross-company/unknown runs", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const other = await seedCompanyRuns(db, "Other");
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id))).decision).toBe("ordinary");
      const cross = await gate.authorizeRunContent(ctx(other.company.id, s.runA.id));
      expect(cross.decision).toBe("deny");
      expect((cross as { reason: string }).reason).toBe("unknown_run");
      const missing = await gate.authorizeRunContent(ctx(s.company.id, randomUUID()));
      expect(missing.decision).toBe("deny");
      await gate.stop();
    });

    it("persists restricting -> restricted with a transition receipt and epochs, and denies in both states", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const receipt = await gate.activateRestriction({
        companyId: s.company.id,
        runId: s.runA.id,
        actorId: "user:custodian",
        reasonCode: "output_exposure",
        authorizationRef: "HYBA-491#synthetic",
      });
      expect(receipt.outcome).toBe("restricted");
      expect(receipt.state).toBe("restricted");
      expect(receipt.epoch).toBeGreaterThanOrEqual(2);
      expect(receipt.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["none->restricting", "restricting->restricted"]);
      const row = await db.select().from(runContentRestrictions).where(eq(runContentRestrictions.runId, s.runA.id)).then((r) => r[0]!);
      expect(row.state).toBe("restricted");
      expect(row.authorizationRef).toBe("HYBA-491#synthetic");
      expect(row.acknowledgedAt).toBeTruthy();
      const decision = await gate.authorizeRunContent(ctx(s.company.id, s.runA.id));
      expect(decision.decision).toBe("deny");
      expect((decision as { tombstone: Record<string, unknown> }).tombstone).toMatchObject({
        runId: s.runA.id,
        companyId: s.company.id,
        state: "restricted",
      });
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runB.id))).decision).toBe("ordinary");
      const audits = await db.select().from(runContentAuditEvents).where(eq(runContentAuditEvents.runId, s.runA.id));
      expect(JSON.stringify(audits)).not.toContain(CANARY_A);
      await gate.stop();
    });

    it("denies for unknown state, unrecognised policy version, and lookup error", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      await db.execute(sql`alter table run_content_restrictions drop constraint run_content_restrictions_state_chk`);
      await db.insert(runContentRestrictions).values({
        companyId: s.company.id, runId: s.runA.id, state: "weird", epoch: 1,
        reasonCode: "x", authorizationRef: "x", actorId: "x",
      });
      const unknown = await gate.authorizeRunContent(ctx(s.company.id, s.runA.id));
      expect(unknown).toMatchObject({ decision: "deny", reason: "unknown_state" });
      await db.execute(sql`alter table run_content_restrictions disable trigger run_content_restrictions_no_delete`);
      await db.delete(runContentRestrictions).where(eq(runContentRestrictions.runId, s.runA.id));
      await db.execute(sql`alter table run_content_restrictions enable trigger run_content_restrictions_no_delete`);
      await db.execute(sql`alter table run_content_restrictions add constraint run_content_restrictions_state_chk check (state in ('restricting','restricted','releasing','released'))`);
      await db.insert(runContentRestrictions).values({
        companyId: s.company.id, runId: s.runB.id, state: "released", epoch: 3, policyVersion: 999,
        reasonCode: "x", authorizationRef: "x", actorId: "x",
      });
      const future = await gate.authorizeRunContent(ctx(s.company.id, s.runB.id));
      expect(future).toMatchObject({ decision: "deny", reason: "unrecognized_policy_version" });
      const broken = runContentGate({
        ...db,
        select: () => { throw new Error("db unavailable"); },
        transaction: () => { throw new Error("db unavailable"); },
        execute: () => { throw new Error("db unavailable"); },
      } as unknown as Db, fast);
      const err = await broken.authorizeRunContent(ctx(s.company.id, s.runB.id));
      expect(err).toMatchObject({ decision: "deny", reason: "lookup_error" });
      await gate.stop();
    });

    it("never caches a permissive decision across a policy change", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id))).decision).toBe("ordinary");
      await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id))).decision).toBe("deny");
      await gate.stop();
    });
  });

  describe("admission barrier, leases and fencing (AC3)", () => {
    it("does not acknowledge activation until a pre-admitted reader releases; no byte after acknowledgment", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const lease = await gate.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "http_read" });
      await lease.checkpoint();
      const emitted: string[] = [];
      let settled = false;
      const activation = gate
        .activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 5_000 })
        .then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 200));
      expect(settled).toBe(false);
      expect(lease.signal.aborted).toBe(true);
      expect(() => lease.emit(() => emitted.push("fenced-byte"))).toThrow();
      await expect(gate.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "http_read" })).rejects.toBeInstanceOf(RunContentDeniedError);
      await lease.release("complete");
      const receipt = await activation;
      expect(receipt.outcome).toBe("restricted");
      expect(receipt.drained.releasedByHolder + receipt.drained.revokedAcked).toBeGreaterThanOrEqual(1);
      expect(() => lease.emit(() => emitted.push("late-byte"))).toThrow();
      expect(emitted).toEqual([]);
      await gate.stop();
    });

    it("pause between gate and emission: holder is fenced, cannot emit, and its refusal is the acknowledgment", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const lease = await gate.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "http_read" });
      await lease.checkpoint();
      let settled = false;
      const activation = gate
        .activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 5_000 })
        .then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);
      const written: string[] = [];
      expect(() => lease.emit(() => written.push("x"))).toThrow(RunContentDeniedError);
      const receipt = await activation;
      expect(receipt.outcome).toBe("restricted");
      expect(receipt.drained.revokedAcked).toBe(1);
      await expect(lease.checkpoint()).rejects.toThrow();
      expect(written).toEqual([]);
      await gate.stop();
    });

    it("refuses emission once the local lease deadline passes (paused holder cannot write after skew bound)", async () => {
      let mono = 1_000;
      const gate = runContentGate(db, { ...fast, tickMs: 60_000, monotonicNow: () => mono });
      const s = await seedCompanyRuns(db);
      const lease = await gate.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "http_read" });
      await lease.checkpoint();
      expect(lease.emit(() => "ok")).toBe("ok");
      mono += 10_000;
      expect(() => lease.emit(() => "late")).toThrow(/lease_expired/);
      await lease.release("test").catch(() => {});
      await gate.stop();
    });

    it("multi-instance: instance 1 reader blocks activation requested via instance 2; instance 2 drains after instance 1 releases", async () => {
      const g1 = runContentGate(db, { ...fast, instanceId: "pod-1" });
      const g2 = runContentGate(db, { ...fast, instanceId: "pod-2" });
      const s = await seedCompanyRuns(db);
      const lease = await g1.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" });
      let settled = false;
      const activation = g2
        .activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 5_000 })
        .then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);
      await expect(g1.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" })).rejects.toBeInstanceOf(RunContentDeniedError);
      await expect(g2.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" })).rejects.toBeInstanceOf(RunContentDeniedError);
      const b = await g2.acquireLease({ ...ctx(s.company.id, s.runB.id), kind: "stream" });
      await b.release("done");
      expect(lease.signal.aborted).toBe(true);
      await lease.release("observed_revocation");
      const receipt = await activation;
      expect(receipt.outcome).toBe("restricted");
      await g1.stop(); await g2.stop();
    });

    it("timeout fails closed: receipt is incomplete, state stays restricting, reads stay denied, retry succeeds after drain", async () => {
      const g1 = runContentGate(db, { ...fast, instanceId: "stuck-pod", tickMs: 60_000 });
      const g2 = runContentGate(db, { ...fast, instanceId: "operator-pod" });
      const s = await seedCompanyRuns(db);
      const stuck = await g1.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" });
      const first = await g2.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 150 });
      expect(first.outcome).toBe("incomplete");
      expect(first.state).toBe("restricting");
      expect(first.drained.stillOpen).toBe(1);
      expect((await g2.authorizeRunContent(ctx(s.company.id, s.runA.id))).decision).toBe("deny");
      await stuck.release("operator_ack");
      const second = await g2.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 2_000 });
      expect(second.outcome).toBe("restricted");
      await g1.stop(); await g2.stop();
    });

    it("restart: a new boot of the same instance reaps leases left by its previous boot", async () => {
      const before = runContentGate(db, { ...fast, instanceId: "pod-r", tickMs: 60_000 });
      const s = await seedCompanyRuns(db);
      const lease = await before.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" });
      const after = runContentGate(db, { ...fast, instanceId: "pod-r" });
      const reaped = await after.start();
      expect(reaped.reapedLeases).toBeGreaterThanOrEqual(1);
      const row = await db.select().from(runContentLeases).where(eq(runContentLeases.id, lease.id)).then((r) => r[0]!);
      expect(row.releasedAt).toBeTruthy();
      expect(row.releaseReason).toBe("holder_restarted");
      const receipt = await after.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 1_000 });
      expect(receipt.outcome).toBe("restricted");
      await before.stop(); await after.stop();
    });

    it("a crashed holder's expired lease is treated as drained only after ttl plus skew", async () => {
      const g1 = runContentGate(db, { ...fast, instanceId: "dead-pod", tickMs: 60_000 });
      const g2 = runContentGate(db, { ...fast, instanceId: "live-pod" });
      const s = await seedCompanyRuns(db);
      await g1.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" });
      const receipt = await g2.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 5_000 });
      expect(receipt.outcome).toBe("restricted");
      expect(receipt.drained.expiredReaped).toBe(1);
      await g1.stop(); await g2.stop();
    });

    it("per-chunk checkpoint cancels a stream whose run is restricted mid-stream", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const lease = await gate.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" });
      const chunks: string[] = [];
      const stream = (async () => {
        for (let i = 0; i < 50; i++) {
          await lease.checkpoint();
          lease.emit(() => chunks.push(`chunk-${i}`));
          await new Promise((r) => setTimeout(r, 30));
        }
      })().catch(() => "cancelled");
      await new Promise((r) => setTimeout(r, 100));
      await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 5_000 });
      const countAtAck = chunks.length;
      expect(await stream).toBe("cancelled");
      expect(chunks.length).toBe(countAtAck);
      await gate.stop();
    });
  });

  describe("company-wide live watcher (live websocket streams)", () => {
    it("refreshes its restricted set and acknowledges before activation completes; fails closed when its lease lapses", async () => {
      const g1 = runContentGate(db, { ...fast, instanceId: "ws-pod" });
      const g2 = runContentGate(db, { ...fast, instanceId: "api-pod" });
      const s = await seedCompanyRuns(db);
      const watcher = await g1.watchCompany({ companyId: s.company.id, kind: "live_socket" });
      expect(watcher.isRestricted(s.runA.id)).toBe(false);
      const receipt = await g2.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 5_000 });
      expect(receipt.outcome).toBe("restricted");
      expect(watcher.isRestricted(s.runA.id)).toBe(true);
      expect(watcher.isRestricted(s.runB.id)).toBe(false);
      await watcher.close();
      let mono = 0;
      const g3 = runContentGate(db, { ...fast, tickMs: 60_000, monotonicNow: () => mono });
      const lapsed = await g3.watchCompany({ companyId: s.company.id, kind: "live_socket" });
      expect(lapsed.isRestricted(s.runB.id)).toBe(false);
      mono += 10_000;
      expect(lapsed.isRestricted(s.runB.id)).toBe(true);
      await lapsed.close();
      await g1.stop(); await g2.stop(); await g3.stop();
    });
  });

  describe("capability inventory and egress (AC4)", () => {
    it("inventories pre-issued capabilities as metadata, revokes supported ones, and reports residual exposure", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      await gate.registerCapability({ companyId: s.company.id, runId: s.runA.id, kind: "signed_mirror_link", issuer: "run-log-store", destinationClass: "object_store", revocationSupported: false, expiresAt: new Date(Date.now() + 3_600_000), metadata: { ttlSeconds: 3600 } });
      await gate.registerCapability({ companyId: s.company.id, runId: s.runA.id, kind: "trace_download_ticket", issuer: "provider-trace", destinationClass: "api", revocationSupported: true });
      const receipt = await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      expect(receipt.outcome).toBe("restricted");
      expect(receipt.containment).toBe("partial");
      expect(receipt.capabilities.revoked).toBe(1);
      expect(receipt.capabilities.residual).toEqual([expect.objectContaining({ kind: "signed_mirror_link", destinationClass: "object_store" })]);
      expect(JSON.stringify(receipt)).not.toMatch(/https?:\/\//);
      await gate.stop();
    });

    it("revalidates a queued job at egress using the current epoch; unclassifiable jobs default to no delivery", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const queued = await gate.authorizeEgress({ companyId: s.company.id, runId: s.runA.id, jobKind: "sentry_failed_run_report", destinationClass: "sentry" });
      expect(queued.allowed).toBe(true);
      await queued.lease?.release("test");
      await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      const after = await gate.authorizeEgress({ companyId: s.company.id, runId: s.runA.id, jobKind: "sentry_failed_run_report", destinationClass: "sentry" });
      expect(after.allowed).toBe(false);
      const unknown = await gate.authorizeEgress({ companyId: s.company.id, runId: null, jobKind: "export", destinationClass: "export" });
      expect(unknown.allowed).toBe(false);
      await gate.stop();
    });
  });

  describe("forensic grants (AC5)", () => {
    const grantInput = (s: Awaited<ReturnType<typeof seedCompanyRuns>>, over: Record<string, unknown> = {}) => ({
      companyId: s.company.id, runId: s.runA.id, granteeActorId: "user:forensic", purpose: "incident review",
      authorizationRef: "HYBA-491#grant", allowedOperations: ["read_events", "read_log"] as const, ttlMs: 60_000,
      issuedBy: "user:custodian", ...over,
    });
    const restrict = (gate: ReturnType<typeof runContentGate>, s: Awaited<ReturnType<typeof seedCompanyRuns>>) =>
      gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });

    it("admin role alone is not a grant; named live grant yields forensic decision for that individual only", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      await restrict(gate, s);
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:instance-admin" }))).decision).toBe("deny");
      const grant = await gate.createForensicGrant({ ...grantInput(s), allowedOperations: [...grantInput(s).allowedOperations] });
      const ok = await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }));
      expect(ok).toMatchObject({ decision: "forensic", grantId: grant.id });
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:someone-else" }))).decision).toBe("deny");
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:forensic", routePurpose: "download_provider_trace" }))).decision).toBe("deny");
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runB.id, { actorId: "user:forensic" }))).decision).toBe("ordinary");
      await gate.stop();
    });

    it("rejects open-ended or anonymous grants", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      await expect(gate.createForensicGrant({ ...grantInput(s), allowedOperations: ["read_events"], ttlMs: 30 * 24 * 3_600_000 })).rejects.toThrow(/ttl/i);
      await expect(gate.createForensicGrant({ ...grantInput(s), allowedOperations: ["read_events"], granteeActorId: "*" })).rejects.toThrow(/individual/i);
      await expect(gate.createForensicGrant({ ...grantInput(s), allowedOperations: [] })).rejects.toThrow(/operation/i);
      await expect(gate.createForensicGrant({ ...grantInput(s), allowedOperations: ["read_events"], issuedBy: "user:forensic" })).rejects.toThrow(/self/i);
      await gate.stop();
    });

    it("expires and revokes (including mid-stream) and audits metadata only", async () => {
      let now = new Date("2026-10-05T00:00:00Z");
      const gate = runContentGate(db, { ...fast, now: () => now });
      const s = await seedCompanyRuns(db);
      await restrict(gate, s);
      const grant = await gate.createForensicGrant({ ...grantInput(s), allowedOperations: ["read_events"], ttlMs: 10_000 });
      const lease = await gate.acquireLease({ ...ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }), kind: "stream" });
      expect(lease.decision).toBe("forensic");
      await lease.checkpoint();
      await gate.revokeForensicGrant({ companyId: s.company.id, grantId: grant.id, revokedBy: "user:custodian", reason: "done" });
      await new Promise((r) => setTimeout(r, 120));
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.checkpoint()).rejects.toThrow();
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }))).decision).toBe("deny");
      const g2 = await gate.createForensicGrant({ ...grantInput(s), allowedOperations: ["read_events"], ttlMs: 10_000 });
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }))).decision).toBe("forensic");
      now = new Date(now.getTime() + 11_000);
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }))).decision).toBe("deny");
      const audits = await db.select().from(runContentAuditEvents).where(eq(runContentAuditEvents.runId, s.runA.id));
      const kinds = audits.map((a) => a.eventKind);
      expect(kinds).toEqual(expect.arrayContaining(["grant_created", "grant_revoked", "access_denied", "access_granted"]));
      expect(JSON.stringify(audits)).not.toContain(CANARY_A);
      expect(g2.id).not.toBe(grant.id);
      await gate.stop();
    });

    it("withholds forensic access while the run is still restricting", async () => {
      const g1 = runContentGate(db, { ...fast, instanceId: "p1", tickMs: 60_000 });
      const g2 = runContentGate(db, { ...fast, instanceId: "p2" });
      const s = await seedCompanyRuns(db);
      const stuck = await g1.acquireLease({ ...ctx(s.company.id, s.runA.id), kind: "stream" });
      await g2.createForensicGrant({ ...grantInput(s), allowedOperations: ["read_events"] });
      const receipt = await g2.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a", drainTimeoutMs: 100 });
      expect(receipt.outcome).toBe("incomplete");
      expect((await g2.authorizeRunContent(ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }))).decision).toBe("deny");
      await stuck.release("x");
      await g1.stop(); await g2.stop();
    });
  });

  describe("rollback / disable path (AC7)", () => {
    it("fenced release transition restores ordinary access, keeps history, and revokes forensic leases", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      await gate.createForensicGrant({ companyId: s.company.id, runId: s.runA.id, granteeActorId: "user:forensic", purpose: "p", authorizationRef: "a", allowedOperations: ["read_events"], ttlMs: 60_000, issuedBy: "user:c" });
      const forensic = await gate.acquireLease({ ...ctx(s.company.id, s.runA.id, { actorId: "user:forensic" }), kind: "stream" });
      forensic.signal.addEventListener("abort", () => void forensic.release("observed_revocation"));
      const receipt = await gate.releaseRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:risk-owner", authorizationRef: "RISK-1", riskAcceptanceRef: "REZ-1" });
      expect(receipt.outcome).toBe("released");
      expect(receipt.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["restricted->releasing", "releasing->released"]);
      expect(forensic.signal.aborted).toBe(true);
      expect((await gate.authorizeRunContent(ctx(s.company.id, s.runA.id))).decision).toBe("ordinary");
      const audits = await db.select().from(runContentAuditEvents).where(eq(runContentAuditEvents.runId, s.runA.id));
      expect(audits.filter((a) => a.eventKind === "transition").length).toBeGreaterThanOrEqual(4);
      await expect(db.delete(runContentAuditEvents).where(eq(runContentAuditEvents.runId, s.runA.id))).rejects.toThrow();
      await expect(db.delete(runContentRestrictions).where(eq(runContentRestrictions.runId, s.runA.id))).rejects.toThrow();
      await gate.stop();
    });

    it("release requires independent risk acceptance and a restricted run", async () => {
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      await expect(gate.releaseRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "u", authorizationRef: "a", riskAcceptanceRef: "r" })).rejects.toThrow(/not restricted/i);
      await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      await expect(gate.releaseRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "u", authorizationRef: "a", riskAcceptanceRef: "" })).rejects.toThrow(/risk/i);
      await gate.stop();
    });

    it("env parsing: bypass mode is explicit, admin API default is off, and retention hold tracks restriction state", async () => {
      expect(runContentGateOptionsFromEnv({}).enabled).toBe(true);
      expect(runContentGateOptionsFromEnv({ PAPERCLIP_RUN_CONTENT_GATE_MODE: "bypass_for_unrestricted" }).enabled).toBe(false);
      expect(runContentGateOptionsFromEnv({ PAPERCLIP_RUN_CONTENT_GATE_MODE: "off" }).enabled).toBe(true);
      const gate = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      expect(await isRunRetentionHeld(db, s.company.id, s.runA.id)).toBe(false);
      await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      expect(await isRunRetentionHeld(db, s.company.id, s.runA.id)).toBe(true);
      expect(await isRunRetentionHeld(db, s.company.id, s.runB.id)).toBe(false);
      const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
      expect(await isRunRetentionHeld(broken, s.company.id, s.runB.id)).toBe(true);
      await gate.releaseRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "u", authorizationRef: "a", riskAcceptanceRef: "r" });
      expect(await isRunRetentionHeld(db, s.company.id, s.runA.id)).toBe(false);
      await gate.stop();
    });

    it("disabling the feature flag is honoured only when no active restriction exists", async () => {
      const on = runContentGate(db, fast);
      const s = await seedCompanyRuns(db);
      const off = runContentGate(db, { ...fast, enabled: false });
      expect((await off.authorizeRunContent(ctx(s.company.id, s.runB.id))).decision).toBe("ordinary");
      await on.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "r", authorizationRef: "a" });
      expect((await off.authorizeRunContent(ctx(s.company.id, s.runA.id))).decision).toBe("deny");
      await on.stop(); await off.stop();
    });
  });
});
