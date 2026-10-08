import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_A = "22222222-2222-4222-8222-222222222222";

function failedRuns(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `run-${i}`,
    jobId: JOB_A,
    status: "failed",
    trigger: "schedule",
    error: "not allowed to perform \"companies.list\"",
    durationMs: 5,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 4, 12, 0) - i * 60_000),
  }));
}

async function createApp(runs: unknown[]) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
    lastError: null,
    manifestJson: { id: "paperclip.example" },
  });
  const jobDeps = {
    jobStore: {
      listRunsByPlugin: vi.fn(async () => runs),
      listJobs: vi.fn(async () => [{ id: JOB_A, jobKey: "inbound-poll" }]),
    },
    scheduler: {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    } as never;
    next();
  });
  app.use("/api", pluginRoutes({} as never, { installPlugin: vi.fn() } as never, jobDeps as never));
  app.use(errorHandler);
  return app;
}

describe.sequential("plugin health shows scheduled job failures (HYBA-876)", () => {
  it("reports unhealthy when status is ready, last_error is null and every job run failed", async () => {
    const app = await createApp(failedRuns(5));
    const res = await request(app).get(`/api/plugins/${PLUGIN_ID}/health`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.lastError).toBeUndefined();
    expect(res.body.healthy).toBe(false);
    const check = res.body.checks.find((c: { name: string }) => c.name === "scheduled_jobs");
    expect(check).toMatchObject({ passed: false });
    expect(check.message).toContain("inbound-poll");
  }, 20_000);

  it("stays healthy when jobs are not failing repeatedly", async () => {
    const app = await createApp(failedRuns(2));
    const res = await request(app).get(`/api/plugins/${PLUGIN_ID}/health`);
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
    expect(res.body.checks.find((c: { name: string }) => c.name === "scheduled_jobs")).toBeUndefined();
  }, 20_000);

  it("shows the same failure on the dashboard", async () => {
    const app = await createApp(failedRuns(4));
    const res = await request(app).get(`/api/plugins/${PLUGIN_ID}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.health.healthy).toBe(false);
    expect(res.body.health.checks.some((c: { name: string; passed: boolean }) => c.name === "scheduled_jobs" && !c.passed)).toBe(true);
  }, 20_000);
});
