# Hybrow fork: multi-replica scale-out (Phase A)

This fork (`hybrowlabs/paperclip`) carries a small patch series that lets
Paperclip run on **2 or more server replicas** against one Postgres. It is
maintained by Hybrow Labs and rebased on `paperclipai/paperclip` every month.
Upstream is MIT-licensed; every ported patch keeps its original author.

Tracking: HYBA-1317 (this series), HYBA-1291 (architecture review and the
board's decision to keep a fork), HYBA-1316 (independent check).

## What Phase A does, and what it does not

Phase A makes extra replicas **safe**. Each of these used to break with more
than one server:

| Problem with more than one replica | Fixed by |
|---|---|
| Every replica ran every scheduler sweep | Patch 2 and 3: one elected scheduler leader |
| Two replicas migrated the schema at the same time on boot | Patch 1: migration advisory lock |
| Backups and plugin jobs ran once per replica | Patch 1: backup lock, atomic plugin-job slot claim |
| The same webhook delivery was dispatched twice | Patch 1: delivery dedupe (migration 0296) |
| The per-agent start lock was in memory, so two replicas overran an agent's concurrency | Patch 1: Postgres advisory try-lock |
| A live event on replica A never reached a browser on replica B | Patch 5: Postgres `LISTEN/NOTIFY` |
| A slow tick was followed by a second tick that stacked on it | Patch 4: tick overlap guard |

### Known limit: agent runs stay on the replica that claimed them

Phase A does **not** move agent runs between replicas. A run executes as a
child process on the replica that claimed it, and its liveness is checked by
local process id. If that replica dies, its runs are recovered by the scheduler
leader the same way a single-server restart recovers them (orphan reaping and
retry), not handed over live. Spreading runs across replicas, with
`SKIP LOCKED` claims and lease-based liveness, is **Phase B**
(upstream issue paperclipai/paperclip#7997) and is not part of this series.
Plugin worker processes and plugin artifacts are also per replica
(upstream issue #7996); do not rely on a plugin being installed on only one
replica.

Because of this limit, scaling replicas up spreads **API and WebSocket load**.
It does not by itself spread agent CPU. Move agent CPU off the API pods with the
built-in Kubernetes sandbox execution mode (`PAPERCLIP_EXECUTION_MODE=kubernetes`),
which is configuration, not part of this series.

## Patch list

Each patch is one commit (or a short run of commits) so the monthly rebase can
drop or re-resolve them one at a time. Commit subjects start with
`feat(scale-out)` or `fix(scale-out)`. The `Upstream-Source:` trailer in each
commit message names the upstream PR.

| # | Commit subject | Upstream source | Migration | Rebase risk |
|---|---|---|---|---|
| 0 | `test(scale-out): multi-replica acceptance suite` | New in this fork | none | Low (new files) |
| 1 | `feat(scale-out): cross-replica coordination via Postgres advisory locks` | [paperclipai/paperclip#7993](https://github.com/paperclipai/paperclip/pull/7993), by Jannes Stubbemann (closed, not merged) | `0296_plugin_webhook_delivery_dedup` | High: touches `heartbeat.ts` (`startNextQueuedRunForAgent`), `index.ts` (backup), `company-skills.ts`, `plugin-job-scheduler.ts` |
| 2 | `feat(scale-out): scheduler_leader lease and leader election service` | [#7995](https://github.com/paperclipai/paperclip/pull/7995), by Jannes Stubbemann (closed, not merged) | `0297_scheduler_leader` | Low (new files) plus `routes/health.ts` |
| 3 | `feat(scale-out): run the heartbeat scheduler only on the elected leader` | #7995, re-wired by hand; includes the Greptile must-fix (recovery completes before the tick timer starts) | none | **Highest**: `server/src/index.ts` scheduler body and shutdown |
| 4 | `fix(scale-out): never start a scheduler tick while the previous one runs` | New in this fork (scale-out review, Phase 1) | none | Low (`scheduler-runtime.ts`) |
| 5 | `feat(scale-out): cross-replica live events over Postgres LISTEN/NOTIFY` | [#5875](https://github.com/paperclipai/paperclip/pull/5875), by Jannes Stubbemann (closed, not merged), without its Redis transport | none | Medium: `services/live-events.ts`, `index.ts`, `routes/health.ts` |

Migration numbers `0296` and `0297` are this fork's. Upstream numbered the same
files `0102` and `0100`/`0103`. When upstream adds migrations, renumber ours
after theirs (see the runbook).

### Differences from the upstream PRs

- The Redis live-events transport from #5875 is **not** carried. Postgres only:
  no new infrastructure, smaller fork.
- #7995's `/api/health` ran a lease query on every probe. Here the
  unauthenticated probe reports `scheduler: { candidate, isLeader }` from process
  memory and never queries the database; the lease row (leader id, host,
  expiry) appears only in the authenticated full view.
- Lease renewal keeps running while the new leader's startup recovery is still
  in progress. Recovery can take longer than the 15 s lease, and without this a
  second replica would take over and repeat it.
- `subscribeAllCompanyLiveEvents` (fork master has it, #5875 predates it) is
  process-local on purpose. Its consumers are best-effort fast paths over
  durable sweeps that the leader runs.

## Environment settings for a multi-replica deployment

### Required rules

1. **External Postgres.** Do not run the embedded database with more than one
   replica. Use a managed or in-cluster Postgres that all replicas reach.
2. **Shared object storage.** Set `PAPERCLIP_STORAGE_PROVIDER=s3` plus
   `PAPERCLIP_STORAGE_S3_BUCKET`, `PAPERCLIP_STORAGE_S3_REGION` (and
   `PAPERCLIP_STORAGE_S3_ENDPOINT` / `PAPERCLIP_STORAGE_S3_PREFIX` if needed).
   Local-disk attachments exist on one pod only.
3. **Shared secrets.** Use a shared secrets provider (for example the AWS
   Secrets Manager provider) or the same `PAPERCLIP_SECRETS_MASTER_KEY` on every
   replica. A per-pod local master key makes secrets unreadable on the others.
4. **Same signing and auth secrets on every replica**:
   `PAPERCLIP_AGENT_JWT_SECRET`, `BETTER_AUTH_SECRET`,
   `PAPERCLIP_DECISION_SIGNING_SECRET`, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`.
5. **Run-log mirror.** Set `RUN_LOG_S3_BUCKET` (and region/endpoint) so run logs
   survive a pod and can be read from any replica.
6. **Behind PgBouncer in transaction mode**, set `DATABASE_PREPARED_STATEMENTS=false`
   on every replica. Keep the pool small enough that
   `replicas * DATABASE_POOL_MAX` fits the pooler and Postgres `max_connections`.
7. **Use a direct (non-pooled) path for the session-level features** when
   `DATABASE_URL` is a transaction-mode pooler. Transaction pooling breaks
   three things, and they use different settings:
   - **Migrations:** set `DATABASE_MIGRATION_URL` to the direct URL. The
     migration lock is a session lock on a dedicated connection to that URL.
   - **Live events (`LISTEN`):** the transport uses
     `PAPERCLIP_LIVE_EVENTS_DATABASE_URL`, then `DATABASE_MIGRATION_URL`, then
     `DATABASE_URL`. Set one of the first two to the direct URL, or events will
     not be delivered across replicas.
   - **Database backups:** the backup lock and `pg_dump` use `DATABASE_URL`
     as given. Behind a transaction-mode pooler, either point
     `DATABASE_URL` at a session-mode pool, or turn the in-app backup off
     (`PAPERCLIP_DB_BACKUP_ENABLED=false`) and back up at the database layer
     (managed snapshots). Do not run the in-app backup through
     transaction pooling.
8. **Sticky sessions are not required for correctness.** WebSockets work from any
   replica because events fan out over Postgres. Stickiness only avoids
   reconnect churn.
9. **Probe `/api/health`** for readiness. Its `scheduler` block shows which pod
   is the leader (`isLeader: true`).

### Settings added or changed by this series

| Variable | Default | Meaning |
|---|---|---|
| `HEARTBEAT_SCHEDULER_ENABLED` | `true` | Be a candidate for scheduler leader. `false` means **serve traffic only, never become leader**. |
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | `30000` (min `10000`) | Tick interval on the leader. A new tick never starts while the previous one is still running. |
| `PAPERCLIP_LIVE_EVENTS_TRANSPORT` | `postgres` | `postgres` or `off` (in-process only; multi-replica UIs go stale). |
| `PAPERCLIP_LIVE_EVENTS_DATABASE_URL` | unset | Direct connection string for `LISTEN`. Falls back to `DATABASE_MIGRATION_URL`, then `DATABASE_URL`. |

Single replica: nothing to set. The lone replica becomes leader on its first
pass at boot and behaviour is unchanged.

### Suggested starting shape

- 2 API replicas with `HEARTBEAT_SCHEDULER_ENABLED=true` (either may lead; the
  other is a standby that takes over in about 15 s after a crash or within a few
  seconds after a graceful stop).
- Add traffic-only replicas with `HEARTBEAT_SCHEDULER_ENABLED=false` if you want
  replicas that can never become leader.
- Pod disruption budget `minAvailable: 1`, rolling update `maxUnavailable: 0`.

## Rollback

Rollback is a deployment action, not a data migration. The two new tables and
the dedupe index are additive and harmless to older code.

1. Scale the Deployment back to **1 replica**
   (`kubectl scale deployment/paperclip --replicas=1`).
2. Redeploy the **previous image digest** (the digest recorded in the release
   task before the rollout; never a mutable tag).
3. Verify: `/api/health` returns `ok`, one pod serves traffic, and the agent
   runs resume (the single pod runs recovery at boot as before).
4. Leave the `scheduler_leader` table and migrations `0296`/`0297` in place.
   Older code ignores them. Do not drop them as part of a rollback.

Rolling back **only** this series on a fork rebuild (drop the patches): the
migrations stay applied in the database; ship a later image that still contains
`0296` and `0297` in its journal, or the older image will refuse to start on an
unknown applied migration if upstream ever enforces journal equality. Prefer the
image-digest rollback above.

## Tests

The acceptance suite starts real server processes against one real Postgres:

```
pnpm run preflight:workspace-links
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm exec vitest run \
  server/src/__tests__/multi-replica-cluster.test.ts \
  server/src/__tests__/agent-start-lock-cross-replica.test.ts \
  server/src/__tests__/scheduler-leadership.test.ts \
  server/src/__tests__/scheduler-runtime.test.ts \
  server/src/__tests__/live-events-cross-replica.test.ts \
  server/src/__tests__/live-events-envelopes.test.ts \
  server/src/__tests__/plugin-job-scheduler-claim.test.ts \
  server/src/__tests__/plugin-webhook-dedup.test.ts \
  server/src/__tests__/advisory-locks.test.ts \
  server/src/__tests__/health-scheduler.test.ts \
  packages/db/src/migration-lock.test.ts \
  --testTimeout=600000 --hookTimeout=200000
```

Run with `NODE_ENV` unset or `development` (not `production`, which skips dev
dependencies on install). The cluster test needs about 2 GB of memory and
several minutes on 4 vCPU because each replica is a full server process.

| Acceptance item | Test |
|---|---|
| (a) one leader, failover on graceful stop and on crash | `multi-replica-cluster.test.ts` (a); `scheduler-leadership.test.ts` |
| (a) `HEARTBEAT_SCHEDULER_ENABLED=false` never leads | `multi-replica-cluster.test.ts` (a) |
| (b) event on replica A reaches a WebSocket on replica B | `multi-replica-cluster.test.ts` (b); `live-events-cross-replica.test.ts` |
| (c) concurrent boot applies migrations once | `multi-replica-cluster.test.ts` (c); `migration-lock.test.ts` |
| (d) backups do not run twice | `multi-replica-cluster.test.ts` (d) |
| (d) plugin jobs do not run twice | `plugin-job-scheduler-claim.test.ts` |
| (e) agent-start lock across replicas | `agent-start-lock-cross-replica.test.ts` |
| Tick does not start before recovery; no overlapping ticks | `scheduler-runtime.test.ts` |

## Monthly upstream sync runbook

Owner: Forge (a monthly routine creates the task). Reviewer: Nova. Checker:
Sentinel. Approver: Rez. Merge: Forge after approval at the approved head.

Goal: keep the fork a thin, current patch series on top of upstream.

1. **Open the sync task** (the routine does this). Record the upstream `master`
   SHA you are syncing to and the current fork `master` SHA.
2. **Check whether upstream already shipped an equivalent change.** For each
   patch in the table, search upstream `master` for the same feature
   (`git log upstream/master --grep` for "advisory lock", "scheduler leader",
   "LISTEN/NOTIFY", and read `server/src/services/` for equivalents). If
   upstream merged an equivalent, **drop our patch** and delete its row, its
   doc, and any tests that only cover it. Keep the acceptance suite tests; they
   must still pass against upstream's implementation.
3. **Branch and rebase.**
   ```
   git fetch upstream origin
   git checkout -b sync/YYYY-MM origin/master
   git rebase upstream/master
   ```
   The fork's `master` also carries Hybrow-only commits (recovery, dispatch
   checkpoints). Rebase them too; do not squash patches together.
4. **Resolve conflicts patch by patch.** Expected hotspots, in order of risk:
   `server/src/index.ts` (scheduler body, shutdown), `server/src/services/heartbeat.ts`
   (`startNextQueuedRunForAgent`), `server/src/services/live-events.ts`,
   `server/src/routes/health.ts`, `server/src/services/plugin-job-scheduler.ts`.
   Keep each patch in its own commit. Never take "theirs" blindly on `index.ts`:
   re-check that startup recovery still completes **before** the tick timer
   starts and that shutdown resigns leadership first.
5. **Renumber migrations.** If upstream added migrations after `0295`, renumber
   `0296_plugin_webhook_delivery_dedup` and `0297_scheduler_leader` after
   upstream's highest number, update `meta/_journal.json` (idx, tag, a `when`
   later than the previous entry) and run
   `pnpm --filter @paperclipai/db run check:migrations`. Never edit a migration
   that has already shipped in a released image; add a new one.
6. **Re-run the checks.**
   - the multi-replica suite (the command in "Tests");
   - the existing server and db suites touched by the conflicts;
   - `pnpm --filter @paperclipai/server exec tsc --noEmit -p tsconfig.json`
     (server typecheck; known unrelated errors, if any, are listed in the task);
   - the Jenkins job `paperclip/paperclip-pr-ci` on `cicd.caprover.hybrowlabs.com`
     at the exact head SHA (Atlas runs it; record the build id).
7. **Open a PR** from `sync/YYYY-MM` to `master` with: upstream SHA, patches
   kept/dropped/renumbered, conflict notes, test evidence, Jenkins build id.
   Move the independent check task to `todo` with the PR number and head SHA.
8. **Do not force-push `master`.** The sync lands as a normal reviewed PR. The
   rollback for a bad sync is the previous image digest.
9. **Close the task** only after review PASS, checker PASS on the same head, and
   approval. Then merge at the approved head.

### Drop-a-patch rule

When upstream merges an equivalent change, remove ours in the same sync PR.
Keep the commit that removes it separate so the history shows why.

### What not to do in a sync

- Do not carry a patch just because it was ours first.
- Do not add Phase B or plugin-artifact work to a sync PR; those are separate
  tasks.
- Do not enable GitHub Actions on the fork (upstream workflows publish images).
