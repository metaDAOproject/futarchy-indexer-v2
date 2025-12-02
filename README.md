# Futarchy Indexer v2

Solana indexer with multi-provider gRPC failover and automatic gap recovery.

## Architecture

```
MAIN PROCESS (index.ts)
    │
    ├─ Streaming Worker ──→ Primary gRPC → Backup gRPC → RPC (failover chain)
    │
    ├─ Cron Workers ──→ Backfill (hourly) / Gap-fill (10 min)
    │
    └─ Reindex Worker ──→ Isolated historical reprocessing (optional)
```

## How It Works

### Real-Time Streaming
- Connects to primary gRPC provider (Yellowstone)
- Falls back to backup gRPC (Helius), then RPC if needed
- Processes transactions and account updates in real-time
- Progress tracked in `indexers` table per-program

### Gap Detection
On startup or reconnect:
1. Query `indexers.latest_slot_processed` for each program
2. Compare to current chain slot
3. If gap ≤ 3000 slots → backup gRPC replay
4. If gap > 3000 slots → RPC signature crawl

### Backfill (Historical)
Crawls signatures forward from `latest_tx_sig_processed`. Progress tracked per-program so backfill resumes if interrupted.

### Reindex (Isolated)
Reprocesses historical transactions without affecting live indexing. Useful for backfilling after adding new event handlers.

## Configuration

```typescript
// src/index.ts
const DRY_RUN = false;          // Log only, no DB writes
const ENABLE_BACKFILL = true;   // Hourly historical backfill
const ENABLE_GAPFILL = true;    // 10-min gap detection
const ENABLE_REINDEXING = true; // Run reindex on startup
const REINDEX_FROM_SLOT = undefined;  // Starting slot (undefined = full history) ex 383015865 
const REINDEX_PROGRAM = undefined;  // Program filter (undefined = all) ex futarchy-v0.6
```

## Environment Variables

```bash
GRPC_ENDPOINT=...           # Primary gRPC (Yellowstone)
GRPC_TOKEN=...
BACKUP_GRPC_ENDPOINT=...    # Backup gRPC (Helius)
BACKUP_GRPC_API_KEY=...
RPC_ENDPOINT=...            # Fallback + tx fetching
DATABASE_URL=...            # Postgres connection
```

## Running

```bash
bun install
bun src/index.ts
```

Health dashboard available at `http://localhost:8080` for local development

---

# Adding a New Program

## Step 1: Create folder structure

```
src/indexers/{program-name}/v{version}/
├── index.ts      # ~15 lines - registration
├── processor.ts  # Event & account handlers
└── snapshot.ts   # Account snapshot logic
```

## Step 2: Create `index.ts`

```typescript
import { createProgramIndexer } from "../../../core/registry";
import { processMyEvent, processMyAccountUpdate } from "./processor";
import { MY_PROGRAM_ID } from "@metadaoproject/futarchy/v0.X";
import { myClient } from "../../../connections/v0.X";
import { snapshotMyAccounts } from "./snapshot";

export const myIndexer = createProgramIndexer({
  programId: MY_PROGRAM_ID,
  name: "my-program-v0.X",
  program: myClient.innerProgram,  // the object with .coder
  accountTypes: ["account1", "account2"],
  processEvent: processMyEvent,
  processAccountUpdate: processMyAccountUpdate,
  snapshotAccounts: snapshotMyAccounts,
});
```

The factory handles:
- Discriminator generation from account types
- Event decoding (base64 + Anchor coder)
- Account decoding (discriminator lookup)
- Auto-registration with the registry

## Step 3: Create `processor.ts`

```typescript
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { db, schema } from "@metadaoproject/indexer-db";

export async function processMyEvent(
  event: { name: string; data: any },
  signature: string,
  txResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "MyEvent":
      await db.insert(schema.my_table).values({
        signature,
        // ... map event data
      }).onConflictDoNothing();
      break;
  }
}

export async function processMyAccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  switch (accountType) {
    case "account1":
      // Handle real-time account state changes from gRPC
      break;
  }
}
```

## Step 4: Create `snapshot.ts`

```typescript
import { db, schema } from "@metadaoproject/indexer-db";
import { myClient } from "../../../connections/v0.X";

export async function snapshotMyAccounts(): Promise<void> {
  // Fetch all accounts and insert current state
  const accounts = await myClient.program.account.myAccount.all();

  for (const { publicKey, account } of accounts) {
    await db.insert(schema.my_table).values({
      address: publicKey.toString(),
      // ... map account data
    }).onConflictDoNothing();
  }
}
```

## Step 5: Add imports to workers

```typescript
// In BOTH src/workers/streaming.ts AND src/workers/backfill.ts:
import "../indexers/my-program/v0.X";
```

## Step 6: Add connection client (if new SDK version)

```typescript
// src/connections/v0.X.ts
import { Connection } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { MyClient } from "@metadaoproject/futarchy/v0.X";

const connection = new Connection(process.env.RPC_ENDPOINT!, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {});

export const myClient = MyClient.createClient({ provider });
```

## Step 7: Add to implementation map

```typescript
// In packages/database/lib/schema.ts, add enum value:
MyProgramV0X = "MyProgramV0X",

// In src/core/backfill/slotTracker.ts, add mapping:
"my-program-v0.X": IndexerImplementation.MyProgramV0X,
```

---

## Summary

| File | Purpose |
|------|---------|
| `index.ts` | 15 lines - factory registration |
| `processor.ts` | Event + account update handlers |
| `snapshot.ts` | Initial state snapshot |
| `streaming.ts` | Add 1 import line |
| `backfill.ts` | Add 1 import line |
| `connections/` | SDK client (if new version) |
| `schema.ts` | Enum value for tracking |
| `slotTracker.ts` | Name → enum mapping |

## Key Patterns

- **Events** = actions that happened (swaps, stakes, etc.)
- **Account updates** = current state changes via gRPC
- **Snapshot** = fast .all() fetch before historical crawl
- Progress tracked via `indexers.latest_slot_processed` and `latest_tx_sig_processed`
