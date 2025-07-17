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

interface PriceDataV3 {
  usdPrice: number;
  blockId: number;
  decimals: number;
  priceChange24h: number;
}
// Jupiter pro url if we want to use it in the future
const baseUrl =
  process.env.JUPITER_API_KEY && process.env.JUPITER_API_KEY.length > 0
    ? "https://api.jup.ag/price/v3?ids="
    : "https://lite-api.jup.ag/price/v3?ids=";

export async function updatePrices(): Promise<{
  message: string;
  error: Error | undefined;
}> {
  try {
    const startTime = performance.now();
    //get all the daos that are not hidden
    const v3Query = db.$with("v3").as(
      db
        .select({
          baseAcct: schema.daos.baseAcct,
        })
        .from(schema.daos)
        .leftJoin(
          schema.daoDetails,
          eq(schema.daoDetails.daoId, schema.daos.daoId)
        )
        .where(eq(schema.daoDetails.isHide, false))
    );

    const v4Query = db.$with("v4").as(
      db
        .select({
          baseAcct: schema.v0_4_daos.tokenMintAcct,
        })
        .from(schema.v0_4_daos)
        .leftJoin(
          schema.organizations,
          eq(
            schema.v0_4_daos.organizationId,
            schema.organizations.organizationId
          )
        )
        .where(eq(schema.organizations.isHide, false))
    );

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
      .with(v3Query, v4Query, v5Query) 
      .select()
      .from(v3Query)
      .union(db.with(v4Query).select().from(v4Query))
      .union(db.with(v5Query).select().from(v5Query)) 
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
    
    // v3 response structure is different - no nested data object
    for (const [tokenId, priceData] of Object.entries(data)) {
      if (priceData) {
        const pd = priceData as PriceDataV3;

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