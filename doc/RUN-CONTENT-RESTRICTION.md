# Per-run content restriction and forensic grant

Status: implemented, **not activated by shipping the code**. Design of record:
HYBA-768 `restriction-design` rev `4df8b572-4838-46f6-920c-96c9597d1997`.

This control lets a custodian withhold the content of one heartbeat run
(`company_id`, `run_id`) from ordinary readers while preserving the originals,
and lets a separately authorised, named individual read them for a limited
time. It does not touch any other run.

## What it is

| Piece | Where |
| --- | --- |
| Tables and migration `0289_run_content_restrictions` | `packages/db/src/schema/run_content_restrictions.ts` |
| Decision, leases, fencing, activation, release, grants, egress | `server/src/services/run-content-gate.ts` |
| Route helpers (`serveRunContent`, `serveRunList`, `serveWorkspaceOperation*`, `denyRestrictedMutation`) | `server/src/routes/run-content-guard.ts` |
| Operator API (default off) | `server/src/routes/run-content-admin.ts` |
| Route inventory test | `server/src/__tests__/run-content/run-content-route-enumeration.test.ts` |

## State machine

`none -> restricting -> restricted -> releasing -> released`

* `restricting` and `restricted` deny ordinary content. `releasing` also denies.
* `released` and "no row" admit ordinary reads.
* Every transition advances `epoch`, writes `run_content_audit_events`
  (append-only by trigger) and keeps the row (delete is blocked by trigger).
* A missing run, a cross-company run, an unknown state, a policy version newer
  than the code, a database error, or an audit write failure **denies**.

## Admission barrier (activation)

1. Under an exclusive per-company advisory lock, the run moves to `restricting`
   and every open lease for that run is marked revoked. New leases for the run
   are refused on every instance (leases are taken under a shared lock).
2. Each holder (HTTP read, stream, download, egress job) holds a row in
   `run_content_leases` until its last byte. A holder checks its lease before
   its first emission and at each chunk or page boundary (`checkpoint()`), and
   `emit()` refuses to write once the lease is revoked, released, or past its
   local deadline (`ttl - clock skew`, measured on a monotonic clock).
   Each lease also arms a timer at its local deadline that aborts the lease
   signal, so a response that is already flushing is cut off without waiting for
   the next `emit()` or `checkpoint()`. A successful renewal re-arms the timer.
   If lease maintenance (the renewal tick) fails, for example because the
   database is unreachable, every held lease and the company watchers are fenced
   at once rather than left to run until their deadline.
3. Activation waits until every revoked lease has been **acknowledged**
   (released by its holder), reaped as expired (past `ttl + skew`, i.e. the holder
   cannot still be writing), or reaped because the holder restarted.
4. If this does not finish within `drainTimeoutMs`, activation returns
   `outcome: "incomplete"` (HTTP 409) and the run stays in `restricting`
   (readable by nobody). Retry the same call after diagnosing.
5. Live WebSocket clients hold a company watcher lease. It refreshes the
   restricted set on a short tick; a lapsed lease suppresses all run-bearing
   events (fail closed).
6. Only then are pre-issued capabilities inventoried (metadata only) and the run
   is committed `restricted`. Unrevokable capabilities are reported as
   `containment: "partial"` with the residual list.

The receipt always carries `storageCustody: "not_attested_by_server"`: the
server cannot prove object-store ACLs, backups, Sentry, or already-delivered
bytes. Those stay with the storage custodian.

## Forensic grants

A grant is a separate, audited, short-lived record: one named individual
(`user:<id>`), one run, listed operations, a purpose, an authorization
reference, and a TTL of at most 24 hours. Instance-admin is **not** a grant.
A grantee cannot self-issue. Each request and each chunk re-checks the grant;
revoke, expiry, or release fences active forensic streams. Forensic reads are
refused while the run is still `restricting`. The audit row stores byte count
and SHA-256, never content. Originals (DB rows, local NDJSON, S3 mirror, trace
sidecars) are never rewritten by this code, and retention cleanup skips a run
that is restricted (`isRunRetentionHeld`).

## Operating it

The operator API is mounted but **returns 404 unless**
`PAPERCLIP_RUN_CONTENT_ADMIN=enabled`. It requires an instance admin who is a
named human.

```
PUT    /api/companies/:companyId/heartbeat-runs/:runId/content-restriction
GET    /api/companies/:companyId/heartbeat-runs/:runId/content-restriction
DELETE /api/companies/:companyId/heartbeat-runs/:runId/content-restriction
POST   /api/companies/:companyId/heartbeat-runs/:runId/forensic-grants
GET    /api/companies/:companyId/heartbeat-runs/:runId/forensic-grants
DELETE /api/companies/:companyId/heartbeat-runs/:runId/forensic-grants/:grantId
GET    /api/companies/:companyId/heartbeat-runs/:runId/content-audit
```

Activation body: `{ "reasonCode", "authorizationRef", "drainTimeoutMs"? }`.
Release body: `{ "authorizationRef", "riskAcceptanceRef" }` (both required).

Tuning environment variables: `PAPERCLIP_INSTANCE_ID` (stable per pod),
`PAPERCLIP_RUN_CONTENT_LEASE_TTL_MS` (default 15000),
`PAPERCLIP_RUN_CONTENT_CLOCK_SKEW_MS` (default 2000).

## Rollback and disable

* **Release one run:** `DELETE .../content-restriction` with a risk-acceptance
  reference. This is a fenced reverse transition (`restricted -> releasing ->
  released`); it revokes forensic grants and leaves all history.
* **Turn the operator API off:** unset `PAPERCLIP_RUN_CONTENT_ADMIN`. Existing
  restrictions keep denying. Nothing is deleted.
* **Skip lease bookkeeping for unrestricted runs:**
  `PAPERCLIP_RUN_CONTENT_GATE_MODE=bypass_for_unrestricted`. Restricted runs
  still deny; only the lease table writes are skipped. Use it if lease writes
  are the problem, then restart. A restriction cannot be bypassed this way.
* **Remove the code:** deploy the previous image. Migration `0289` only adds
  tables, so it is additive; leaving the tables in place is safe. Do not drop
  `run_content_restrictions` or `run_content_audit_events` while any run is
  restricted, because that would silently reopen the run.
* Emergency recovery when the database is unavailable is an offline,
  custodian-controlled procedure, not an API fallback.

## Known limits (be explicit)

* Activation must only be requested when every instance runs in enforcing mode.
  An instance started in bypass mode creates no leases, so the barrier cannot
  see or drain its readers.
* `POST /heartbeat-runs/:runId/cancel` stays available for a restricted run and
  returns a metadata-only body (`id`, `companyId`, `createdAt`, `state`,
  `contentWithheld`, `status`) with `Cache-Control: no-store`, never the run row.

* Bytes served before activation are not recalled.
* Sentry, exports, backups, and S3 objects are outside the server's control.
  The server blocks new egress and records pre-issued capabilities it knows
  about; it does not enumerate capabilities issued by code that does not call
  `registerCapability`. Today no code path issues signed run-log links, so the
  S3 mirror is reachable only by principals with direct bucket access.
* Plugins and the runner process receive run data through their own channels;
  the plugin session stream is gated, other plugin reads are not run-content
  routes.
* A new content-bearing run route must be added to
  `AUDITED_ROUTES` in the enumeration test and use one of the guard helpers.
