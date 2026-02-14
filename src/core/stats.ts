/**
 * Shared stats counters for health reporting
 * Separated to avoid circular dependencies between subscriptionManager and transactionIndexer
 */

// Stats counters
let eventCounter = 0;
let accountUpdateCounter = 0;

// Per-program event counts (program name -> event name -> count)
export const eventCountsByProgram: Map<string, Map<string, number>> = new Map();

// Per-account type counts
export const accountCountsByType: Map<string, number> = new Map();

export function getEventCount(): number {
  return eventCounter;
}

export function getAccountUpdateCount(): number {
  return accountUpdateCounter;
}

export function incrementEventCounter(count: number = 1): void {
  eventCounter += count;
}

export function incrementAccountUpdateCounter(count: number = 1): void {
  accountUpdateCounter += count;
}
