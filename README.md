# Futarchy Indexer v2

Solana indexer with multi-provider gRPC failover and automatic gap recovery.

## Architecture

```
MAIN PROCESS (index.ts)
    │
    ├─ Streaming Worker ──→ Primary gRPC → Backup gRPC → RPC (failover chain)
    │
    └─ Cron Workers ──→ Backfill (hourly) / Gap-fill (10 min)
```

## How It Works

### Real-Time Streaming
- Connects to primary gRPC provider
- Falls back to backup gRPC, then RPC if needed
- Processes transactions and account updates in real-time
- Progress tracked in `indexers` table per-indexer

### Gap Detection
On startup or reconnect:
1. Query `indexers.latest_slot_processed` for each indexer
2. Compare to current chain slot
3. If gap ≤ 3000 slots → backup gRPC replay
4. If gap > 3000 slots → RPC signature crawl

### Backfill (Historical)
Crawls signatures forward from `latest_tx_sig_processed` in the `indexers` table. Progress is tracked per-indexer so backfill can resume if interrupted.

## Configuration

```typescript
// src/index.ts
const DRY_RUN = true;           // Log only, no DB writes
const ENABLE_BACKFILL = false;  // Hourly historical backfill
const ENABLE_GAPFILL = false;   // 10-min gap detection
```

## Environment Variables

```bash
GRPC_ENDPOINT=...           # Primary gRPC
GRPC_TOKEN=...
BACKUP_GRPC_ENDPOINT=...    # Backup gRPC 
BACKUP_GRPC_API_KEY=...
RPC_ENDPOINT=...            # Fallback + tx fetching
```

## Running

```bash
bun install
bun start
```

---

# Adding a New Program / SDK Version

## 1. Create a client connection for the version

```typescript
// src/connections/v0.7/index.ts
import { Connection } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { FutarchyClient } from "@metadaoproject/futarchy/v0.7";

const connection = new Connection(process.env.RPC_ENDPOINT!, "confirmed");

export const futarchyClient = FutarchyClient.createClient({ provider });
```

## 2. Create indexer files

```
src/indexers/my-program/v1.0/
├── index.ts      # Registration + discriminators
├── processor.ts  # Event and account update handlers
└── snapshot.ts   # Initial account snapshot (optional)
```

## 3. Register the indexer

In `index.ts`:
- Define account discriminators (first 8 bytes identify account type)
- Implement `decodeEvent()` and `decodeAccount()`
- Implement `processEvent()` and `processAccountUpdate()`
- Call `registerProgram()`

## 4. Add enum value to schema

In `packages/database/lib/schema.ts`, add to `IndexerImplementation`:
```typescript
MyProgramV10 = "MyProgramV10",
```

## 5. Add to implementation map

In `src/core/backfill/slotTracker.ts`:
```typescript
"my-program-v1.0": IndexerImplementation.MyProgramV10,
```

## 6. Import in workers

```typescript
// src/workers/streaming.ts AND src/workers/backfill.ts
import "../indexers/my-program/v1.0";
```

## Key Patterns

- Progress tracked via `indexers.latest_slot_processed` and `latest_tx_sig_processed`
- Events = actions that happened, Account updates = current state changes
