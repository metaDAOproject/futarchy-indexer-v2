import { subscribe, CommitmentLevel, type LaserstreamConfig, type SubscribeRequest } from 'helius-laserstream';
import { log } from "../../logger/logger";

const logger = log.child({ module: "laserstream" });

export class HeliusProvider {
  private config: LaserstreamConfig;
  private streamHandle: any = null;

  constructor(endpoint: string, apiKey: string) {
    this.config = { endpoint, apiKey };
    logger.info({ endpoint }, "Laserstream provider initialized");
  }

  /**
   * Subscribe to transaction updates for specified programs
   */
  async subscribe(
    programIds: string[],
    onData: (data: any) => Promise<void>,
    onError: (error: Error) => void,
    fromSlot?: string
  ): Promise<void> {
    logger.info({
      programIds,
      fromSlot,
      endpoint: this.config.endpoint
    }, "Starting subscription");

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
      fromSlot: fromSlot ? parseInt(fromSlot, 10) : undefined,
    };

    logger.debug({ request }, "Request config");

    let txCount = 0;
    let lastLogTime = Date.now();

    const wrappedOnData = async (data: any) => {
      txCount++;
      const now = Date.now();

      if (txCount === 1) {
        logger.info({ slot: data.transaction?.slot }, "Received first transaction");
      }

      if (now - lastLogTime > 10000) {
        logger.info({ txCount, lastSlot: data.transaction?.slot }, "Progress update");
        lastLogTime = now;
      }

      await onData(data);
    };

    const wrappedOnError = (error: Error) => {
      logger.error({ error: error.message, txCount }, "Stream error");
      onError(error);
    };

    logger.info("Connecting to laserstream...");
    try {
      this.streamHandle = await subscribe(this.config, request, wrappedOnData, wrappedOnError);
      logger.info({ streamId: this.streamHandle?.id }, "Stream connected");
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Subscribe threw error");
      throw err;
    }
    logger.info({ txCount }, "Subscription ended");
  }

  stop(): void {
    if (this.streamHandle) {
      logger.info("Stopping backup GRPC stream");
      try {
        this.streamHandle.cancel();
      } catch (error) {
        logger.warn({ error }, "Error cancelling stream");
      }
      this.streamHandle = null;
    }
  }

  /**
   * Gap-fill using replay capability (for gaps ≤3000 slots)
   * Waits until stream catches up to targetSlot before returning
   */
  async replayFromSlot(
    programIds: string[],
    fromSlot: bigint,
    onData: (data: any) => Promise<void>,
    targetSlot?: bigint
  ): Promise<{ txCount: number }> {
    logger.info({
      programIds,
      fromSlot: fromSlot.toString(),
      targetSlot: targetSlot?.toString()
    }, "Starting replay for gap-fill");

    const startTime = Date.now();

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
      fromSlot: Number(fromSlot),
    };

    let txCount = 0;
    let lastSlot = fromSlot;
    let streamHandle: any = null;

    return new Promise((resolve, reject) => {
      // Timeout after 10 seconds of no data (gap-fill should be quick)
      let noDataTimeout: NodeJS.Timeout;
      const resetTimeout = () => {
        if (noDataTimeout) clearTimeout(noDataTimeout);
        noDataTimeout = setTimeout(() => {
          logger.info({ txCount, lastSlot: lastSlot.toString() }, "No more data after 10s, replay complete");
          if (streamHandle) streamHandle.cancel();
          resolve({ txCount });
        }, 10000);
      };
      resetTimeout();

      logger.info("Connecting to laserstream for replay...");

      subscribe(this.config, request,
        async (data) => {
          resetTimeout();
          txCount++;
          const slot = BigInt(data.transaction?.slot || 0);
          lastSlot = slot;

          if (txCount === 1) {
            logger.info({ slot: slot.toString() }, "Replay: received first transaction");
          }

          if (txCount % 50 === 0) {
            logger.info({ txCount, slot: slot.toString() }, "Replay progress");
          }

          await onData(data);

          // If we have a target and reached it, stop
          if (targetSlot && slot >= targetSlot) {
            logger.info({ txCount, slot: slot.toString(), targetSlot: targetSlot.toString() }, "Reached target slot");
            clearTimeout(noDataTimeout);
            if (streamHandle) streamHandle.cancel();
            resolve({ txCount });
          }
        },
        (error) => {
          clearTimeout(noDataTimeout);
          logger.error({ error: error.message, txCount }, "Replay stream error");
          // Don't reject on error, just resolve with what we got
          resolve({ txCount });
        }
      ).then((handle) => {
        streamHandle = handle;
        logger.info({ streamId: handle?.id }, "Replay stream connected");
      }).catch((err) => {
        clearTimeout(noDataTimeout);
        logger.error({ error: (err as Error).message }, "Failed to connect replay stream");
        reject(err);
      });
    }).then((result) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info({
        duration: `${duration}s`,
        txCount: (result as { txCount: number }).txCount,
        fromSlot: fromSlot.toString()
      }, "Replay completed");
      return result as { txCount: number };
    });
  }
}
