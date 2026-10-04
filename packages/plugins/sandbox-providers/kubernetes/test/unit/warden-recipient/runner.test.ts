import { describe, expect, it, vi } from "vitest";
import {
  CheckDenied,
  WARDEN_RECIPE,
  type GrantPort,
  startRecipientLeaseSweeper,
  runWardenRecipientCheck,
  sweepExpiredRecipientLeases,
  buildWardenRecipientEgressPolicy,
  type AuditEvent,
  type GrantOutcome,
  type RunnerDeps,
} from "../../../src/warden-recipient/index.js";

const CHECK_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const SENTINEL = "sentinel-agent";
const WARDEN = "warden-agent";
const SECRET_AK = "AKIA_SYNTHETIC_ACCESS_KEY_VALUE";
const SECRET_SK = "synthetic-secret-key-value-do-not-leak";
const IMAGE = `registry.example/warden-recipient@sha256:${"a".repeat(64)}`;
const POD_NAME = "wr-pod-1";

const actor = { agentId: SENTINEL, runId: "run-1", companyId: "company-1" };
const request = { selector: "warden-uat-aws", issueId: ISSUE, grantId: GRANT, expectedConfigRevision: "rev-7" };

const notFound = () => Object.assign(new Error("nf"), { code: 404 });

function podResult(overrides: Record<string, string> = {}) {
  return JSON.stringify({
    v: 1,
    recipe: WARDEN_RECIPE.version,
    checkId: CHECK_ID,
    expectedPrincipalMatch: "PASS",
    codebuildProjectFound: "PASS",
    eksClusterActive: "PASS",
    ...overrides,
  });
}

interface World {
  deps: RunnerDeps;
  audit: AuditEvent[];
  calls: string[];
  state: { job: boolean; secret: boolean; policy: boolean; pods: number };
  clients: any;
  grants: Set<string>;
}

function makeWorld(opts: {
  grantOutcome?: GrantOutcome;
  target?: Partial<{ recipientAgentId: string; currentConfigRevision: string; checkerAgentId: string; checkerRunId: string; issueId: string; environmentDriver: string }> | null;
  podMessage?: string | undefined;
  jobPhase?: "Succeeded" | "Failed" | "Running";
  extraEgressNetworkPolicies?: any[];
  extraCilium?: any[];
  extraClusterwide?: any[];
  deleteFails?: boolean;
  config?: Partial<RunnerDeps["config"]>;
  env?: Record<string, string> | null;
  aliasProjection?: unknown;
  deliveryThrows?: boolean;
  nowStep?: number;
} = {}): World {
  const audit: AuditEvent[] = [];
  const calls: string[] = [];
  const state = { job: false, secret: false, policy: false, pods: 0 };
  let policyBody: any = null;
  let t = Date.parse("2026-10-04T12:00:00Z");
  const consumed = new Set<string>();
  const clients: any = {
    custom: {
      createNamespacedCustomObject: vi.fn(async ({ body }: any) => { calls.push("policy.create"); state.policy = true; policyBody = body; }),
      listNamespacedCustomObject: vi.fn(async () => ({ items: [...(state.policy ? [policyBody] : []), ...(opts.extraCilium ?? [])] })),
      listClusterCustomObject: vi.fn(async () => ({ items: opts.extraClusterwide ?? [] })),
      deleteNamespacedCustomObject: vi.fn(async () => { calls.push("policy.delete"); if (opts.deleteFails) throw new Error("boom"); state.policy = false; }),
      getNamespacedCustomObject: vi.fn(async () => { if (!state.policy) throw notFound(); return policyBody; }),
    },
    networking: {
      listNamespacedNetworkPolicy: vi.fn(async () => ({ items: opts.extraEgressNetworkPolicies ?? [] })),
    },
    core: {
      createNamespacedSecret: vi.fn(async () => { calls.push("secret.create"); state.secret = true; }),
      deleteNamespacedSecret: vi.fn(async () => { calls.push("secret.delete"); if (opts.deleteFails) throw new Error("boom"); state.secret = false; }),
      readNamespacedSecret: vi.fn(async () => { if (!state.secret) throw notFound(); return {}; }),
      deleteCollectionNamespacedPod: vi.fn(async () => { calls.push("pods.delete"); state.pods = 0; }),
      listNamespacedPod: vi.fn(async () => ({
        items: state.pods > 0 || opts.jobPhase ? [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }].slice(0, state.pods || (state.job ? 1 : 0)) : [],
      })),
      readNamespacedPod: vi.fn(async () => ({
        status: { containerStatuses: [{ name: "recipient", state: { terminated: { message: "podMessage" in opts ? opts.podMessage : podResult() } } }] },
      })),
    },
    batch: {
      createNamespacedJob: vi.fn(async ({ body }: any) => { calls.push("job.create"); state.job = true; state.pods = 1; (clients as any).lastJob = body; return { metadata: { uid: "job-uid-1" } }; }),
      readNamespacedJobStatus: vi.fn(async () => {
        const phase = opts.jobPhase ?? "Succeeded";
        return phase === "Running" ? { status: { active: 1 } } : phase === "Succeeded" ? { status: { succeeded: 1 } } : { status: { failed: 1 } };
      }),
      deleteNamespacedJob: vi.fn(async () => { calls.push("job.delete"); if (opts.deleteFails) throw new Error("boom"); state.job = false; state.pods = 0; }),
      readNamespacedJob: vi.fn(async () => { if (!state.job) throw notFound(); return {}; }),
    },
  };
  const deps: RunnerDeps = {
    clients,
    config: {
      expectedRecipientAgentId: WARDEN,
      driver: "kubernetes",
      backend: "job",
      egressMode: "cilium",
      namespace: "wr-ns",
      image: IMAGE,
      imageAllowPrefixes: ["registry.example/"],
      deadlineSeconds: 30,
      pollMs: 1,
      ...opts.config,
    },
    preflight: {
      resolve: vi.fn(async () =>
        opts.target === null
          ? null
          : { recipientAgentId: WARDEN, currentConfigRevision: "rev-7", checkerAgentId: SENTINEL, checkerRunId: "run-1", issueId: ISSUE, environmentDriver: "kubernetes", ...opts.target },
      ),
    },
    grants: {
      consume: vi.fn(async (i) => {
        if (opts.grantOutcome) return opts.grantOutcome;
        if (consumed.has(i.grantId)) return "already_consumed";
        consumed.add(i.grantId);
        return "consumed";
      }),
    },
    delivery: {
      resolveRecipientEnv: vi.fn(async () => {
        if (opts.deliveryThrows) throw new Error(`leak ${SECRET_SK}`);
        return opts.env === undefined ? { AWS_ACCESS_KEY_ID: SECRET_AK, AWS_SECRET_ACCESS_KEY: SECRET_SK } : opts.env;
      }),
    },
    aliases: { project: vi.fn(async () => opts.aliasProjection ?? { authority: true, accessKeyId: { name: "aws/warden-uat-validate/id", delivery: "env" }, secretAccessKey: { name: "aws/warden-uat-validate/secret", delivery: "env" }, oldMappingsPresent: false }) },
    audit: { record: vi.fn(async (e: AuditEvent) => { audit.push(e); }) },
    now: () => new Date((t += opts.nowStep ?? 10)),
    newCheckId: () => CHECK_ID,
    sleep: async () => {},
  };
  return { deps, audit, calls, state, clients, grants: consumed };
}

const leaked = (value: unknown) => {
  const s = JSON.stringify(value);
  return s.includes(SECRET_AK) || s.includes(SECRET_SK);
};

async function denied(world: World, req: unknown = request, a = actor) {
  const err = await runWardenRecipientCheck(world.deps, a, req).then(() => null, (e) => e);
  expect(err).toBeInstanceOf(CheckDenied);
  expect(world.calls).toEqual([]);
  expect(world.deps.delivery.resolveRecipientEnv).not.toHaveBeenCalled();
  return (err as CheckDenied).code;
}

describe("warden recipient runner: pre-lease denials (no lease, no credential projection)", () => {
  it("rejects wrong actor", async () => {
    expect(await denied(makeWorld({ target: { checkerAgentId: "someone-else" } }))).toBe("wrong_actor");
  });
  it("rejects wrong run for the right agent", async () => {
    expect(await denied(makeWorld({ target: { checkerRunId: "other-run" } }))).toBe("wrong_actor");
  });
  it("rejects wrong issue", async () => {
    expect(await denied(makeWorld({ target: { issueId: "99999999-9999-4999-8999-999999999999" } }))).toBe("wrong_issue");
  });
  it("rejects revision drift", async () => {
    expect(await denied(makeWorld({ target: { currentConfigRevision: "rev-8" } }))).toBe("stale_config_revision");
  });
  it("rejects wrong/unresolvable recipient", async () => {
    expect(await denied(makeWorld({ target: null }))).toBe("wrong_recipient");
  });
  it.each([["not_found", "grant_not_found"], ["expired", "grant_expired"], ["already_consumed", "grant_already_consumed"], ["mismatch", "grant_mismatch"]] as const)(
    "rejects grant outcome %s",
    async (outcome, code) => {
      expect(await denied(makeWorld({ grantOutcome: outcome }))).toBe(code);
    },
  );
  it.each([
    ["extra field (command)", { ...request, command: "id" }],
    ["extra field (awsTarget)", { ...request, cluster: "other" }],
    ["extra field (secretRef)", { ...request, secretId: "x" }],
    ["extra field (model instruction)", { ...request, prompt: "hi" }],
    ["wrong selector", { ...request, selector: "arbitrary" }],
    ["missing grant", { selector: request.selector, issueId: ISSUE, expectedConfigRevision: "rev-7" }],
  ])("rejects caller-supplied input: %s", async (_n, req) => {
    expect(await denied(makeWorld(), req)).toBe("invalid_request");
  });
  it("rejects local/ssh environment drivers (host execution)", async () => {
    for (const environmentDriver of ["local", "ssh"]) {
      expect(await denied(makeWorld({ target: { environmentDriver } }))).toBe("host_execution_rejected");
    }
  });
  it("rejects non-kubernetes/job runner config (no host fallback)", async () => {
    expect(await denied(makeWorld({ config: { driver: "local" as never } }))).toBe("host_execution_rejected");
    expect(await denied(makeWorld({ config: { backend: "sandbox-cr" as never } }))).toBe("host_execution_rejected");
  });
  it("rejects missing egress constraint (standard NetworkPolicy mode)", async () => {
    expect(await denied(makeWorld({ config: { egressMode: "standard" as never } }))).toBe("missing_egress_constraint");
  });
  it("rejects unpinned or non-allowlisted image before consuming the grant", async () => {
    expect(await denied(makeWorld({ config: { image: "registry.example/x:latest" } }))).toBe("image_rejected");
    expect(await denied(makeWorld({ config: { image: `evil.example/x@sha256:${"b".repeat(64)}` } }))).toBe("image_rejected");
    const w = makeWorld({ config: { image: "registry.example/x:latest" } });
    await denied(w);
    expect(w.deps.grants.consume).not.toHaveBeenCalled();
  });
  it("audits each denial without credentials", async () => {
    const w = makeWorld({ target: { currentConfigRevision: "rev-8" } });
    await denied(w);
    expect(w.audit.map((e) => [e.event, e.code])).toEqual([["denied", "stale_config_revision"]]);
    expect(leaked(w.audit)).toBe(false);
  });
});

describe("warden recipient runner: replay", () => {
  it("consumes the grant once; replay and concurrent duplicate are denied before any second lease", async () => {
    const w = makeWorld();
    const [a, b] = await Promise.allSettled([runWardenRecipientCheck(w.deps, actor, request), runWardenRecipientCheck(w.deps, actor, request)]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as CheckDenied).code).toBe("grant_already_consumed");
    expect(w.calls.filter((c) => c === "job.create")).toHaveLength(1);
  });
});

describe("warden recipient runner: happy path", () => {
  it("creates a fresh lease, verifies egress before the pod exists, reduces to fixed predicates, destroys and attests", async () => {
    const w = makeWorld();
    const receipt = await runWardenRecipientCheck(w.deps, actor, request);
    expect(receipt).toMatchObject({
      checkId: CHECK_ID,
      recipeVersion: WARDEN_RECIPE.version,
      initiatedBy: SENTINEL,
      recipient: WARDEN,
      targetIssue: ISSUE,
      configRevision: "rev-7",
      aliasNamesMatch: "PASS",
      expectedPrincipalMatch: "PASS",
      codebuildProjectFound: "PASS",
      eksClusterActive: "PASS",
      overall: "PASS",
      outcome: "completed",
    });
    expect(receipt.leaseAttestation).toMatchObject({ freshLease: true, egressVerified: true, destroyed: true, destroyVerifiedAbsent: true });
    expect(w.calls.indexOf("policy.create")).toBeLessThan(w.calls.indexOf("job.create"));
    expect(w.calls.indexOf("secret.create")).toBeLessThan(w.calls.indexOf("job.create"));
    expect(w.state).toEqual({ job: false, secret: false, policy: false, pods: 0 });
    expect(w.audit.map((e) => e.event)).toEqual(["grant_consumed", "lease_created", "egress_verified", "run_finished", "lease_destroyed"]);
    expect(Object.keys(receipt).sort()).toEqual(
      ["aliasNamesMatch", "checkId", "codebuildProjectFound", "configRevision", "eksClusterActive", "expectedPrincipalMatch", "finishedAt", "initiatedBy", "leaseAttestation", "outcome", "overall", "recipeVersion", "recipient", "startedAt", "targetIssue"].sort(),
    );
  });

  it("delivers exactly the two recipient env keys into a per-check Secret and references them from the Job by secretKeyRef only", async () => {
    const w = makeWorld();
    await runWardenRecipientCheck(w.deps, actor, request);
    const secretCall = w.clients.core.createNamespacedSecret.mock.calls[0][0];
    expect(Object.keys(secretCall.body.stringData).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(JSON.stringify(w.clients.lastJob)).not.toContain(SECRET_SK);
    expect(JSON.stringify(w.clients.lastJob)).not.toContain(SECRET_AK);
  });
});

describe("warden recipient runner: Job manifest (no host/model/command path)", () => {
  it("is hard-coded, digest-pinned, non-root, no SA token, no host namespaces, fixed command", async () => {
    const w = makeWorld();
    await runWardenRecipientCheck(w.deps, actor, request);
    const job = w.clients.lastJob;
    const pod = job.spec.template.spec;
    const c = pod.containers[0];
    expect(pod.containers).toHaveLength(1);
    expect(c.image).toBe(IMAGE);
    expect(c.command).toEqual(["/usr/bin/node", "/opt/warden-recipient/pod-main.js"]);
    expect(c.args).toBeUndefined();
    expect(c.envFrom).toBeUndefined();
    expect(pod.automountServiceAccountToken).toBe(false);
    expect([pod.hostNetwork, pod.hostPID, pod.hostIPC]).toEqual([false, false, false]);
    expect(pod.restartPolicy).toBe("Never");
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.activeDeadlineSeconds).toBe(30);
    expect(c.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
    expect(c.terminationMessagePolicy).toBe("File");
    expect(job.spec.template.metadata.labels["paperclip.io/role"]).toBe("warden-recipient");
    expect(c.env.map((e: any) => e.name).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "WARDEN_CHECK_ID", "WARDEN_DEADLINE_MS"]);
    expect(JSON.stringify(job)).not.toMatch(/ANTHROPIC|OPENAI|PAPERCLIP_API|BOOTSTRAP_TOKEN|prompt|model/i);
  });
  it("never reads pod logs or uses exec (no stdout/stderr capture path)", async () => {
    const w = makeWorld();
    w.clients.core.readNamespacedPodLog = vi.fn();
    w.clients.core.connectGetNamespacedPodExec = vi.fn();
    await runWardenRecipientCheck(w.deps, actor, request);
    expect(w.clients.core.readNamespacedPodLog).not.toHaveBeenCalled();
    expect(w.clients.core.connectGetNamespacedPodExec).not.toHaveBeenCalled();
  });
});

describe("warden recipient runner: egress isolation proven after policy combination", () => {
  const permissive = {
    metadata: { name: "paperclip-egress-allow" },
    spec: { podSelector: { matchLabels: { "paperclip.io/role": "warden-recipient" } }, policyTypes: ["Egress"], egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }] },
  };
  it("denies when a baseline NetworkPolicy adds egress to the recipient pod, and creates no Job or credential-bearing pod", async () => {
    const w = makeWorld({ extraEgressNetworkPolicies: [permissive] });
    const receipt = await runWardenRecipientCheck(w.deps, actor, request);
    expect(w.calls).not.toContain("job.create");
    expect(receipt.overall).toBe("INCONCLUSIVE");
    expect(receipt.outcome).toBe("error");
    expect(receipt.leaseAttestation?.egressVerified).toBe(false);
    expect(w.state).toEqual({ job: false, secret: false, policy: false, pods: 0 });
  });
  it("denies when an additional CiliumNetworkPolicy adds egress to the pod", async () => {
    const w = makeWorld({ extraCilium: [{ metadata: { name: "baseline" }, spec: { endpointSelector: {}, egress: [{ toCIDR: ["0.0.0.0/0"] }] } }] });
    await runWardenRecipientCheck(w.deps, actor, request);
    expect(w.calls).not.toContain("job.create");
  });
  it("denies when a cluster-wide Cilium policy adds egress", async () => {
    const w = makeWorld({ extraClusterwide: [{ metadata: { name: "cw" }, spec: { endpointSelector: {}, egress: [{ toEntities: ["world"] }] } }] });
    await runWardenRecipientCheck(w.deps, actor, request);
    expect(w.calls).not.toContain("job.create");
  });
  it("treats matchExpressions selectors as potentially matching (fail closed)", async () => {
    const w = makeWorld({ extraEgressNetworkPolicies: [{ metadata: { name: "x" }, spec: { podSelector: { matchExpressions: [{ key: "a", operator: "Exists" }] }, egress: [{}] } }] });
    await runWardenRecipientCheck(w.deps, actor, request);
    expect(w.calls).not.toContain("job.create");
  });
  it("ignores non-selecting policies", async () => {
    const other = { metadata: { name: "o" }, spec: { podSelector: { matchLabels: { "paperclip.io/role": "agent" } }, egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }] } };
    const w = makeWorld({ extraEgressNetworkPolicies: [other] });
    expect((await runWardenRecipientCheck(w.deps, actor, request)).overall).toBe("PASS");
  });
  describe("Cilium source-prefixed selectors", () => {
    const widen = (matchLabels: Record<string, string>) => ({
      metadata: { name: "tenant-baseline" },
      spec: { endpointSelector: { matchLabels }, egress: [{ toCIDR: ["0.0.0.0/0"] }] },
    });
    const selectorCases: Array<[string, Record<string, string>]> = [
      ["plain role", { "paperclip.io/role": "warden-recipient" }],
      ["k8s: role", { "k8s:paperclip.io/role": "warden-recipient" }],
      ["any: managed-by", { "any:paperclip.io/managed-by": "paperclip-k8s-plugin" }],
      ["k8s: namespace pseudo-label", { "k8s:io.kubernetes.pod.namespace": "wr-ns" }],
      ["plain namespace pseudo-label", { "io.kubernetes.pod.namespace": "wr-ns" }],
      ["any: namespace pseudo-label", { "any:io.kubernetes.pod.namespace": "wr-ns" }],
      ["namespace + k8s: role", { "k8s:io.kubernetes.pod.namespace": "wr-ns", "k8s:paperclip.io/role": "warden-recipient" }],
      ["unknown source prefix", { "reserved:host": "" }],
      ["cilium internal label", { "io.cilium.k8s.policy.cluster": "default" }],
    ];
    for (const [name, labels] of selectorCases) {
      it(`denies a namespaced CiliumNetworkPolicy widening egress selected by ${name}`, async () => {
        const w = makeWorld({ extraCilium: [widen(labels)] });
        const r = await runWardenRecipientCheck(w.deps, actor, request);
        expect(w.calls).not.toContain("job.create");
        expect(r.overall).toBe("INCONCLUSIVE");
        expect(r.leaseAttestation?.egressVerified).toBe(false);
        expect(w.state).toEqual({ job: false, secret: false, policy: false, pods: 0 });
      });
      it(`denies a clusterwide Cilium policy widening egress selected by ${name}`, async () => {
        const w = makeWorld({ extraClusterwide: [widen(labels)] });
        const r = await runWardenRecipientCheck(w.deps, actor, request);
        expect(w.calls).not.toContain("job.create");
        expect(r.overall).toBe("INCONCLUSIVE");
        expect(w.state).toEqual({ job: false, secret: false, policy: false, pods: 0 });
      });
    }
    const nonMatching: Array<[string, Record<string, string>]> = [
      ["other namespace (k8s:)", { "k8s:io.kubernetes.pod.namespace": "other-ns" }],
      ["other namespace (plain)", { "io.kubernetes.pod.namespace": "other-ns" }],
      ["other role (k8s:)", { "k8s:paperclip.io/role": "agent" }],
      ["other role (any:)", { "any:paperclip.io/role": "agent" }],
      ["matching namespace but other role", { "k8s:io.kubernetes.pod.namespace": "wr-ns", "k8s:paperclip.io/role": "agent" }],
    ];
    for (const [name, labels] of nonMatching) {
      it(`ignores a non-selecting prefixed policy: ${name}`, async () => {
        const ns = makeWorld({ extraCilium: [widen(labels)] });
        expect((await runWardenRecipientCheck(ns.deps, actor, request)).overall).toBe("PASS");
        const cw = makeWorld({ extraClusterwide: [widen(labels)] });
        expect((await runWardenRecipientCheck(cw.deps, actor, request)).overall).toBe("PASS");
      });
    }
  });
  it("fails closed when policies cannot be listed", async () => {
    const w = makeWorld();
    w.clients.networking.listNamespacedNetworkPolicy = vi.fn(async () => { throw new Error("rbac"); });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(w.calls).not.toContain("job.create");
    expect(r.overall).toBe("INCONCLUSIVE");
  });
  it("policy allows only the three exact AWS endpoints on 443 plus pinned DNS, with no CIDR/entity/wildcard rule", () => {
    const p = buildWardenRecipientEgressPolicy({ namespace: "n", checkId: CHECK_ID }) as any;
    const s = JSON.stringify(p);
    expect(p.spec.egress[1].toFQDNs.map((f: any) => f.matchName).sort()).toEqual([
      "codebuild.ap-south-2.amazonaws.com",
      "eks.ap-south-2.amazonaws.com",
      "sts.ap-south-2.amazonaws.com",
    ]);
    expect(p.spec.egress[1].toPorts[0].ports).toEqual([{ port: "443", protocol: "TCP" }]);
    expect(p.spec.egress[0].toPorts[0].rules.dns.every((d: any) => "matchName" in d)).toBe(true);
    expect(s).not.toMatch(/toCIDR|toEntities|matchPattern|\*|paperclip-server|3100/);
    expect(p.spec.endpointSelector.matchLabels["paperclip.io/check-id"]).toBe(CHECK_ID);
  });
});

describe("warden recipient runner: lease destroyed on every terminal path", () => {
  const empty = { job: false, secret: false, policy: false, pods: 0 };
  it("error (pod produced unparseable/oversized result)", async () => {
    const w = makeWorld({ podMessage: "x".repeat(5000) });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r).toMatchObject({ outcome: "error", overall: "INCONCLUSIVE", expectedPrincipalMatch: "INCONCLUSIVE" });
    expect(w.state).toEqual(empty);
    expect(r.leaseAttestation?.destroyVerifiedAbsent).toBe(true);
  });
  it("job failed", async () => {
    const w = makeWorld({ jobPhase: "Failed", podMessage: undefined });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(w.state).toEqual(empty);
  });
  it("timeout", async () => {
    const w = makeWorld({ jobPhase: "Running", nowStep: 5000 });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.outcome).toBe("timeout");
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(w.state).toEqual(empty);
  });
  it("cancellation", async () => {
    const w = makeWorld({ jobPhase: "Running" });
    const ac = new AbortController();
    w.clients.batch.readNamespacedJobStatus = vi.fn(async () => { ac.abort(); return { status: { active: 1 } }; });
    const r = await runWardenRecipientCheck(w.deps, actor, request, ac.signal);
    expect(r.outcome).toBe("cancelled");
    expect(w.state).toEqual(empty);
    expect(r.leaseAttestation?.destroyed).toBe(true);
  });
  it("cancellation before lease use", async () => {
    const w = makeWorld();
    const ac = new AbortController();
    ac.abort();
    const err = await runWardenRecipientCheck(w.deps, actor, request, ac.signal).then(() => null, (e) => e);
    expect((err as CheckDenied).code).toBe("cancelled");
    expect(w.calls).toEqual([]);
    expect(w.state).toEqual(empty);
  });
  it("Job creation failure still removes Secret and policy", async () => {
    const w = makeWorld();
    w.clients.batch.createNamespacedJob = vi.fn(async () => { throw new Error("quota"); });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.outcome).toBe("error");
    expect(w.state).toEqual(empty);
  });
  it("destroy failure is reported (never PASS) and attestation shows not verified absent", async () => {
    const w = makeWorld({ deleteFails: true });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(r.leaseAttestation).toMatchObject({ destroyed: false, destroyVerifiedAbsent: false, destroyedAt: null });
    expect(w.audit.at(-1)?.event).toBe("lease_destroy_failed");
  });
  it("delivery returning wrong key set is denied before any lease", async () => {
    const w = makeWorld({ env: { AWS_ACCESS_KEY_ID: SECRET_AK, AWS_SECRET_ACCESS_KEY: SECRET_SK, EXTRA: "x" } });
    const err = await runWardenRecipientCheck(w.deps, actor, request).then(() => null, (e) => e);
    expect((err as CheckDenied).code).toBe("delivery_unavailable");
    expect(w.calls).toEqual([]);
  });
  it("sweeper removes expired credential-bearing leases left by a crashed server", async () => {
    const w = makeWorld();
    w.state.secret = true; w.state.job = true;
    w.clients.core.listNamespacedSecret = vi.fn(async () => ({
      items: [
        { metadata: { labels: { "paperclip.io/check-id": CHECK_ID }, creationTimestamp: "2026-10-04T10:00:00Z" } },
        { metadata: { labels: { "paperclip.io/check-id": "fresh" }, creationTimestamp: "2026-10-04T12:59:00Z" } },
      ],
    }));
    const out = await sweepExpiredRecipientLeases(w.clients, { namespace: "wr-ns", now: () => new Date("2026-10-04T13:00:00Z") });
    expect(out.swept).toBe(1);
    expect(w.state.secret).toBe(false);
  });
});

describe("warden recipient runner: redaction and no model path", () => {
  it("receipt, audit and thrown errors never contain credentials, secret ids, pod text or raw output", async () => {
    const poisoned = JSON.stringify({ v: 1, recipe: WARDEN_RECIPE.version, checkId: CHECK_ID, expectedPrincipalMatch: "PASS", codebuildProjectFound: "PASS", eksClusterActive: "PASS", extra: SECRET_SK });
    const w = makeWorld({ podMessage: poisoned });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(leaked([r, w.audit])).toBe(false);
  });
  it("delivery errors containing secret text never surface", async () => {
    const w = makeWorld({ deliveryThrows: true });
    const err = await runWardenRecipientCheck(w.deps, actor, request).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CheckDenied);
    expect(leaked([String(err), (err as Error).stack?.split("\n")[0], w.audit])).toBe(false);
  });
  it("pod result for another check id is rejected", async () => {
    const w = makeWorld({ podMessage: podResult().replace(CHECK_ID, "44444444-4444-4444-8444-444444444444") });
    expect((await runWardenRecipientCheck(w.deps, actor, request)).overall).toBe("INCONCLUSIVE");
  });
  it("a FAIL pod predicate yields FAIL only when lease destroyed", async () => {
    const w = makeWorld({ podMessage: podResult({ expectedPrincipalMatch: "FAIL", codebuildProjectFound: "INCONCLUSIVE", eksClusterActive: "INCONCLUSIVE" }) });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.overall).toBe("FAIL");
  });
  it("RunnerDeps has no model/agent execution dependency", () => {
    const w = makeWorld();
    expect(Object.keys(w.deps).sort()).toEqual(["aliases", "audit", "clients", "config", "delivery", "grants", "newCheckId", "now", "preflight", "sleep"]);
  });
});

describe("values-free alias projection", () => {
  const good = { authority: true, accessKeyId: { name: "aws/warden-uat-validate/id", delivery: "env" }, secretAccessKey: { name: "aws/warden-uat-validate/secret", delivery: "env" }, oldMappingsPresent: false };
  it.each([
    ["no metadata authority", { ...good, authority: false }, "INCONCLUSIVE"],
    ["old mapping present", { ...good, oldMappingsPresent: true }, "FAIL"],
    ["wrong name", { ...good, accessKeyId: { name: "pw-hrms/ACCESS_KEY_ID", delivery: "env" } }, "FAIL"],
    ["wrong delivery", { ...good, secretAccessKey: { ...good.secretAccessKey, delivery: "file" } }, "FAIL"],
    ["missing mapping", { ...good, secretAccessKey: null }, "FAIL"],
    ["opaque ids smuggled in (schema violation)", { ...good, accessKeyId: { ...good.accessKeyId, id: "uuid" } }, "INCONCLUSIVE"],
    ["malformed", "garbage", "INCONCLUSIVE"],
    ["all good", good, "PASS"],
  ])("%s -> %s", async (_n, aliasProjection, expected) => {
    const w = makeWorld({ aliasProjection });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.aliasNamesMatch).toBe(expected);
    if (expected !== "PASS") expect(r.overall).not.toBe("PASS");
  });
  it("without a projection port the predicate is INCONCLUSIVE and overall is never PASS", async () => {
    const w = makeWorld();
    delete (w.deps as any).aliases;
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.aliasNamesMatch).toBe("INCONCLUSIVE");
    expect(r.overall).toBe("INCONCLUSIVE");
  });
  it("projection throwing yields INCONCLUSIVE", async () => {
    const w = makeWorld();
    w.deps.aliases = { project: vi.fn(async () => { throw new Error("403"); }) };
    expect((await runWardenRecipientCheck(w.deps, actor, request)).aliasNamesMatch).toBe("INCONCLUSIVE");
  });
});


const EMPTY = { job: false, secret: false, policy: false, pods: 0 };
const AUDIT_EVENTS = ["grant_consumed", "lease_created", "egress_verified", "run_finished", "lease_destroyed"] as const;

describe("repair: audit sink failure never strands a credential-bearing lease (P1)", () => {
  it.each(AUDIT_EVENTS)("audit port throws at %s -> lease fully destroyed", async (failAt) => {
    const w = makeWorld();
    const original = w.deps.audit.record;
    w.deps.audit = {
      record: vi.fn(async (e: AuditEvent) => {
        if (e.event === failAt) throw new Error(`sink down ${SECRET_SK}`);
        return original(e);
      }),
    };
    const result = await runWardenRecipientCheck(w.deps, actor, request).then((r) => ({ r }), (e) => ({ e }));
    expect(w.state).toEqual(EMPTY);
    if ("e" in result) {
      expect(String(result.e)).not.toContain(SECRET_SK);
      expect(result.e).toBeInstanceOf(CheckDenied);
      if (failAt !== "grant_consumed") throw new Error("only the pre-lease audit may deny");
      expect(w.calls).toEqual([]);
    }
  });
  it("audit port throws on every record -> still no lease and no leak", async () => {
    const w = makeWorld();
    w.deps.audit = { record: vi.fn(async () => { throw new Error(`down ${SECRET_AK}`); }) };
    const result = await runWardenRecipientCheck(w.deps, actor, request).then((r) => ({ r }), (e) => ({ e }));
    expect(w.state).toEqual(EMPTY);
    expect(JSON.stringify(result, (_k, v) => (v instanceof Error ? v.message : v))).not.toContain(SECRET_AK);
  });
  it("destroy() throwing unexpectedly is reported as not verified absent, never PASS", async () => {
    const w = makeWorld();
    w.clients.core.listNamespacedPod = vi.fn(async () => { throw new Error("api down"); });
    const r = await runWardenRecipientCheck(w.deps, actor, request);
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(r.leaseAttestation?.destroyVerifiedAbsent).toBe(false);
  });
  it("abort fired during lease creation still destroys what was created", async () => {
    const w = makeWorld();
    const ac = new AbortController();
    w.clients.core.createNamespacedSecret = vi.fn(async () => { w.state.secret = true; ac.abort(); });
    const r = await runWardenRecipientCheck(w.deps, actor, request, ac.signal);
    expect(r.outcome).toBe("cancelled");
    expect(w.state).toEqual(EMPTY);
  });
});

describe("repair: port exceptions map to internal_denial without raw messages (P10)", () => {
  it.each(["preflight", "grants", "audit-grant_consumed"])("%s throws -> internal_denial, no lease, no raw text", async (which) => {
    const w = makeWorld();
    const boom = () => { throw new Error(`db down ${SECRET_SK}`); };
    if (which === "preflight") w.deps.preflight = { resolve: vi.fn(async () => boom()) };
    if (which === "grants") w.deps.grants = { consume: vi.fn(async () => boom()) };
    if (which === "audit-grant_consumed") {
      const orig = w.deps.audit.record;
      w.deps.audit = { record: vi.fn(async (e: AuditEvent) => (e.event === "grant_consumed" ? boom() : orig(e))) };
    }
    const err = await runWardenRecipientCheck(w.deps, actor, request).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CheckDenied);
    expect((err as CheckDenied).code).toBe("internal_denial");
    expect(String(err)).not.toContain(SECRET_SK);
    expect(w.calls).toEqual([]);
    expect(w.deps.delivery.resolveRecipientEnv).not.toHaveBeenCalled();
  });
  it("an audit failure while recording a denial still yields the original denial code", async () => {
    const w = makeWorld({ target: { currentConfigRevision: "rev-8" } });
    w.deps.audit = { record: vi.fn(async () => { throw new Error(SECRET_SK); }) };
    const err = await runWardenRecipientCheck(w.deps, actor, request).then(() => null, (e) => e);
    expect((err as CheckDenied).code).toBe("stale_config_revision");
  });
});

describe("repair: abort ordering (P2)", () => {
  it("pre-aborted signal creates nothing and consumes no grant", async () => {
    const w = makeWorld();
    const ac = new AbortController();
    ac.abort();
    const err = await runWardenRecipientCheck(w.deps, actor, request, ac.signal).then(() => null, (e) => e);
    expect((err as CheckDenied).code).toBe("cancelled");
    expect(w.calls).toEqual([]);
    expect(w.deps.grants.consume).not.toHaveBeenCalled();
    expect(w.clients.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(w.clients.core.createNamespacedSecret).not.toHaveBeenCalled();
  });
  it("abort after the grant is consumed but before lease creation creates no policy or Secret", async () => {
    const w = makeWorld();
    const ac = new AbortController();
    const orig = w.deps.delivery.resolveRecipientEnv;
    w.deps.delivery = { resolveRecipientEnv: vi.fn(async (i) => { ac.abort(); return orig(i); }) };
    const r = await runWardenRecipientCheck(w.deps, actor, request, ac.signal);
    expect(r.outcome).toBe("cancelled");
    expect(r.leaseAttestation).toBeNull();
    expect(w.clients.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(w.clients.core.createNamespacedSecret).not.toHaveBeenCalled();
  });
});

describe("repair: recipient pinned in the runner (P3)", () => {
  it("preflight returning a different recipient agent is denied before grant/lease/delivery", async () => {
    const w = makeWorld({ target: { recipientAgentId: "some-other-agent" } });
    const err = await runWardenRecipientCheck(w.deps, actor, request).then(() => null, (e) => e);
    expect((err as CheckDenied).code).toBe("wrong_recipient");
    expect(w.deps.grants.consume).not.toHaveBeenCalled();
    expect(w.deps.delivery.resolveRecipientEnv).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
  });
});

describe("repair: single-use GrantPort contract (P4)", () => {
  function atomicGrantStore(): GrantPort {
    const state = new Map<string, "open" | "consumed">([[GRANT, "open"]]);
    return {
      consume: async (i) => {
        await Promise.resolve();
        const s = state.get(i.grantId);
        if (!s) return "not_found";
        if (s === "consumed") return "already_consumed";
        state.set(i.grantId, "consumed");
        return "consumed";
      },
    };
  }
  it("10 concurrent invocations against a compliant atomic grant store yield exactly one lease", async () => {
    const w = makeWorld();
    w.deps.grants = atomicGrantStore();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => runWardenRecipientCheck(w.deps, actor, request)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const codes = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as CheckDenied).code);
    expect(codes).toHaveLength(9);
    expect(new Set(codes)).toEqual(new Set(["grant_already_consumed"]));
    expect(w.calls.filter((c) => c === "job.create")).toHaveLength(1);
  });
  it("process-local guard blocks concurrent replay even against a NON-atomic (non-compliant) store in the same process", async () => {
    const w = makeWorld();
    let consumed = false;
    w.deps.grants = { consume: async () => { await Promise.resolve(); const was = consumed; consumed = false; return was ? "already_consumed" : "consumed"; } };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => runWardenRecipientCheck(w.deps, actor, request)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("a denied (non-consumed) outcome does not poison the grant for a later legitimate call", async () => {
    const w = makeWorld();
    let first = true;
    w.deps.grants = { consume: vi.fn(async () => { if (first) { first = false; return "mismatch"; } return "consumed"; }) };
    await expect(runWardenRecipientCheck(w.deps, actor, request)).rejects.toBeInstanceOf(CheckDenied);
    expect((await runWardenRecipientCheck(w.deps, actor, request)).overall).toBe("PASS");
  });
});

describe("repair 2: Cilium top-level specs[] bypass and hardening (Sentinel 02188df)", () => {
  const wide = [{ toCIDR: ["0.0.0.0/0"] }];
  const sel = { matchLabels: { "paperclip.io/role": "warden-recipient" } };
  const benign = { endpointSelector: { matchLabels: { "paperclip.io/role": "agent" } }, ingress: [{}] };
  const cases: Array<[string, any]> = [
    ["specs only", { metadata: { name: "s" }, specs: [{ endpointSelector: sel, egress: wide }] }],
    ["specs beside a benign spec", { metadata: { name: "s" }, spec: benign, specs: [{ endpointSelector: sel, egress: wide }] }],
    ["specs nested in spec", { metadata: { name: "s" }, spec: { ...benign, specs: [{ endpointSelector: sel, egress: wide }] } }],
    ["specs with prefixed selector", { metadata: { name: "s" }, specs: [{ endpointSelector: { matchLabels: { "k8s:paperclip.io/role": "warden-recipient" } }, egress: wide }] }],
    ["specs entry with empty selector", { metadata: { name: "s" }, specs: [{ endpointSelector: {}, egress: wide }] }],
    ["malformed specs", { metadata: { name: "s" }, spec: benign, specs: "x" }],
    ["no spec and no specs", { metadata: { name: "s" } }],
    ["non-object specs entry", { metadata: { name: "s" }, specs: [null] }],
  ];
  for (const [name, policy] of cases) {
    it(`denies a namespaced policy: ${name}`, async () => {
      const w = makeWorld({ extraCilium: [policy] });
      const r = await runWardenRecipientCheck(w.deps, actor, request);
      expect(w.calls).not.toContain("job.create");
      expect(r.overall).toBe("INCONCLUSIVE");
      expect(r.leaseAttestation?.egressVerified).toBe(false);
      expect(w.state).toEqual({ job: false, secret: false, policy: false, pods: 0 });
    });
    it(`denies a clusterwide policy: ${name}`, async () => {
      const w = makeWorld({ extraClusterwide: [policy] });
      const r = await runWardenRecipientCheck(w.deps, actor, request);
      expect(w.calls).not.toContain("job.create");
      expect(r.overall).toBe("INCONCLUSIVE");
      expect(w.state).toEqual({ job: false, secret: false, policy: false, pods: 0 });
    });
  }
  it("ignores specs entries that do not select the recipient", async () => {
    const policy = { metadata: { name: "s" }, specs: [{ endpointSelector: { matchLabels: { "paperclip.io/role": "agent" } }, egress: wide }] };
    expect((await runWardenRecipientCheck(makeWorld({ extraCilium: [policy] }).deps, actor, request)).overall).toBe("PASS");
    expect((await runWardenRecipientCheck(makeWorld({ extraClusterwide: [policy] }).deps, actor, request)).overall).toBe("PASS");
  });
  it("rejects an empty or blank expectedRecipientAgentId before any preflight, grant or lease", async () => {
    for (const id of ["", "   "]) {
      const w = makeWorld({ config: { expectedRecipientAgentId: id } });
      expect(await denied(w)).toBe("internal_denial");
      expect(w.deps.preflight.resolve).not.toHaveBeenCalled();
      expect(w.deps.grants.consume).not.toHaveBeenCalled();
    }
  });
  it("maps an unknown GrantPort outcome to internal_denial, with no lease", async () => {
    for (const bad of ["CONSUMED", undefined, "ok"]) {
      const w = makeWorld();
      w.deps.grants = { consume: vi.fn(async () => bad as never) };
      expect(await denied(w)).toBe("internal_denial");
    }
  });
});

describe("repair: sweeper is schedulable", () => {
  it("startRecipientLeaseSweeper sweeps on its interval and can be stopped", async () => {
    vi.useFakeTimers();
    try {
      const w = makeWorld();
      w.clients.core.listNamespacedSecret = vi.fn(async () => ({ items: [] }));
      const sweeper = startRecipientLeaseSweeper(w.clients, { namespace: "wr-ns", intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(2500);
      expect(w.clients.core.listNamespacedSecret).toHaveBeenCalledTimes(2);
      sweeper.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(w.clients.core.listNamespacedSecret).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
