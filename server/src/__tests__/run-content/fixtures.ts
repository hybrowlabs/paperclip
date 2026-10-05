import { randomUUID } from "node:crypto";
import { agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";

export const CANARY_A = "CANARY-A-synthetic-credential-4f9c1e7b2d";
export const CANARY_B = "CANARY-B-synthetic-credential-91a0c3d8e5";

export async function seedCompanyRuns(db: Db, label = "Gate") {
  const [company] = await db
    .insert(companies)
    .values({ name: `${label} ${randomUUID()}`, issuePrefix: `G${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Gate Agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning();
  const runs = await db
    .insert(heartbeatRuns)
    .values([CANARY_A, CANARY_B].map((canary) => ({
      companyId: company!.id,
      agentId: agent!.id,
      status: "failed",
      error: `error ${canary}`,
      resultJson: { summary: `summary ${canary}` },
      stdoutExcerpt: `stdout ${canary}`,
      stderrExcerpt: `stderr ${canary}`,
      contextSnapshot: { note: canary },
    })))
    .returning();
  return { company: company!, agent: agent!, runA: runs[0]!, runB: runs[1]! };
}

export async function seedSecondCompany(db: Db) {
  return seedCompanyRuns(db, "Other");
}
