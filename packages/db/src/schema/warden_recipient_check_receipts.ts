import { index, pgTable, text, timestamp, uniqueIndex, uuid, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { wardenRecipientCheckGrants } from "./warden_recipient_check_grants.js";

export const wardenRecipientCheckReceipts = pgTable(
  "warden_recipient_check_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id").notNull().references(() => wardenRecipientCheckGrants.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    checkerAgentId: uuid("checker_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    recipientAgentId: uuid("recipient_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    checkId: uuid("check_id").notNull(),
    recipe: text("recipe").notNull(),
    configRevision: text("config_revision").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    aliasNamesMatch: text("alias_names_match").notNull(),
    expectedPrincipalMatch: text("expected_principal_match").notNull(),
    codebuildProjectFound: text("codebuild_project_found").notNull(),
    eksClusterActive: text("eks_cluster_active").notNull(),
    overall: text("overall").notNull(),
    outcome: text("outcome").notNull(),
    leaseFresh: boolean("lease_fresh").notNull(),
    leaseEgressVerified: boolean("lease_egress_verified").notNull(),
    leaseDestroyed: boolean("lease_destroyed").notNull(),
    leaseDestroyVerifiedAbsent: boolean("lease_destroy_verified_absent").notNull(),
    leaseJobUidDigest: text("lease_job_uid_digest").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    grantUq: uniqueIndex("warden_recipient_check_receipts_grant_uq").on(table.grantId),
    issueIdx: index("warden_recipient_check_receipts_issue_idx").on(table.companyId, table.issueId),
  }),
);
