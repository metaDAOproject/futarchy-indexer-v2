import {
  AccountMeta,
  CompiledInstruction,
  ConfirmedTransactionMeta,
  Message,
  MessageAccountKeys,
  PublicKey,
  VersionedTransactionResponse,
  AddressLookupTableAccount,
} from "@solana/web3.js";

import { z } from "zod";

import * as base58 from "bs58";
import { connection, provider } from "../connection";
import { BorshInstructionCoder, Idl, Program } from "@coral-xyz/anchor";
import { PROGRAM_ID_TO_IDL_MAP } from "../constants";
import {
  InstructionDisplay,
  Instruction as AnchorInstruction,
} from "@coral-xyz/anchor/dist/cjs/coder/borsh/instruction";
import { log } from "../../logger/logger";

const logger = log.child({
  module: "transaction-serialize"
});

/**
 * This version should be bumped every time we update this file.
 * It will reset all the transaction watchers to slot 0
 * TODO: it should also create new indexers
 */
export const SERIALIZED_TRANSACTION_LOGIC_VERSION = 0;

// bigint isn't JSON serializable
// https://github.com/GoogleChromeLabs/jsbi/issues/30#issuecomment-1006088574
export function serialize(transaction: Transaction, pretty = false): string {
  return JSON.stringify(
    transaction,
    (_, value) =>
      typeof value === "bigint" ? `BIGINT:${value.toString()}` : value,
    pretty ? 2 : 0
  );
}

const bigintEncodingPattern = /^BIGINT:[0-9]+$/;


export const SerializableTokenMeta = z.strictObject({
  mint: z.string(),
  owner: z.string(),
  amount: z.bigint(),
  decimals: z.number(),
});

/**
 * on the transaction level this will not have a name, but it will have the pre and post balances.
 * At the instruction level, we WILL see the name, but we will not have pre and post balances.
 */
export const SerializableAccountMeta = z.strictObject({
  name: z.string().optional(),
  pubkey: z.string(),
  isSigner: z.boolean().optional(),
  isWriteable: z.boolean().optional(),
  // lamport balances (rent)
  preBalance: z.bigint().optional(),
  postBalance: z.bigint().optional(),
  // if the account was an ATA
  preTokenBalance: SerializableTokenMeta.optional(),
  postTokenBalance: SerializableTokenMeta.optional(),
});

export const SerializableInstructionArg = z.strictObject({
  name: z.string(),
  type: z.string(),
  data: z.string(),
});

export const SerializableInstruction = z.strictObject({
  name: z.string(),
  stackHeight: z.number(),
  programIdIndex: z.number(),
  data: z.string(),
  accounts: z.array(z.number()),
  accountsWithData: z.array(SerializableAccountMeta),
  args: z.array(SerializableInstructionArg),
});

export const SerializableTransactionError = z
  .strictObject({
    InstructionError: z
      .tuple([
        z.number(),
        z.union([z.string(), z.strictObject({ Custom: z.number() })]),
      ])
      .optional(),
    InsufficientFundsForRent: z
      .strictObject({
        account_index: z.number(),
      })
      .optional(),
  })
  .optional();

export const SerializableTransaction = z.strictObject({
  blockTime: z.number(),
  slot: z.number(),
  recentBlockhash: z.string(),
  computeUnitsConsumed: z.bigint(),
  err: SerializableTransactionError,
  fee: z.bigint(),
  signatures: z.array(z.string()),
  version: z.union([z.literal("legacy"), z.literal(0)]),
  logMessages: z.array(z.string()),
  accounts: z.array(SerializableAccountMeta),
  instructions: z.array(SerializableInstruction),
});

export type Transaction = z.infer<typeof SerializableTransaction>;
export type Account = z.infer<typeof SerializableAccountMeta>;
export type TokenBalance = z.infer<typeof SerializableTokenMeta>;
export type Instruction = z.infer<typeof SerializableInstruction>;

export enum GetTransactionErrorType {
  NullGetTransactionResponse = "NullGetTransactionResponse",
  ZodError = "ZodError",
  ResolveAccountError = "ResolveAccountError", // problem getting account list from transaction
  DuplicateTokenAccounts = "DuplicateTokenAccounts", // if multiple items in pre or post token balances reference the same account
  OuterIxStackHeightNonNull = "OuterIxStackHeightNonNull", // it's expected that all outer instructions have a null stackHeight (even though it's really 1)
  RepeatOuterIndicesForInnerIx = "RepeatOuterIndicesForInnerIx", // if multiple items in innerInstructions reference same outer instruction
  InvalidStackHeightTransition = "InvalidStackHeightTransition", // if next instruction item in an inner instruction list increases by more than 1, or if it goes to less than 2 (only outers can have stack height 1)
}

type TokenBalanceResponse = NonNullable<
  NonNullable<VersionedTransactionResponse["meta"]>["postTokenBalances"]
>[number];


/**
 *  maps account pubkey to token balance
 */
function getTokenBalances(
  tokenBalanceResponses: TokenBalanceResponse[],
  accountsRaw: MessageAccountKeys
): Map<string, TokenBalance> {
  
  const tokenBalances = new Map<string, TokenBalance>();
  for (let i = 0; i < tokenBalanceResponses.length; ++i) {
    const cur = tokenBalanceResponses[i];
  
    const accountPubkey = accountsRaw.get(cur.accountIndex)!.toBase58();
    tokenBalances.set(accountPubkey, {    
        mint: cur.mint,
        owner: cur.owner ?? "",
        amount: BigInt(cur.uiTokenAmount.amount),
        decimals: cur.uiTokenAmount.decimals,
      });
  }
  return tokenBalances;
}

/**
 * @private
 */
async function parseInstructions(
  outer: Message["compiledInstructions"],
  inner: NonNullable<ConfirmedTransactionMeta["innerInstructions"]>,
  accounts: AccountMeta[]
): Promise<Instruction[] | null> {
  const innerInstructionMap: Record<number, CompiledInstruction[]> = {};
  for (let i = 0; i < inner.length; ++i) {
    const { index, instructions } = inner[i];
    if (index in innerInstructionMap) {
      logger.error("repeat outer indices for inner ix", index);
      return null;
    }
    innerInstructionMap[index] = instructions;
  }
  const instructions: Instruction[] = [];
  for (let outerI = 0; outerI < outer.length; ++outerI) {
    const curOuter = outer[outerI];
    // TODO: figure out why the outer and inner instruction types don't have a stackHeight member even though the rpc always returns this.
    //       perhaps we need to patch web3 libs or there's some edge case we aren't aware of.
    if ("stackHeight" in curOuter) {
      logger.error("outer ix stack height not null", curOuter);
      return null;
    }
    const programAccount = accounts[curOuter.programIdIndex].pubkey;
    const idl = await getIdlForProgram(programAccount);
    let outerIxWithDisplay = null;
    try {
      outerIxWithDisplay = getIxWithDisplay(
        {
          ...curOuter,
        data: Buffer.from(curOuter.data),
        accounts: curOuter.accountKeyIndexes,
      },
      idl,
        accounts
      );
    } catch (e) {
      logger.warn(e, "error with getIxWithDisplay");
    }

    const outerName = outerIxWithDisplay?.instruction.name ?? "unknown";
    const outerArgs = outerIxWithDisplay?.instructionDisplay?.args ?? [];
    const outerAccountsWithData =
      outerIxWithDisplay?.instructionDisplay?.accounts ?? [];
    instructions.push({
      stackHeight: 1,
      programIdIndex: curOuter.programIdIndex,
      data: base58.encode(curOuter.data),
      accounts: curOuter.accountKeyIndexes,
      name: outerName,
      args: outerArgs,
      // we do not have balances here
      accountsWithData: outerAccountsWithData.map(({ isWritable, ...a }) => ({
        ...a,
        isWriteable: isWritable,
        pubkey: a.pubkey.toBase58(),
      })),
    });
    let curStackHeight = 1;
    const curInnerInstructions = innerInstructionMap[outerI] ?? [];
    for (let innerI = 0; innerI < curInnerInstructions.length; ++innerI) {
      const curInner = curInnerInstructions[innerI];
      const innerStackHeight: number = (curInner as any).stackHeight;
      const isInvalidStackHeight =
        typeof innerStackHeight !== "number" ||
        (innerStackHeight > curStackHeight &&
          curStackHeight + 1 !== innerStackHeight) ||
        innerStackHeight < 2;
      if (isInvalidStackHeight) {

        logger.error("invalid stack height transition");
        return null;

      }
      const programAccount = accounts[curInner.programIdIndex].pubkey;
      const idl = await getIdlForProgram(programAccount);
      const innerIxWithDisplay = getIxWithDisplay(
        {
          ...curOuter,
          data: Buffer.from(curOuter.data),
          accounts: curOuter.accountKeyIndexes,
        },
        idl,
        accounts
      );

      const innerName = innerIxWithDisplay?.instruction.name ?? "unknown";
      const innerArgs = innerIxWithDisplay?.instructionDisplay?.args ?? [];
      const innerAccountsWithData =
        innerIxWithDisplay?.instructionDisplay?.accounts ?? [];

      instructions.push({
        stackHeight: innerStackHeight,
        programIdIndex: curInner.programIdIndex,
        data: curInner.data,
        accounts: curInner.accounts,
        name: innerName,
        args: innerArgs,
        // we do not have balances here
        accountsWithData: innerAccountsWithData.map(({ isWritable, ...a }) => ({
          ...a,
          isWriteable: isWritable,
          pubkey: a.pubkey.toBase58(),
        })),
      });
      curStackHeight = innerStackHeight;
    }
  }
  return instructions;
}





async function getIdlForProgram(
  programAccount: PublicKey
): Promise<Idl | null> {
  try {
    let idl: Idl | null = PROGRAM_ID_TO_IDL_MAP[programAccount.toBase58()];
    if (!idl) {
      idl = await Program.fetchIdl(programAccount, provider);
    }
    return idl;
  } catch (e) {
    return null;
  }
}

export type IdlAccount = {
  name: string;
  isMut: boolean;
  isSigner: boolean;
};

export type IdlAccounts = {
  name: string;
  accounts: IdlAccount[];
};

/**
 * @private
 */
export type IdlAccountItem = IdlAccounts | IdlAccount;

function getIxWithDisplay(
  instruction: { accounts: number[]; data: Buffer },
  idl: Idl | null,
  accountMetas: AccountMeta[]
): {
  instruction: AnchorInstruction;
  instructionDisplay: InstructionDisplay | null;
} | null {
  if (!idl) {
    return null;
  }
  let coder: BorshInstructionCoder | null = null;
  let decodedIx: AnchorInstruction | null = null;

  // Added because of this error:
  // User defined types not provided
  // TypeError: field.type is not an Object. (evaluating '"vec" in field.type')
  try {
    coder = new BorshInstructionCoder(idl);
  } catch (e) {
    logger.warn(e, "error with initializing coder");
    return null;
  }

  if (!coder) {
    logger.warn("no coder can't continue");
    return null;
  }

  try {
    decodedIx = coder.decode(instruction.data);
  } catch (e) {
    logger.warn(e, "error with coder decoding of instruction:");
    return null;
  }

  if (!decodedIx) {
    return null;
  }

  const ix = idl.instructions.find((instr) => instr.name === decodedIx.name);
  const flatIdlAccounts = flattenIdlAccounts(<IdlAccountItem[]>ix?.accounts);
  const accounts = instruction.accounts.map((number, idx) => {
    const meta = accountMetas[number];
    if (idx < flatIdlAccounts.length) {
      return {
        name: flatIdlAccounts[idx].name,
        ...meta,
      };
    }
    // "Remaining accounts" are unnamed in Anchor.
    else {
      return {
        name: `Remaining ${idx - flatIdlAccounts.length}`,
        ...meta,
      };
    }
  });
  try {
    const ixDisplay = coder.format(decodedIx, accounts);

    return {
      instruction: decodedIx,
      instructionDisplay: ixDisplay,
    };
  } catch (e) {
    logger.warn(e, "error with coder formatting of decodedIx:");
    return null;
  }
}

function flattenIdlAccounts(
  accounts: IdlAccountItem[],
  prefix?: string
): IdlAccount[] {
  return accounts
    .map((account) => {
      const accName = account.name;
      if (Object.prototype.hasOwnProperty.call(account, "accounts")) {
        const newPrefix = prefix ? `${prefix} > ${accName}` : accName;

        return flattenIdlAccounts((<IdlAccounts>account).accounts, newPrefix);
      } else {
        return {
          ...(<IdlAccount>account),
          name: prefix ? `${prefix} > ${accName}` : accName,
        };
      }
    })
    .flat();
}

export async function getTransaction(signature: string): Promise<{tx: Transaction, rawTx: VersionedTransactionResponse}|null> {
  let txResponse: VersionedTransactionResponse | null = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  
  if (!txResponse) {
    //try agaain, just in case the first call didnt work
    txResponse = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!txResponse) {
      logger.warn(`${signature} no tx response for signature`);
      return null;
    }
  }

  
  const accountsRaw = await resolveAccounts(txResponse, signature);
  if (!accountsRaw) {
    logger.warn(`${signature} no accounts response for signature`);
    return null;
  }
  
  const accounts: Account[] = [];
  
  const preTokenBalances = getTokenBalances(txResponse.meta?.preTokenBalances ?? [], accountsRaw);
  const postTokenBalances = getTokenBalances(txResponse.meta?.postTokenBalances ?? [], accountsRaw );

  for (let i = 0; i < accountsRaw.length; ++i) {
    const cur = accountsRaw.get(i);
    const pubkey = cur!.toBase58();
    accounts.push({
      name: "",
      pubkey,
      isSigner: txResponse.transaction.message.isAccountSigner(i),
      isWriteable: txResponse.transaction.message.isAccountWritable(i),
      preBalance: BigInt(txResponse.meta?.preBalances[i]!),
      postBalance: BigInt(txResponse.meta?.postBalances[i]!),
      preTokenBalance: preTokenBalances.get(pubkey),
      postTokenBalance: postTokenBalances.get(pubkey),
    });
  }

  const accountMetas: AccountMeta[] = accounts.map((a) => ({
    pubkey: new PublicKey(a.pubkey),
    isWritable: a.isWriteable ?? false,
    isSigner: a.isSigner ?? false,
  }));

  const instructions = await parseInstructions(
    txResponse.transaction.message.compiledInstructions,
    txResponse.meta?.innerInstructions!,
    accountMetas
  );
  if (!instructions) {
    logger.warn("no instructions");
    return null;
  }

  const parseResult = SerializableTransaction.safeParse({
    blockTime: txResponse.blockTime,
    slot: txResponse.slot,
    recentBlockhash: txResponse.transaction.message.recentBlockhash,
    computeUnitsConsumed: BigInt(txResponse.meta?.computeUnitsConsumed!),
    err: txResponse.meta?.err ?? undefined,
    fee: BigInt(txResponse.meta?.fee!),
    signatures: txResponse.transaction.signatures,
    version: txResponse.version,
    logMessages: txResponse.meta?.logMessages,
    accounts,
    instructions,
  });

  if (parseResult.success) {
    return {tx: parseResult.data, rawTx: txResponse};
  } 
    
  logger.error(parseResult.error, "error with parsing transaction" );
  return null;

}

export function parseFormattedInstructionArgsData<T>(data: string) {
  let jsonString = data.replace(/'/g, '"');

  jsonString = jsonString.replace(/(\w+):/g, '"$1":');

  jsonString = jsonString.replace(/:\s*(\w+)(?=,|})/g, (match, p1) => {
    return isNaN(p1) ? `: "${p1}"` : `: ${p1}`;
  });

  return JSON.parse(jsonString) as T;
}

async function resolveAccounts({transaction, version}: VersionedTransactionResponse, signature: string): Promise<MessageAccountKeys|null> {
  let accountKeys: MessageAccountKeys;
  switch (version) {
    case 'legacy':
      if (transaction.message.addressTableLookups.length > 0) {

        logger.info("address table lookups in legacy tx", transaction.message.addressTableLookups);
        return null;
      
      }
      accountKeys = transaction.message.getAccountKeys();
      break;
    case 0:

      try{
        const parsedTx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        accountKeys = new MessageAccountKeys(parsedTx?.transaction.message.accountKeys.map((acct) => acct.pubkey) ?? []);
      } catch (e) {
        //we may want to tone this down to just a warning
        logger.error(e, "error with getting parsed transaction");
        return null;
      }
      break;
    default:
      logger.info("unsupported transaction versoin", version)
      return null;
  }
  return accountKeys;
}

