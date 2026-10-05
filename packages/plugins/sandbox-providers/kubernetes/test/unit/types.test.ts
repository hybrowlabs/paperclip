import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.jobTtlSecondsAfterFinished).toBe(900);
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: false })).toThrow(
      /requires one of `inCluster` or `kubeconfig`/,
    );
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "INVALID UPPER" }),
    ).toThrow();
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });

  describe("tenant quota / limit range", () => {
    const quota = {
      pods: "10",
      requestsCpu: "4",
      requestsMemory: "8Gi",
      limitsCpu: "8",
      limitsMemory: "16Gi",
    };
    const limitRange = {
      defaultCpu: "1",
      defaultMemory: "2Gi",
      defaultRequestCpu: "250m",
      defaultRequestMemory: "512Mi",
      maxCpu: "4",
      maxMemory: "8Gi",
    };

    it("leaves tenantResourceQuota and tenantLimitRange undefined when absent", () => {
      const parsed = parseKubernetesProviderConfig({ inCluster: true });
      expect(parsed.tenantResourceQuota).toBeUndefined();
      expect(parsed.tenantLimitRange).toBeUndefined();
    });

    it("accepts valid tenantResourceQuota and tenantLimitRange", () => {
      const parsed = parseKubernetesProviderConfig({
        inCluster: true,
        tenantResourceQuota: quota,
        tenantLimitRange: limitRange,
      });
      expect(parsed.tenantResourceQuota).toEqual(quota);
      expect(parsed.tenantLimitRange).toEqual(limitRange);
    });

    it.each(["abc", "", "4 CPU", "-1", "1Gb", "1.5.2"])(
      "rejects invalid quantity %j in tenantResourceQuota",
      (bad) => {
        expect(() =>
          parseKubernetesProviderConfig({
            inCluster: true,
            tenantResourceQuota: { ...quota, requestsCpu: bad },
          }),
        ).toThrow(/quantity/i);
      },
    );

    it.each(["0", "-3", "1.5", "ten", ""])("rejects invalid pods count %j", (bad) => {
      expect(() =>
        parseKubernetesProviderConfig({
          inCluster: true,
          tenantResourceQuota: { ...quota, pods: bad },
        }),
      ).toThrow(/pods/i);
    });

    it("rejects invalid quantity in tenantLimitRange", () => {
      expect(() =>
        parseKubernetesProviderConfig({
          inCluster: true,
          tenantLimitRange: { ...limitRange, maxMemory: "lots" },
        }),
      ).toThrow(/quantity/i);
    });

    it("rejects a partial tenantResourceQuota", () => {
      const { limitsMemory: _omit, ...partial } = quota;
      expect(() =>
        parseKubernetesProviderConfig({ inCluster: true, tenantResourceQuota: partial }),
      ).toThrow();
    });
  });
});
