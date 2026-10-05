#!/usr/bin/env -S node --import tsx
import { and, desc, eq, sql } from "drizzle-orm";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  agentConfigRevisions,
  agents,
  createDb,
  environments,
  heartbeatRuns,
  issues,
  projects,
  routineRevisions,
  routineRuns,
  routines,
} from "@paperclipai/db";

const REGION_KEY = "AWS_DEFAULT_REGION";
const TARGET_REGION = "ap-south-2";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RegionBinding = { present: boolean; type: string | null; equalsTarget: boolean | null };

type RegionSource = "agent" | "environment" | "project" | "issue_override" | "unknown";

type RegionSourceInput = {
  agent: RegionBinding;
  environment: RegionBinding;
  project: RegionBinding;
  issueOverride: RegionBinding;
  issueOverrideReplacesEnv: boolean;
  issueOverrideApplicabilityKnown: boolean;
  routinePresent: boolean | null;
  trustedProjectionPresent: boolean | null;
};

export function compareRegionBinding(binding: unknown): RegionBinding {
  if (binding === undefined || binding === null) return { present: false, type: null, equalsTarget: null };
  if (typeof binding === "string") {
    return { present: true, type: "plain", equalsTarget: binding === TARGET_REGION };
  }
  if (typeof binding !== "object" || Array.isArray(binding)) {
    return { present: true, type: "invalid", equalsTarget: null };
  }
  const record = binding as Record<string, unknown>;
  if (record.type !== "plain") {
    const type = record.type === "secret_ref" || record.type === "user_secret_ref" ? record.type : "invalid";
    return { present: true, type, equalsTarget: null };
  }
  return {
    present: true,
    type: "plain",
    equalsTarget: typeof record.value === "string" ? record.value === TARGET_REGION : null,
  };
}

export function summarizeRegionSources(input: RegionSourceInput) {
  // An issue adapterConfig.env replaces the agent env map, even if the issue
  // map omits this key. Project, routine and projection bindings merge later.
  let source: RegionSource = input.agent.present && !input.issueOverrideReplacesEnv ? "agent" : "unknown";
  if (input.issueOverrideReplacesEnv && input.issueOverride.present) source = "issue_override";
  if (input.environment.present && source === "unknown") source = "environment";
  if (input.project.present) source = "project";
  const unresolvedLayer = !input.issueOverrideApplicabilityKnown ||
    input.routinePresent === null || input.trustedProjectionPresent === null;
  if (input.routinePresent === true || input.trustedProjectionPresent === true) {
    return { knownSource: source, effectiveSource: "later_override" };
  }
  return { knownSource: source, effectiveSource: unresolvedLayer ? "inconclusive" : source };
}

export type ComparisonOptions = Record<"agent-id" | "company-id" | "environment-id" | "run-id", string>;

export function parseComparisonArgs(argv: string[]): ComparisonOptions {
  if (argv.length !== 8 || argv.some((arg, index) => index % 2 === 0 && !arg.startsWith("--"))) {
    throw new Error("invalid_arguments");
  }
  const options = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [argv[index * 2]!.slice(2), argv[index * 2 + 1]!]));
  if (Object.keys(options).sort().join(",") !== "agent-id,company-id,environment-id,run-id" ||
    Object.values(options).some((value) => !UUID_RE.test(value))) {
    throw new Error("invalid_arguments");
  }
  return options as ComparisonOptions;
}

export async function runRegionComparison(db: ReturnType<typeof createDb>, options: ComparisonOptions) {
  return db.transaction(async (tx) => {
    const agentEnv = sql`case when jsonb_typeof(${agents.adapterConfig} -> 'env') = 'object'
      then ${agents.adapterConfig} -> 'env' else '{}'::jsonb end`;
    const [agent] = await tx.select({
      id: agents.id,
      region: sql<unknown>`${agentEnv} -> ${REGION_KEY}`,
      envNames: sql<number>`(select count(*)::int from jsonb_object_keys(${agentEnv}))`,
      refCount: sql<number>`(select count(*)::int from jsonb_each(${agentEnv}) as entry where entry.value ->> 'type' = 'secret_ref')`,
    }).from(agents).where(and(eq(agents.id, options["agent-id"]), eq(agents.companyId, options["company-id"])));
    const [run] = await tx.select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      projectId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'projectId'`,
      selectedEnvironmentId: sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'paperclipEnvironment' ->> 'id'`,
      workspaceId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId'`,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, options["run-id"]), eq(heartbeatRuns.companyId, options["company-id"])));
    if (!agent || !run || run.agentId !== agent.id || !run.issueId ||
      !run.selectedEnvironmentId || run.selectedEnvironmentId !== options["environment-id"]) {
      throw new Error("scope_mismatch");
    }
    const [issue] = await tx.select({
      id: issues.id,
      projectId: issues.projectId,
      assigneeAgentId: issues.assigneeAgentId,
      issueOverride: sql<unknown>`${issues.assigneeAdapterOverrides} -> 'adapterConfig' -> 'env' -> ${REGION_KEY}`,
      issueOverrideReplacesEnv: sql<boolean>`coalesce(jsonb_typeof(${issues.assigneeAdapterOverrides} -> 'adapterConfig' -> 'env') = 'object', false)`,
      updatedAt: issues.updatedAt,
      originKind: issues.originKind,
      originId: issues.originId,
      originRunId: issues.originRunId,
    }).from(issues).where(and(eq(issues.id, run.issueId), eq(issues.companyId, options["company-id"])));
    if (!issue || (run.projectId && issue.projectId !== run.projectId)) throw new Error("scope_mismatch");
    const [environment] = await tx.select({
      id: environments.id,
      driver: environments.driver,
      region: sql<unknown>`${environments.envVars} -> ${REGION_KEY}`,
    }).from(environments).where(eq(environments.id, options["environment-id"]));
    if (!environment) throw new Error("scope_mismatch");
    const [project] = issue.projectId
      ? await tx.select({ region: sql<unknown>`${projects.env} -> ${REGION_KEY}` })
          .from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, options["company-id"])))
      : [];
    if (issue.projectId && !project) throw new Error("scope_mismatch");
    let routineRegion: unknown = null;
    let routineSource: "revision" | "current" | "not_applicable" = "not_applicable";
    if (issue.originKind === "routine_execution") {
      if (!issue.originId) throw new Error("scope_mismatch");
      const [routineRun] = issue.originRunId
        ? await tx.select({ revisionId: routineRuns.routineRevisionId })
            .from(routineRuns).where(and(
              eq(routineRuns.id, issue.originRunId),
              eq(routineRuns.routineId, issue.originId),
              eq(routineRuns.companyId, options["company-id"]),
            ))
        : [];
      const [revision] = routineRun?.revisionId
        ? await tx.select({
            region: sql<unknown>`${routineRevisions.snapshot} -> 'routine' -> 'env' -> ${REGION_KEY}`,
            version: sql<string | null>`${routineRevisions.snapshot} ->> 'version'`,
          })
            .from(routineRevisions).where(and(
              eq(routineRevisions.id, routineRun.revisionId),
              eq(routineRevisions.routineId, issue.originId),
              eq(routineRevisions.companyId, options["company-id"]),
            ))
        : [];
      const [currentRoutine] = await tx.select({ region: sql<unknown>`${routines.env} -> ${REGION_KEY}` })
        .from(routines).where(and(eq(routines.id, issue.originId), eq(routines.companyId, options["company-id"])));
      if (!currentRoutine) throw new Error("scope_mismatch");
      routineSource = revision?.version === "1" ? "revision" : "current";
      routineRegion = routineSource === "revision" ? revision!.region : currentRoutine.region;
    }
    const [revision] = await tx.select({
      id: agentConfigRevisions.id,
      createdAt: agentConfigRevisions.createdAt,
      source: agentConfigRevisions.source,
    }).from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.agentId, agent.id),
      eq(agentConfigRevisions.companyId, options["company-id"]),
    )).orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id)).limit(1);
    const bindings = {
      agent: compareRegionBinding(agent.region),
      environment: compareRegionBinding(environment.region),
      project: compareRegionBinding(project?.region),
      issueOverride: compareRegionBinding(issue.issueOverride),
      routine: compareRegionBinding(routineRegion),
    };
    return {
      comparison: bindings,
      source: summarizeRegionSources({
        ...bindings,
        issueOverrideReplacesEnv: issue.assigneeAgentId === agent.id && issue.issueOverrideReplacesEnv,
        issueOverrideApplicabilityKnown: issue.assigneeAgentId === agent.id || !issue.issueOverrideReplacesEnv,
        routinePresent: bindings.routine.present,
        trustedProjectionPresent: null,
      }),
      issueOverrideReplacesEnv: issue.issueOverrideReplacesEnv,
      issueOverrideApplicableNow: issue.assigneeAgentId === agent.id,
      issueChangedAfterRun: issue.updatedAt > (run.startedAt ?? run.createdAt),
      routineSource,
      selectedEnvironmentId: environment.id,
      selectedEnvironmentDriver: environment.driver,
      historicalRunEnvironmentMatch: true,
      historicalRunProjection: "inconclusive",
      historicalRunRoutine: issue.originKind === "routine_execution" ? bindings.routine.present : "not_applicable",
      runIssueId: issue.id,
      runWorkspaceRecorded: Boolean(run.workspaceId),
      latestRevision: revision ? { id: revision.id, createdAt: revision.createdAt, source: revision.source } : null,
      agentEnvNameCount: Number(agent.envNames),
      agentSecretRefCount: Number(agent.refCount),
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function main() {
  const options = parseComparisonArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("database_url_required");
  const db = createDb(databaseUrl);
  try {
    console.log(JSON.stringify(await runRegionComparison(db, options)));
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => {
    // Deliberately do not print database errors, SQL arguments, or config data.
    console.error("forge_region_comparison_failed");
    process.exitCode = 1;
  });
}
