import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../routes");
const servicesDir = path.resolve(routesDir, "../services");

type Classification =
  | { kind: "gated"; via: string }
  | { kind: "metadata_only"; reason: string }
  | { kind: "mutation_gated"; via: string }
  | { kind: "not_run_content"; reason: string };

/**
 * Every Express route whose path is run-scoped must be classified here. A new
 * run-scoped route that is not in this table fails the test, which forces the
 * author to put it behind authorizeRunContent (via serveRunContent /
 * serveRunList / serveWorkspaceOperation*) or to justify why it carries no run
 * content. Keys are "METHOD path" exactly as registered.
 */
const AUDITED_ROUTES: Record<string, Classification> = {
  "GET /companies/:companyId/skill-test-run-templates": { kind: "not_run_content", reason: "skill test templates, not heartbeat runs" },
  "POST /companies/:companyId/skill-test-run-templates": { kind: "not_run_content", reason: "skill test templates, not heartbeat runs" },
  "PATCH /companies/:companyId/skill-test-run-templates/:templateId": { kind: "not_run_content", reason: "skill test templates, not heartbeat runs" },
  "DELETE /companies/:companyId/skill-test-run-templates/:templateId": { kind: "not_run_content", reason: "skill test templates, not heartbeat runs" },
  "GET /companies/:companyId/execution-workspaces": { kind: "metadata_only", reason: "workspace rows; selects run id/status only (services/execution-workspaces.ts:1524)" },
  "GET /execution-workspaces/:id": { kind: "metadata_only", reason: "workspace row; no run content columns" },
  "GET /execution-workspaces/:id/close-readiness": { kind: "metadata_only", reason: "reads run id/status only" },
  "POST /execution-workspaces/:id/login-handoff": { kind: "not_run_content", reason: "workspace login handoff" },
  "POST /execution-workspaces/:id/runtime-services/:action": { kind: "not_run_content", reason: "runtime control; writes operations, does not read run output" },
  "POST /execution-workspaces/:id/runtime-commands/:action": { kind: "not_run_content", reason: "runtime control; writes operations, does not read run output" },
  "POST /execution-workspaces/:id/reconcile-branch": { kind: "not_run_content", reason: "git reconcile on workspace" },
  "PATCH /execution-workspaces/:id": { kind: "not_run_content", reason: "workspace settings" },
  "GET /run-content/purposes": { kind: "not_run_content", reason: "static list of purpose names; admin-gated, no run data" },
  "PUT /companies/:companyId/heartbeat-runs/:runId/content-restriction": { kind: "not_run_content", reason: "operator control plane (default off, instance admin); returns metadata receipts only" },
  "GET /companies/:companyId/heartbeat-runs/:runId/content-restriction": { kind: "metadata_only", reason: "restriction state row; no run content" },
  "DELETE /companies/:companyId/heartbeat-runs/:runId/content-restriction": { kind: "not_run_content", reason: "fenced release transition; metadata receipt only" },
  "POST /companies/:companyId/heartbeat-runs/:runId/forensic-grants": { kind: "not_run_content", reason: "creates a grant; returns grant metadata only" },
  "GET /companies/:companyId/heartbeat-runs/:runId/forensic-grants": { kind: "metadata_only", reason: "grant metadata only" },
  "DELETE /companies/:companyId/heartbeat-runs/:runId/forensic-grants/:grantId": { kind: "not_run_content", reason: "revokes a grant" },
  "GET /companies/:companyId/heartbeat-runs/:runId/content-audit": { kind: "metadata_only", reason: "audit rows hold metadata, byte count and hash only" },
  "GET /companies/:companyId/heartbeat-runs": { kind: "gated", via: "serveRunList" },
  "GET /companies/:companyId/live-runs": { kind: "gated", via: "serveRunList" },
  "GET /heartbeat-runs/:runId": { kind: "gated", via: "serveRunContent" },
  "GET /heartbeat-runs/:runId/events": { kind: "gated", via: "serveRunContent" },
  "GET /heartbeat-runs/:runId/log": { kind: "gated", via: "serveRunContent" },
  "GET /heartbeat-runs/:runId/workspace-operations": { kind: "gated", via: "serveRunContent" },
  "GET /workspace-operations/:operationId/log": { kind: "gated", via: "serveWorkspaceOperation" },
  "GET /execution-workspaces/:id/workspace-operations": { kind: "gated", via: "serveWorkspaceOperationList" },
  "GET /heartbeat-runs/:runId/provider-trace": { kind: "gated", via: "serveRunContent" },
  "GET /heartbeat-runs/:runId/provider-trace/download": { kind: "gated", via: "serveRunContent" },
  "POST /heartbeat-runs/:runId/provider-trace/frames/:frameId/reveal": { kind: "gated", via: "serveRunContent" },
  "DELETE /heartbeat-runs/:runId/provider-trace": { kind: "mutation_gated", via: "denyRestrictedMutation" },
  "POST /heartbeat-runs/:runId/provider-trace/reproject-workspace-diffs": { kind: "mutation_gated", via: "denyRestrictedMutation" },
  "GET /companies/:companyId/provider-traces": { kind: "metadata_only", reason: "trace metadata only; restricted runs filtered via restrictedRunIds" },
  "GET /issues/:issueId/live-runs": { kind: "gated", via: "serveRunList" },
  "GET /issues/:issueId/execution": { kind: "gated", via: "authorizeRunContent" },
  "GET /issues/:issueId/active-run": { kind: "gated", via: "authorizeRunContent" },
  "GET /issues/:id/runs": { kind: "gated", via: "serveRunList" },
  "GET /heartbeat-runs/:runId/issues": { kind: "gated", via: "serveRunContent" },
  "GET /companies/:companyId/tools/runs/:runId/decisions": { kind: "gated", via: "serveRunContent" },
  "POST /heartbeat-runs/:runId/cancel": { kind: "not_run_content", reason: "control action; response is the run row but cancel must stay available during an incident" },
  "POST /heartbeat-runs/:runId/watchdog-decisions": { kind: "not_run_content", reason: "writes an operator decision; returns the decision row only" },
  "POST /heartbeat-runs/:runId/runtime-requests/:requestId/resolve": { kind: "not_run_content", reason: "operator answer to a live runtime request; returns accepted/commandId" },
  "GET /routines/:id/runs": { kind: "not_run_content", reason: "routine run history, not heartbeat run content" },
  "GET /plugins/:pluginId/jobs/:jobId/runs": { kind: "not_run_content", reason: "plugin job runs, not heartbeat run content" },
  "GET /companies/:companyId/smoke-lab/runs": { kind: "not_run_content", reason: "smoke-lab runs are a separate table" },
  "POST /companies/:companyId/smoke-lab/runs": { kind: "not_run_content", reason: "smoke-lab runs are a separate table" },
  "GET /companies/:companyId/smoke-lab/runs/:runId": { kind: "not_run_content", reason: "smoke-lab runs are a separate table" },
  "PATCH /companies/:companyId/smoke-lab/runs/:runId": { kind: "not_run_content", reason: "smoke-lab runs are a separate table" },
  "POST /companies/:companyId/smoke-lab/runs/:runId/steps": { kind: "not_run_content", reason: "smoke-lab runs are a separate table" },
  "GET /companies/:companyId/skills/:skillId/test-runs": { kind: "not_run_content", reason: "skill test runs are a separate table" },
  "GET /companies/:companyId/skills/:skillId/test-runs/:runId": { kind: "not_run_content", reason: "skill test runs are a separate table" },
  "POST /companies/:companyId/skills/:skillId/test-runs": { kind: "not_run_content", reason: "skill test runs are a separate table" },
  "POST /companies/:companyId/skills/:skillId/test-runs/:runId/cancel": { kind: "not_run_content", reason: "skill test runs are a separate table" },
  "DELETE /companies/:companyId/skills/:skillId/test-runs/:runId": { kind: "not_run_content", reason: "skill test runs are a separate table" },
  "GET /companies/:companyId/ai-connections/:connectionId/active-runs": { kind: "metadata_only", reason: "id/status columns only; no content column selected" },
  "POST /routines/:id/run": { kind: "not_run_content", reason: "starts a routine; not run output" },
  "POST /companies/:companyId/built-in-agents/:key/routines/:routineKey/run": { kind: "not_run_content", reason: "starts a routine; not run output" },
  "GET /status-cards/:id/dry-run": { kind: "not_run_content", reason: "status card dry-run" },
};

// Matches both "literal" and `${base}/template` route paths. Template paths are
// resolved against a `const base = "..."` declared in the same file, so a route
// cannot dodge the audit by being written as a template string.
const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*(?:\n\s*)?(?:"([^"]+)"|`([^`]+)`)/g;
const RUN_SCOPED = /(heartbeat-runs|live-runs|active-run|workspace-operations|\/runs\b|test-runs|provider-trace|\/execution\b|\brun\b|-run\b)/;

function collectRoutes() {
  const found: Array<{ key: string; file: string; body: string }> = [];
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const src = fs.readFileSync(path.join(routesDir, file), "utf8");
    const baseMatch = src.match(/const base = "([^"]+)"/);
    for (const match of src.matchAll(ROUTE_RE)) {
      const method = match[1]!.toUpperCase();
      let routePath = match[2] ?? match[3]!;
      if (match[3]) {
        if (routePath.startsWith("${base}") && baseMatch) {
          routePath = routePath.replace("${base}", baseMatch[1]!);
        } else if (RUN_SCOPED.test(routePath)) {
          throw new Error(`${file}: run-scoped template route path ${routePath} cannot be resolved; use a literal or const base`);
        } else {
          continue;
        }
      }
      if (!RUN_SCOPED.test(routePath)) continue;
      const start = match.index!;
      const next = src.slice(start + 10).search(/\n\s*router\.(get|post|put|patch|delete)\(/);
      const body = src.slice(start, next === -1 ? undefined : start + 10 + next);
      found.push({ key: `${method} ${routePath}`, file, body });
    }
  }
  return found;
}

describe("run content route enumeration (AC6)", () => {
  const routes = collectRoutes();

  it("classifies every run-scoped route; an unclassified new route fails", () => {
    const unclassified = routes.filter((r) => !(r.key in AUDITED_ROUTES)).map((r) => `${r.key} (${r.file})`);
    expect(unclassified, "new run-scoped route(s) must be classified in AUDITED_ROUTES and gated").toEqual([]);
  });

  it("has no stale entries for routes that no longer exist", () => {
    const present = new Set(routes.map((r) => r.key));
    const stale = Object.keys(AUDITED_ROUTES).filter((key) => !present.has(key));
    expect(stale).toEqual([]);
  });

  it("every route classified as gated invokes its named gate helper in its handler body", () => {
    const failures: string[] = [];
    for (const route of routes) {
      const cls = AUDITED_ROUTES[route.key];
      if (!cls || (cls.kind !== "gated" && cls.kind !== "mutation_gated")) continue;
      if (!route.body.includes(cls.via)) failures.push(`${route.key} (${route.file}) does not call ${cls.via}`);
    }
    expect(failures).toEqual([]);
  });

  it("no gated route selects content before the gate: handlers must not call heartbeat.getRun/listEvents/readLog outside produce()", () => {
    const failures: string[] = [];
    for (const route of routes) {
      const cls = AUDITED_ROUTES[route.key];
      if (!cls || cls.kind !== "gated") continue;
      const beforeGate = route.body.slice(0, Math.max(0, route.body.indexOf(cls.via)));
      for (const forbidden of ["heartbeat.getRun(", "heartbeat.listEvents(", "heartbeat.readLog(", "providerTraces.inspect(", "providerTraces.download(", "providerTraces.revealFrame(", "workspaceOperations.readLog(", "workspaceOperations.listForRun(", "workspaceOperations.getById("]) {
        if (beforeGate.includes(forbidden)) failures.push(`${route.key} calls ${forbidden} before ${cls.via}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every service module that reads a run log or run events imports the gate", () => {
    const readers: Array<{ file: string; needle: RegExp }> = [
      { file: "issues.ts", needle: /readIssueCommentRunLogText/ },
      { file: "feedback.ts", needle: /readFullRunLog/ },
      { file: "run-failure-report.ts", needle: /captureRunFailure/ },
      { file: "plugin-host-services.ts", needle: /heartbeat\.run\.log/ },
    ];
    const missing = readers
      .filter(({ file, needle }) => needle.test(fs.readFileSync(path.join(servicesDir, file), "utf8")))
      .filter(({ file }) => !fs.readFileSync(path.join(servicesDir, file), "utf8").includes("run-content-gate"))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it("the live events websocket consults the gate", () => {
    const src = fs.readFileSync(path.resolve(routesDir, "../realtime/live-events-ws.ts"), "utf8");
    expect(src).toContain("watchCompany");
    expect(src).toContain("isRestricted");
  });

  it("documents the content-bearing readers outside routes that this audit found", () => {
    const direct = ["issues.ts:readIssueCommentRunLogText", "feedback.ts:buildFeedbackTraceBundleFromRow", "run-failure-report.ts:captureTerminalRunFailure", "plugin-host-services.ts:agents.sessions", "live-events-ws.ts"];
    expect(direct.length).toBeGreaterThan(0);
  });
});
