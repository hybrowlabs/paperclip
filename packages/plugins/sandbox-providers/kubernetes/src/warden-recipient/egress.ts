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

type CiliumRule = Record<string, unknown> & { endpointSelector?: Selector };

interface CiliumItem {
  metadata?: { name?: string };
  spec?: CiliumRule;
  specs?: CiliumRule[];
}

export interface EgressListing {
  networkPolicies: Array<{ metadata?: { name?: string }; spec?: { podSelector?: Selector; policyTypes?: string[]; egress?: unknown[] } }>;
  ciliumPolicies: CiliumItem[];
  ciliumClusterwidePolicies: CiliumItem[];
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenRule(rule: unknown, depth = 0): CiliumRule[] {
  if (!isObject(rule) || depth > 8) throw new EgressConstraintError("egress_unverifiable");
  const out: CiliumRule[] = [rule as CiliumRule];
  const nested = rule.specs;
  if (nested !== undefined && nested !== null) {
    if (!Array.isArray(nested)) throw new EgressConstraintError("egress_unverifiable");
    for (const child of nested) out.push(...flattenRule(child, depth + 1));
  }
  return out;
}

function ciliumRules(item: CiliumItem): CiliumRule[] {
  const rules: CiliumRule[] = [];
  const hasSpec = item.spec !== undefined && item.spec !== null;
  const hasSpecs = item.specs !== undefined && item.specs !== null;
  if (!hasSpec && !hasSpecs) throw new EgressConstraintError("egress_unverifiable");
  if (hasSpec) rules.push(...flattenRule(item.spec));
  if (hasSpecs) {
    if (!Array.isArray(item.specs)) throw new EgressConstraintError("egress_unverifiable");
    for (const rule of item.specs) rules.push(...flattenRule(rule));
  }
  return rules;
}

function ruleWidensEgress(rule: CiliumRule): boolean {
  return CILIUM_EGRESS_KEYS.some((k) => {
    const v = rule[k];
    if (v === undefined || v === null) return false;
    if (k === "egress" && Array.isArray(v)) return v.length > 0;
    return true;
  });
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
    const isOurs =
      cnp.metadata?.name === expectedName &&
      (cnp.specs === undefined || cnp.specs === null) &&
      isObject(cnp.spec) &&
      stable(cnp.spec) === expectedSpec;
    if (isOurs) {
      if (selectsCilium(cnp.spec?.endpointSelector, input.podLabels, input.namespace)) ours += 1;
      continue;
    }
    for (const rule of ciliumRules(cnp)) {
      if (!selectsCilium(rule.endpointSelector, input.podLabels, input.namespace)) continue;
      if (ruleWidensEgress(rule)) throw new EgressConstraintError("egress_not_effective");
    }
  }
  for (const ccnp of input.listing.ciliumClusterwidePolicies) {
    for (const rule of ciliumRules(ccnp)) {
      if (!selectsCilium(rule.endpointSelector, input.podLabels, input.namespace)) continue;
      if (ruleWidensEgress(rule)) throw new EgressConstraintError("egress_not_effective");
    }
  }
  if (ours !== 1) throw new EgressConstraintError("egress_not_effective");
}

export function assertEgressModeSupported(mode: string): void {
  if (mode !== "cilium") throw new EgressConstraintError("missing_egress_constraint");
}
