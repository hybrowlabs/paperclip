import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Authoritative per-run content restriction. One row per `(company_id, run_id)`.
 * States: restricting -> restricted -> releasing -> released. Only `released`
 * (or the absence of a row) admits ordinary content readers. The row is never
 * deleted; every transition is also written to `run_content_audit_events`.
 */
export const runContentRestrictions = pgTable(
  "run_content_restrictions",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    state: text("state").notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull().default(1),
    policyVersion: integer("policy_version").notNull().default(1),
    reasonCode: text("reason_code").notNull(),
    authorizationRef: text("authorization_ref").notNull(),
    actorId: text("actor_id").notNull(),
    priorState: text("prior_state"),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.runId], name: "run_content_restrictions_pk" }),
    activeStateIdx: index("run_content_restrictions_company_state_idx")
      .on(table.companyId, table.state)
      .where(sql`${table.state} <> 'released'`),
  }),
);

/**
 * Held admission leases. A reader/stream/egress worker holds one from the
 * moment its gate decision is made until its final byte (or termination).
 * `run_ids` lists every run the holder may emit content for (one for a
 * by-ID read, many for a list).
 */
export const runContentLeases = pgTable(
  "run_content_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runIds: uuid("run_ids").array().notNull(),
    epochs: jsonb("epochs").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    kind: text("kind").notNull(),
    purpose: text("purpose").notNull(),
    actorId: text("actor_id"),
    grantId: uuid("grant_id"),
    holderInstanceId: text("holder_instance_id").notNull(),
    holderBootId: text("holder_boot_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
  },
  (table) => ({
    openByCompanyIdx: index("run_content_leases_open_company_idx")
      .on(table.companyId)
      .where(sql`${table.releasedAt} is null`),
    openByHolderIdx: index("run_content_leases_open_holder_idx")
      .on(table.holderInstanceId)
      .where(sql`${table.releasedAt} is null`),
  }),
);

/** Named, individual, time-limited forensic read grant bound to one company+run. */
export const runContentForensicGrants = pgTable(
  "run_content_forensic_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    granteeActorId: text("grantee_actor_id").notNull(),
    purpose: text("purpose").notNull(),
    authorizationRef: text("authorization_ref").notNull(),
    allowedOperations: text("allowed_operations").array().notNull(),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (table) => ({
    runGranteeIdx: index("run_content_forensic_grants_run_grantee_idx").on(
      table.companyId,
      table.runId,
      table.granteeActorId,
    ),
  }),
);

/**
 * Metadata-only inventory of capabilities issued before a restriction:
 * signed links, trace tickets, exports, cache entries, queued outbound jobs.
 * Never stores a bearer URL or any content.
 */
export const runContentCapabilities = pgTable(
  "run_content_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    kind: text("kind").notNull(),
    issuer: text("issuer").notNull(),
    destinationClass: text("destination_class").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revocationSupported: boolean("revocation_supported").notNull().default(false),
    status: text("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    runStatusIdx: index("run_content_capabilities_run_status_idx").on(
      table.companyId,
      table.runId,
      table.status,
    ),
  }),
);

/** Append-only metadata audit trail (enforced by trigger). Never holds content. */
export const runContentAuditEvents = pgTable(
  "run_content_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull(),
    eventKind: text("event_kind").notNull(),
    actorId: text("actor_id"),
    grantId: uuid("grant_id"),
    authorizationRef: text("authorization_ref"),
    operation: text("operation"),
    result: text("result").notNull(),
    epoch: bigint("epoch", { mode: "number" }),
    policyVersion: integer("policy_version"),
    byteCount: bigint("byte_count", { mode: "number" }),
    sha256: text("sha256"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index("run_content_audit_events_run_created_idx").on(
      table.companyId,
      table.runId,
      table.createdAt,
    ),
  }),
);
