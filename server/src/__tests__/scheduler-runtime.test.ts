import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeaderScheduler, createTickScope } from "../services/scheduler-runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("leader scheduler runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start the tick timer until the recovery chain has finished", async () => {
    const recovery = deferred();
    const tick = vi.fn(async () => {});
    const scheduler = createLeaderScheduler({ intervalMs: 1_000, recover: () => recovery.promise, tick });

    const started = scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
    expect(scheduler.isRunning()).toBe(false);

    recovery.resolve();
    await started;
    expect(scheduler.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await scheduler.stop();
  });

  it("never starts the tick timer when recovery fails, and reports the failure to the caller", async () => {
    const tick = vi.fn(async () => {});
    const scheduler = createLeaderScheduler({
      intervalMs: 1_000,
      recover: async () => {
        throw new Error("recovery boom");
      },
      tick,
    });

    await expect(scheduler.start()).rejects.toThrow("recovery boom");
    expect(scheduler.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("keeps ticking after a tick fails", async () => {
    const onTickError = vi.fn();
    const tick = vi.fn(async () => {
      if (tick.mock.calls.length === 1) throw new Error("tick boom");
    });
    const scheduler = createLeaderScheduler({ intervalMs: 1_000, recover: async () => {}, tick, onTickError });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onTickError).toHaveBeenCalledTimes(1);

    await scheduler.stop();
  });

  it("stops ticking on stop() and reruns recovery when started again (failover back)", async () => {
    const recover = vi.fn(async () => {});
    const tick = vi.fn(async () => {});
    const scheduler = createLeaderScheduler({ intervalMs: 1_000, recover, tick });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await scheduler.start();
    expect(recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("does not start the timer when stop() arrives while recovery is still running", async () => {
    const recovery = deferred();
    const tick = vi.fn(async () => {});
    const scheduler = createLeaderScheduler({ intervalMs: 1_000, recover: () => recovery.promise, tick });

    const started = scheduler.start();
    await scheduler.stop();
    recovery.resolve();
    await started;

    expect(scheduler.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("start() is idempotent while running", async () => {
    const recover = vi.fn(async () => {});
    const scheduler = createLeaderScheduler({ intervalMs: 1_000, recover, tick: async () => {} });
    await scheduler.start();
    await scheduler.start();
    expect(recover).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

describe("tick scope", () => {
  it("resolves only after every promise tracked inside the scope, including late ones, has settled", async () => {
    const scope = createTickScope();
    const early = deferred();
    const late = deferred();
    let finished = false;

    const run = scope
      .run(async () => {
        scope.track(early.promise);
        await Promise.resolve();
        await Promise.resolve();
        scope.track(late.promise);
      })
      .then(() => {
        finished = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);

    early.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);

    late.reject(new Error("ignored"));
    await run;
    expect(finished).toBe(true);
  });

  it("ignores promises tracked outside any scope and isolates concurrent scopes", async () => {
    const scope = createTickScope();
    scope.track(new Promise(() => {}));

    const a = deferred();
    const b = deferred();
    let aDone = false;
    const runA = scope.run(async () => scope.track(a.promise)).then(() => {
      aDone = true;
    });
    const runB = scope.run(async () => scope.track(b.promise));

    b.resolve();
    await runB;
    expect(aDone).toBe(false);
    a.resolve();
    await runA;
    expect(aDone).toBe(true);
  });
});
