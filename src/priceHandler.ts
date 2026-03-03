import { db, eq, schema } from "@metadaoproject/indexer-db";
import {
  PricesRecord,
  PricesType,
} from "@metadaoproject/indexer-db/lib/schema";
import { connection } from "./connection";
import { log } from "./logger/logger";
import env from "dotenv";

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
const baseUrl = "https://api.jup.ag/price/v3?ids=";

const apiKey = process.env.JUPITER_API_KEY;

const excludedMints = process.env.EXCLUDED_MINTS ? process.env.EXCLUDED_MINTS.split(",") : [];

export async function updatePrices(): Promise<{
  message: string;
  error: Error | undefined;
}> {
  try {
    const startTime = performance.now();

    const v5Query = db.$with("v5").as(
      db
        .select({
          baseAcct: schema.v0_5_daos.baseMintAcct,
        })
        .from(schema.v0_5_daos)
        .leftJoin(
          schema.organizations,
          eq(
            schema.v0_5_daos.organizationId,
            schema.organizations.organizationId
          )
        )
        .where(eq(schema.organizations.isHide, false))
    );


    const results = await db
      .with(v5Query) 
      .select()
      .from(v5Query)
      .execute();


    const allMints = results
      .map((res) => res.baseAcct)
      .filter((acct): acct is string => acct != null);

    const filteredMints = allMints.filter((mint) => !excludedMints.includes(mint));

    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    
    if (apiKey && apiKey.length > 0) {
      headers["x-api-key"] = apiKey;
    }

    // Jupiter Price API V3 has a 50-id query limit
    const BATCH_SIZE = 50;
    let data: Record<string, unknown> = {};

    for (let i = 0; i < filteredMints.length; i += BATCH_SIZE) {
      const batch = filteredMints.slice(i, i + BATCH_SIZE);
      const url = baseUrl + batch.join(",");

      const response = await fetch(url, {
        headers: headers,
      });

      if (!response.ok) {
        logger.error(`Error fetching prices (batch ${i / BATCH_SIZE + 1}): ${response.statusText}`);
        continue;
      }
      const batchData = await response.json();
      data = { ...data, ...batchData };
    }
    const slot = await connection.getSlot();

    let missingPrices = [];
    let errors = [];
    
    // v3 response structure is different - no nested data object
    for (const [tokenId, priceData] of Object.entries(data)) {
      if (priceData && typeof (priceData as PriceData).usdPrice === "number") {
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
    const missingPricesMessage = missingPrices.filter(Boolean).join("<br>");
    const message = `Updated prices in ${
      (endTime - startTime) / 1000
    }s missing <br>${missingPricesMessage}`;
    logger.info(message);
    let errorMessage = "";
    for (const error of errors) {
      errorMessage += error + "<br>";
    }

    return {
      message: message,
      error: errorMessage ? new Error(errorMessage) : undefined,
    };
  } catch (error) {
    logger.error(`Error updating prices: ${error}`);
    return {
      message: `Error updating prices: ${error}`,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}