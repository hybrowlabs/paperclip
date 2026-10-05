import { describe, expect, it } from "vitest";
import { compareRegionBinding, summarizeRegionSources } from "./forge-region-provenance.js";

describe("sanitized Forge region comparison", () => {
  it("distinguishes missing, matching, nonmatching and non-plain bindings", () => {
    expect(compareRegionBinding(undefined)).toEqual({ present: false, type: null, equalsTarget: null });
    expect(compareRegionBinding({ type: "plain", value: "ap-south-2" })).toEqual({ present: true, type: "plain", equalsTarget: true });
    expect(compareRegionBinding({ type: "plain", value: "other" })).toEqual({ present: true, type: "plain", equalsTarget: false });
    expect(compareRegionBinding({ type: "secret_ref", secretId: "synthetic" })).toEqual({ present: true, type: "secret_ref", equalsTarget: null });
    expect(compareRegionBinding({ type: "plain" })).toEqual({ present: true, type: "plain", equalsTarget: null });
  });

  it("does not assert the effective historical run source when later layers are unknown", () => {
    const agent = compareRegionBinding({ type: "plain", value: "ap-south-2" });
    const environment = compareRegionBinding({ type: "plain", value: "other" });
    const project = compareRegionBinding(undefined);
    const issueOverride = compareRegionBinding(undefined);
    const sources = { agent, environment, project, issueOverride, issueOverrideReplacesEnv: false, issueOverrideApplicabilityKnown: true, routinePresent: false };
    expect(summarizeRegionSources({ ...sources, trustedProjectionPresent: null })).toEqual({
      knownSource: "agent",
      effectiveSource: "inconclusive",
    });
    expect(summarizeRegionSources({ ...sources, project: compareRegionBinding({ type: "plain", value: "other" }), trustedProjectionPresent: false })).toEqual({
      knownSource: "project",
      effectiveSource: "project",
    });
    expect(summarizeRegionSources({ ...sources, issueOverrideReplacesEnv: true, trustedProjectionPresent: false })).toEqual({
      knownSource: "environment",
      effectiveSource: "environment",
    });
    expect(summarizeRegionSources({ ...sources, issueOverrideReplacesEnv: true, issueOverrideApplicabilityKnown: false, trustedProjectionPresent: false })).toEqual({
      knownSource: "environment",
      effectiveSource: "inconclusive",
    });
  });
});
