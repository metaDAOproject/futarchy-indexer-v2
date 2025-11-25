/**
 * Shared utilities for all indexers
 */

/**
 * Serialize objects for readable logging - handles BN, PublicKey, BigInt
 */
export function serializeForLogging(obj: any, depth = 0, maxDepth = 10): any {
  // Handle null/undefined
  if (obj === null || obj === undefined) return obj;

  // Handle BigNumber (BN) - check BEFORE depth limit
  if (obj && obj.constructor && obj.constructor.name === 'BN') {
    return obj.toString();
  }

  // Handle PublicKey - check BEFORE depth limit
  if (obj && typeof obj === 'object' && obj._bn && typeof obj.toBase58 === 'function') {
    return obj.toBase58();
  }

  // Handle bigint
  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  // NOW check depth limit (after handling BN/PublicKey)
  if (depth > maxDepth) return '[Max Depth Reached]';

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => serializeForLogging(item, depth + 1, maxDepth));
  }

  // Handle objects
  if (typeof obj === 'object') {
    const serialized: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        serialized[key] = serializeForLogging(obj[key], depth + 1, maxDepth);
      }
    }
    return serialized;
  }

  // Return primitives as-is
  return obj;
}
