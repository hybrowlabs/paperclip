import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  tryAdvisoryXactLock,
  trySessionAdvisoryLock,
  withAdvisoryXactLock,
} from "../services/advisory-locks.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("advisory locks", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;
  let connectionString = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-advisory-locks-");
    connectionString = tempDb.connectionString;
    dbA = createDb(connectionString);
    dbB = createDb(connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("withAdvisoryXactLock serializes critical sections across two clients", async () => {
    const order: string[] = [];
    // Deterministic latch: A's critical section resolves `aInside` as its
    // first statement, and the test waits on it before starting B — A is
    // guaranteed to hold the lock when B contends, with no timing sleep.
    let aInsideResolve!: () => void;
    const aInside = new Promise<void>((resolve) => (aInsideResolve = resolve));
    const first = withAdvisoryXactLock(dbA, "test-serialize", async () => {
      aInsideResolve();
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push("a-end");
    });
    await aInside;
    const second = withAdvisoryXactLock(dbB, "test-serialize", async () => {
      order.push("b-start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("tryAdvisoryXactLock skips when another client holds the lock", async () => {
    // Deterministic latch (same pattern as the serialization test): A's
    // critical section resolves `aInside` as its first statement, and the
    // test waits on it before B tries — A is guaranteed to hold the lock,
    // with no timing sleep.
    let aInsideResolve!: () => void;
    const aInside = new Promise<void>((resolve) => (aInsideResolve = resolve));
    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => (releaseA = resolve));
    const first = withAdvisoryXactLock(dbA, "test-skip", async () => {
      aInsideResolve();
      await held;
    });
    await aInside;
    const result = await tryAdvisoryXactLock(dbB, "test-skip", async () => "ran");
    expect(result).toEqual({ acquired: false });
    releaseA();
    await first;
    const after = await tryAdvisoryXactLock(dbB, "test-skip", async () => "ran");
    expect(after).toEqual({ acquired: true, result: "ran" });
  });

  it("releases the lock when the critical section throws", async () => {
    await expect(
      withAdvisoryXactLock(dbA, "test-error", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await tryAdvisoryXactLock(dbB, "test-error", async () => "ran");
    expect(after).toEqual({ acquired: true, result: "ran" });
  });

  it("different names do not contend", async () => {
    const result = await withAdvisoryXactLock(dbA, "name-one", async () =>
      tryAdvisoryXactLock(dbB, "name-two", async () => "ran"),
    );
    expect(result).toEqual({ acquired: true, result: "ran" });
  });

  it("trySessionAdvisoryLock holds across transactions until released", async () => {
    const lock = await trySessionAdvisoryLock(connectionString, "test-session");
    expect(lock.acquired).toBe(true);
    const contender = await trySessionAdvisoryLock(connectionString, "test-session");
    expect(contender.acquired).toBe(false);
    if (lock.acquired) await lock.release();
    const after = await trySessionAdvisoryLock(connectionString, "test-session");
    expect(after.acquired).toBe(true);
    if (after.acquired) await after.release();
  });

  it("does not deadlock a small pool when more locks are held than the pool has connections", async () => {
    const smallPool = createDb(connectionString, { maxConnections: 2 });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered = 0;
      let allEntered!: () => void;
      const everyoneInside = new Promise<void>((resolve) => (allEntered = resolve));
      const holders = ["pool-a", "pool-b", "pool-c", "pool-d"].map((name) =>
        tryAdvisoryXactLock(smallPool, `test-${name}`, async () => {
          entered += 1;
          if (entered === 4) allEntered();
          await gate;
          const rows = await smallPool.execute(sql`select 1 as one`);
          return rows.length;
        }),
      );
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("locks starved the shared pool: deadlock")), 10_000),
      );
      await Promise.race([everyoneInside, timeout]);
      release();
      const results = await Promise.race([Promise.all(holders), timeout]);
      expect(results.every((result) => result.acquired)).toBe(true);
      const blocking = await Promise.race([
        Promise.all(
          ["pool-e", "pool-f", "pool-g"].map((name) =>
            withAdvisoryXactLock(smallPool, `test-${name}`, async () => {
              const rows = await smallPool.execute(sql`select 1 as one`);
              return rows.length;
            }),
          ),
        ),
        timeout,
      ]);
      expect(blocking).toEqual([1, 1, 1]);
    } finally {
      await smallPool.$client.end({ timeout: 5 });
    }
  }, 30_000);

  it("keeps working for a Db that was not built by createDb", async () => {
    const wrapped = { transaction: dbA.transaction.bind(dbA) } as unknown as Db;
    const result = await tryAdvisoryXactLock(wrapped, "test-wrapped", async () => "ran");
    expect(result).toEqual({ acquired: true, result: "ran" });
  });
});
