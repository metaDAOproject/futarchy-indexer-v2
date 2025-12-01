import { subscribe, CommitmentLevel, type LaserstreamConfig, type SubscribeRequest } from 'helius-laserstream';
import { log } from "../../logger/logger";

const logger = log.child({ module: "helius-provider" });

export class HeliusProvider {
  private config: LaserstreamConfig;

  constructor(endpoint: string, apiKey: string) {
    this.config = { endpoint, apiKey };
  }

  /**
   * Subscribe to transaction updates for specified programs
   */
  async subscribe(
    programIds: string[],
    onData: (data: any) => Promise<void>,
    onError: (error: Error) => void,
    fromSlot?: string  // For replay/gap-fill (max 3000 slots back)
  ): Promise<void> {
    logger.info({
      programIds,
      fromSlot,
      endpoint: this.config.endpoint
    }, "Starting Helius Laserstream subscription");

    const request: SubscribeRequest = {
      transactions: {
        client: {
          accountInclude: programIds,
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false
        }
      },
      commitment: CommitmentLevel.CONFIRMED,
      accounts: {},
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      fromSlot,  // Replay from this slot (max 3000 slots back)
    };

    await subscribe(this.config, request, onData, onError);
  }

  /**
   * Gap-fill using Helius replay capability (for gaps ≤3000 slots)
   * This replays transactions from a specific slot to catch up
   */
  async replayFromSlot(
    programIds: string[],
    fromSlot: bigint,
    onData: (data: any) => Promise<void>
  ): Promise<void> {
    logger.info({
      programIds,
      fromSlot: fromSlot.toString()
    }, "Starting Helius replay from slot");

    await this.subscribe(programIds, onData, (error) => {
      logger.error({ error }, "Helius replay error");
    }, fromSlot.toString());
  }
}
