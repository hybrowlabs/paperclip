# Warden recipient runner (offline primitive, HYBA-767)

Dedicated, no-model, single-recipe recipient lease. It is not wired to a route, scheduler, heartbeat or provider `execute`; nothing here runs until a server adapter implements the ports below and a deployment/grant gate is passed.

## Trust boundary

- Input: `{selector:"warden-uat-aws", issueId, grantId, expectedConfigRevision}` only (strict schema). No command, script, secret ref, AWS target, agent id or model text.
- Order: schema -> runner config (kubernetes/job/cilium only; no local/ssh/sandbox-cr fallback) -> `RecipientPreflightPort` (actor/run, issue, recipient, current revision, environment driver) -> image digest/allow-list -> atomic `GrantPort.consume` (one-use, expiry) -> `DeliveryPort` (normal recipient binding delivery; exactly `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) -> optional values-free `AliasProjectionPort` -> lease.
- Every denial happens before any Kubernetes object or credential projection exists.
- Lease = per-check CiliumNetworkPolicy + per-check Secret + Job (one container, fixed command, digest-pinned image, non-root, read-only rootfs, no SA token, no host namespaces, secrets only via `secretKeyRef`).
- Egress: Cilium FQDN policy for `sts|codebuild|eks.ap-south-2.amazonaws.com:443` plus DNS restricted to those names; no paperclip-server, CIDR, entity or wildcard rule. Before the Job exists, `verifyEffectiveEgress` lists NetworkPolicy, CiliumNetworkPolicy and CiliumClusterwideNetworkPolicy; any other policy that selects the pod labels (or uses `matchExpressions`) and adds egress, a missing/modified own policy, or a listing failure aborts with no Job.
- Result: only the pod termination message (<=512 bytes, strict schema, check-id bound). Pod logs, exec and SDK payloads are never read. Reduced to four predicates + overall; any failure to prove -> INCONCLUSIVE; FAIL only for verified negative.
- Teardown on success, error, timeout, cancellation, and creation failure: delete Job, pods, Secret, policy, then read back absence; the attestation reports `destroyVerifiedAbsent`. A failed teardown can never be PASS. `sweepExpiredRecipientLeases` removes leases orphaned by a server crash.
- Audit events: denied, grant_consumed, lease_created, egress_verified, run_finished, lease_destroyed|lease_destroy_failed (ids only, no values).

## Not included (separate work)

- Server adapters for the four ports (grant store, preflight against agent config revisions, delivery, metadata projection) and the route. Alias predicate is INCONCLUSIVE without `AliasProjectionPort` or without metadata authority.
- Runtime image containing `pod-main.js` (build/registry push not authorized here).
- Proof against a live cluster: needs a Cilium-enabled namespace; policies are verified by manifest/listing, not by live traffic.

## Rollback

Delete this directory and `test/unit/warden-recipient`; nothing else is modified.
