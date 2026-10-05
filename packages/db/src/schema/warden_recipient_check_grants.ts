import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { issues } from "./issues.js";

export const wardenRecipientCheckGrants = pgTable(
  "warden_recipient_check_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    checkerAgentId: uuid("checker_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    recipientAgentId: uuid("recipient_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    configRevision: text("config_revision").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    recipe: text("recipe").notNull(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    createdByUserId: text("created_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByRunId: uuid("consumed_by_run_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCheckerIdx: index("warden_recipient_check_grants_issue_checker_idx").on(
      table.companyId,
      table.issueId,
      table.checkerAgentId,
    ),
    approvalUq: uniqueIndex("warden_recipient_check_grants_approval_uq").on(table.approvalId),
  }),
);
