CREATE TABLE "equipped" (
	"account_id" uuid NOT NULL,
	"kingdom_id" text NOT NULL,
	"slot" text NOT NULL,
	"item_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipped_account_id_kingdom_id_slot_pk" PRIMARY KEY("account_id","kingdom_id","slot")
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"account_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'purchase' NOT NULL,
	CONSTRAINT "inventory_account_id_item_id_pk" PRIMARY KEY("account_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "equipped" ADD CONSTRAINT "equipped_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;