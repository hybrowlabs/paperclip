import { WARDEN_RECIPE } from "./recipe.js";

export const WARDEN_RECIPIENT_ROLE = "warden-recipient";
export const WARDEN_RECIPIENT_POLICY_PREFIX = "wr-egress-";

export class EgressConstraintError extends Error {
  constructor(readonly code: "missing_egress_constraint" | "egress_not_effective" | "egress_unverifiable") {
    super(code);
    this.name = "EgressConstraintError";
  }
}

export function buildWardenRecipientEgressPolicy(input: { namespace: string; checkId: string }): Record<string, unknown> {
  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: `${WARDEN_RECIPIENT_POLICY_PREFIX}${input.checkId}`,
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin", "paperclip.io/check-id": input.checkId },
    },
    spec: {
      endpointSelector: { matchLabels: { "paperclip.io/check-id": input.checkId, "paperclip.io/role": WARDEN_RECIPIENT_ROLE } },
      egress: [
        {
          toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } }],
          toPorts: [
            {
              ports: [
                { port: "53", protocol: "UDP" },
                { port: "53", protocol: "TCP" },
              ],
              rules: { dns: WARDEN_RECIPE.endpoints.map((matchName) => ({ matchName })) },
            },
          ],
        },
        {
          toFQDNs: WARDEN_RECIPE.endpoints.map((matchName) => ({ matchName })),
          toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
        },
      ],
    },
  };
}

interface Selector {
  matchLabels?: Record<string, string>;
  matchExpressions?: unknown[];
}

const CILIUM_NAMESPACE_LABEL = "io.kubernetes.pod.namespace";

function selects(selector: Selector | undefined, labels: Record<string, string>): boolean {
  if (!selector) return true;
  if (selector.matchExpressions && selector.matchExpressions.length > 0) return true;
  return Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v);
}

function selectsCilium(selector: Selector | undefined, labels: Record<string, string>, namespace: string): boolean {
  if (!selector) return true;
  if (selector.matchExpressions && selector.matchExpressions.length > 0) return true;
  return Object.entries(selector.matchLabels ?? {}).every(([rawKey, value]) => {
    let key = rawKey;
    const sep = key.indexOf(":");
    if (sep >= 0) {
      const source = key.slice(0, sep);
      if (source !== "k8s" && source !== "any") return true;
      key = key.slice(sep + 1);
    }
    if (key === CILIUM_NAMESPACE_LABEL) return value === namespace;
    if (key.startsWith("io.cilium.") || key.startsWith("io.kubernetes.")) return true;
    return labels[key] === value;
  });
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export interface EgressListing {
  networkPolicies: Array<{ metadata?: { name?: string }; spec?: { podSelector?: Selector; policyTypes?: string[]; egress?: unknown[] } }>;
  ciliumPolicies: Array<{ metadata?: { name?: string }; spec?: Record<string, unknown> & { endpointSelector?: Selector } }>;
  ciliumClusterwidePolicies: Array<{ metadata?: { name?: string }; spec?: Record<string, unknown> & { endpointSelector?: Selector } }>;
}

const CILIUM_EGRESS_KEYS = [
  "egress",
  "egressDeny",
  "toEndpoints",
  "toCIDR",
  "toCIDRSet",
  "toEntities",
  "toFQDNs",
  "toServices",
  "toGroups",
];

function ciliumRuleSets(spec: Record<string, unknown> | undefined): unknown[] {
  if (!spec) return [];
  const rules: unknown[] = [];
  if (spec.egress) rules.push(...(spec.egress as unknown[]));
  const specs = spec.specs as Array<Record<string, unknown>> | undefined;
  for (const s of specs ?? []) rules.push(...ciliumRuleSets(s));
  return rules;
}

export function verifyEffectiveEgress(input: {
  expectedPolicy: Record<string, unknown>;
  podLabels: Record<string, string>;
  namespace: string;
  listing: EgressListing;
}): void {
  const expectedName = (input.expectedPolicy.metadata as { name: string }).name;
  const expectedSpec = stable(input.expectedPolicy.spec);

  if (input.podLabels["paperclip.io/role"] !== WARDEN_RECIPIENT_ROLE) throw new EgressConstraintError("egress_not_effective");

  let ours = 0;
  for (const np of input.listing.networkPolicies) {
    if (!selects(np.spec?.podSelector, input.podLabels)) continue;
    if ((np.spec?.egress?.length ?? 0) > 0) throw new EgressConstraintError("egress_not_effective");
  }
  for (const cnp of input.listing.ciliumPolicies) {
    if (!selectsCilium(cnp.spec?.endpointSelector, input.podLabels, input.namespace)) continue;
    if (cnp.metadata?.name === expectedName && stable(cnp.spec) === expectedSpec) {
      ours += 1;
      continue;
    }
    if (ciliumRuleSets(cnp.spec).length > 0 || CILIUM_EGRESS_KEYS.some((k) => cnp.spec && k !== "egress" && k in cnp.spec)) {
      throw new EgressConstraintError("egress_not_effective");
    }
  }
  for (const ccnp of input.listing.ciliumClusterwidePolicies) {
    if (!selectsCilium(ccnp.spec?.endpointSelector, input.podLabels, input.namespace)) continue;
    if (ciliumRuleSets(ccnp.spec).length > 0) throw new EgressConstraintError("egress_not_effective");
  }
  if (ours !== 1) throw new EgressConstraintError("egress_not_effective");
}

export function assertEgressModeSupported(mode: string): void {
  if (mode !== "cilium") throw new EgressConstraintError("missing_egress_constraint");
}
