CREATE TABLE "kingdom_stats" (
	"account_id" uuid NOT NULL,
	"kingdom_id" text NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"top3" integer DEFAULT 0 NOT NULL,
	"playtime_seconds" integer DEFAULT 0 NOT NULL,
	"damage_dealt" integer DEFAULT 0 NOT NULL,
	"placement_sum" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kingdom_stats_account_id_kingdom_id_pk" PRIMARY KEY("account_id","kingdom_id")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "xp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kingdom_stats" ADD CONSTRAINT "kingdom_stats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;