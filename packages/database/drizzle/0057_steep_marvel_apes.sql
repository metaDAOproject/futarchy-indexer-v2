ALTER TABLE "futarchy_markets" DROP CONSTRAINT "futarchy_markets_dao_addr_proposal_addr_market_type_pk";--> statement-breakpoint
ALTER TABLE "futarchy_prices" DROP CONSTRAINT "futarchy_prices_dao_addr_proposal_addr_market_type_slot_pk";--> statement-breakpoint
ALTER TABLE "futarchy_twaps" DROP CONSTRAINT "futarchy_twaps_dao_addr_proposal_addr_market_type_slot_pk";--> statement-breakpoint
ALTER TABLE "futarchy_markets" ALTER COLUMN "proposal_addr" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "futarchy_prices" ALTER COLUMN "proposal_addr" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "futarchy_twaps" ALTER COLUMN "proposal_addr" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "futarchy_markets" ADD CONSTRAINT "futarchy_markets_dao_addr_proposal_addr_market_type_unique" UNIQUE NULLS NOT DISTINCT("dao_addr","proposal_addr","market_type");--> statement-breakpoint
ALTER TABLE "futarchy_prices" ADD CONSTRAINT "futarchy_prices_dao_addr_proposal_addr_market_type_slot_unique" UNIQUE NULLS NOT DISTINCT("dao_addr","proposal_addr","market_type","slot");--> statement-breakpoint
ALTER TABLE "futarchy_twaps" ADD CONSTRAINT "futarchy_twaps_dao_addr_proposal_addr_market_type_slot_unique" UNIQUE NULLS NOT DISTINCT("dao_addr","proposal_addr","market_type","slot");