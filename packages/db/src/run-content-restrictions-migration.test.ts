import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

d("run content restriction migration 0289", () => {
  it("creates the tables, enforces the state check, and blocks audit mutation and restriction delete", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("run-content-mig-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'run_content_%'`).map((r) => r.table_name as string).sort();
    expect(tables).toEqual(["run_content_audit_events", "run_content_capabilities", "run_content_forensic_grants", "run_content_leases", "run_content_restrictions"]);

    const [company] = await sql`insert into companies (name, issue_prefix) values ('c', 'MIG1') returning id`;
    const [agent] = await sql`insert into agents (company_id, name, role, status, adapter_type, adapter_config, runtime_config) values (${company!.id}, 'a', 'engineer', 'active', 'process', '{}', '{}') returning id`;
    const [run] = await sql`insert into heartbeat_runs (company_id, agent_id, status) values (${company!.id}, ${agent!.id}, 'failed') returning id`;

    await expect(sql`insert into run_content_restrictions (company_id, run_id, state, reason_code, authorization_ref, actor_id) values (${company!.id}, ${run!.id}, 'bogus', 'r', 'a', 'u')`).rejects.toThrow(/state_chk/);
    await sql`insert into run_content_restrictions (company_id, run_id, state, reason_code, authorization_ref, actor_id) values (${company!.id}, ${run!.id}, 'restricting', 'r', 'a', 'u')`;
    await expect(sql`insert into run_content_restrictions (company_id, run_id, state, reason_code, authorization_ref, actor_id) values (${company!.id}, ${run!.id}, 'restricted', 'r', 'a', 'u')`).rejects.toThrow(/pk|duplicate/);
    await expect(sql`delete from run_content_restrictions where run_id = ${run!.id}`).rejects.toThrow(/never deleted/);

    await sql`insert into run_content_audit_events (company_id, run_id, event_kind, result) values (${company!.id}, ${run!.id}, 'transition', 'ok')`;
    await expect(sql`update run_content_audit_events set result = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from run_content_audit_events`).rejects.toThrow(/append-only/);
  }, 90_000);
});
