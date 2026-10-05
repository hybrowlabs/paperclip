import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, heartbeatRunEvents, heartbeatRuns, providerTraceRecords, type Db } from "@paperclipai/db";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-content-integrity-"));
process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
process.env.PROVIDER_TRACE_BASE_PATH = path.join(root, "traces");

const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import("../helpers/embedded-postgres.js");
const { runContentGate } = await import("../../services/run-content-gate.js");
const { providerTraceStore } = await import("../../services/provider-trace-store.js");
const { createDurableRunLogStore } = await import("../../services/run-log-store.js");
const { CANARY_A, seedCompanyRuns } = await import("./fixtures.js");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

d("run content originals are never mutated (AC5 byte/hash integrity)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-content-integrity-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("DB row, local NDJSON, trace sidecar and mirror object keep identical bytes/hash through activate, grant, forensic read, expiry cleanup and release", async () => {
    const s = await seedCompanyRuns(db, "Integrity");
    const gate = runContentGate(db);

    const logRef = `${s.company.id}/${s.runA.id}.ndjson`;
    const logPath = path.join(process.env.RUN_LOG_BASE_PATH!, logRef);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const logBytes = Buffer.from(`${JSON.stringify({ ts: "2026-10-05T00:00:00Z", stream: "stdout", chunk: `log ${CANARY_A}` })}\n`);
    await fs.writeFile(logPath, logBytes);
    await db.update(heartbeatRuns).set({ logStore: "local_file", logRef, logSha256: sha(logBytes), logBytes: logBytes.byteLength }).where(eq(heartbeatRuns.id, s.runA.id));
    await db.insert(heartbeatRunEvents).values({ companyId: s.company.id, runId: s.runA.id, agentId: s.agent.id, seq: 1, eventType: "log", message: `event ${CANARY_A}`, payload: { k: CANARY_A } });

    const mirror = new Map<string, Buffer>();
    const store = createDurableRunLogStore({
      basePath: path.join(root, "mirror-base"),
      s3: {
        keyPrefix: "mirror",
        provider: {
          id: "s3",
          putObject: async (input: any) => { mirror.set(input.objectKey, Buffer.isBuffer(input.body) ? input.body : Buffer.from(await new Response(input.body).arrayBuffer())); },
          getObject: async () => { throw new Error("not used"); },
          headObject: async () => ({ exists: false }),
          deleteObject: async (input: any) => { mirror.delete(input.objectKey); },
        } as any,
      },
    });
    const handle = await store.begin({ companyId: s.company.id, agentId: s.agent.id, runId: s.runA.id });
    await store.append(handle, { stream: "stdout", chunk: CANARY_A, ts: new Date().toISOString() });
    await store.finalize(handle);

    await fs.mkdir(process.env.PROVIDER_TRACE_BASE_PATH!, { recursive: true });
    const traceRef = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.ndjson";
    const traceBytes = Buffer.from(`${JSON.stringify({ kind: "frame", frameId: 1, rawBase64: Buffer.from(CANARY_A).toString("base64") })}\n`);
    await fs.writeFile(path.join(process.env.PROVIDER_TRACE_BASE_PATH!, traceRef), traceBytes);
    await db.insert(providerTraceRecords).values({ companyId: s.company.id, runId: s.runA.id, status: "complete", provider: "codex", traceRef, frameCount: 1, byteCount: traceBytes.byteLength, requestedBy: "t", expiresAt: new Date(Date.now() - 1000) });

    const snapshot = async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runA.id));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, s.runA.id));
      const [trace] = await db.select().from(providerTraceRecords).where(eq(providerTraceRecords.runId, s.runA.id));
      return {
        runRow: sha(JSON.stringify({ error: run!.error, resultJson: run!.resultJson, stdout: run!.stdoutExcerpt, stderr: run!.stderrExcerpt, ctx: run!.contextSnapshot })),
        events: sha(JSON.stringify(events.map((e) => [e.message, e.payload, e.seq]))),
        log: sha(await fs.readFile(logPath)),
        trace: sha(await fs.readFile(path.join(process.env.PROVIDER_TRACE_BASE_PATH!, traceRef))),
        traceDeletedAt: trace!.deletedAt,
        traceRef: trace!.traceRef,
        mirror: sha(JSON.stringify([...mirror.entries()].map(([k, v]) => [k, sha(v)]).sort())),
        mirrorKeys: mirror.size,
      };
    };

    const before = await snapshot();
    expect(before.mirrorKeys).toBeGreaterThan(0);

    const receipt = await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-I1" });
    expect(receipt.outcome).toBe("restricted");
    await providerTraceStore(db).cleanupExpired();
    const grant = await gate.createForensicGrant({ companyId: s.company.id, runId: s.runA.id, granteeActorId: "user:named", purpose: "p", authorizationRef: "SYN-I2", allowedOperations: ["read_log"], ttlMs: 60_000, issuedBy: "user:c" });
    const lease = await gate.acquireLease({ companyId: s.company.id, runId: s.runA.id, actorId: "user:named", routePurpose: "read_log", kind: "http_read" });
    const read = await store.read(handle, { offset: 0, limitBytes: 1_000_000 });
    await gate.recordForensicRead({ companyId: s.company.id, runId: s.runA.id, actorId: "user:named", grantId: grant.id, operation: "read_log", bytes: read.content });
    await lease.release("complete");
    await gate.revokeForensicGrant({ companyId: s.company.id, grantId: grant.id, revokedBy: "user:c", reason: "done" });

    expect(await snapshot()).toEqual(before);

    const released = await gate.releaseRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:risk", authorizationRef: "SYN-I3", riskAcceptanceRef: "REZ-SYN" });
    expect(released.outcome).toBe("released");
    const { traceDeletedAt: _a, traceRef: _b, ...afterReleaseStable } = await snapshot();
    const { traceDeletedAt: _c, traceRef: _d, ...beforeStable } = before;
    expect(afterReleaseStable).toEqual(beforeStable);
    await gate.stop();
  });
});
