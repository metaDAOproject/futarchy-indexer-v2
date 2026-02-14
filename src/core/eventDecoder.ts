import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import assert from "assert";
import { getProgramByOwner, ProgramIndexer } from "./registry";
import { log } from "../logger/logger";

const logger = log.child({ module: "eventDecoder" });

export interface DecodedEvent {
  event: any;
  indexer: ProgramIndexer;
}

export interface InnerInstruction {
  programIdIndex: number;
  data: Uint8Array | string;
}

export interface InnerInstructionSet {
  instructions: InnerInstruction[];
}

/**
 * Decode events from RPC transaction response format
 * Account keys are PublicKey objects (static + loaded addresses)
 */
export function decodeEventsFromRpc(
  innerInstructions: { instructions: { programIdIndex: number; data: string }[] }[],
  accountKeys: PublicKey[],
  filterIndexer?: ProgramIndexer
): DecodedEvent[] {
  const decodedEvents: DecodedEvent[] = [];

  for (const innerInstruction of innerInstructions) {
    for (const ix of innerInstruction.instructions) {
      if (ix.programIdIndex >= accountKeys.length) {
        continue;
      }
      const programId = accountKeys[ix.programIdIndex];

      // Find the indexer for this program
      const indexer = getProgramByOwner(programId);
      if (!indexer) {
        continue;
      }

      // If filtering by specific indexer, skip events from other programs
      if (filterIndexer && indexer.programId.toString() !== filterIndexer.programId.toString()) {
        continue;
      }

      // Try to decode as an event
      try {
        const ixData = anchor.utils.bytes.bs58.decode(ix.data);
        const event = indexer.decodeEvent(Buffer.from(ixData));

        if (event) {
          decodedEvents.push({ event, indexer });
        }
      } catch {
        // Not all instructions are events, this is expected
      }
    }
  }

  return decodedEvents;
}

/**
 * Decode events from gRPC transaction format
 * Account keys are Uint8Array (need to convert to PublicKey)
 */
export function decodeEventsFromGrpc(
  innerInstructions: InnerInstructionSet[],
  accountKeys: Uint8Array[],
  loadedWritableAddresses: Uint8Array[] = [],
  loadedReadonlyAddresses: Uint8Array[] = []
): DecodedEvent[] {
  const decodedEvents: DecodedEvent[] = [];

  // Build full address list
  const allAddresses = [
    ...accountKeys,
    ...loadedWritableAddresses,
    ...loadedReadonlyAddresses,
  ];

  for (const innerInstruction of innerInstructions) {
    for (const ix of innerInstruction.instructions) {
      assert(ix.programIdIndex < allAddresses.length, "programIdIndex is out of bounds");
      const programId = new PublicKey(allAddresses[ix.programIdIndex]);

      // Find the indexer for this program
      const indexer = getProgramByOwner(programId);
      if (!indexer) {
        continue;
      }

      // Try to decode as an event
      // gRPC data is already Uint8Array
      const data = ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data);
      const event = indexer.decodeEvent(Buffer.from(data));
      if (!event) {
        continue;
      }

      decodedEvents.push({ event, indexer });
    }
  }

  return decodedEvents;
}

/**
 * Extract block time from decoded events
 * Looks for common.unixTimestamp in event data
 */
export function extractBlockTimeFromEvents(decodedEvents: DecodedEvent[]): Date | null {
  for (const { event } of decodedEvents) {
    if (event.data?.common?.unixTimestamp) {
      const unixTs = Number(event.data.common.unixTimestamp);
      return new Date(unixTs * 1000);
    }
  }
  return null;
}
