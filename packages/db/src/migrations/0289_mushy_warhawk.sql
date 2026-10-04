CREATE TABLE "warden_recipient_check_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"checker_agent_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"config_revision" text NOT NULL,
	"recipe" text NOT NULL,
	"approval_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_run_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warden_recipient_check_grants" ADD CONSTRAINT "warden_recipient_check_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warden_recipient_check_grants" ADD CONSTRAINT "warden_recipient_check_grants_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warden_recipient_check_grants" ADD CONSTRAINT "warden_recipient_check_grants_checker_agent_id_agents_id_fk" FOREIGN KEY ("checker_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warden_recipient_check_grants" ADD CONSTRAINT "warden_recipient_check_grants_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warden_recipient_check_grants" ADD CONSTRAINT "warden_recipient_check_grants_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warden_recipient_check_grants_issue_checker_idx" ON "warden_recipient_check_grants" USING btree ("company_id","issue_id","checker_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warden_recipient_check_grants_approval_uq" ON "warden_recipient_check_grants" USING btree ("approval_id");