import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { KubeClients } from "../kube-client.js";
import { createJob, findPodForJob, getJobStatus } from "../job-orchestrator.js";
import { isKubeNotFoundError } from "../lease-lifecycle.js";
import {
  EgressConstraintError,
  WARDEN_RECIPIENT_POLICY_PREFIX,
  WARDEN_RECIPIENT_ROLE,
  assertEgressModeSupported,
  buildWardenRecipientEgressPolicy,
  verifyEffectiveEgress,
  type EgressListing,
} from "./egress.js";
import { buildRecipientJobManifest, recipientJobName, recipientSecretName, ManifestError } from "./manifest.js";
import { WARDEN_RECIPE, parsePodTerminationMessage, reduceAliasPredicate, reduceOverall, type Tri } from "./recipe.js";

export const checkRequestSchema = z
  .object({
    selector: z.literal("warden-uat-aws"),
    issueId: z.string().uuid(),
    grantId: z.string().uuid(),
    expectedConfigRevision: z.string().min(1).max(128),
  })
  .strict();
export type CheckRequest = z.infer<typeof checkRequestSchema>;

export interface CheckActor {
  agentId: string;
  runId: string;
  companyId: string;
}

export type DenialCode =
  | "invalid_request"
  | "wrong_actor"
  | "wrong_issue"
  | "wrong_recipient"
  | "stale_config_revision"
  | "grant_not_found"
  | "grant_expired"
  | "grant_already_consumed"
  | "grant_mismatch"
  | "host_execution_rejected"
  | "missing_egress_constraint"
  | "delivery_unavailable"
  | "image_rejected"
  | "internal_denial";

export class CheckDenied extends Error {
  constructor(readonly code: DenialCode) {
    super(code);
    this.name = "CheckDenied";
  }
}

export interface RecipientTarget {
  recipientAgentId: string;
  currentConfigRevision: string;
  checkerAgentId: string;
  checkerRunId: string;
  issueId: string;
  environmentDriver: string;
}

export interface RecipientPreflightPort {
  resolve(actor: CheckActor, request: CheckRequest): Promise<RecipientTarget | null>;
}

export type GrantOutcome = "consumed" | "not_found" | "expired" | "already_consumed" | "mismatch";

export interface GrantPort {
  consume(input: {
    grantId: string;
    checkerAgentId: string;
    checkerRunId: string;
    issueId: string;
    recipientAgentId: string;
    configRevision: string;
    recipe: string;
    now: Date;
  }): Promise<GrantOutcome>;
}

export interface DeliveryPort {
  resolveRecipientEnv(input: {
    companyId: string;
    recipientAgentId: string;
    configRevision: string;
  }): Promise<Record<string, string> | null>;
}

export interface AliasProjectionPort {
  project(input: { companyId: string; recipientAgentId: string; configRevision: string }): Promise<unknown>;
}

export interface AuditEvent {
  checkId: string;
  event:
    | "denied"
    | "grant_consumed"
    | "lease_created"
    | "egress_verified"
    | "run_finished"
    | "lease_destroyed"
    | "lease_destroy_failed";
  at: string;
  recipe: string;
  actorAgentId: string;
  actorRunId: string;
  issueId: string;
  recipientAgentId: string | null;
  configRevision: string | null;
  grantId: string | null;
  code?: string;
  outcome?: string;
}

export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}

export interface RunnerConfig {
  driver: "kubernetes";
  backend: "job";
  egressMode: "cilium";
  namespace: string;
  image: string;
  imageAllowPrefixes: readonly string[];
  deadlineSeconds?: number;
  runtimeClassName?: string;
  pollMs?: number;
}

export interface RunnerDeps {
  clients: KubeClients;
  preflight: RecipientPreflightPort;
  grants: GrantPort;
  delivery: DeliveryPort;
  aliases?: AliasProjectionPort;
  audit: AuditPort;
  config: RunnerConfig;
  now?: () => Date;
  newCheckId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface LeaseAttestation {
  freshLease: true;
  jobUidDigest: string;
  egressVerified: boolean;
  destroyed: boolean;
  destroyVerifiedAbsent: boolean;
  createdAt: string;
  destroyedAt: string | null;
}

export type Outcome = "completed" | "timeout" | "cancelled" | "error";

export interface CheckReceipt {
  checkId: string;
  recipeVersion: string;
  initiatedBy: string;
  recipient: string;
  targetIssue: string;
  configRevision: string;
  leaseAttestation: LeaseAttestation | null;
  startedAt: string;
  finishedAt: string;
  aliasNamesMatch: Tri;
  expectedPrincipalMatch: Tri;
  codebuildProjectFound: Tri;
  eksClusterActive: Tri;
  overall: Tri;
  outcome: Outcome;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const digest = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);

export async function runWardenRecipientCheck(deps: RunnerDeps, actor: CheckActor, rawRequest: unknown, signal?: AbortSignal): Promise<CheckReceipt> {
  const now = deps.now ?? (() => new Date());
  const checkId = (deps.newCheckId ?? randomUUID)();
  const base = (event: AuditEvent["event"], extra: Partial<AuditEvent> = {}): AuditEvent => ({
    checkId,
    event,
    at: now().toISOString(),
    recipe: WARDEN_RECIPE.version,
    actorAgentId: actor.agentId,
    actorRunId: actor.runId,
    issueId: "",
    recipientAgentId: null,
    configRevision: null,
    grantId: null,
    ...extra,
  });
  const deny = async (code: DenialCode, extra: Partial<AuditEvent> = {}): Promise<never> => {
    await deps.audit.record(base("denied", { code, ...extra }));
    throw new CheckDenied(code);
  };

  const parsed = checkRequestSchema.safeParse(rawRequest);
  if (!parsed.success) return deny("invalid_request");
  const request = parsed.data;
  const ctx = { issueId: request.issueId, grantId: request.grantId };

  if (deps.config.driver !== "kubernetes" || deps.config.backend !== "job") return deny("host_execution_rejected", ctx);
  try {
    assertEgressModeSupported(deps.config.egressMode);
  } catch {
    return deny("missing_egress_constraint", ctx);
  }

  const target = await deps.preflight.resolve(actor, request);
  if (!target) return deny("wrong_recipient", ctx);
  const tctx = { ...ctx, recipientAgentId: target.recipientAgentId, configRevision: target.currentConfigRevision };
  if (target.environmentDriver !== "kubernetes") return deny("host_execution_rejected", tctx);
  if (target.checkerAgentId !== actor.agentId || target.checkerRunId !== actor.runId) return deny("wrong_actor", tctx);
  if (target.issueId !== request.issueId) return deny("wrong_issue", tctx);
  if (target.currentConfigRevision !== request.expectedConfigRevision) return deny("stale_config_revision", tctx);

  try {
    buildRecipientJobManifest({
      namespace: deps.config.namespace,
      checkId,
      image: deps.config.image,
      imageAllowPrefixes: deps.config.imageAllowPrefixes,
      secretName: recipientSecretName(checkId),
      deadlineSeconds: deps.config.deadlineSeconds ?? WARDEN_RECIPE.defaultDeadlineSeconds,
      runtimeClassName: deps.config.runtimeClassName,
    });
  } catch (err) {
    if (err instanceof ManifestError) return deny("image_rejected", tctx);
    throw err;
  }

  const outcome = await deps.grants.consume({
    grantId: request.grantId,
    checkerAgentId: actor.agentId,
    checkerRunId: actor.runId,
    issueId: request.issueId,
    recipientAgentId: target.recipientAgentId,
    configRevision: target.currentConfigRevision,
    recipe: WARDEN_RECIPE.version,
    now: now(),
  });
  if (outcome !== "consumed") {
    const map: Record<Exclude<GrantOutcome, "consumed">, DenialCode> = {
      not_found: "grant_not_found",
      expired: "grant_expired",
      already_consumed: "grant_already_consumed",
      mismatch: "grant_mismatch",
    };
    return deny(map[outcome], tctx);
  }
  await deps.audit.record(base("grant_consumed", tctx));

  const startedAt = now().toISOString();
  let env: Record<string, string> | null;
  try {
    env = await deps.delivery.resolveRecipientEnv({
      companyId: actor.companyId,
      recipientAgentId: target.recipientAgentId,
      configRevision: target.currentConfigRevision,
    });
  } catch {
    env = null;
  }
  const keys = env ? Object.keys(env).sort() : [];
  const expectedKeys = [...WARDEN_RECIPE.allowedEnvKeys].sort();
  if (!env || keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i]) || Object.values(env).some((v) => typeof v !== "string" || v.length === 0)) {
    return deny("delivery_unavailable", tctx);
  }

  let aliasNamesMatch: Tri = "INCONCLUSIVE";
  if (deps.aliases) {
    try {
      aliasNamesMatch = reduceAliasPredicate(
        await deps.aliases.project({ companyId: actor.companyId, recipientAgentId: target.recipientAgentId, configRevision: target.currentConfigRevision }),
      );
    } catch {
      aliasNamesMatch = "INCONCLUSIVE";
    }
  }

  const lease = new RecipientLease(deps, checkId);
  let pod: ReturnType<typeof parsePodTerminationMessage> = null;
  let runOutcome: Outcome = "error";
  let jobUid = "";
  let egressVerified = false;
  const createdAt = now().toISOString();
  try {
    await lease.create(env, tctx.configRevision, signal);
    await deps.audit.record(base("lease_created", tctx));
    await lease.verifyEgress();
    egressVerified = true;
    await deps.audit.record(base("egress_verified", tctx));
    await lease.start();
    jobUid = lease.currentJobUid();
    const result = await lease.wait(signal);
    pod = result.pod;
    runOutcome = result.outcome;
  } catch (err) {
    runOutcome = err instanceof EgressConstraintError ? "error" : signal?.aborted ? "cancelled" : "error";
  } finally {
    env = null;
  }
  await deps.audit.record(base("run_finished", { ...tctx, outcome: runOutcome }));

  const destroy = await lease.destroy();
  await deps.audit.record(base(destroy.verifiedAbsent ? "lease_destroyed" : "lease_destroy_failed", tctx));

  const predicates = {
    expectedPrincipalMatch: (pod?.expectedPrincipalMatch ?? "INCONCLUSIVE") as Tri,
    codebuildProjectFound: (pod?.codebuildProjectFound ?? "INCONCLUSIVE") as Tri,
    eksClusterActive: (pod?.eksClusterActive ?? "INCONCLUSIVE") as Tri,
  };
  let overall = reduceOverall([aliasNamesMatch, ...Object.values(predicates)]);
  if (!egressVerified || !destroy.verifiedAbsent || runOutcome !== "completed") overall = overall === "FAIL" && destroy.verifiedAbsent ? "FAIL" : "INCONCLUSIVE";

  return {
    checkId,
    recipeVersion: WARDEN_RECIPE.version,
    initiatedBy: actor.agentId,
    recipient: target.recipientAgentId,
    targetIssue: request.issueId,
    configRevision: target.currentConfigRevision,
    leaseAttestation: lease.wasCreated()
      ? {
          freshLease: true,
          jobUidDigest: jobUid ? digest(jobUid) : "none",
          egressVerified,
          destroyed: destroy.deleted,
          destroyVerifiedAbsent: destroy.verifiedAbsent,
          createdAt,
          destroyedAt: destroy.verifiedAbsent ? now().toISOString() : null,
        }
      : null,
    startedAt,
    finishedAt: now().toISOString(),
    aliasNamesMatch,
    ...predicates,
    overall,
    outcome: runOutcome,
  };
}

class RecipientLease {
  private readonly namespace: string;
  private readonly jobName: string;
  private readonly secretName: string;
  private readonly policyName: string;
  private readonly podLabels: Record<string, string>;
  private readonly policy: Record<string, unknown>;
  private touched = false;

  constructor(private readonly deps: RunnerDeps, private readonly checkId: string) {
    this.namespace = deps.config.namespace;
    this.jobName = recipientJobName(checkId);
    this.secretName = recipientSecretName(checkId);
    this.policy = buildWardenRecipientEgressPolicy({ namespace: this.namespace, checkId });
    this.policyName = (this.policy.metadata as { name: string }).name;
    this.podLabels = {
      "paperclip.io/managed-by": "paperclip-k8s-plugin",
      "paperclip.io/check-id": checkId,
      "paperclip.io/role": WARDEN_RECIPIENT_ROLE,
      "paperclip.io/recipe": WARDEN_RECIPE.version,
    };
  }

  wasCreated(): boolean {
    return this.touched;
  }

  async create(env: Record<string, string>, configRevision: string, signal?: AbortSignal): Promise<void> {
    const { clients } = this.deps;
    this.touched = true;
    await clients.custom.createNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace: this.namespace,
      plural: "ciliumnetworkpolicies",
      body: this.policy,
    });
    await clients.core.createNamespacedSecret({
      namespace: this.namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name: this.secretName,
          namespace: this.namespace,
          labels: { ...this.podLabels },
          annotations: { "paperclip.io/config-revision-digest": digest(configRevision) },
        },
        stringData: env,
      },
    });
    if (signal?.aborted) throw new Error("cancelled");
  }

  private jobUid: string | null = null;

  async verifyEgress(): Promise<void> {
    const { clients } = this.deps;
    const ns = this.namespace;
    const [np, cnp, ccnp] = await Promise.all([
      clients.networking.listNamespacedNetworkPolicy({ namespace: ns }),
      clients.custom.listNamespacedCustomObject({ group: "cilium.io", version: "v2", namespace: ns, plural: "ciliumnetworkpolicies" }),
      clients.custom.listClusterCustomObject({ group: "cilium.io", version: "v2", plural: "ciliumclusterwidenetworkpolicies" }),
    ]).catch(() => {
      throw new EgressConstraintError("egress_unverifiable");
    });
    const items = (v: unknown) => ((v as { items?: unknown[] } | undefined)?.items ?? []) as never[];
    const listing: EgressListing = {
      networkPolicies: items(np),
      ciliumPolicies: items(cnp),
      ciliumClusterwidePolicies: items(ccnp),
    };
    verifyEffectiveEgress({ expectedPolicy: this.policy, podLabels: this.podLabels, listing });
  }

  async start(): Promise<void> {
    const { config, clients } = this.deps;
    const manifest = buildRecipientJobManifest({
      namespace: this.namespace,
      checkId: this.checkId,
      image: config.image,
      imageAllowPrefixes: config.imageAllowPrefixes,
      secretName: this.secretName,
      deadlineSeconds: config.deadlineSeconds ?? WARDEN_RECIPE.defaultDeadlineSeconds,
      runtimeClassName: config.runtimeClassName,
    });
    const { uid } = await createJob(clients, this.namespace, manifest);
    this.jobUid = uid;
  }

  currentJobUid(): string {
    return this.jobUid ?? "";
  }

  async wait(signal?: AbortSignal): Promise<{ outcome: Outcome; pod: ReturnType<typeof parsePodTerminationMessage> }> {
    const { clients } = this.deps;
    const sleep = this.deps.sleep ?? defaultSleep;
    const now = this.deps.now ?? (() => new Date());
    const deadline = now().getTime() + (this.deps.config.deadlineSeconds ?? WARDEN_RECIPE.defaultDeadlineSeconds) * 1000;
    const pollMs = this.deps.config.pollMs ?? 1500;
    for (;;) {
      if (signal?.aborted) return { outcome: "cancelled", pod: null };
      const status = await getJobStatus(clients, this.namespace, this.jobName);
      if (status.phase === "Succeeded" || status.phase === "Failed") {
        const podName = await findPodForJob(clients, this.namespace, this.jobName);
        if (!podName) return { outcome: "error", pod: null };
        const podObj = (await clients.core.readNamespacedPod({ namespace: this.namespace, name: podName })) as {
          status?: { containerStatuses?: Array<{ name?: string; state?: { terminated?: { message?: string } } }> };
        };
        const message = podObj.status?.containerStatuses?.find((c) => c.name === "recipient")?.state?.terminated?.message;
        const pod = parsePodTerminationMessage(message, this.checkId);
        return { outcome: pod ? "completed" : "error", pod };
      }
      if (now().getTime() >= deadline) return { outcome: "timeout", pod: null };
      await sleep(pollMs);
    }
  }

  async destroy(): Promise<{ deleted: boolean; verifiedAbsent: boolean }> {
    if (!this.touched) return { deleted: true, verifiedAbsent: true };
    const { clients } = this.deps;
    const ns = this.namespace;
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (!isKubeNotFoundError(err)) return false;
      }
      return true;
    };
    const results = await Promise.all([
      attempt(() => clients.batch.deleteNamespacedJob({ namespace: ns, name: this.jobName, propagationPolicy: "Foreground" })),
      attempt(() => clients.core.deleteCollectionNamespacedPod({ namespace: ns, labelSelector: `paperclip.io/check-id=${this.checkId}` })),
      attempt(() => clients.core.deleteNamespacedSecret({ namespace: ns, name: this.secretName })),
      attempt(() =>
        clients.custom.deleteNamespacedCustomObject({ group: "cilium.io", version: "v2", namespace: ns, plural: "ciliumnetworkpolicies", name: this.policyName }),
      ),
    ]);
    const deleted = results.every(Boolean);
    const absent = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return false;
      } catch (err) {
        return isKubeNotFoundError(err);
      }
    };
    let verifiedAbsent = false;
    try {
      const checks = await Promise.all([
        absent(() => clients.batch.readNamespacedJob({ namespace: ns, name: this.jobName })),
        absent(() => clients.core.readNamespacedSecret({ namespace: ns, name: this.secretName })),
        absent(() =>
          clients.custom.getNamespacedCustomObject({ group: "cilium.io", version: "v2", namespace: ns, plural: "ciliumnetworkpolicies", name: this.policyName }),
        ),
        clients.core
          .listNamespacedPod({ namespace: ns, labelSelector: `paperclip.io/check-id=${this.checkId}` })
          .then((r) => ((r as { items?: unknown[] }).items ?? []).length === 0),
      ]);
      verifiedAbsent = checks.every(Boolean);
    } catch {
      verifiedAbsent = false;
    }
    return { deleted, verifiedAbsent };
  }
}

export async function sweepExpiredRecipientLeases(
  clients: KubeClients,
  input: { namespace: string; maxAgeSeconds?: number; now?: () => Date },
): Promise<{ swept: number }> {
  const now = (input.now ?? (() => new Date()))().getTime();
  const maxAgeMs = (input.maxAgeSeconds ?? WARDEN_RECIPE.maxLeaseSeconds) * 1000;
  const selector = `paperclip.io/role=${WARDEN_RECIPIENT_ROLE}`;
  const secrets = (await clients.core.listNamespacedSecret({ namespace: input.namespace, labelSelector: selector })) as {
    items?: Array<{ metadata?: { name?: string; creationTimestamp?: string | Date; labels?: Record<string, string> } }>;
  };
  let swept = 0;
  for (const item of secrets.items ?? []) {
    const checkId = item.metadata?.labels?.["paperclip.io/check-id"];
    const created = item.metadata?.creationTimestamp ? new Date(item.metadata.creationTimestamp).getTime() : 0;
    if (!checkId || now - created < maxAgeMs) continue;
    const ns = input.namespace;
    const ignore = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (!isKubeNotFoundError(err)) throw err;
      }
    };
    await ignore(() => clients.batch.deleteNamespacedJob({ namespace: ns, name: recipientJobName(checkId), propagationPolicy: "Foreground" }));
    await ignore(() => clients.core.deleteCollectionNamespacedPod({ namespace: ns, labelSelector: `paperclip.io/check-id=${checkId}` }));
    await ignore(() => clients.core.deleteNamespacedSecret({ namespace: ns, name: recipientSecretName(checkId) }));
    await ignore(() =>
      clients.custom.deleteNamespacedCustomObject({ group: "cilium.io", version: "v2", namespace: ns, plural: "ciliumnetworkpolicies", name: `${WARDEN_RECIPIENT_POLICY_PREFIX}${checkId}` }),
    );
    swept += 1;
  }
  return { swept };
}
