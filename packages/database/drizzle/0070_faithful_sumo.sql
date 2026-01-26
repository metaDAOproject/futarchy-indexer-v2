CREATE TABLE IF NOT EXISTS "fee_collections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dao_addr" varchar(44),
	"bid_wall_addr" varchar(44),
	"launch_addr" varchar(44),
	"fee_type" varchar NOT NULL,
	"version" varchar(10) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"base_mint" varchar(44),
	"quote_mint" varchar(44),
	"base_fees_collected" bigint,
	"quote_fees_collected" bigint,
	"price_at_execution" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
