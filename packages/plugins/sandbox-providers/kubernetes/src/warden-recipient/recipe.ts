import { z } from "zod";

export const WARDEN_RECIPE = Object.freeze({
  version: "warden-uat-aws-v1",
  region: "ap-south-2",
  expectedPrincipalArn: "arn:aws:iam::312019941175:user/warden-uat-validate",
  codebuildProject: "frappe-hrms",
  eksCluster: "frappe-hrms-eks-uat",
  endpoints: Object.freeze([
    "sts.ap-south-2.amazonaws.com",
    "codebuild.ap-south-2.amazonaws.com",
    "eks.ap-south-2.amazonaws.com",
  ]),
  allowedEnvKeys: Object.freeze(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]),
  approvedBindings: Object.freeze({
    AWS_ACCESS_KEY_ID: Object.freeze({ name: "aws/warden-uat-validate/id", delivery: "env" }),
    AWS_SECRET_ACCESS_KEY: Object.freeze({ name: "aws/warden-uat-validate/secret", delivery: "env" }),
  }),
  maxLeaseSeconds: 900,
  defaultDeadlineSeconds: 120,
  resultMaxBytes: 512,
});

export type Tri = "PASS" | "FAIL" | "INCONCLUSIVE";
export const triSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);

export const podResultSchema = z
  .object({
    v: z.literal(1),
    recipe: z.literal(WARDEN_RECIPE.version),
    checkId: z.string().uuid(),
    expectedPrincipalMatch: triSchema,
    codebuildProjectFound: triSchema,
    eksClusterActive: triSchema,
  })
  .strict();
export type PodResult = z.infer<typeof podResultSchema>;

export interface AwsReadPort {
  getCallerIdentityArn(signal: AbortSignal): Promise<string>;
  codebuildProjectExists(project: string, signal: AbortSignal): Promise<boolean>;
  eksClusterStatus(cluster: string, signal: AbortSignal): Promise<string>;
}

export async function runFixedRecipe(aws: AwsReadPort, checkId: string, signal: AbortSignal): Promise<PodResult> {
  const base = {
    v: 1 as const,
    recipe: WARDEN_RECIPE.version,
    checkId,
    expectedPrincipalMatch: "INCONCLUSIVE" as Tri,
    codebuildProjectFound: "INCONCLUSIVE" as Tri,
    eksClusterActive: "INCONCLUSIVE" as Tri,
  };
  try {
    const arn = await aws.getCallerIdentityArn(signal);
    base.expectedPrincipalMatch = arn === WARDEN_RECIPE.expectedPrincipalArn ? "PASS" : "FAIL";
  } catch {
    return base;
  }
  if (base.expectedPrincipalMatch !== "PASS") return base;
  try {
    base.codebuildProjectFound = (await aws.codebuildProjectExists(WARDEN_RECIPE.codebuildProject, signal)) ? "PASS" : "FAIL";
  } catch {
    base.codebuildProjectFound = "INCONCLUSIVE";
  }
  try {
    base.eksClusterActive = (await aws.eksClusterStatus(WARDEN_RECIPE.eksCluster, signal)) === "ACTIVE" ? "PASS" : "FAIL";
  } catch {
    base.eksClusterActive = "INCONCLUSIVE";
  }
  return base;
}

export function parsePodTerminationMessage(raw: unknown, expectedCheckId: string): PodResult | null {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > WARDEN_RECIPE.resultMaxBytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = podResultSchema.safeParse(json);
  if (!parsed.success || parsed.data.checkId !== expectedCheckId) return null;
  return parsed.data;
}

export const aliasProjectionSchema = z
  .object({
    authority: z.boolean(),
    accessKeyId: z.object({ name: z.string(), delivery: z.string() }).strict().nullable(),
    secretAccessKey: z.object({ name: z.string(), delivery: z.string() }).strict().nullable(),
    oldMappingsPresent: z.boolean(),
  })
  .strict();
export type AliasProjection = z.infer<typeof aliasProjectionSchema>;

export function reduceAliasPredicate(projection: unknown): Tri {
  const parsed = aliasProjectionSchema.safeParse(projection);
  if (!parsed.success || !parsed.data.authority) return "INCONCLUSIVE";
  const p = parsed.data;
  const want = WARDEN_RECIPE.approvedBindings;
  if (!p.accessKeyId || !p.secretAccessKey) return "FAIL";
  const ok =
    p.accessKeyId.name === want.AWS_ACCESS_KEY_ID.name &&
    p.accessKeyId.delivery === want.AWS_ACCESS_KEY_ID.delivery &&
    p.secretAccessKey.name === want.AWS_SECRET_ACCESS_KEY.name &&
    p.secretAccessKey.delivery === want.AWS_SECRET_ACCESS_KEY.delivery &&
    !p.oldMappingsPresent;
  return ok ? "PASS" : "FAIL";
}

export function reduceOverall(predicates: Tri[]): Tri {
  if (predicates.includes("FAIL")) return "FAIL";
  return predicates.every((p) => p === "PASS") ? "PASS" : "INCONCLUSIVE";
}
