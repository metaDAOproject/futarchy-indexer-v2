import { ConfirmedSignatureInfo } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { log } from "../logger/logger";
import * as fs from "fs";
import * as path from "path";

const logger = log.child({
  module: "signaturePersistence"
});

interface SignatureCheckpoint {
  programId: string;
  signatures: ConfirmedSignatureInfo[];
  processedCount: number;
  totalCount: number;
  lastProcessedSignature?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SignatureFile {
  checkpoints: SignatureCheckpoint[];
  version: string;
}

const SIGNATURE_FILE_PATH = path.join(process.cwd(), "signatures.json");
const VERSION = "1.0.0";

/**
 * Loads signature checkpoints from the persistence file
 * @returns SignatureFile object or null if file doesn't exist
 */
export function loadSignatureCheckpoints(): SignatureFile | null {
  try {
    if (!fs.existsSync(SIGNATURE_FILE_PATH)) {
      logger.info("No signature persistence file found");
      return null;
    }

    const fileContent = fs.readFileSync(SIGNATURE_FILE_PATH, "utf-8");
    const data: SignatureFile = JSON.parse(fileContent);
    
    // Validate version
    if (data.version !== VERSION) {
      logger.warn(`Version mismatch: expected ${VERSION}, got ${data.version}. Creating new file.`);
      return null;
    }

    logger.info(`Loaded ${data.checkpoints.length} signature checkpoints from file`);
    return data;
  } catch (error) {
    logger.error("Error loading signature checkpoints:", error);
    return null;
  }
}

/**
 * Saves signature checkpoints to the persistence file
 * @param checkpoints - Array of signature checkpoints to save
 */
export function saveSignatureCheckpoints(checkpoints: SignatureCheckpoint[]): void {
  try {
    const signatureFile: SignatureFile = {
      checkpoints,
      version: VERSION
    };

    // Ensure directory exists
    const dir = path.dirname(SIGNATURE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(SIGNATURE_FILE_PATH, JSON.stringify(signatureFile, null, 2));
    logger.info(`Saved ${checkpoints.length} signature checkpoints to file`);
  } catch (error) {
    logger.error("Error saving signature checkpoints:", error);
  }
}

/**
 * Gets an existing checkpoint for a specific program ID
 * @param programId - The program ID to get checkpoint for
 * @returns SignatureCheckpoint for the program ID or null if not found
 */
export function getExistingCheckpoint(programId: string): SignatureCheckpoint | null {
  const file = loadSignatureCheckpoints();
  
  if (file) {
    const existingCheckpoint = file.checkpoints.find(cp => cp.programId === programId);
    if (existingCheckpoint) {
      logger.info(`Found existing checkpoint for ${programId} with ${existingCheckpoint.signatures.length} signatures`);
      return existingCheckpoint;
    }
  }

  return null;
}

/**
 * Creates a new checkpoint for a specific program ID
 * @param programId - The program ID to create checkpoint for
 * @param allSignatures - All signatures to store
 * @returns SignatureCheckpoint for the program ID
 */
export function createNewCheckpoint(
  programId: string, 
  allSignatures: ConfirmedSignatureInfo[]
): SignatureCheckpoint {
  const newCheckpoint: SignatureCheckpoint = {
    programId,
    signatures: allSignatures,
    processedCount: 0,
    totalCount: allSignatures.length,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  logger.info(`Created new checkpoint for ${programId} with ${allSignatures.length} signatures`);
  return newCheckpoint;
}

/**
 * Appends new signatures to an existing checkpoint
 * @param programId - The program ID to update
 * @param newSignatures - New signatures to append
 */
export function appendSignaturesToCheckpoint(programId: string, newSignatures: ConfirmedSignatureInfo[]): void {
  const file = loadSignatureCheckpoints();
  
  if (!file) {
    logger.warn("No signature file found to append signatures");
    return;
  }

  const checkpoint = file.checkpoints.find(cp => cp.programId === programId);
  if (!checkpoint) {
    logger.warn(`No checkpoint found for program ID ${programId}`);
    return;
  }

  // Append new signatures to the beginning (since we're working backwards)
  checkpoint.signatures = [...newSignatures, ...checkpoint.signatures];
  checkpoint.totalCount = checkpoint.signatures.length;
  checkpoint.updatedAt = new Date();

  saveSignatureCheckpoints(file.checkpoints);
  logger.info(`Appended ${newSignatures.length} new signatures to ${programId}. Total: ${checkpoint.totalCount}`);
}

/**
 * Gets or creates a checkpoint for a specific program ID
 * @param programId - The program ID to get checkpoint for
 * @param allSignatures - All signatures to store if creating new checkpoint
 * @returns SignatureCheckpoint for the program ID
 */
export function getOrCreateCheckpoint(
  programId: string, 
  allSignatures: ConfirmedSignatureInfo[]
): SignatureCheckpoint {
  const existing = getExistingCheckpoint(programId);
  if (existing) {
    return existing;
  }

  return createNewCheckpoint(programId, allSignatures);
}

/**
 * Updates a checkpoint with new processed count and last processed signature
 * @param programId - The program ID to update
 * @param processedCount - Number of signatures processed
 * @param lastProcessedSignature - The last processed signature
 */
export function updateCheckpoint(
  programId: string,
  processedCount: number,
  lastProcessedSignature?: string
): void {
  const file = loadSignatureCheckpoints();
  
  if (!file) {
    logger.warn("No signature file found to update checkpoint");
    return;
  }

  const checkpoint = file.checkpoints.find(cp => cp.programId === programId);
  if (!checkpoint) {
    logger.warn(`No checkpoint found for program ID ${programId}`);
    return;
  }

  checkpoint.processedCount = processedCount;
  checkpoint.lastProcessedSignature = lastProcessedSignature;
  checkpoint.updatedAt = new Date();

  saveSignatureCheckpoints(file.checkpoints);
  logger.debug(`Updated checkpoint for ${programId}: ${processedCount}/${checkpoint.totalCount} processed`);
}

/**
 * Gets the remaining unprocessed signatures for a program ID
 * @param programId - The program ID to get remaining signatures for
 * @returns Array of unprocessed ConfirmedSignatureInfo objects
 */
export function getRemainingSignatures(programId: string): ConfirmedSignatureInfo[] {
  const file = loadSignatureCheckpoints();
  
  if (!file) {
    logger.info(`No signature file found for program ID ${programId}`);
    return [];
  }

  const checkpoint = file.checkpoints.find(cp => cp.programId === programId);
  if (!checkpoint) {
    logger.info(`No checkpoint found for program ID ${programId}`);
    return [];
  }

  const remainingSignatures = checkpoint.signatures.slice(checkpoint.processedCount);
  logger.info(`Found ${remainingSignatures.length} remaining signatures for ${programId}`);
  
  return remainingSignatures;
}

/**
 * Checks if there are unprocessed signatures for a program ID
 * @param programId - The program ID to check
 * @returns True if there are unprocessed signatures, false otherwise
 */
export function hasUnprocessedSignatures(programId: string): boolean {
  const file = loadSignatureCheckpoints();
  
  if (!file) {
    return false;
  }

  const checkpoint = file.checkpoints.find(cp => cp.programId === programId);
  if (!checkpoint) {
    return false;
  }

  return checkpoint.processedCount < checkpoint.totalCount;
}

/**
 * Cleans up completed checkpoints (removes them from the file)
 * @param programId - The program ID to clean up
 */
export function cleanupCheckpoint(programId: string): void {
  const file = loadSignatureCheckpoints();
  
  if (!file) {
    return;
  }

  const filteredCheckpoints = file.checkpoints.filter(cp => cp.programId !== programId);
  
  if (filteredCheckpoints.length !== file.checkpoints.length) {
    saveSignatureCheckpoints(filteredCheckpoints);
    logger.info(`Cleaned up checkpoint for program ID ${programId}`);
  }
}

/**
 * Gets progress information for a program ID
 * @param programId - The program ID to get progress for
 * @returns Object with progress information or null if no checkpoint exists
 */
export function getProgress(programId: string): { processed: number; total: number; percentage: number } | null {
  const file = loadSignatureCheckpoints();
  
  if (!file) {
    return null;
  }

  const checkpoint = file.checkpoints.find(cp => cp.programId === programId);
  if (!checkpoint) {
    return null;
  }

  const percentage = checkpoint.totalCount > 0 ? 
    Math.round((checkpoint.processedCount / checkpoint.totalCount) * 100) : 0;

  return {
    processed: checkpoint.processedCount,
    total: checkpoint.totalCount,
    percentage
  };
}
