import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createSingletonSweepGuard, singletonSweepsAllowed } from "../services/singleton-sweep.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("singleton sweep guard (HEARTBEAT_SCHEDULER_ENABLED=false, review M3)", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-singleton-sweep-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 120_000);

  it("runs a sweep on one replica at a time and skips it on the other", async () => {
    const guardA = createSingletonSweepGuard(dbA);
    const guardB = createSingletonSweepGuard(dbB);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inside!: () => void;
    const aInside = new Promise<void>((resolve) => (inside = resolve));
    const ran: string[] = [];

    const first = guardA("status_delivery", async () => {
      ran.push("a");
      inside();
      await gate;
    });
    await aInside;
    const skipped = await guardB("status_delivery", async () => {
      ran.push("b");
    });
    expect(skipped).toEqual({ ran: false });
    expect(ran).toEqual(["a"]);
    release();
    await first;

    const after = await guardB("status_delivery", async () => {
      ran.push("b");
    });
    expect(after).toEqual({ ran: true });
    expect(ran).toEqual(["a", "b"]);
  });

  it("does not make different sweeps contend", async () => {
    const guardA = createSingletonSweepGuard(dbA);
    const guardB = createSingletonSweepGuard(dbB);
    const result = await guardA("finalization", async () => guardB("replacement", async () => undefined));
    expect(result).toEqual({ ran: true });
  });

  it("releases the lock when the sweep throws, and rethrows", async () => {
    const guardA = createSingletonSweepGuard(dbA);
    const guardB = createSingletonSweepGuard(dbB);
    await expect(
      guardA("github_poll", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await guardB("github_poll", async () => undefined)).toEqual({ ran: true });
  });

  it("reports each skip to the caller-supplied hook", async () => {
    const skips: string[] = [];
    const guardA = createSingletonSweepGuard(dbA);
    const guardB = createSingletonSweepGuard(dbB, { onSkipped: (name) => skips.push(name) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inside!: () => void;
    const aInside = new Promise<void>((resolve) => (inside = resolve));
    const first = guardA("env_cleanup", async () => {
      inside();
      await gate;
    });
    await aInside;
    await guardB("env_cleanup", async () => undefined);
    release();
    await first;
    expect(skips).toEqual(["env_cleanup"]);
  });
});

describe("singletonSweepsAllowed (review M3 policy)", () => {
  it("a scheduler candidate always runs its sweeps", () => {
    expect(singletonSweepsAllowed({ schedulerEnabled: true, env: {} })).toBe(true);
    expect(singletonSweepsAllowed({ schedulerEnabled: true, env: { PAPERCLIP_MULTI_REPLICA: "true" } })).toBe(true);
  });

  it("with the scheduler off, a lone replica keeps its previous behaviour", () => {
    expect(singletonSweepsAllowed({ schedulerEnabled: false, env: {} })).toBe(true);
    expect(singletonSweepsAllowed({ schedulerEnabled: false, env: { PAPERCLIP_MULTI_REPLICA: "false" } })).toBe(true);
  });

  it("with the scheduler off in a multi-replica deployment, the replica serves traffic only", () => {
    expect(singletonSweepsAllowed({ schedulerEnabled: false, env: { PAPERCLIP_MULTI_REPLICA: "true" } })).toBe(false);
  });
});
