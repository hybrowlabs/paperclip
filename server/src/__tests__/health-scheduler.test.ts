import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  getSchedulerHealth: vi.fn(),
  getLocalSchedulerHealth: vi.fn(),
}));

vi.mock("../services/scheduler-leadership.js", () => ({
  getSchedulerHealth: mocks.getSchedulerHealth,
  getLocalSchedulerHealth: mocks.getLocalSchedulerHealth,
  registerSchedulerLeadershipForHealth: vi.fn(),
  getRegisteredSchedulerLeadership: vi.fn().mockReturnValue(null),
}));

import { healthRoutes } from "../routes/health.js";

function appFor(deploymentMode: "local_trusted" | "authenticated", actor: "none" | "board", db: Db) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: actor, source: actor === "none" ? "none" : "session" };
    next();
  });
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode,
      deploymentExposure: deploymentMode === "authenticated" ? "public" : "private",
      authReady: true,
      companyDeletionEnabled: false,
    }),
  );
  return app;
}

describe("GET /health scheduler leadership", () => {
  const execute = vi.fn();
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([{ count: 1 }]),
    })),
  }));
  const db = { execute, select } as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue([{ "?column?": 1 }]);
    mocks.getLocalSchedulerHealth.mockReturnValue({ candidate: true, isLeader: true });
    mocks.getSchedulerHealth.mockResolvedValue({
      candidate: true,
      isLeader: true,
      leader: { leaderId: "pod-a", hostname: "host-a", electedAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:00:15.000Z" },
    });
  });

  it("redacted probe reports booleans from process memory and never queries the lease table", async () => {
    const res = await request(appFor("authenticated", "none", db)).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.scheduler).toEqual({ candidate: true, isLeader: true });
    expect(res.body.scheduler).not.toHaveProperty("leader");
    expect(mocks.getSchedulerHealth).not.toHaveBeenCalled();
    expect(mocks.getLocalSchedulerHealth).toHaveBeenCalledTimes(1);
  });

  it("full view includes the lease row for authenticated board callers", async () => {
    const res = await request(appFor("authenticated", "board", db)).get("/health");

    expect(res.status).toBe(200);
    expect(mocks.getSchedulerHealth).toHaveBeenCalledWith(db);
    expect(res.body.scheduler.leader).toEqual(expect.objectContaining({ leaderId: "pod-a" }));
  });

  it("full view falls back to the local booleans when the lease lookup fails", async () => {
    mocks.getSchedulerHealth.mockRejectedValue(new Error("db down"));

    const res = await request(appFor("authenticated", "board", db)).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.scheduler).toEqual({ candidate: true, isLeader: true });
  });
});
