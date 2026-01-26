import * as anchor from "@coral-xyz/anchor";
import * as multisig from "@sqds/multisig";
import BN from "bn.js";
import {
  FutarchyClient,
  MAINNET_METEORA_CONFIG as MAINNET_METEORA_CONFIG_V07,
  PERMISSIONLESS_ACCOUNT,
  LAUNCHPAD_PROGRAM_ID as LAUNCHPAD_PROGRAM_ID_V07,
  LaunchpadClient as LaunchpadClientV07,
  type Launch as LaunchV07,
  BidWallClient,
  MAINNET_USDC,
} from "@metadaoproject/futarchy/v0.7";
import {
  FutarchyClient as FutarchyClientV06,
  MAINNET_METEORA_CONFIG as MAINNET_METEORA_CONFIG_V06,
  LAUNCHPAD_PROGRAM_ID as LAUNCHPAD_PROGRAM_ID_V06,
  PERMISSIONLESS_ACCOUNT as PERMISSIONLESS_ACCOUNT_V06,
  LaunchpadClient as LaunchpadClientV06,
  type Launch as LaunchV06,
} from "@metadaoproject/futarchy/v0.6";
import { PublicKey, ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { db, schema } from "@metadaoproject/indexer-db";
import { log } from "../logger/logger";
import { FeeCollectionType } from "@metadaoproject/indexer-db/lib/schema";
import { extractAmmState, getBlockTimeAndSlot } from "../utils/general";
import { getMeteoraDammFees } from "../utils/meteora";

const logger = log.child({ module: "feeCollector" });

// MetaDAO multisig vault - hardcoded fee destination
const METADAO_MULTISIG_VAULT = new PublicKey(
  "6awyHMshBGVjJ3ozdSJdyyDE1CTAXUwrpNMaRGMsb4sf"
);

type LaunchVersion = "v0.6" | "v0.7";

type LaunchAccount = {
  publicKey: PublicKey;
  account: LaunchV06 | LaunchV07;
};

type TaggedLaunch = LaunchAccount & { version: LaunchVersion };

// ============ FEE COLLECTOR SERVICE ============

export class FeeCollectorService {
  private provider: anchor.AnchorProvider;
  private payer: Keypair;
  private futarchyV07: FutarchyClient;
  private futarchyV06: FutarchyClientV06;
  private launchpadV07: LaunchpadClientV07;
  private launchpadV06: LaunchpadClientV06;
  private bidWallClient: BidWallClient;

  constructor(provider: anchor.AnchorProvider, payer: Keypair) {
    this.provider = provider;
    this.payer = payer;
    this.futarchyV07 = FutarchyClient.createClient({ provider });
    this.futarchyV06 = FutarchyClientV06.createClient({ provider });
    this.launchpadV07 = LaunchpadClientV07.createClient({ provider });
    this.launchpadV06 = LaunchpadClientV06.createClient({ provider });
    this.bidWallClient = BidWallClient.createClient({ provider });
  }

  async run(): Promise<void> {
    logger.info("Starting fee collection run");

    // Fetch all bid walls
    const allBidWalls = await this.bidWallClient.bidWallProgram.account.bidWall.all();
    const bidWallsWithFees = allBidWalls.filter(
      (bw) => bw.account.feesCollected.toNumber() > 0
    );
    logger.info({ total: allBidWalls.length, withFees: bidWallsWithFees.length }, "Fetched bid walls");

    // Fetch all launches
    const [v07Launches, v06Launches] = await Promise.all([
      this.launchpadV07.launchpad.account.launch.all(),
      this.launchpadV06.launchpad.account.launch.all(),
    ]);

    const allLaunches: TaggedLaunch[] = [
      ...v07Launches
        .filter((l: LaunchAccount) => l.account.dao !== null)
        .map((l: LaunchAccount) => ({ ...l, version: "v0.7" as const })),
      ...v06Launches
        .filter((l: LaunchAccount) => l.account.dao !== null)
        .map((l: LaunchAccount) => ({ ...l, version: "v0.6" as const })),
    ];

    logger.info({ v07: v07Launches.length, v06: v06Launches.length, completed: allLaunches.length }, "Fetched launches");

    // Process each launch
    for (const launch of allLaunches) {
      await this.processLaunch(launch, allBidWalls);
    }

    logger.info("Fee collection run completed");
  }

  private async processLaunch(launch: TaggedLaunch, allBidWalls: any[]): Promise<void> {
    const daoAddress = launch.account.dao!;
    const baseMint = launch.account.baseMint;
    const quoteMint = launch.account.quoteMint;

    logger.info({ dao: daoAddress.toBase58(), version: launch.version }, "Processing DAO");

    const daoAccount = await this.futarchyV07.autocrat.account.dao.fetch(daoAddress);
    const ammState = extractAmmState(daoAccount);

    const hasInternalFees = ammState.isSpot &&
      (!ammState.baseProtocolFeeBalance.isZero() || !ammState.quoteProtocolFeeBalance.isZero());

    const meteoraFees = await getMeteoraDammFees(
      this.provider.connection,
      baseMint,
      quoteMint,
      launch.version === "v0.7" ? LAUNCHPAD_PROGRAM_ID_V07 : LAUNCHPAD_PROGRAM_ID_V06,
      launch.version === "v0.7" ? MAINNET_METEORA_CONFIG_V07 : MAINNET_METEORA_CONFIG_V06
    );
    const hasMeteoraFees = meteoraFees && (!meteoraFees.feeA.isZero() || !meteoraFees.feeB.isZero());

    // Find bid walls for this DAO
    const daoBidWallsWithFees = allBidWalls.filter(
      (bw) => bw.account.baseMint.toBase58() === baseMint.toBase58() &&
              bw.account.feesCollected.toNumber() > 0
    );

    // Create ATA instructions
    const baseAta = getAssociatedTokenAddressSync(baseMint, METADAO_MULTISIG_VAULT, true);
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, METADAO_MULTISIG_VAULT, true);
    const createBaseAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      this.payer.publicKey, baseAta, METADAO_MULTISIG_VAULT, baseMint
    );
    const createQuoteAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      this.payer.publicKey, quoteAta, METADAO_MULTISIG_VAULT, quoteMint
    );

    // Collect internal fees
    if (ammState.isSpot && hasInternalFees) {
      await this.collectInternalFees(
        launch, daoAddress, baseMint, quoteMint, ammState,
        createBaseAtaIx, createQuoteAtaIx
      );
    }

    // Collect Meteora fees
    if (hasMeteoraFees) {
      await this.collectMeteoraFees(
        launch, daoAddress, daoAccount, baseMint, quoteMint, meteoraFees!,
        createBaseAtaIx, createQuoteAtaIx
      );
    }

    // Collect bid wall fees
    for (const bw of daoBidWallsWithFees) {
      await this.collectBidWallFees(launch, daoAddress, bw);
    }
  }

  private async collectInternalFees(
    launch: TaggedLaunch,
    daoAddress: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    ammState: ReturnType<typeof extractAmmState>,
    createBaseAtaIx: any,
    createQuoteAtaIx: any
  ): Promise<void> {
    try {
      logger.info({ dao: daoAddress.toBase58() }, "Collecting internal fees");

      const signature = await this.futarchyV07
        .collectFeesIx({ dao: daoAddress, baseMint, quoteMint })
        .signers([this.payer])
        .preInstructions([createBaseAtaIx, createQuoteAtaIx])
        .rpc();

      const txInfo = await getBlockTimeAndSlot(this.provider.connection, signature);

      await this.insertFeeCollection({
        feeType: FeeCollectionType.Internal,
        version: launch.version,
        daoAddr: daoAddress.toBase58(),
        launchAddr: launch.publicKey.toBase58(),
        txSignature: signature,
        slot: txInfo?.slot ?? BigInt(0),
        timestamp: txInfo?.blockTime ?? new Date(),
        baseMint: baseMint.toBase58(),
        quoteMint: quoteMint.toBase58(),
        baseFeesCollected: BigInt(ammState.baseProtocolFeeBalance.toString()),
        quoteFeesCollected: BigInt(ammState.quoteProtocolFeeBalance.toString()),
        priceAtExecution: ammState.lastPrice,
      });

      logger.info({ signature }, "Internal fees collected");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.error({ error: errorMsg, dao: daoAddress.toBase58() }, "Failed to collect internal fees");
    }
  }

  private async collectMeteoraFees(
    launch: TaggedLaunch,
    daoAddress: PublicKey,
    daoAccount: any,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    meteoraFees: { feeA: BN; feeB: BN },
    createBaseAtaIx: any,
    createQuoteAtaIx: any
  ): Promise<void> {
    try {
      logger.info({ dao: daoAddress.toBase58() }, "Collecting Meteora fees");

      const squadsMultisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
        this.provider.connection,
        daoAccount.squadsMultisig
      );

      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
      const transactionIndex = BigInt(squadsMultisigAccount.transactionIndex.toString()) + 1n;
      const meteoraConfig = launch.version === "v0.7" ? MAINNET_METEORA_CONFIG_V07 : MAINNET_METEORA_CONFIG_V06;

      let signature: string;
      if (launch.version === "v0.6") {
        signature = await this.futarchyV06
          .collectMeteoraDammFeesIx({
            dao: daoAddress, baseMint, quoteMint, transactionIndex, meteoraConfig,
          })
          .signers([this.payer, PERMISSIONLESS_ACCOUNT_V06])
          .preInstructions([computeBudgetIx, createBaseAtaIx, createQuoteAtaIx])
          .rpc();
      } else {
        signature = await this.futarchyV07
          .collectMeteoraDammFeesIx({
            dao: daoAddress, baseMint, quoteMint, transactionIndex, meteoraConfig,
          })
          .signers([this.payer, PERMISSIONLESS_ACCOUNT])
          .preInstructions([computeBudgetIx, createBaseAtaIx, createQuoteAtaIx])
          .rpc();
      }

      const txInfo = await getBlockTimeAndSlot(this.provider.connection, signature);

      await this.insertFeeCollection({
        feeType: FeeCollectionType.Meteora,
        version: launch.version,
        daoAddr: daoAddress.toBase58(),
        launchAddr: launch.publicKey.toBase58(),
        txSignature: signature,
        slot: txInfo?.slot ?? BigInt(0),
        timestamp: txInfo?.blockTime ?? new Date(),
        baseMint: baseMint.toBase58(),
        quoteMint: quoteMint.toBase58(),
        baseFeesCollected: BigInt(meteoraFees.feeA.toString()),
        quoteFeesCollected: BigInt(meteoraFees.feeB.toString()),
        priceAtExecution: null,
      });

      logger.info({ signature }, "Meteora fees collected");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.error({ error: errorMsg, dao: daoAddress.toBase58() }, "Failed to collect Meteora fees");
    }
  }

  private async collectBidWallFees(
    launch: TaggedLaunch,
    daoAddress: PublicKey,
    bw: any
  ): Promise<void> {
    try {
      const bidWallAddr = bw.publicKey;
      logger.info({ bidWall: bidWallAddr.toBase58() }, "Collecting bid wall fees");

      const usdcAta = getAssociatedTokenAddressSync(MAINNET_USDC, METADAO_MULTISIG_VAULT, true);
      const createUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        this.payer.publicKey, usdcAta, METADAO_MULTISIG_VAULT, MAINNET_USDC
      );

      const signature = await this.bidWallClient
        .collectFeesIx({ bidWall: bidWallAddr, admin: this.payer.publicKey })
        .signers([this.payer])
        .preInstructions([createUsdcAtaIx])
        .rpc();

      const txInfo = await getBlockTimeAndSlot(this.provider.connection, signature);

      await this.insertFeeCollection({
        feeType: FeeCollectionType.BidWall,
        version: launch.version,
        daoAddr: daoAddress.toBase58(),
        bidWallAddr: bidWallAddr.toBase58(),
        launchAddr: launch.publicKey.toBase58(),
        txSignature: signature,
        slot: txInfo?.slot ?? BigInt(0),
        timestamp: txInfo?.blockTime ?? new Date(),
        baseMint: bw.account.baseMint.toBase58(),
        quoteMint: MAINNET_USDC.toBase58(),
        baseFeesCollected: null,
        quoteFeesCollected: BigInt(bw.account.feesCollected.toString()),
        priceAtExecution: null,
      });

      logger.info({ signature }, "Bid wall fees collected");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.error({ error: errorMsg, bidWall: bw.publicKey.toBase58() }, "Failed to collect bid wall fees");
    }
  }

  private async insertFeeCollection(data: {
    feeType: FeeCollectionType;
    version: string;
    daoAddr?: string;
    bidWallAddr?: string;
    launchAddr?: string;
    txSignature: string;
    slot: bigint;
    timestamp: Date;
    baseMint?: string;
    quoteMint?: string;
    baseFeesCollected?: bigint | null;
    quoteFeesCollected?: bigint | null;
    priceAtExecution?: string | null;
  }): Promise<void> {
    await db.insert(schema.fee_collections).values({
      feeType: data.feeType,
      version: data.version,
      daoAddr: data.daoAddr,
      bidWallAddr: data.bidWallAddr,
      launchAddr: data.launchAddr,
      txSignature: data.txSignature,
      slot: data.slot,
      timestamp: data.timestamp,
      baseMint: data.baseMint,
      quoteMint: data.quoteMint,
      baseFeesCollected: data.baseFeesCollected,
      quoteFeesCollected: data.quoteFeesCollected,
      priceAtExecution: data.priceAtExecution,
    });
  }
}
