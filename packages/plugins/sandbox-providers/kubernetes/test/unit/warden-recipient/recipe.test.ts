import { describe, expect, it, vi } from "vitest";
import { WARDEN_RECIPE, createFixedAwsReadPort, parsePodTerminationMessage, runFixedRecipe, signRequest, type AwsReadPort } from "../../../src/warden-recipient/index.js";

const CHECK = "11111111-1111-4111-8111-111111111111";
const signal = new AbortController().signal;

function port(over: Partial<AwsReadPort> = {}): AwsReadPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getCallerIdentityArn: vi.fn(async () => { calls.push("sts"); return WARDEN_RECIPE.expectedPrincipalArn; }),
    codebuildProjectExists: vi.fn(async (p) => { calls.push(`cb:${p}`); return true; }),
    eksClusterStatus: vi.fn(async (c) => { calls.push(`eks:${c}`); return "ACTIVE"; }),
    ...over,
  };
}

describe("fixed AWS recipe", () => {
  it("passes with exact principal/project/cluster", async () => {
    const p = port();
    expect(await runFixedRecipe(p, CHECK, signal)).toMatchObject({ expectedPrincipalMatch: "PASS", codebuildProjectFound: "PASS", eksClusterActive: "PASS" });
    expect(p.calls).toEqual(["sts", "cb:frappe-hrms", "eks:frappe-hrms-eks-uat"]);
  });
  it("identity mismatch FAILs and skips later reads", async () => {
    const p = port({ getCallerIdentityArn: vi.fn(async () => "arn:aws:iam::312019941175:user/other") });
    const r = await runFixedRecipe(p, CHECK, signal);
    expect(r).toMatchObject({ expectedPrincipalMatch: "FAIL", codebuildProjectFound: "INCONCLUSIVE", eksClusterActive: "INCONCLUSIVE" });
    expect(p.codebuildProjectExists).not.toHaveBeenCalled();
    expect(p.eksClusterStatus).not.toHaveBeenCalled();
  });
  it("AccessDenied/timeout on STS is INCONCLUSIVE, never PASS", async () => {
    const p = port({ getCallerIdentityArn: vi.fn(async () => { throw new Error("AccessDenied"); }) });
    expect(await runFixedRecipe(p, CHECK, signal)).toMatchObject({ expectedPrincipalMatch: "INCONCLUSIVE" });
    expect(p.codebuildProjectExists).not.toHaveBeenCalled();
  });
  it("errors on CodeBuild/EKS are INCONCLUSIVE; absent project / non-ACTIVE cluster FAIL", async () => {
    expect(await runFixedRecipe(port({ codebuildProjectExists: vi.fn(async () => { throw new Error("x"); }) }), CHECK, signal)).toMatchObject({ codebuildProjectFound: "INCONCLUSIVE", eksClusterActive: "PASS" });
    expect(await runFixedRecipe(port({ codebuildProjectExists: vi.fn(async () => false), eksClusterStatus: vi.fn(async () => "CREATING") }), CHECK, signal)).toMatchObject({ codebuildProjectFound: "FAIL", eksClusterActive: "FAIL" });
  });
  it("result carries only the fixed schema and parses strictly", () => {
    const good = JSON.stringify({ v: 1, recipe: WARDEN_RECIPE.version, checkId: CHECK, expectedPrincipalMatch: "PASS", codebuildProjectFound: "PASS", eksClusterActive: "PASS" });
    expect(parsePodTerminationMessage(good, CHECK)).not.toBeNull();
    expect(parsePodTerminationMessage(good.replace("}", ',"arn":"x"}'), CHECK)).toBeNull();
    expect(parsePodTerminationMessage("not json", CHECK)).toBeNull();
    expect(parsePodTerminationMessage(undefined, CHECK)).toBeNull();
  });
});

describe("fixed SigV4 read port", () => {
  const creds = { accessKeyId: "AKSYNTH", secretAccessKey: "synthsecret" };
  const now = () => new Date("2026-10-04T12:00:00Z");
  it("calls only the three allowed read operations on the three allowed hosts", async () => {
    const seen: Array<{ url: string; method: string; target?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      seen.push({ url, method: init.method, target: init.headers["x-amz-target"] });
      if (url.includes("sts.")) return { ok: true, status: 200, text: async () => JSON.stringify({ GetCallerIdentityResponse: { GetCallerIdentityResult: { Arn: WARDEN_RECIPE.expectedPrincipalArn } } }) };
      if (url.includes("codebuild.")) return { ok: true, status: 200, text: async () => JSON.stringify({ projects: [{ name: "frappe-hrms" }] }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ cluster: { status: "ACTIVE" } }) };
    });
    const p = createFixedAwsReadPort({ ...creds, fetchImpl, now });
    const r = await runFixedRecipe(p, CHECK, signal);
    expect(r.expectedPrincipalMatch).toBe("PASS");
    expect(seen).toEqual([
      { url: "https://sts.ap-south-2.amazonaws.com/", method: "POST", target: undefined },
      { url: "https://codebuild.ap-south-2.amazonaws.com/", method: "POST", target: "CodeBuild_20161006.BatchGetProjects" },
      { url: "https://eks.ap-south-2.amazonaws.com/clusters/frappe-hrms-eks-uat", method: "GET", target: undefined },
    ]);
  });
  it("refuses other projects/clusters", async () => {
    const p = createFixedAwsReadPort({ ...creds, fetchImpl: vi.fn(), now });
    await expect(p.codebuildProjectExists("other", signal)).rejects.toThrow("target_not_allowed");
    await expect(p.eksClusterStatus("other", signal)).rejects.toThrow("target_not_allowed");
  });
  it("non-2xx is an error (INCONCLUSIVE upstream), no body leaks into the thrown error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => "SECRET-BODY synthsecret" }));
    const p = createFixedAwsReadPort({ ...creds, fetchImpl, now });
    const err = await p.getCallerIdentityArn(signal).then(() => null, (e) => e);
    expect(String(err)).not.toContain("SECRET-BODY");
    expect(String(err)).not.toContain("synthsecret");
  });
  it("signature is deterministic and carries scope for ap-south-2", () => {
    const req = signRequest({ service: "sts", host: "sts.ap-south-2.amazonaws.com", method: "POST", path: "/", body: "Action=GetCallerIdentity&Version=2011-06-15", now: now(), ...creds });
    expect(req.headers.authorization).toContain("Credential=AKSYNTH/20261004/ap-south-2/sts/aws4_request");
    expect(req.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(req.headers)).not.toContain("synthsecret");
  });
});
