import type { Db } from "@paperclipai/db";
import { tryAdvisoryXactLock } from "./advisory-locks.js";
import { isMultiReplicaDeployment } from "./native-runtime/native-restart-recovery.js";

export type SingletonSweepResult = { ran: boolean };

export interface SingletonSweepGuardOptions {
  onSkipped?: (name: string) => void;
}

/**
 * Cluster-wide single-flight for background sweeps that are not safe to run on
 * two replicas at once (execution-control reconcilers, GitHub poll, sandbox
 * cleanup, external-object refresh). Each sweep name maps to one advisory lock:
 * if another replica is already running that sweep, this one skips it and the
 * next interval covers it. The scheduler leader and traffic-only replicas
 * (HEARTBEAT_SCHEDULER_ENABLED=false) both go through the same guard, so the
 * flag never lets a second copy of a sweep run beside the leader's.
 *
 * Single replica: the lock is always free, behaviour is unchanged.
 */
export function createSingletonSweepGuard(db: Db, options: SingletonSweepGuardOptions = {}) {
  return async function runSingletonSweep(
    name: string,
    work: () => Promise<unknown>,
  ): Promise<SingletonSweepResult> {
    const outcome = await tryAdvisoryXactLock(db, `sweep:${name}`, async () => {
      await work();
    });
    if (!outcome.acquired) {
      options.onSkipped?.(name);
      return { ran: false };
    }
    return { ran: true };
  };
}

/**
 * Whether this replica may run singleton background sweeps at all. Scheduler
 * candidates always may (the lock still keeps two copies from overlapping). A
 * replica with HEARTBEAT_SCHEDULER_ENABLED=false serves traffic only when the
 * deployment is multi-replica (PAPERCLIP_MULTI_REPLICA=true); a lone replica
 * with the flag off keeps running them, as before this series.
 */
export function singletonSweepsAllowed(input: {
  schedulerEnabled: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return input.schedulerEnabled || !isMultiReplicaDeployment(input.env ?? process.env);
}
