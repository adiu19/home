---
layout: post
title: "Peer-to-Peer Caching for FUSE-Backed Content Stores, Part 1"
date: 2026-05-22
description: "Measuring the per-op cost of going through FUSE versus a kernel filesystem, as groundwork for a peer-to-peer blob-sharing layer."
categories:
  - Distributed Systems
  - Systems Programming
tags:
  - FUSE
  - Distributed Systems
  - Performance
  - Go
giscus_comments: false
---

<style>
.viz-container {
  --viz-bg: #fafafa;
  --viz-fg: #222;
  --viz-muted: #888;
  --viz-grid: #e5e5e5;
  --viz-fuse: #f59e0b;
  --viz-tmpfs: #2563eb;
  --viz-fuse-band: rgba(245, 158, 11, 0.18);
  --viz-tmpfs-band: rgba(37, 99, 235, 0.15);
  background: var(--viz-bg);
  color: var(--viz-fg);
  border: 1px solid var(--viz-grid);
  border-radius: 8px;
  padding: 16px;
  margin: 24px 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
html[data-theme="dark"] .viz-container {
  --viz-bg: #1a1a1a;
  --viz-fg: #eee;
  --viz-muted: #999;
  --viz-grid: #333;
  --viz-fuse: #fbbf24;
  --viz-tmpfs: #60a5fa;
  --viz-fuse-band: rgba(251, 191, 36, 0.22);
  --viz-tmpfs-band: rgba(96, 165, 250, 0.20);
}
.viz-charts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 720px) {
  .viz-charts { grid-template-columns: 1fr; }
}
.viz-chart {
  width: 100%;
  height: auto;
  font-size: 11px;
}
.viz-chart .viz-title {
  font-size: 13px;
  font-weight: 600;
  fill: var(--viz-fg);
}
.viz-chart .viz-gridlines line {
  stroke: var(--viz-grid);
  stroke-width: 1;
}
.viz-chart .viz-axis {
  stroke: var(--viz-muted);
  stroke-width: 1;
  fill: none;
}
.viz-chart .viz-labels text,
.viz-chart .viz-axis-title {
  fill: var(--viz-muted);
}
.viz-chart .viz-axis-title { font-size: 12px; }
.viz-chart .viz-line {
  stroke-width: 2;
  fill: none;
}
.viz-chart .viz-line.fuse { stroke: var(--viz-fuse); }
.viz-chart .viz-line.tmpfs { stroke: var(--viz-tmpfs); }
.viz-chart .viz-point.fuse { fill: var(--viz-fuse); }
.viz-chart .viz-point.tmpfs { fill: var(--viz-tmpfs); }
.viz-chart .viz-band.fuse { fill: var(--viz-fuse-band); }
.viz-chart .viz-band.tmpfs { fill: var(--viz-tmpfs-band); }
.viz-legend {
  display: flex;
  gap: 18px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--viz-muted);
  flex-wrap: wrap;
  justify-content: center;
}
.viz-legend .item { display: flex; align-items: center; gap: 6px; }
.viz-legend .swatch { display: inline-block; width: 14px; height: 3px; border-radius: 2px; }
.viz-legend .swatch.fuse { background: var(--viz-fuse); }
.viz-legend .swatch.tmpfs { background: var(--viz-tmpfs); }
.viz-legend .swatch.band { height: 10px; width: 14px; background: var(--viz-fuse-band); border: 1px solid var(--viz-fuse); border-radius: 2px; }
.viz-caption { text-align: center; font-size: 12px; color: var(--viz-muted); margin-top: 10px; font-style: italic; }
</style>

Modal published a [blog post](https://modal.com/blog/truly-serverless-gpus) in May 2026 about their serverless GPU stack. Cold-starting a container on a GPU worker means pulling its filesystem first (image layers and model weights), so the bytes a container reads come from a cache hierarchy instead of object storage on every boot. One line about that hierarchy stood out:

> "To really make this rip, you might build more layers between SSD and object storage, like an RDMA layer or within-AZ peer-to-peer sharing. Both are compelling on the numbers, but add a lot of engineering complexity, so we haven't added them — yet."

The unbuilt tier they're calling out: when a worker misses its local SSD cache, the fall-through is the AZ cache server at ~1ms. There's another worker right next door, on the same intra-AZ network, probably already holding the same blob. Why not ask that worker first?

This two-part series measures that. Part 1 (this post) is the groundwork: how much does going through FUSE cost compared to going through a kernel filesystem? What's the per-op overhead, and how does it scale with concurrency? Part 2 builds the P2P layer and measures whether fetching from a peer actually beats the centralized fall-through, and whether the coordination overhead eats the savings.

## Why FUSE

<img src="/assets/img/p2p_fuse_overview_light_mode.png" alt="FUSE architecture: app → kernel VFS → /dev/fuse → userspace daemon → backend" class="fuse-overview-light" style="max-width: 60%;">
<img src="/assets/img/p2p_fuse_overview_dark_mode.png" alt="FUSE architecture: app → kernel VFS → /dev/fuse → userspace daemon → backend" class="fuse-overview-dark" style="max-width: 60%;">

<style>
html[data-theme="dark"] .fuse-overview-light { display: none; }
html[data-theme="dark"] .fuse-overview-dark { display: block; margin: 0 auto; }
html:not([data-theme="dark"]) .fuse-overview-light { display: block; margin: 0 auto; }
html:not([data-theme="dark"]) .fuse-overview-dark { display: none; }
</style>

Apps `open()` files and `read()` bytes, and they don't know what's underneath. To serve them custom data without changing them, we need to look like a filesystem.

FUSE lets us do that: the kernel keeps its VFS abstraction while a userspace daemon implements the ops over a `/dev/fuse` channel. The daemon can do anything (fetch from the network, lazy-load) and the kernel doesn't care.

The cost is the round trip: every `read()` walks app → kernel → daemon → kernel → app, which is two context switches and tens of microseconds at minimum. Whether that cost matters depends on what we're hiding behind it.

## The setup

I've been building [chorus](https://github.com/adiu19/chorus) for a while: it started as a gossip cluster, grew into a replicated KV store, then more pieces on top. The point of chorus, to me, was never any specific feature. It was to find out whether I could combine the primitives without coupling them (and help me benchmark things!).

For part 1, only one of those primitives matters: the pluggable FUSE backend, which mounts a filesystem and serves bytes from an in-memory map. The full worker architecture (gossip, replicated KV for discovery, peer-fetch transport) lands in part 2, when there's actually a cluster to talk about.

## How we measure

We measure what an app would feel: `open()` and `read()` syscalls against the mount, timed at the syscall boundary. That's a specific workload, so we wrote a specific harness (a Go program that opens hash-named files and reads their bytes). The corpus is N deterministic random blobs, each named by `sha256(bytes)`. The daemon and harness derive the same hash list from a shared seed, with no coordination at startup.

The baseline is tmpfs with the same harness and workload, so the gap between FUSE p99 and tmpfs p99 is exactly the cost of the FUSE round trip, with nothing else varying.

We run each configuration 10 times, take the p99 within each run, then report the median of those 10 p99s. The concurrency sweep covers 1, 4, 16, 64, and 256 readers, on a box with 4 dedicated vCPU and 16 GB of RAM.

## What we found

<div class="viz-container">
<div class="viz-charts">

<svg class="viz-chart" viewBox="0 0 480 380" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
  <text class="viz-title" x="240" y="18" text-anchor="middle">open()</text>
  <g class="viz-gridlines">
    <line x1="60" y1="320" x2="460" y2="320" />
    <line x1="60" y1="262" x2="460" y2="262" />
    <line x1="60" y1="204" x2="460" y2="204" />
    <line x1="60" y1="146" x2="460" y2="146" />
    <line x1="60" y1="88" x2="460" y2="88" />
    <line x1="60" y1="30" x2="460" y2="30" />
  </g>
  <path class="viz-axis" d="M60,30 L60,320 L460,320" />
  <g class="viz-labels">
    <text x="56" y="324" text-anchor="end">1µs</text>
    <text x="56" y="266" text-anchor="end">10µs</text>
    <text x="56" y="208" text-anchor="end">100µs</text>
    <text x="56" y="150" text-anchor="end">1ms</text>
    <text x="56" y="92" text-anchor="end">10ms</text>
    <text x="56" y="34" text-anchor="end">100ms</text>
    <text x="60" y="340" text-anchor="middle">1</text>
    <text x="160" y="340" text-anchor="middle">4</text>
    <text x="260" y="340" text-anchor="middle">16</text>
    <text x="360" y="340" text-anchor="middle">64</text>
    <text x="460" y="340" text-anchor="middle">256</text>
  </g>
  <text class="viz-axis-title" x="260" y="362" text-anchor="middle">concurrency</text>

  <polyline class="viz-line fuse" points="60,208 160,142 260,108 360,71 460,39" />
  <circle class="viz-point fuse" cx="60" cy="208" r="3" />
  <circle class="viz-point fuse" cx="160" cy="142" r="3" />
  <circle class="viz-point fuse" cx="260" cy="108" r="3" />
  <circle class="viz-point fuse" cx="360" cy="71" r="3" />
  <circle class="viz-point fuse" cx="460" cy="39" r="3" />

  <polyline class="viz-line tmpfs" points="60,264 160,252 260,259 360,262 460,262" />
  <circle class="viz-point tmpfs" cx="60" cy="264" r="3" />
  <circle class="viz-point tmpfs" cx="160" cy="252" r="3" />
  <circle class="viz-point tmpfs" cx="260" cy="259" r="3" />
  <circle class="viz-point tmpfs" cx="360" cy="262" r="3" />
  <circle class="viz-point tmpfs" cx="460" cy="262" r="3" />
</svg>

<svg class="viz-chart" viewBox="0 0 480 380" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
  <text class="viz-title" x="240" y="18" text-anchor="middle">read()</text>
  <g class="viz-gridlines">
    <line x1="60" y1="320" x2="460" y2="320" />
    <line x1="60" y1="262" x2="460" y2="262" />
    <line x1="60" y1="204" x2="460" y2="204" />
    <line x1="60" y1="146" x2="460" y2="146" />
    <line x1="60" y1="88" x2="460" y2="88" />
    <line x1="60" y1="30" x2="460" y2="30" />
  </g>
  <path class="viz-axis" d="M60,30 L60,320 L460,320" />
  <g class="viz-labels">
    <text x="56" y="324" text-anchor="end">1µs</text>
    <text x="56" y="266" text-anchor="end">10µs</text>
    <text x="56" y="208" text-anchor="end">100µs</text>
    <text x="56" y="150" text-anchor="end">1ms</text>
    <text x="56" y="92" text-anchor="end">10ms</text>
    <text x="56" y="34" text-anchor="end">100ms</text>
    <text x="60" y="340" text-anchor="middle">1</text>
    <text x="160" y="340" text-anchor="middle">4</text>
    <text x="260" y="340" text-anchor="middle">16</text>
    <text x="360" y="340" text-anchor="middle">64</text>
    <text x="460" y="340" text-anchor="middle">256</text>
  </g>
  <text class="viz-axis-title" x="260" y="362" text-anchor="middle">concurrency</text>

  <polyline class="viz-line fuse" points="60,218 160,173 260,127 360,82 460,46" />
  <circle class="viz-point fuse" cx="60" cy="218" r="3" />
  <circle class="viz-point fuse" cx="160" cy="173" r="3" />
  <circle class="viz-point fuse" cx="260" cy="127" r="3" />
  <circle class="viz-point fuse" cx="360" cy="82" r="3" />
  <circle class="viz-point fuse" cx="460" cy="46" r="3" />

  <polyline class="viz-line tmpfs" points="60,310 160,306 260,308 360,310 460,312" />
  <circle class="viz-point tmpfs" cx="60" cy="310" r="3" />
  <circle class="viz-point tmpfs" cx="160" cy="306" r="3" />
  <circle class="viz-point tmpfs" cx="260" cy="308" r="3" />
  <circle class="viz-point tmpfs" cx="360" cy="310" r="3" />
  <circle class="viz-point tmpfs" cx="460" cy="312" r="3" />
</svg>

</div>

<div class="viz-legend">
  <div class="item"><span class="swatch fuse"></span>FUSE p99</div>
  <div class="item"><span class="swatch tmpfs"></span>tmpfs p99</div>
</div>
<div class="viz-caption">p99 latency vs concurrent readers</div>
</div>

**At a single reader,** FUSE adds ~85µs to `open()` and ~58µs to `read()` over tmpfs: what every FUSE-backed system pays per op with no contention. **Under load it diverges**: tmpfs stays flat at ~11µs across the entire concurrency range, while FUSE grows nearly linearly, reaching a 72ms p99 at 256 readers.

The shape is interesting too: tmpfs is flat because the kernel parallelizes filesystem ops natively; FUSE isn't, because every request flows through one `/dev/fuse` channel to one daemon process.

That single path seems to be the bottleneck, and any FUSE-backed system that wants to scale has to tackle it: more channels, more daemon threads, or enough caching that most reads never reach the daemon at all.

## What comes next

The follow-up question, which part 2 measures: when the bytes aren't local, where should they come from? The shared cache server everyone falls through to, or a peer that already holds the bytes? How does that choice affect end-to-end latency at realistic concurrency?
