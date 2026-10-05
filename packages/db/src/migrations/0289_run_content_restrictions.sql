CREATE TABLE "run_content_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"actor_id" text,
	"grant_id" uuid,
	"authorization_ref" text,
	"operation" text,
	"result" text NOT NULL,
	"epoch" bigint,
	"policy_version" integer,
	"byte_count" bigint,
	"sha256" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_content_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"issuer" text NOT NULL,
	"destination_class" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revocation_supported" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "run_content_forensic_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"grantee_actor_id" text NOT NULL,
	"purpose" text NOT NULL,
	"authorization_ref" text NOT NULL,
	"allowed_operations" text[] NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "run_content_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_ids" uuid[] NOT NULL,
	"epochs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"actor_id" text,
	"grant_id" uuid,
	"holder_instance_id" text NOT NULL,
	"holder_boot_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "run_content_restrictions" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"state" text NOT NULL,
	"epoch" bigint DEFAULT 1 NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"reason_code" text NOT NULL,
	"authorization_ref" text NOT NULL,
	"actor_id" text NOT NULL,
	"prior_state" text,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_content_restrictions_pk" PRIMARY KEY("company_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "run_content_audit_events" ADD CONSTRAINT "run_content_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_capabilities" ADD CONSTRAINT "run_content_capabilities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_capabilities" ADD CONSTRAINT "run_content_capabilities_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_forensic_grants" ADD CONSTRAINT "run_content_forensic_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_forensic_grants" ADD CONSTRAINT "run_content_forensic_grants_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_leases" ADD CONSTRAINT "run_content_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_restrictions" ADD CONSTRAINT "run_content_restrictions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_content_restrictions" ADD CONSTRAINT "run_content_restrictions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_content_audit_events_run_created_idx" ON "run_content_audit_events" USING btree ("company_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "run_content_capabilities_run_status_idx" ON "run_content_capabilities" USING btree ("company_id","run_id","status");--> statement-breakpoint
CREATE INDEX "run_content_forensic_grants_run_grantee_idx" ON "run_content_forensic_grants" USING btree ("company_id","run_id","grantee_actor_id");--> statement-breakpoint
CREATE INDEX "run_content_leases_open_company_idx" ON "run_content_leases" USING btree ("company_id") WHERE "run_content_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "run_content_leases_open_holder_idx" ON "run_content_leases" USING btree ("holder_instance_id") WHERE "run_content_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "run_content_restrictions_company_state_idx" ON "run_content_restrictions" USING btree ("company_id","state") WHERE "run_content_restrictions"."state" <> 'released';--> statement-breakpoint
ALTER TABLE "run_content_restrictions" ADD CONSTRAINT "run_content_restrictions_state_chk" CHECK ("state" in ('restricting','restricted','releasing','released'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION run_content_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'run_content_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "run_content_audit_events_no_update"
BEFORE UPDATE OR DELETE ON "run_content_audit_events"
FOR EACH ROW EXECUTE FUNCTION run_content_audit_events_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION run_content_restrictions_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'run_content_restrictions rows are never deleted; use the fenced release transition';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "run_content_restrictions_no_delete"
BEFORE DELETE ON "run_content_restrictions"
FOR EACH ROW EXECUTE FUNCTION run_content_restrictions_no_delete();
