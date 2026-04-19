---
layout: post
title: "Building an LSM Storage Engine from Scratch in Go, Part 2"
date: 2025-08-29
description: "WAL for crash recovery, group commit for throughput, and bloom filters for read performance."
categories:
  - Storage Engines
tags:
  - Storage Engines
  - Go
  - Systems Programming
giscus_comments: false
---

Part 1 ended with a storage engine that loses data on crash and scans every SSTable on read. I'll try to address both in this post.

## The Write-Ahead Log

The memtable lives in memory; if the process dies, we lose the data. The fix is a write-ahead log, and before writing to the memtable, we append the entry to a file on disk and fsync. If the process crashes, we replay the log on startup to rebuild what was lost.

The WAL is append-only, using the same binary format as SSTables (tombstone byte, key length, key, value length, value).

```go
func (w *WAL) write(key, value []byte, tombstone byte) error {
    // append entry to buffer, block until fsync
}
```

After the WAL fsync completes, the write goes into the memtable. If the process crashes between the fsync and the memtable write, the entry is still on disk and recovery replays it.

The ordering here is important. WAL first, then memtable. If we wrote to the memtable first and crashed before the WAL fsync, the caller would get an acknowledgment for a non-durable write. The WAL's whole purpose is to guarantee that a successful return means the data survived a crash.

### Recovering from a Crash

Writing to the WAL gives us durability, but we also need to recover those entries on startup. If the process crashes, there are WAL entries on disk that never made it to an SSTable, and replaying them correctly turns out to be tricky.

During flush, we switch to a new WAL file before writing the SSTable, so one WAL maps to exactly one memtable generation. On startup, there might be one or two WAL files sitting on disk that need to be replayed. The naive approach would be to read each entry and call `lsm.Insert()`, but that writes back into the WAL (circular) and triggers auto-flush, which messes with WAL file lifecycle management.

I went through four different approaches before landing on one that handles repeated crashes correctly:

The first idea was to consolidate old WAL entries into a fresh WAL file, fsync it, and delete the old ones. The problem is what happens if we crash between the fsync and the delete. Both copies survive, and the next restart reads all of them, doubling the data. If the system keeps crashing at this point (and if it's crashing during startup, it probably will), data compounds with each restart.

The second idea was to read entries directly into a skiplist and then delete the old WAL files. But if we crash after deleting the old WALs and before the memtable gets flushed, the data is gone. It was in the WALs (now deleted), it's in the memtable (in memory, lost on crash), and the new WAL is empty.

The third was a variant of the first in the sense we consolidate but don't flush and let the system self-heal on restart (same compounding problem).

The approach I went with was to read all old WAL entries, build a skiplist, and write it directly to an SSTable. The SSTable is a different durable artifact than the WALs. We're transforming data from one format to another, not copying within the same format. Once the SSTable is fsynced, the WALs are redundant.

<img src="/assets/img/wal-recovery-light.svg" alt="WAL crash recovery flow" class="wal-recovery-light">
<img src="/assets/img/wal-recovery-dark.svg" alt="WAL crash recovery flow" class="wal-recovery-dark">

<style>
html[data-theme="dark"] .wal-recovery-light { display: none; }
html[data-theme="dark"] .wal-recovery-dark { display: block; }
html:not([data-theme="dark"]) .wal-recovery-light { display: block; }
html:not([data-theme="dark"]) .wal-recovery-dark { display: none; }
</style>

The reason this works is that no matter where the process crashes, the damage is bounded. If we crash before the SSTable fsync, the old WALs are still on disk and the next restart replays them again with no compounding. If we crash after the SSTable fsync but before deleting the old WALs, we end up with a duplicate SSTable on the next restart, but compaction handles that.

```go
func (lsm *LSM) RecoverExistingWALs() error {
    entries, paths, err := lsm.wal.readAllEntries()
    if err != nil {
        return fmt.Errorf("recovery: %w", err)
    }
    if len(entries) == 0 {
        return nil
    }

    sl := NewSkipList()
    for _, entry := range entries {
        if entry.Tombstone == 1 {
            sl.InsertWithTombstone(entry.Key)
        } else {
            sl.Insert(entry.Key, entry.Val)
        }
    }

    if err := lsm.writeSkipListToSSTable(sl, 0); err != nil {
        return fmt.Errorf("recovery: %w", err)
    }

    return lsm.wal.deleteFiles(paths)
}
```

There's a subtle gotcha here: recovery has to respect tombstones. If a WAL contains a delete operation and we ignore the tombstone during replay, the deleted key resurrects from an older SSTable. The skiplist preserves tombstone markers, and they get written through to the SSTable.

### Group Commit

The WAL works, but per-write fsync is a bottleneck. At 10K write QPS, that's 10K fsyncs per second, and the WAL would potentially become our throughput ceiling. Group commit fixes this by batching multiple writes into a single fsync.

<img src="/assets/img/group-commit-light.svg" alt="Group commit flow" class="group-commit-light">
<img src="/assets/img/group-commit-dark.svg" alt="Group commit flow" class="group-commit-dark">

<style>
html[data-theme="dark"] .group-commit-light { display: none; }
html[data-theme="dark"] .group-commit-dark { display: block; }
html:not([data-theme="dark"]) .group-commit-light { display: block; }
html:not([data-theme="dark"]) .group-commit-dark { display: none; }
</style>

A background goroutine runs on a 5ms ticker. Writers append their entries to a shared buffer and block on a channel. When the ticker fires, the goroutine:

1. Swaps the buffer (atomically, so new writes go to a fresh buffer)
2. Writes all entries from the old buffer to disk
3. Fsyncs once
4. Closes the channel to wake all blocked writers

At 10K QPS with a 5ms batch window, each batch contains ~50 writes. Instead of 10K fsyncs/second, we do 200.

The choice was to block the caller until fsync completes. The alternative is to return immediately and fsync in the background (faster, but breaks our durability guarantee).

PostgreSQL and RocksDB (with `sync_wal`) do the same thing: the caller blocks until the batch is durable. The latency cost is at most one batch interval (5ms worst case, 2.5ms average).

## Bloom Filters

That covers durability. The other problem is reads: a point read for a missing key has to scan every SSTable on disk, which brings us to bloom filters.

A bloom filter is a bit array with k hash functions. To insert a key: hash it k times, set those k bit positions to 1. To query: hash it k times, check those k positions. If any bit is 0, the key is definitely not present. If all bits are 1, the key is probably present. False negatives are impossible; if the bloom filter says "no," we skip the SSTable entirely. If it says "yes," we do the disk I/O.

The textbook approach uses k independent hash functions, but most production implementations (RocksDB included) use a single hash. The key is hashed to 64 bits, split into two 32-bit halves, and k positions are derived from those:

```go
func (bf *BloomFilter) hash(key []byte) (uint32, uint32) {
    bf.HashFunc.Reset()
    bf.HashFunc.Write(key)
    sum := bf.HashFunc.Sum64()
    h1 := uint32(sum >> 32)
    h2 := uint32(sum)
    return h1, h2
}

func (bf *BloomFilter) Exists(key []byte) bool {
    h1, h2 := bf.hash(key)
    for i := uint32(0); i < 5; i++ {
        pos := (h1 + i*h2) % bf.Modulo
        if !bf.getBit(pos) {
            return false
        }
    }
    return true
}
```

Deleted keys must also be captured in the bloom filter. If a tombstoned key is absent from the filter, the read path skips the SSTable containing the tombstone, falls through to an older SSTable containing the original value, and returns it. The key silently resurrects.

### Read Path Order

The read path checks two layers before hitting disk:

<img src="/assets/img/read-path-light.svg" alt="Read path order" class="read-path-light">
<img src="/assets/img/read-path-dark.svg" alt="Read path order" class="read-path-dark">

<style>
html[data-theme="dark"] .read-path-light { display: none; }
html[data-theme="dark"] .read-path-dark { display: block; }
html:not([data-theme="dark"]) .read-path-light { display: block; }
html:not([data-theme="dark"]) .read-path-dark { display: none; }
</style>

Ordering from cheapest to most expensive filter means we only do disk I/O when both in-memory checks pass.

## Where We Are

The storage engine now has:

- **Durability:** WAL with group commit ensures every acknowledged write survives a crash, and recovery replays WALs into SSTables on startup.
- **Write throughput:** Group commit batches writes into a single fsync, bringing us from 10K fsyncs/second down to 200.
- **Read efficiency:** Bloom filters let us skip SSTables that definitely don't contain the key we're looking for.

[Code is on GitHub.](https://github.com/adiu19/chorus/tree/main/storage)

*Part 3 covers compaction and folder-based SSTable recovery.*
