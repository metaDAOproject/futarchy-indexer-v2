import { db, eq, schema } from "@metadaoproject/indexer-db";
import {
  PricesRecord,
  PricesType,
} from "@metadaoproject/indexer-db/lib/schema";
import { connection } from "./connections/v0.6";
import { log } from "./logger/logger";

const logger = log.child({
  module: "priceHandler",
});

interface PriceData {
  usdPrice: number;
  blockId: number;
  decimals: number;
  priceChange24h: number;
}
// Jupiter pro url if we want to use it in the future
const baseUrl = "https://lite-api.jup.ag/price/v3?ids=";

export async function updatePrices(): Promise<{
  message: string;
  error: Error | undefined;
}> {
  try {
    const startTime = performance.now();

    const v6Query = db.$with("v6").as(
      db
        .select({
          baseAcct: schema.v0_6_daos.baseMintAcct,
        })
        .from(schema.v0_6_daos)
        .leftJoin(
          schema.organizations,
          eq(
            schema.v0_6_daos.organizationId,
            schema.organizations.organizationId
          )
        )
        .where(eq(schema.organizations.isHide, false))
    );

    const results = await db
      .with(v6Query)
      .select()
      .from(v6Query)
      .execute();

    let ids = "";
    for (const res of results) {
      ids += res.baseAcct + ",";
    }

    const url = baseUrl + ids;
    const apiKey = process.env.JUPITER_API_KEY;

    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (apiKey && apiKey.length > 0) {
      headers["x-api-key"] = apiKey;
    }

    const response = await fetch(url, {
      headers: headers,
    });

    if (!response.ok) {
      logger.error(`Error fetching prices: ${response.statusText}`);
      return {
        message: `Error fetching prices: ${response.statusText}`,
        error: new Error(response.statusText),
      };
    }

    const data = await response.json();
    const slot = await connection.getSlot();

    let missingPrices = [];
    let errors = [];

    for (const [tokenId, priceData] of Object.entries(data)) {
      if (priceData) {
        const pd = priceData as PriceData;

        const newPrice: PricesRecord = {
          marketAcct: tokenId,
          price: pd.usdPrice.toString(),
          pricesType: PricesType.Spot,
          createdBy: "jupiter-quotes-indexer",
          updatedSlot: slot?.toString() ?? "0",
        };

        try {
          await db
            .insert(schema.prices)
            .values(newPrice)
            .onConflictDoNothing()
            .execute();
        } catch (error) {
          logger.error(`Error inserting price for ${tokenId}: ${error}`);
          errors.push(`Error inserting price for ${tokenId}: ${error}`);
        }
      } else {
        logger.warn(`No price data found for ${tokenId}`);
        missingPrices.push(tokenId);
      }
    }

    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    const updatedCount = Object.keys(data).length - missingPrices.length;

    logger.info({
      duration: `${duration}s`,
      updated: updatedCount,
      missing: missingPrices.length
    }, "Jupiter price update complete");

    if (missingPrices.length > 0) {
      logger.warn({ tokens: missingPrices }, "Missing price data for tokens");
    }

    const message = `Updated ${updatedCount} prices in ${duration}s${missingPrices.length > 0 ? `, ${missingPrices.length} missing` : ''}`;

    return {
      message,
      error: errors.length > 0 ? new Error(errors.join(", ")) : undefined,
    };
  } catch (error) {
    logger.error(`Error updating prices: ${error}`);
    return {
      message: `Error updating prices: ${error}`,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
