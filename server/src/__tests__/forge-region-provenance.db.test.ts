import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentConfigRevisions,
  agents,
  companies,
  createDb,
  environments,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { parseComparisonArgs, runRegionComparison } from "../forge-region-provenance.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SYNTHETIC_SECRET_ID = "11111111-2222-4333-8444-555555555555";
const SYNTHETIC_OTHER_REGION = "synthetic-region-9";

describeEmbeddedPostgres("Forge region comparator against the real schema", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("forge-region-provenance");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  async function seed(input: { agentRegion: string; environmentRegion?: string; projectRegion?: string }) {
    const company = await db.insert(companies).values({
      name: `Synthetic ${randomUUID()}`,
      issuePrefix: `SY${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const env: Record<string, unknown> = {
      AWS_DEFAULT_REGION: { type: "plain", value: input.agentRegion },
      OTHER_PLAIN: { type: "plain", value: "synthetic" },
      AWS_ACCESS_KEY_ID: { type: "secret_ref", secretId: SYNTHETIC_SECRET_ID, version: "latest" },
    };
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { model: "synthetic-model", env },
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    const project = await db.insert(projects).values({
      companyId: company.id,
      name: `Project ${randomUUID()}`,
      env: input.projectRegion ? { AWS_DEFAULT_REGION: { type: "plain", value: input.projectRegion } } : null,
    }).returning().then((rows) => rows[0]!);
    const environment = await db.insert(environments).values({
      name: `Env ${randomUUID()}`,
      driver: "ssh",
      envVars: input.environmentRegion
        ? { AWS_DEFAULT_REGION: { type: "plain", value: input.environmentRegion } }
        : {},
    }).returning().then((rows) => rows[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id,
      projectId: project.id,
      title: "Synthetic region check",
      status: "in_progress",
      assigneeAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date(Date.now() + 60_000),
      contextSnapshot: {
        issueId: issue.id,
        projectId: project.id,
        paperclipEnvironment: { id: environment.id },
      },
    }).returning().then((rows) => rows[0]!);
    const revision = await db.insert(agentConfigRevisions).values({
      companyId: company.id,
      agentId: agent.id,
      source: "patch",
      changedKeys: ["env"],
      beforeConfig: {},
      afterConfig: { env },
    }).returning().then((rows) => rows[0]!);
    return {
      options: parseComparisonArgs([
        "--company-id", company.id,
        "--agent-id", agent.id,
        "--environment-id", environment.id,
        "--run-id", run.id,
      ]),
      revisionId: revision.id,
    };
  }

  it("reports a later project override that defeats a correct agent value, without leaking values", async () => {
    const { options, revisionId } = await seed({ agentRegion: "ap-south-2", projectRegion: SYNTHETIC_OTHER_REGION });
    const report = await runRegionComparison(db, options);
    expect(report.comparison.agent).toEqual({ present: true, type: "plain", equalsTarget: true });
    expect(report.comparison.project).toEqual({ present: true, type: "plain", equalsTarget: false });
    expect(report.comparison.environment).toEqual({ present: false, type: null, equalsTarget: null });
    expect(report.source).toEqual({ knownSource: "project", effectiveSource: "inconclusive" });
    expect(report.latestRevision?.id).toBe(revisionId);
    expect(report.agentEnvNameCount).toBe(3);
    expect(report.agentSecretRefCount).toBe(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SYNTHETIC_OTHER_REGION);
    expect(serialized).not.toContain(SYNTHETIC_SECRET_ID);
    expect(serialized).not.toContain("synthetic-model");
  });

  it("reports a stale stored agent value when no override is present", async () => {
    const { options } = await seed({ agentRegion: SYNTHETIC_OTHER_REGION, environmentRegion: "ap-south-2" });
    const report = await runRegionComparison(db, options);
    expect(report.comparison.agent.equalsTarget).toBe(false);
    expect(report.comparison.environment.equalsTarget).toBe(true);
    expect(report.source.knownSource).toBe("agent");
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_OTHER_REGION);
  });

  it("refuses an environment that the run did not select", async () => {
    const { options } = await seed({ agentRegion: "ap-south-2" });
    await expect(runRegionComparison(db, { ...options, "environment-id": randomUUID() }))
      .rejects.toThrow("scope_mismatch");
  });

  it("runs inside a read-only transaction", async () => {
    const { options } = await seed({ agentRegion: "ap-south-2" });
    const original = db.transaction.bind(db);
    let readOnly: unknown;
    let config: unknown;
    const spy = vi.spyOn(db, "transaction").mockImplementation(((fn: any, txConfig: any) => {
      config = txConfig;
      return original(async (tx) => {
        readOnly = (await tx.execute(sql`show transaction_read_only`))[0];
        return fn(tx);
      }, txConfig);
    }) as typeof db.transaction);
    try {
      await expect(runRegionComparison(db, options)).resolves.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect(config).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    expect(readOnly).toMatchObject({ transaction_read_only: "on" });
  });

  it("rejects malformed arguments", () => {
    expect(() => parseComparisonArgs(["--agent-id", "x"])).toThrow("invalid_arguments");
  });
});
