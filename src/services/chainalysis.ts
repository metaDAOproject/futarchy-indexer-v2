import { log } from "../logger/logger";

const logger = log.child({ module: "chainalysis" });

export interface ChainalysisResponse {
  risk: string;
  addressType: string;
  cluster: string;
  riskReason: string;
  status: string;
  addressIdentifications?: any[];
  exposures?: any[];
  triggers?: any[];
}

export async function checkAddressRisk(
  address: string,
  retries = 3
): Promise<ChainalysisResponse | null> {
  const apiKey = process.env.CHAINALYSIS_API_KEY;
  if (!apiKey) {
    throw new Error("CHAINALYSIS_API_KEY not configured");
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(
        `https://api.chainalysis.com/api/risk/v2/entities/${address}`,
        {
          headers: {
            Token: apiKey,
            Accept: "application/json",
          },
        }
      );

      if (response.status === 404) {
        return null; // Address not in Chainalysis system
      }

      // Handle rate limiting with exponential backoff
      if (response.status === 429) {
        if (attempt < retries) {
          const backoffMs = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
          logger.warn({ address, attempt, backoffMs }, "Rate limited, backing off");
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        } else {
          throw new Error(`Rate limited after ${retries} retries`);
        }
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Chainalysis API error: ${response.status} - ${errorBody}`);
      }

      return await response.json();
    } catch (error) {
      if (attempt === retries) {
        logger.error({
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          address,
          attempts: attempt + 1
        }, "Failed to check address risk after retries");
        throw error;
      }
    }
  }

  throw new Error("Unexpected error in checkAddressRisk");
}
