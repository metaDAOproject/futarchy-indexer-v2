import { db } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";

const logger = log.child({ module: "snapshot" });

/**
 * Generic helper for snapshotting on-chain accounts to a database table.
 * Fetches all accounts of a given type and inserts them with onConflictDoNothing().
 *
 * @example
 * await snapshotAccounts({
 *   name: "launches",
 *   fetchAll: () => launchpadClient.launchpad.account.launch.all(),
 *   table: schema.v0_6_launches,
 *   transform: (pubkey, data) => ({
 *     launchAddr: pubkey,
 *     baseMintAcct: data.baseMint.toString(),
 *     // ... other fields
 *   }),
 * });
 */
export async function snapshotAccounts<TAccount, TInsert>(options: {
  name: string;
  fetchAll: () => Promise<Array<{ publicKey: { toString(): string }; account: TAccount }>>;
  table: { $inferInsert: TInsert };
  transform: (pubkey: string, data: TAccount) => TInsert;
  onBeforeInsert?: (pubkey: string, data: TAccount) => Promise<void>;
}): Promise<number> {
  const { name, fetchAll, table, transform, onBeforeInsert } = options;

  logger.info(`Snapshotting ${name}...`);

  try {
    const accounts = await fetchAll();
    logger.info({ count: accounts.length }, `Fetched ${name} from chain`);

    let successCount = 0;
    for (const { publicKey, account } of accounts) {
      try {
        if (onBeforeInsert) {
          await onBeforeInsert(publicKey.toString(), account);
        }
        await db
          .insert(table as any)
          .values(transform(publicKey.toString(), account) as any)
          .onConflictDoNothing();
        successCount++;
      } catch (error) {
        logger.warn({ error, pubkey: publicKey.toString() }, `Error snapshotting ${name} account`);
      }
    }

    logger.info({ count: successCount }, `${name} snapshot complete`);
    return successCount;
  } catch (error) {
    logger.error({ error }, `Error fetching ${name} for snapshot`);
    return 0;
  }
}
