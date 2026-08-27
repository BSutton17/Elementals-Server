CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_code" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ticks" integer NOT NULL,
	"tick_rate" integer NOT NULL,
	"player_count" integer NOT NULL,
	"human_count" integer NOT NULL,
	"winner_player_id" text,
	"balance_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"account_id" uuid,
	"player_id" text NOT NULL,
	"name" text NOT NULL,
	"kingdom_id" text,
	"placement" integer NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"bot_difficulty" text,
	"eliminated_at_tick" integer,
	"survived_ticks" integer NOT NULL,
	"damage_dealt" integer DEFAULT 0 NOT NULL,
	"damage_taken" integer DEFAULT 0 NOT NULL,
	"healing_done" integer DEFAULT 0 NOT NULL,
	"gold_earned" integer DEFAULT 0 NOT NULL,
	"gold_spent" integer DEFAULT 0 NOT NULL,
	"abilities_cast" integer DEFAULT 0 NOT NULL,
	"kills_credited" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participants_account_idx" ON "participants" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "participants_kingdom_idx" ON "participants" USING btree ("kingdom_id");