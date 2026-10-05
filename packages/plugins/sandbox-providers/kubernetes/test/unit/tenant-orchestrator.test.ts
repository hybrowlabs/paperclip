import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_LIMIT_RANGE,
  DEFAULT_RESOURCE_QUOTA,
  ensureTenant,
  resolveTenantLimits,
} from "../../src/tenant-orchestrator.js";
import { parseKubernetesProviderConfig } from "../../src/types.js";

function makeMockClients() {
  const calls: { kind: string; name: string; namespace?: string; body?: unknown }[] = [];
  function track(kind: string) {
    return vi.fn(async (...args: unknown[]) => {
      const arg = (args[0] ?? {}) as { name?: string; namespace?: string; body?: unknown };
      calls.push({ kind, name: arg.name ?? "", namespace: arg.namespace, body: arg.body });
      return { body: arg.body };
    });
  }
  return {
    calls,
    core: {
      createNamespace: track("Namespace"),
      readNamespacedServiceAccount: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedServiceAccount: track("ServiceAccount"),
      readNamespacedResourceQuota: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedResourceQuota: track("ResourceQuota"),
      readNamespacedLimitRange: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedLimitRange: track("LimitRange"),
      readNamespace: vi.fn().mockRejectedValue({ code: 404 }),
    },
    rbac: {
      readNamespacedRole: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRole: track("Role"),
      readNamespacedRoleBinding: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRoleBinding: track("RoleBinding"),
    },
    networking: {
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedNetworkPolicy: track("NetworkPolicy"),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedCustomObject: track("CiliumNetworkPolicy"),
    },
  };
}

describe("ensureTenant", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    companyId: "11111111-1111-1111-1111-111111111111",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "20", requestsCpu: "5", requestsMemory: "20Gi", limitsCpu: "20", limitsMemory: "80Gi" },
  };

  it("creates all required resources in the correct order on a fresh tenant", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, baseInput);
    const order = clients.calls.map((c) => c.kind);
    expect(order).toEqual([
      "Namespace",
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "ResourceQuota",
      "LimitRange",
      "NetworkPolicy",
      "NetworkPolicy",
    ]);
  });

  it("creates a CiliumNetworkPolicy instead of standard egress when egressMode=cilium", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" });
    const cnpCall = clients.calls.find((c) => c.kind === "CiliumNetworkPolicy");
    expect(cnpCall).toBeDefined();
    const npCalls = clients.calls.filter((c) => c.kind === "NetworkPolicy");
    expect(npCalls).toHaveLength(1);
    expect((npCalls[0].body as { metadata: { name: string } }).metadata.name).toBe("paperclip-deny-all");
  });

  it("applies serviceAccountAnnotations to the ServiceAccount", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, {
      ...baseInput,
      serviceAccountAnnotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123:role/paperclip" },
    });
    const saCall = clients.calls.find((c) => c.kind === "ServiceAccount");
    const sa = saCall!.body as { metadata: { annotations: Record<string, string> } };
    expect(sa.metadata.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123:role/paperclip");
  });

  it("skips creates that already exist (idempotency)", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue({ body: { metadata: { name: baseInput.namespace } } });
    await ensureTenant(clients as never, baseInput);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
  });

  it("tolerates a 409 AlreadyExists from a concurrent ensure for the same tenant", async () => {
    const clients = makeMockClients();
    // Both racers saw the 404 read; the loser's create returns 409, which means
    // the desired state exists and must not fail the lease acquisition.
    clients.core.createNamespace.mockRejectedValue({ statusCode: 409 });
    clients.core.createNamespacedServiceAccount.mockRejectedValue({ code: 409 });
    await expect(ensureTenant(clients as never, baseInput)).resolves.not.toThrow();
  });
});

describe("ensureTenant LimitRange values", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    companyId: "11111111-1111-1111-1111-111111111111",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: [] as string[],
    egressAllowCidrs: [] as string[],
    resourceQuota: DEFAULT_RESOURCE_QUOTA,
  };

  function limitRangeSpec(clients: ReturnType<typeof makeMockClients>) {
    const call = clients.calls.find((c) => c.kind === "LimitRange");
    return (call!.body as { spec: { limits: Array<Record<string, unknown>> } }).spec.limits[0];
  }

  it("uses the built-in LimitRange defaults when none is supplied", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, baseInput);
    const limit = limitRangeSpec(clients);
    expect(limit.max).toEqual({ cpu: "4", memory: "8Gi" });
    expect(limit.default).toEqual({ cpu: "1", memory: "2Gi" });
    expect(limit.defaultRequest).toEqual({ cpu: "250m", memory: "512Mi" });
    expect(limit.min).toEqual({ cpu: "100m", memory: "128Mi" });
  });

  it("stamps the supplied LimitRange values", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, {
      ...baseInput,
      limitRange: {
        defaultCpu: "500m",
        defaultMemory: "1Gi",
        defaultRequestCpu: "200m",
        defaultRequestMemory: "256Mi",
        maxCpu: "2",
        maxMemory: "4Gi",
      },
    });
    const limit = limitRangeSpec(clients);
    expect(limit.max).toEqual({ cpu: "2", memory: "4Gi" });
    expect(limit.default).toEqual({ cpu: "500m", memory: "1Gi" });
    expect(limit.defaultRequest).toEqual({ cpu: "200m", memory: "256Mi" });
  });

  it("stamps the supplied ResourceQuota values", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, {
      ...baseInput,
      resourceQuota: { pods: "10", requestsCpu: "4", requestsMemory: "8Gi", limitsCpu: "8", limitsMemory: "16Gi" },
    });
    const call = clients.calls.find((c) => c.kind === "ResourceQuota");
    expect((call!.body as { spec: { hard: Record<string, string> } }).spec.hard).toEqual({
      pods: "10",
      "requests.cpu": "4",
      "requests.memory": "8Gi",
      "limits.cpu": "8",
      "limits.memory": "16Gi",
    });
  });
});

describe("resolveTenantLimits", () => {
  it("keeps the existing defaults when config sets nothing", () => {
    const cfg = parseKubernetesProviderConfig({ inCluster: true });
    expect(resolveTenantLimits(cfg)).toEqual({
      resourceQuota: DEFAULT_RESOURCE_QUOTA,
      limitRange: DEFAULT_LIMIT_RANGE,
    });
    expect(DEFAULT_RESOURCE_QUOTA).toEqual({
      pods: "20",
      requestsCpu: "10",
      requestsMemory: "20Gi",
      limitsCpu: "20",
      limitsMemory: "40Gi",
    });
  });

  it("returns the configured values when set", () => {
    const quota = { pods: "10", requestsCpu: "4", requestsMemory: "8Gi", limitsCpu: "8", limitsMemory: "16Gi" };
    const lr = {
      defaultCpu: "1",
      defaultMemory: "2Gi",
      defaultRequestCpu: "250m",
      defaultRequestMemory: "512Mi",
      maxCpu: "4",
      maxMemory: "8Gi",
    };
    const cfg = parseKubernetesProviderConfig({ inCluster: true, tenantResourceQuota: quota, tenantLimitRange: lr });
    expect(resolveTenantLimits(cfg)).toEqual({ resourceQuota: quota, limitRange: lr });
  });
});
