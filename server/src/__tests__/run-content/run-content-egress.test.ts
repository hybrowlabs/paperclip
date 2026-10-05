import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, heartbeatRuns, type Db } from "@paperclipai/db";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-content-egress-"));
process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../../sentry.js", () => ({ captureRunFailure: mockCaptureRunFailure }));

const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import("../helpers/embedded-postgres.js");
const { reportRunFailure, waitForPendingRunFailureReports } = await import("../../services/run-failure-report.js");
const { runContentGate, getRunContentGate } = await import("../../services/run-content-gate.js");
const { readIssueCommentRunLogText } = await import("../../services/issues.js");
const { CANARY_A, CANARY_B, seedCompanyRuns } = await import("./fixtures.js");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("run content egress (failed-run report, Sentry, log derivation)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-content-egress-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  beforeEach(() => mockCaptureRunFailure.mockClear());
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function failedRun(label: string) {
    const s = await seedCompanyRuns(db, label);
    const taskId = randomUUID();
    for (const [run, canary] of [[s.runA, CANARY_A], [s.runB, CANARY_B]] as const) {
      await db.update(heartbeatRuns).set({
        status: "failed", errorCode: "adapter_failed", error: `boom ${canary}`,
        contextSnapshot: { issueId: taskId, note: canary }, stdoutExcerpt: `out ${canary}`,
      }).where(eq(heartbeatRuns.id, run.id));
    }
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.company.id));
    return { s, a: rows.find((r) => r.id === s.runA.id)!, b: rows.find((r) => r.id === s.runB.id)! };
  }

  it("reports an unrestricted failed run to Sentry and never transmits a restricted run's content", async () => {
    const { s, a, b } = await failedRun("Sentry");
    await reportRunFailure(db, b);
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureRunFailure.mock.calls[0]![0]).toMatchObject({ runId: s.runB.id, runStatus: "failed" });

    mockCaptureRunFailure.mockClear();
    const gate = getRunContentGate(db);
    await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-E1" });
    await reportRunFailure(db, a);
    await waitForPendingRunFailureReports(2000);
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it("revalidates at egress: a report queued before activation is dropped, not sent, once restricted mid-flight", async () => {
    const { s, a } = await failedRun("SentryQueued");
    const gate = getRunContentGate(db);
    const pending = reportRunFailure(db, a);
    await gate.activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-E2", drainTimeoutMs: 5000 });
    await pending;
    const sent = mockCaptureRunFailure.mock.calls.map((c) => JSON.stringify(c));
    expect(sent.some((x) => x.includes(CANARY_A))).toBe(false);
  });

  it("fails closed when the restriction state cannot be read (no send)", async () => {
    const { b } = await failedRun("SentryBroken");
    const broken = { ...db, select: () => { throw new Error("db down"); }, transaction: () => { throw new Error("db down"); }, execute: () => { throw new Error("db down"); } } as unknown as Db;
    await reportRunFailure(broken, b);
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it("issue-comment run-log derivation does not read a restricted run's NDJSON log", async () => {
    const { s } = await failedRun("Derive");
    const logRef = `${s.company.id}/${s.runA.id}.ndjson`;
    await fs.mkdir(path.join(process.env.RUN_LOG_BASE_PATH!, s.company.id), { recursive: true });
    await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH!, logRef), `${JSON.stringify({ chunk: `log ${CANARY_A}` })}\n`);
    const before = await readIssueCommentRunLogText({ runId: s.runA.id, companyId: s.company.id, logStore: "local_file", logRef, logBytes: 64 }, db);
    expect(before).toContain(CANARY_A);
    await runContentGate(db).activateRestriction({ companyId: s.company.id, runId: s.runA.id, actorId: "user:c", reasonCode: "x", authorizationRef: "SYN-E3" });
    const after = await readIssueCommentRunLogText({ runId: s.runA.id, companyId: s.company.id, logStore: "local_file", logRef, logBytes: 64 }, db);
    expect(after).toBe("");
  });
});
