import { createHash, createHmac } from "node:crypto";
import { WARDEN_RECIPE, type AwsReadPort } from "./recipe.js";

const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

export interface SignedRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string;
}

export function signRequest(input: {
  service: string;
  host: string;
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): SignedRequest {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(input.headers ?? {}), host: input.host, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method, input.path, "", canonicalHeaders, signedHeaders, sha256Hex(input.body)].join("\n");
  const scope = `${dateStamp}/${WARDEN_RECIPE.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), WARDEN_RECIPE.region), input.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: `https://${input.host}${input.path}`,
    method: input.method,
    headers: { ...lower, authorization },
    body: input.body,
  };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HOSTS = {
  sts: "sts.ap-south-2.amazonaws.com",
  codebuild: "codebuild.ap-south-2.amazonaws.com",
  eks: "eks.ap-south-2.amazonaws.com",
} as const;

export function createFixedAwsReadPort(input: {
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl: FetchLike;
  now?: () => Date;
}): AwsReadPort {
  const now = input.now ?? (() => new Date());
  const send = async (req: SignedRequest, signal: AbortSignal) => {
    const host = new URL(req.url).host;
    if (!(WARDEN_RECIPE.endpoints as readonly string[]).includes(host)) throw new Error("endpoint_not_allowed");
    const res = await input.fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.method === "POST" ? req.body : undefined, signal });
    return { status: res.status, ok: res.ok, text: await res.text() };
  };
  const creds = { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
  return {
    async getCallerIdentityArn(signal) {
      const body = "Action=GetCallerIdentity&Version=2011-06-15";
      const res = await send(
        signRequest({ service: "sts", host: HOSTS.sts, method: "POST", path: "/", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json" }, body, now: now(), ...creds }),
        signal,
      );
      if (!res.ok) throw new Error("sts_failed");
      const arn = (JSON.parse(res.text) as { GetCallerIdentityResponse?: { GetCallerIdentityResult?: { Arn?: unknown } } }).GetCallerIdentityResponse?.GetCallerIdentityResult?.Arn;
      if (typeof arn !== "string") throw new Error("sts_shape");
      return arn;
    },
    async codebuildProjectExists(project, signal) {
      if (project !== WARDEN_RECIPE.codebuildProject) throw new Error("target_not_allowed");
      const body = JSON.stringify({ names: [project] });
      const res = await send(
        signRequest({ service: "codebuild", host: HOSTS.codebuild, method: "POST", path: "/", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "CodeBuild_20161006.BatchGetProjects" }, body, now: now(), ...creds }),
        signal,
      );
      if (!res.ok) throw new Error("codebuild_failed");
      const parsed = JSON.parse(res.text) as { projects?: Array<{ name?: unknown }> };
      return Array.isArray(parsed.projects) && parsed.projects.some((p) => p.name === project);
    },
    async eksClusterStatus(cluster, signal) {
      if (cluster !== WARDEN_RECIPE.eksCluster) throw new Error("target_not_allowed");
      const res = await send(
        signRequest({ service: "eks", host: HOSTS.eks, method: "GET", path: `/clusters/${cluster}`, headers: { accept: "application/json" }, body: "", now: now(), ...creds }),
        signal,
      );
      if (!res.ok) throw new Error("eks_failed");
      const status = (JSON.parse(res.text) as { cluster?: { status?: unknown } }).cluster?.status;
      if (typeof status !== "string") throw new Error("eks_shape");
      return status;
    },
  };
}
