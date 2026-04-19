---
layout: post
title: "Building an LSM Storage Engine from Scratch in Go, Part 1"
date: 2025-08-16
description: "Writing a log-structured merge-tree storage engine from first principles in Go: skiplists, binary SSTables, and the flush path."
categories:
  - Storage Engines
tags:
  - Storage Engines
  - Go
  - Systems Programming
giscus_comments: false
---

We built an LSM-tree storage engine from scratch in Go. No external dependencies, only raw file I/O and binary formats. This post covers Part 1: the core data structures and the write path from memory to disk.

## Why Build a Storage Engine?

Any system that needs to persist key-value data and read it back efficiently needs a storage engine.

We wanted to understand what actually happens when bytes move from a function call to physical disk. What guarantees does fsync give? What happens on crash? Building from scratch was the fastest way to answer these questions.

The engine targets 10K write QPS with bounded read latency.

## The LSM-Tree in 30 Seconds

An LSM-tree (Log-Structured Merge-tree) is a write-optimized data structure. The core idea:

1. **Write to memory first.** An in-memory sorted structure (the *memtable*) absorbs all writes (no disk I/O).
2. **Flush to disk periodically.** When the memtable gets large enough, write it out as a sorted, immutable file (an *SSTable*).
3. **Read by checking layers.** Check the memtable first, then SSTables on disk newest first (first match wins).
4. **Compact in the background.** Merge SSTables over time to reclaim space and reduce read amplification.

Writes are always sequential (append to memory, flush sorted blocks). Reads fan out across layers. This tradeoff (fast writes, slightly more expensive reads) is why LSMs are popular for write-heavy workloads (RocksDB and Cassandra both use variants of this).

## The Memtable: A Skiplist

The memtable needs to support concurrent inserts and sorted iteration. We chose a skiplist.

A skiplist is a probabilistic data structure built on layered linked lists. Each node exists at level 0 (the base). On insertion, a coin-flip loop decides how many upper levels the node gets promoted to. The result: O(log n) expected time for insert, lookup, and delete. Same complexity as a balanced BST, but without rotations.

```
Level 3:  HEAD ---------------------------------> 40 -> nil
Level 2:  HEAD ---------> 15 -------------------> 40 -> nil
Level 1:  HEAD -> 5 ----> 15 ---------> 30 -----> 40 -> nil
Level 0:  HEAD -> 5 -> 10 -> 15 -> 20 -> 30 -> 35 -> 40 -> nil
```

To find key `20`: start at the top level, skip forward until overshooting, drop down, repeat. Most keys are skipped entirely at upper levels.

Our implementation:

```go
type Node struct {
    Key       []byte
    Value     []byte
    Forward   []*Node
    Tombstone byte
}

type SkipList struct {
    Head        *Node
    mu          sync.RWMutex
    SizeInBytes int
}
```

A few design choices:

- **`RWMutex`, not per-node locks.** A `Get` traversing forward pointers while an `Insert` modifies them mid-splice can follow a nil or stale pointer. Reads need at minimum an RLock. We went with a single RWMutex over the whole skiplist. Simpler, and the critical section is short (pointer updates only).
- **`SizeInBytes` tracking.** Every insert adds `1 + len(key) + len(value)` to the counter. Overwrites adjust by `len(newValue) - len(oldValue)`. This drives the auto-flush decision without scanning the skiplist.
- **Overwrite semantics.** Inserting a duplicate key overwrites the value in place. LSM semantics are last-write-wins.

## The Tombstone Problem

How do we delete a key from an append-only system? We can't go back and remove it from an SSTable on disk. SSTables are immutable.

The answer is a *tombstone*: a marker that says "this key is deleted." A delete is really an insert with the tombstone byte set to `1`. When the read path encounters a tombstone, it stops searching.

## The SSTable: A Binary File Format

When the memtable is flushed, we walk the skiplist in sorted order (level 0) and write each entry to a binary file. We considered three encoding options:

- **Delimiter-separated** (e.g. newline between entries): simple, but breaks if values contain the delimiter byte.
- **Fixed-width fields**: wastes space. Our values range from a few bytes to several KB.
- **Length-prefixed binary**: handles arbitrary byte values, and lets us skip entries during scan without reading them (read the length, seek forward).

We went with length-prefixed. The format:

```
Per entry: [1B tombstone][1B key_len][key][2B val_len][value]
```

Why these sizes?

- **1 byte tombstone.** Could pack into a single bit of `key_len`, but byte-aligned fields are simpler to debug. The 7 unused bits are available for future metadata flags.
- **1 byte key_len (max 255 bytes).** Our keys are 10-40 bytes, so 255 should be more than enough. Saves 1 byte per entry vs uint16.
- **2 byte val_len (max ~64KB, big-endian).** Values can be several KB. 64KB headroom is sufficient.

The overhead is 4 bytes per entry.

## The Flush Path

When the memtable exceeds a size threshold (500MB chosen for the workload), we flush it to an SSTable:

1. **Atomic pointer swap.** Replace the active memtable with a fresh empty skiplist. The old skiplist becomes immutable. New writes go to the fresh skiplist immediately, no blocking.
2. **Write the SSTable.** Walk level 0 of the old skiplist, write each entry in the binary format. Flush the bufio buffer, then fsync to disk.
3. **Update the manifest.** Append one line to a manifest file recording the SSTable's filename, sequence number, size, and key range.
4. **Clear the immutable reference.** The old skiplist can be garbage collected.

```go
func (lsm *LSM) Flush() error {
    old := lsm.memTable.Load()
    lsm.immutableMemTable.Store(old)
    lsm.memTable.Store(NewSkipList())

    if err := lsm.writeSkipListToSSTable(old); err != nil {
        return err
    }

    lsm.immutableMemTable.Store(nil)
    return nil
}
```

The immutable memtable exists for the read path. During flush, a `Get` might look for a key that's in the old skiplist but not yet on disk. The read path checks: active memtable, then immutable memtable, then SSTables. Once the SSTable is written and the manifest updated, the immutable reference is cleared.

### Why `atomic.Pointer`?

The memtable swap uses `atomic.Pointer[SkipList]`. This guarantees the pointer replacement is a single indivisible operation. No goroutine ever sees a half-written pointer. But it does *not* make the sequence `Load() + Store()` atomic.

In practice, a few writes might land in the old skiplist during the swap window. They end up duplicated in the flushed SSTable but correct. Last-write-wins semantics handle it.

### Auto-Flush

Both `Insert` and `Delete` check the memtable's `SizeInBytes` after each write via `defer checkAndTriggerAutoFlush()`. If the threshold is exceeded, a goroutine is spawned to flush. `sync.Mutex` with `TryLock()` prevents concurrent flushes. If one is already running, the second trigger is a no-op.

```go
func (lsm *LSM) checkAndTriggerAutoFlush() {
    if lsm.memTable.Load().SizeInBytes >= lsm.manifest.maxBytesBeforeFlush {
        go func() {
            if lsm.mu.TryLock() {
                lsm.Flush()
                lsm.mu.Unlock()
            }
        }()
    }
}
```

### The Manifest

On restart, the LSM needs to know which SSTables exist, their key ranges, and their ordering. Scanning the directory and opening every file is O(N) in the number of SSTables. At 10K write QPS, that's thousands of files per hour before compaction.

Instead, we maintain a manifest file. Each flush appends one line:

```
sstable_000001.dat,seq=1,size=4096,minKey=<base62>,maxKey=<base62>
```

Keys are base62-encoded in the manifest because raw keys can contain commas, newlines, or any byte. Storing them directly in a text format would break parsing.

On startup, we read one file, parse the entries, and derive `nextSeq` from the last entry's sequence number + 1. No `nextSeq` header needed since it's derivable from the data. This makes flush a pure append to the manifest: no read-before-write, no rewrite.

## The Read Path

A `Get` checks three tiers, newest first:

```
Active memtable -> Immutable memtable -> SSTables (newest first)
```

For SSTables, we filter before scanning:

1. **Min/max key range** (from manifest, in memory): if the target key is outside the SSTable's key range, skip it entirely.
2. **Sequential scan**: read entries one by one until we find the key or hit EOF.

This works but has a clear bottleneck: a point read for a missing key scans every SSTable. Part 2 addresses this with bloom filters.

[Code is on GitHub.](https://github.com/adiu19/chorus/tree/main/storage)

*Part 2 covers the WAL, crash recovery, group commit, and bloom filters. We make writes durable and reads efficient.*
