---
layout: post
title: "Building an LSM Storage Engine from Scratch in Go, Part 4"
date: 2025-09-26
description: "Benchmarking the LSM: throughput-latency curves, group commit tuning, and the methodology behind it all."
categories:
  - Storage Engines
tags:
  - Storage Engines
  - Go
  - Systems Programming
giscus_comments: false
---

<style>
.viz-container {
  --viz-bg: #fafafa;
  --viz-fg: #222;
  --viz-muted: #888;
  --viz-grid: #e5e5e5;
  --viz-p50: #2563eb;
  --viz-p99: #f59e0b;
  --viz-p999: #dc2626;
  --viz-slo: #16a34a;
  --viz-marker: #222;
  --viz-accent: #6366f1;
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
  --viz-muted: #888;
  --viz-grid: #333;
  --viz-p50: #60a5fa;
  --viz-p99: #fbbf24;
  --viz-p999: #f87171;
  --viz-slo: #4ade80;
  --viz-marker: #eee;
  --viz-accent: #a78bfa;
}
.viz-container svg { display: block; width: 100%; height: auto; }
.viz-container canvas { display: block; width: 100%; max-width: 100%; }
.viz-controls { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.viz-controls input[type="range"] { flex: 1; min-width: 200px; accent-color: var(--viz-accent); }
.viz-controls label { font-size: 13px; color: var(--viz-muted); }
.viz-readout { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-top: 12px; font-size: 14px; }
.viz-readout .metric { background: var(--viz-grid); padding: 8px 12px; border-radius: 4px; }
.viz-readout .metric .label { font-size: 11px; color: var(--viz-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.viz-readout .metric .value { font-size: 16px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.viz-readout .metric.p50 .value { color: var(--viz-p50); }
.viz-readout .metric.p99 .value { color: var(--viz-p99); }
.viz-readout .metric.p999 .value { color: var(--viz-p999); }
.viz-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--viz-muted); flex-wrap: wrap; }
.viz-legend .item { display: flex; align-items: center; gap: 6px; }
.viz-legend .swatch { width: 12px; height: 3px; border-radius: 2px; }
</style>

Parts 1 through 3 laid down the pieces: a skiplist memtable, a WAL with group commit, bloom filters, and leveled compaction across per-level directories. Part 4 is where we check whether our design decisions hold up under load, and whether we actually hit the 10K write QPS target set in Part 1.

## The Benchmark Setup

The obvious way to benchmark here is to spin up N client goroutines, each in a loop: send a request, wait for the response, record the latency, repeat. This is a closed-loop setup, and it systematically lies about latency under load.

The problem is coordinated omission (when the server slows down, the client slows down with it). If a request takes 500ms instead of the expected 5ms, the client waits 500ms before firing the next one. A real caller would have already queued up the next batch of requests in that window, but the benchmark never sees them, so the latency percentiles only reflect requests the server managed to serve (Scylla has a [great writeup](https://www.scylladb.com/2021/04/22/on-coordinated-omission/) on this).

The fix is an open-loop load generator that fires requests at a fixed rate regardless of whether previous ones completed. The setup here is a single goroutine with a ticker: every 1ms it pushes N tokens into a buffered channel, where each token carries the timestamp at which it *should* have fired. Worker goroutines pull tokens off the channel and fire a gRPC call each. Latency is measured as `time.Since(token.ts)`, so it includes the time the token spent sitting in the channel.

<div class="viz-container" id="benchmark-viz">
  <canvas id="bm-canvas" width="800" height="240"></canvas>
  <div class="viz-legend">
    <div class="item"><span class="swatch" style="background: var(--viz-p50); width: 8px; height: 8px; border-radius: 50%;"></span>token (with timestamp)</div>
    <div class="item"><span class="swatch" style="background: var(--viz-accent); width: 12px; height: 3px;"></span>load gen tick</div>
    <div class="item"><span class="swatch" style="background: var(--viz-p999); width: 8px; height: 8px; border-radius: 50%;"></span>in-flight (gRPC)</div>
  </div>
</div>

<script>
(function() {
  const canvas = document.getElementById('bm-canvas');
  const ctx = canvas.getContext('2d');
  const FIXED_RATE = 3;
  function getColor(name) {
    return getComputedStyle(document.getElementById('benchmark-viz')).getPropertyValue(name).trim();
  }

  const W = 800, H = 240;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  // Sim params (slowed way down for visual clarity)
  const CHANNEL_CAP = 10;
  const NUM_WORKERS = 4;
  const SERVICE_TIME = 1.2;   // sim seconds per gRPC call
  const TICK_INTERVAL = 0.4;  // sim seconds between load-gen ticks
  const SIM_SPEED = 0.6;      // real seconds per sim second

  // State
  let simTime = 0;
  let lastTickTime = 0;
  let tokens = [];  // { id, ts, state, x, y, tx, ty, startedAt, workerIdx }
  let nextId = 0;
  const workers = Array.from({ length: NUM_WORKERS }, (_, i) => ({ id: i, busy: false, token: null, progressStart: 0 }));
  let tickFlashUntil = 0;

  // Layout coordinates
  const LOADGEN = { x: 60, y: 100 };
  const CHANNEL_X = 180, CHANNEL_Y = 100, CHANNEL_W = 300, SLOT_SIZE = 28;
  const WORKERS_X = 580, WORKER_SPACING = 50, WORKERS_Y_START = 50;
  const SERVER_X = 730, SERVER_Y = 100;

  function workerY(i) { return WORKERS_Y_START + i * WORKER_SPACING; }

  function step(dt) {
    simTime += dt;

    // Load-gen: fire tokens every TICK_INTERVAL
    if (simTime - lastTickTime >= TICK_INTERVAL) {
      const rate = FIXED_RATE;
      tickFlashUntil = simTime + 0.15;
      for (let i = 0; i < rate; i++) {
        if (tokens.filter(t => t.state === 'queued' || t.state === 'arriving').length >= CHANNEL_CAP) {
          // Channel full, the token still gets queued in "waiting to enter" — we model this by still pushing; real code blocks the ticker
          // For visual clarity we skip (blocked ticker); in the note below we mention real behavior
          break;
        }
        tokens.push({
          id: nextId++,
          ts: simTime,
          state: 'arriving',
          progress: 0,
        });
      }
      lastTickTime = simTime;
    }

    // Advance arriving tokens to the channel
    tokens.forEach(t => {
      if (t.state === 'arriving') {
        t.progress += dt / 0.4; // 0.4s to arrive
        if (t.progress >= 1) {
          t.state = 'queued';
          t.progress = 0;
        }
      }
    });

    // Workers pick up tokens
    workers.forEach(w => {
      if (!w.busy) {
        const queued = tokens.filter(t => t.state === 'queued');
        if (queued.length > 0) {
          // FIFO: oldest first
          queued.sort((a, b) => a.ts - b.ts);
          const token = queued[0];
          token.state = 'transit';  // moving to worker
          token.transitProgress = 0;
          token.workerIdx = w.id;
          w.busy = true;
          w.token = token;
        }
      }
    });

    // Transit to worker
    tokens.forEach(t => {
      if (t.state === 'transit') {
        t.transitProgress += dt / 0.4;
        if (t.transitProgress >= 1) {
          t.state = 'processing';
          t.processStart = simTime;
        }
      }
    });

    // Processing (gRPC call)
    tokens.forEach(t => {
      if (t.state === 'processing') {
        if (simTime - t.processStart >= SERVICE_TIME) {
          const w = workers[t.workerIdx];
          w.busy = false;
          w.token = null;
          t.state = 'done';
        }
      }
    });

    tokens = tokens.filter(t => t.state !== 'done');
  }

  function draw() {
    const cFg = getColor('--viz-fg');
    const cMuted = getColor('--viz-muted');
    const cGrid = getColor('--viz-grid');
    const cToken = getColor('--viz-p50');
    const cInFlight = getColor('--viz-p999');
    const cAccent = getColor('--viz-accent');
    const cBg = getColor('--viz-bg');

    ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, W, H);

    // Labels
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillStyle = cMuted;
    ctx.textAlign = 'center';
    ctx.fillText('Load gen', LOADGEN.x, 20);
    ctx.fillText('(ticker)', LOADGEN.x, 35);
    ctx.fillText('Channel (buffered, cap 10)', CHANNEL_X + CHANNEL_W / 2, 20);
    ctx.fillText('Workers (4)', WORKERS_X, 20);
    ctx.fillText('gRPC server', SERVER_X, 20);

    // Load gen box
    const flashing = simTime < tickFlashUntil;
    ctx.strokeStyle = flashing ? cAccent : cGrid;
    ctx.lineWidth = flashing ? 3 : 2;
    ctx.fillStyle = flashing ? cAccent + '33' : cBg;
    ctx.beginPath();
    ctx.arc(LOADGEN.x, LOADGEN.y, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = flashing ? cAccent : cMuted;
    ctx.font = '16px -apple-system, sans-serif';
    ctx.fillText('tick', LOADGEN.x, LOADGEN.y + 5);

    // Channel slots
    const queued = tokens.filter(t => t.state === 'queued').sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < CHANNEL_CAP; i++) {
      const x = CHANNEL_X + i * ((CHANNEL_W - SLOT_SIZE) / (CHANNEL_CAP - 1));
      ctx.strokeStyle = cGrid;
      ctx.lineWidth = 1;
      ctx.fillStyle = cBg;
      ctx.fillRect(x, CHANNEL_Y - SLOT_SIZE / 2, SLOT_SIZE, SLOT_SIZE);
      ctx.strokeRect(x, CHANNEL_Y - SLOT_SIZE / 2, SLOT_SIZE, SLOT_SIZE);
      if (queued[i]) {
        ctx.fillStyle = cToken;
        ctx.beginPath();
        ctx.arc(x + SLOT_SIZE / 2, CHANNEL_Y, 9, 0, Math.PI * 2);
        ctx.fill();
        // Age (just the number, fits in slot)
        const age = (simTime - queued[i].ts).toFixed(1);
        ctx.fillStyle = cMuted;
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(age, x + SLOT_SIZE / 2, CHANNEL_Y + SLOT_SIZE + 4);
      }
    }
    // Single "queue wait" annotation below the numbers
    ctx.fillStyle = cMuted;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('↑ queue wait (time.Since(token.ts))', CHANNEL_X + CHANNEL_W / 2, CHANNEL_Y + SLOT_SIZE + 22);

    // Arrow channel → workers (static)
    ctx.strokeStyle = cGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CHANNEL_X + CHANNEL_W, CHANNEL_Y);
    ctx.lineTo(WORKERS_X - 30, CHANNEL_Y);
    ctx.stroke();

    // Workers
    workers.forEach((w, i) => {
      const y = workerY(i);
      ctx.fillStyle = w.busy ? cInFlight + '33' : cBg;
      ctx.strokeStyle = w.busy ? cInFlight : cGrid;
      ctx.lineWidth = 2;
      ctx.fillRect(WORKERS_X - 25, y - 15, 50, 30);
      ctx.strokeRect(WORKERS_X - 25, y - 15, 50, 30);
      ctx.fillStyle = w.busy ? cInFlight : cMuted;
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('W' + i, WORKERS_X, y + 4);

      // Progress bar on busy worker
      if (w.busy && w.token) {
        const prog = Math.min((simTime - w.token.processStart) / SERVICE_TIME, 1);
        ctx.fillStyle = cInFlight;
        ctx.fillRect(WORKERS_X - 23, y + 10, 46 * prog, 3);
      }
    });

    // Server box
    ctx.strokeStyle = cGrid;
    ctx.lineWidth = 2;
    ctx.fillStyle = cBg;
    ctx.fillRect(SERVER_X - 30, SERVER_Y - 25, 60, 50);
    ctx.strokeRect(SERVER_X - 30, SERVER_Y - 25, 60, 50);
    ctx.fillStyle = cMuted;
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LSM', SERVER_X, SERVER_Y + 5);

    // Arrows workers → server
    workers.forEach((w, i) => {
      ctx.strokeStyle = w.busy ? cInFlight : cGrid;
      ctx.lineWidth = w.busy ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(WORKERS_X + 25, workerY(i));
      ctx.lineTo(SERVER_X - 30, SERVER_Y);
      ctx.stroke();
    });

    // Arriving tokens (between load gen and channel)
    tokens.filter(t => t.state === 'arriving').forEach(t => {
      const x = LOADGEN.x + 24 + (CHANNEL_X - LOADGEN.x - 24) * t.progress;
      const y = LOADGEN.y;
      ctx.fillStyle = cToken;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    });

    // Transit tokens (channel → worker)
    tokens.filter(t => t.state === 'transit').forEach(t => {
      const sourceX = CHANNEL_X + CHANNEL_W / 2;
      const targetX = WORKERS_X;
      const targetY = workerY(t.workerIdx);
      const x = sourceX + (targetX - sourceX) * t.transitProgress;
      const y = CHANNEL_Y + (targetY - CHANNEL_Y) * t.transitProgress;
      ctx.fillStyle = cInFlight;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    });

  }

  let lastFrame = performance.now();
  function loop(now) {
    const realDt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    const simDt = realDt / SIM_SPEED;
    // Step in small chunks for accuracy
    let remaining = simDt;
    const stepSize = 0.05;
    while (remaining > 0) {
      const s = Math.min(stepSize, remaining);
      step(s);
      remaining -= s;
    }
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
</script>

The animation above shows how the benchmark setup works. Under light load the channel stays empty and latency is just service time; under overload it fills up, tokens accumulate wait time, and the numbers reflect the full delay a caller would see.

<blockquote style="font-size: 1em;">
All the numbers below come from an Apple M2 laptop running Go 1.21, a single node with no replication, 19-byte keys, and 256-byte random values. The WAL uses a 5ms group commit tick.
</blockquote>

## Throughput vs Latency

With a reasonable measurement harness, we can finally answer: how much load can the engine take without blasting through our latency objectives? Part 1 set a target of 10K write QPS, and a 20ms p99 is a reasonable latency budget for a KV write. The benchmark goes through target rates from 5K to 100K writes per second (in 5K steps), measuring p50, p99, and p999 at each step.

<div class="viz-container" id="throughput-latency-viz">
  <svg id="tl-svg" viewBox="0 0 800 400" preserveAspectRatio="xMidYMid meet"></svg>
  <div class="viz-controls">
    <label for="tl-slider">Target rate:</label>
    <input type="range" id="tl-slider" min="0" max="19" value="2" step="1">
    <span id="tl-rate-label" style="font-variant-numeric: tabular-nums; font-weight: 600;">15K/s</span>
  </div>
  <div class="viz-readout">
    <div class="metric p50"><div class="label">p50</div><div class="value" id="tl-p50">6.1ms</div></div>
    <div class="metric p99"><div class="label">p99</div><div class="value" id="tl-p99">9.4ms</div></div>
    <div class="metric p999"><div class="label">p999</div><div class="value" id="tl-p999">42.9ms</div></div>
  </div>
  <div class="viz-legend">
    <div class="item"><span class="swatch" style="background: var(--viz-p50);"></span>p50</div>
    <div class="item"><span class="swatch" style="background: var(--viz-p99);"></span>p99</div>
    <div class="item"><span class="swatch" style="background: var(--viz-p999);"></span>p999</div>
    <div class="item"><span class="swatch" style="background: var(--viz-slo);"></span>20ms SLO</div>
  </div>
</div>

<script>
(function() {
  const data = [
    { rate: 5,   p50: 5.7,   p99: 8.7,    p999: 29.3  },
    { rate: 10,  p50: 5.9,   p99: 10.2,   p999: 43.3  },
    { rate: 15,  p50: 6.1,   p99: 9.4,    p999: 42.9  },
    { rate: 20,  p50: 5.7,   p99: 12.1,   p999: 80.3  },
    { rate: 25,  p50: 6.7,   p99: 12.1,   p999: 38.4  },
    { rate: 30,  p50: 6.3,   p99: 20.0,   p999: 68.4  },
    { rate: 35,  p50: 6.9,   p99: 76.6,   p999: 151.2 },
    { rate: 40,  p50: 6.8,   p99: 41.7,   p999: 102.1 },
    { rate: 45,  p50: 7.4,   p99: 28.4,   p999: 67.8  },
    { rate: 50,  p50: 7.6,   p99: 42.8,   p999: 59.0  },
    { rate: 55,  p50: 7.2,   p99: 64.7,   p999: 118.4 },
    { rate: 60,  p50: 7.0,   p99: 50.3,   p999: 63.3  },
    { rate: 65,  p50: 7.3,   p99: 76.9,   p999: 115.3 },
    { rate: 70,  p50: 7.6,   p99: 85.2,   p999: 114.6 },
    { rate: 75,  p50: 7.9,   p99: 82.2,   p999: 108.5 },
    { rate: 80,  p50: 9.5,   p99: 240.2,  p999: 283.1 },
    { rate: 85,  p50: 9.1,   p99: 80.8,   p999: 101.4 },
    { rate: 90,  p50: 64.7,  p99: 234.3,  p999: 278.7 },
    { rate: 95,  p50: 105.4, p99: 687.0,  p999: 760.7 },
    { rate: 100, p50: 237.7, p99: 535.5,  p999: 598.9 },
  ];

  const svg = document.getElementById('tl-svg');
  const slider = document.getElementById('tl-slider');
  const rateLabel = document.getElementById('tl-rate-label');
  const p50El = document.getElementById('tl-p50');
  const p99El = document.getElementById('tl-p99');
  const p999El = document.getElementById('tl-p999');

  const W = 800, H = 400;
  const margin = { top: 20, right: 20, bottom: 70, left: 80 };
  const iw = W - margin.left - margin.right;
  const ih = H - margin.top - margin.bottom;

  const yMax = 300;
  const xScale = r => margin.left + (r - 5) / (100 - 5) * iw;
  const yScale = l => margin.top + ih - Math.min(l, yMax) / yMax * ih;

  function getColor(name) {
    return getComputedStyle(document.getElementById('throughput-latency-viz')).getPropertyValue(name).trim();
  }

  function render() {
    const idx = parseInt(slider.value);
    const point = data[idx];
    rateLabel.textContent = point.rate + 'K/s';
    p50El.textContent = point.p50.toFixed(1) + 'ms';
    p99El.textContent = point.p99.toFixed(1) + 'ms';
    p999El.textContent = point.p999.toFixed(1) + 'ms';

    const cFg = getColor('--viz-fg');
    const cMuted = getColor('--viz-muted');
    const cGrid = getColor('--viz-grid');
    const cP50 = getColor('--viz-p50');
    const cP99 = getColor('--viz-p99');
    const cP999 = getColor('--viz-p999');
    const cSlo = getColor('--viz-slo');
    const cMarker = getColor('--viz-marker');

    const ns = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';

    // gridlines (y)
    for (let v = 0; v <= yMax; v += 50) {
      const y = yScale(v);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', margin.left);
      line.setAttribute('x2', W - margin.right);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', cGrid);
      line.setAttribute('stroke-width', 1);
      svg.appendChild(line);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', margin.left - 8);
      label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('fill', cMuted);
      label.setAttribute('font-size', '11');
      label.textContent = v + 'ms';
      svg.appendChild(label);
    }

    // x-axis ticks
    for (let r = 5; r <= 100; r += 15) {
      const x = xScale(r);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', H - margin.bottom + 20);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', cMuted);
      label.setAttribute('font-size', '11');
      label.textContent = r + 'K';
      svg.appendChild(label);
    }

    // axis labels
    const xl = document.createElementNS(ns, 'text');
    xl.setAttribute('x', margin.left + iw / 2);
    xl.setAttribute('y', H - 10);
    xl.setAttribute('text-anchor', 'middle');
    xl.setAttribute('fill', cFg);
    xl.setAttribute('font-size', '12');
    xl.textContent = 'Target throughput (writes/sec)';
    svg.appendChild(xl);

    const yl = document.createElementNS(ns, 'text');
    yl.setAttribute('x', -margin.top - ih / 2);
    yl.setAttribute('y', 16);
    yl.setAttribute('text-anchor', 'middle');
    yl.setAttribute('fill', cFg);
    yl.setAttribute('font-size', '12');
    yl.setAttribute('transform', 'rotate(-90)');
    yl.textContent = 'Latency';
    svg.appendChild(yl);

    // SLO line
    const sloY = yScale(20);
    const sloLine = document.createElementNS(ns, 'line');
    sloLine.setAttribute('x1', margin.left);
    sloLine.setAttribute('x2', W - margin.right);
    sloLine.setAttribute('y1', sloY);
    sloLine.setAttribute('y2', sloY);
    sloLine.setAttribute('stroke', cSlo);
    sloLine.setAttribute('stroke-width', 1.5);
    sloLine.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(sloLine);

    const sloLabel = document.createElementNS(ns, 'text');
    sloLabel.setAttribute('x', W - margin.right - 4);
    sloLabel.setAttribute('y', sloY - 4);
    sloLabel.setAttribute('text-anchor', 'end');
    sloLabel.setAttribute('fill', cSlo);
    sloLabel.setAttribute('font-size', '11');
    sloLabel.textContent = '20ms SLO';
    svg.appendChild(sloLabel);

    // lines
    function drawLine(key, color) {
      const path = document.createElementNS(ns, 'path');
      let d = '';
      data.forEach((pt, i) => {
        const x = xScale(pt.rate);
        const y = yScale(pt[key]);
        d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
      });
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', 2);
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);

      data.forEach((pt) => {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', xScale(pt.rate));
        c.setAttribute('cy', yScale(pt[key]));
        c.setAttribute('r', 2.5);
        c.setAttribute('fill', color);
        svg.appendChild(c);
      });
    }

    drawLine('p999', cP999);
    drawLine('p99', cP99);
    drawLine('p50', cP50);

    // active marker
    const markerX = xScale(point.rate);
    const markerLine = document.createElementNS(ns, 'line');
    markerLine.setAttribute('x1', markerX);
    markerLine.setAttribute('x2', markerX);
    markerLine.setAttribute('y1', margin.top);
    markerLine.setAttribute('y2', H - margin.bottom);
    markerLine.setAttribute('stroke', cMarker);
    markerLine.setAttribute('stroke-width', 1);
    markerLine.setAttribute('stroke-dasharray', '2 3');
    markerLine.setAttribute('opacity', '0.5');
    svg.appendChild(markerLine);

    ['p50', 'p99', 'p999'].forEach((k) => {
      const color = k === 'p50' ? cP50 : k === 'p99' ? cP99 : cP999;
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', markerX);
      c.setAttribute('cy', yScale(point[k]));
      c.setAttribute('r', 5);
      c.setAttribute('fill', color);
      c.setAttribute('stroke', getColor('--viz-bg'));
      c.setAttribute('stroke-width', 2);
      svg.appendChild(c);
    });
  }

  slider.addEventListener('input', render);
  const observer = new MutationObserver(render);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  render();
})();
</script>

p99 stays under 20ms up to about 30K writes per second, clearing the Part 1 target by roughly 3x (caveat: no replication in the loop; adding that is future work). That 30K/s is also the goodput ceiling: the engine accepts more requests past that point, it just cannot honor the latency budget for them. Past 30K/s, latency climbs into hundreds of milliseconds, and by 90K even p50 is past 100ms. This is where the open-loop methodology earns its keep: the channel saturates, tokens accumulate real wait time, and the numbers reflect the full pain a caller would feel.

## Wrapping Up

The LSM storage engine is a foundation, and a pretty cool one at that (for me, personally, crash recovery was fun to hash out). The benchmarks raise many questions: what does compaction cost us in write amplification? How does the read path hold up under load? But, those are stories for another day.

[Code is on GitHub.](https://github.com/adiu19/chorus/tree/main/storage)
