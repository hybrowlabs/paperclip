import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../middleware/logger.js";

export interface TickScope {
  track(work: Promise<unknown>): void;
  run(fn: () => void | Promise<void>): Promise<void>;
}

export function createTickScope(): TickScope {
  const storage = new AsyncLocalStorage<Set<Promise<void>>>();

  return {
    track(work) {
      const tracked = storage.getStore();
      if (!tracked) return;
      const settled: Promise<void> = Promise.resolve(work)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          tracked.delete(settled);
        });
      tracked.add(settled);
    },
    async run(fn) {
      const tracked = new Set<Promise<void>>();
      let failure: { error: unknown } | null = null;
      await storage.run(tracked, async () => {
        try {
          await fn();
        } catch (error) {
          failure = { error };
        }
        while (tracked.size > 0) {
          await Promise.allSettled([...tracked]);
        }
      });
      if (failure) throw (failure as { error: unknown }).error;
    },
  };
}

export interface LeaderSchedulerOptions {
  intervalMs: number;
  recover: () => Promise<void>;
  tick: () => Promise<void>;
  onTickSkipped?: () => void;
  onTickError?: (err: unknown) => void;
}

export interface LeaderScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createLeaderScheduler(opts: LeaderSchedulerOptions): LeaderScheduler {
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let starting = false;
  let tickInFlight: Promise<void> | null = null;

  const onTickSkipped =
    opts.onTickSkipped ??
    (() => {
      logger.warn(
        { intervalMs: opts.intervalMs },
        "heartbeat scheduler tick skipped: previous tick still running; sweeps are slower than the tick interval",
      );
    });
  const onTickError =
    opts.onTickError ??
    ((err: unknown) => {
      logger.error({ err }, "heartbeat scheduler tick failed");
    });

  function fire() {
    if (tickInFlight) {
      onTickSkipped();
      return;
    }
    const current = Promise.resolve()
      .then(() => opts.tick())
      .catch(onTickError)
      .finally(() => {
        if (tickInFlight === current) tickInFlight = null;
      });
    tickInFlight = current;
  }

  return {
    async start() {
      if (running || starting) return;
      starting = true;
      generation += 1;
      const mine = generation;
      try {
        await opts.recover();
      } finally {
        starting = false;
      }
      if (mine !== generation) return;
      running = true;
      timer = setInterval(fire, opts.intervalMs);
      timer.unref?.();
    },
    async stop() {
      generation += 1;
      starting = false;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const inFlight = tickInFlight;
      if (inFlight) await inFlight;
    },
    isRunning() {
      return running;
    },
  };
}
