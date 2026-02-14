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

/**
 * Error thrown when Chainalysis returns 401/403 (auth failure or rate limit disguised as auth error)
 * Should NOT be retried - indicates API key issue or excessive request volume
 */
export class AuthenticationError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when Chainalysis returns 429 (explicit rate limit)
 * Can be retried after waiting
 */
export class RateLimitError extends Error {
  public retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
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

      // Handle auth failures - don't retry, throw immediately
      // Chainalysis returns 403 both for invalid keys AND when rate limiting aggressively
      if (response.status === 401 || response.status === 403) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, address, errorBody },
          "Chainalysis auth/rate limit error - not retrying"
        );
        throw new AuthenticationError(
          `Chainalysis error ${response.status}: ${errorBody}`,
          response.status
        );
      }

      // Handle explicit rate limiting with exponential backoff
      if (response.status === 429) {
        const backoffMs = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        if (attempt < retries) {
          logger.warn({ address, attempt, backoffMs }, "Rate limited (429), backing off");
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        } else {
          // After all retries exhausted, throw RateLimitError so caller can handle globally
          throw new RateLimitError(
            `Rate limited after ${retries} retries`,
            backoffMs * 2 // Suggest waiting even longer
          );
        }
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Chainalysis API error: ${response.status} - ${errorBody}`);
      }

      return await response.json();
    } catch (error) {
      // Don't retry AuthenticationError or RateLimitError - propagate immediately
      if (error instanceof AuthenticationError || error instanceof RateLimitError) {
        throw error;
      }

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
