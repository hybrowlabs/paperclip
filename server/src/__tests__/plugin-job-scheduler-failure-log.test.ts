import { describe, expect, it, vi } from "vitest";
import { buildJobFailureLogRow } from "../services/plugin-job-health.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

describe("buildJobFailureLogRow (HYBA-876)", () => {
  it("builds an error row with identifiers only", () => {
    const row = buildJobFailureLogRow({
      pluginId: PLUGIN_ID,
      jobId: JOB_ID,
      jobKey: "inbound-poll",
      runId: RUN_ID,
      trigger: "schedule",
      durationMs: 12,
      error: "not allowed to perform \"companies.list\"",
    });
    expect(row).toMatchObject({
      pluginId: PLUGIN_ID,
      companyId: null,
      level: "error",
      meta: { jobId: JOB_ID, jobKey: "inbound-poll", runId: RUN_ID, trigger: "schedule" },
    });
    expect(row.message).toContain("inbound-poll");
    expect(row.message).toContain("companies.list");
  });

  it("truncates a very long error", () => {
    const row = buildJobFailureLogRow({
      pluginId: PLUGIN_ID,
      jobId: JOB_ID,
      jobKey: "k",
      trigger: "manual",
      durationMs: 1,
      error: "x".repeat(5_000),
    });
    expect(row.message.length).toBeLessThan(400);
  });
});

function makeScheduler(callError: Error, insertFails = false) {
  const inserted: unknown[] = [];
  const insertValues = vi.fn(async (row: unknown) => {
    if (insertFails) throw new Error("db down");
    inserted.push(row);
  });
  const db = {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  };
  const job = {
    id: JOB_ID,
    pluginId: PLUGIN_ID,
    jobKey: "inbound-poll",
    status: "active",
    schedule: "*/5 * * * *",
    nextRunAt: null,
  };
  const completeRun = vi.fn(async () => undefined);
  const jobStore = {
    getJobById: vi.fn(async () => job),
    createRun: vi.fn(async () => ({ id: RUN_ID })),
    markRunning: vi.fn(async () => undefined),
    completeRun,
  };
  const workerManager = {
    isRunning: () => true,
    call: vi.fn(async () => {
      throw callError;
    }),
  };
  const scheduler = createPluginJobScheduler({
    db: db as never,
    jobStore: jobStore as never,
    workerManager: workerManager as never,
  });
  return { scheduler, inserted, completeRun };
}

describe("plugin job scheduler failure visibility (HYBA-876)", () => {
  it("writes an error row to plugin_logs when a manual run fails", async () => {
    const { scheduler, inserted, completeRun } = makeScheduler(
      new Error("not allowed to perform \"companies.list\""),
    );
    await scheduler.triggerJob(JOB_ID, "manual");
    await vi.waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      level: "error",
      meta: { jobKey: "inbound-poll", runId: RUN_ID, trigger: "manual" },
    });
    expect(completeRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: "failed" }));
  });

  it("still marks the run failed when the plugin_logs write itself fails", async () => {
    const { scheduler, completeRun } = makeScheduler(new Error("boom"), true);
    await scheduler.triggerJob(JOB_ID, "manual");
    await vi.waitFor(() =>
      expect(completeRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: "failed" })),
    );
  });
});
