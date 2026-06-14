---
layout: post
title: "Preempting the Prefill, Part 1: Context"
date: 2026-05-28
description: "Why TTFT SLOs are hard to meet under contention, and what the FlowPrefill paper proposes to do about it. Setup for a three-part series on implementing the idea in vLLM."
categories:
  - LLM Infrastructure
tags:
  - vLLM
giscus_comments: false
published: true
---
Inference serving has a latency problem. Long prefills hold the GPU for hundreds of milliseconds, urgent requests queued behind them miss their TTFT SLO, and the scheduler's only preemption trigger is KV cache memory pressure, which says nothing about deadlines. Under contention, the system can be doing exactly what it was designed to do and still miss the metric users care about. In our case, that metric is TTFT (time to first token).

[FlowPrefill](https://arxiv.org/pdf/2602.16603) is a proposal that claims to close this gap: preempt long prefills mid-forward-pass to rescue urgent waiters. I built a variant in vLLM on a P/D-disaggregated setup, and I'll walk through it in three parts: this post sets the background and motivation, the next focuses on the design decisions and implementation, and the third gets into the benchmark numbers (the fun part).

## How vLLM serves a streaming request

[vLLM](https://github.com/vllm-project/vllm) is the open-source library for LLM inference and serving, and its stack runs as three process groups:
1. The API server (AsyncLLM) owns HTTP and tokenization.
2. EngineCore owns the scheduler and drives the step loop.
3. The model executor runs as a pool of GPU worker processes (one per tensor-parallel rank) that share each forward pass and coordinate via NCCL collectives at every layer boundary.

The API/EngineCore split exists because Python's GIL would otherwise contend the engine's busy loop with HTTP I/O, adding jitter to the scheduler's tick cadence. EngineCore talks to the API server via ZMQ (control plane) and to the workers via shared memory (hot path); each worker has its own broadcast-in and response-out queue. [A Scheduler as a Lens into LLM Inference](/blog/a-scheduler-as-a-lens-into-llm-inference/) discusses schedulers in detail.

<img src="/assets/img/llm_b1_vllmarch_light_mode.svg" alt="vLLM request flow: client to API server (AsyncLLM) over HTTP, AsyncLLM to EngineCore over ZMQ, EngineCore to TP worker pool over shared memory, with NCCL sync across worker ranks. Numbered arrows trace the streaming request sequence." class="vllm-arch-light">
<img src="/assets/img/llm_b1_vllmarch_dark_mode.svg" alt="vLLM request flow: client to API server (AsyncLLM) over HTTP, AsyncLLM to EngineCore over ZMQ, EngineCore to TP worker pool over shared memory, with NCCL sync across worker ranks. Numbered arrows trace the streaming request sequence." class="vllm-arch-dark">

<style>
.vllm-arch-light, .vllm-arch-dark { width: 50%; height: auto; margin: 0 auto; }
html[data-theme="dark"] .vllm-arch-light { display: none; }
html[data-theme="dark"] .vllm-arch-dark { display: block; }
html:not([data-theme="dark"]) .vllm-arch-light { display: block; }
html:not([data-theme="dark"]) .vllm-arch-dark { display: none; }
</style>

A streaming completion request flows like this:

1. AsyncLLM accepts the HTTP request and tokenizes it. The connection stays open while it creates a per-request output queue, hands the request off to EngineCore over ZMQ, and waits for the first token.
2. EngineCore's loop fires on arrivals and completions. It runs the scheduler: same three-phase cycle from the previous post (drain -> reclaim -> admit) except the capacity unit is KV blocks instead of an abstract cost.
3. The scheduler picks a batch (this is where the bulk of the scheduler's logic sits) and hands it to the workers via the shared-memory broadcast queue.
4. Each worker runs the forward pass on the GPU (synchronizing across ranks via NCCL) and writes the result to its response queue.
5. EngineCore reads the result, updates the scheduler with what happened, and ships the token back to AsyncLLM over ZMQ.
6. AsyncLLM matches the token to the per-request queue by request id, detokenizes it, and streams it back as an SSE chunk.
7. Steps 2–6 repeat per decode step until the token limit or a stop condition.

Dispatching the forward pass is synchronous; EngineCore's main thread blocks until the workers return (though a config option lets us prepare the next batch asynchronously). This matters because the SLO monitor lives as a daemon thread *inside* EngineCore so it can keep evaluating while the main thread is parked there.

## The paper

FlowPrefill ranks requests by urgency, specifically how much time each one has left before its deadline, minus the time the prefill itself will take to finish. The net-new addition is that the scheduler can preempt a running prefill *during* its forward pass if a more urgent request shows up.

<img src="/assets/img/llm_v1_vllmproposal_light_mode.svg" alt="FlowPrefill proposal: a forward pass can be cut at any layer boundary so the scheduler can re-admit a higher-priority waiter, contrasted with vanilla vLLM's preempt-only-between-passes behavior." class="vllm-proposal-light">
<img src="/assets/img/llm_v1_vllmproposal_dark_mode.svg" alt="FlowPrefill proposal: a forward pass can be cut at any layer boundary so the scheduler can re-admit a higher-priority waiter, contrasted with vanilla vLLM's preempt-only-between-passes behavior." class="vllm-proposal-dark">

<style>
.vllm-proposal-light, .vllm-proposal-dark { width: 50%; height: auto; margin: 0 auto; }
html[data-theme="dark"] .vllm-proposal-light { display: none; }
html[data-theme="dark"] .vllm-proposal-dark { display: block; }
html:not([data-theme="dark"]) .vllm-proposal-light { display: block; }
html:not([data-theme="dark"]) .vllm-proposal-dark { display: none; }
</style>

Why this paper, then? Schedulers are not easy and I've always had a soft spot for them. Every serving workload wants different things, and there's no canonical answer to what the priority function or admission policy should be.

For me, FlowPrefill stands out because it goes further than most scheduling work, pushing the preempt decision past the scheduler and into the model's forward pass. And the idea is bigger than TTFT: the same mechanism works for any signal we can rank requests by, whether fairness, priority, or something else. Real-world workloads have priority baked in, so preemption is almost certainly on the radar.

## Where the optimization lives

Prefill and decode are very different workloads. Prefill processes many tokens per forward pass (hundreds or thousands at a time) and that requires raw GPU compute. Decode generates one token at a time per request and is mostly limited by how fast the GPU can read memory, which is why production setups often split them onto separate nodes.

For this work the split is more than ergonomic. TTFT is set during prefill, and once decode starts, the deadline has already been hit or missed. Preempting mid-decode doesn't make sense anyway: a decode step is one token of work per request, so there's nothing meaningful to reclaim. The optimization lives on the prefill node.

## What I built, and what I didn't

What I built is a variant of the paper. A lot of the choices below are aimed at keeping the MVP small enough to ship, so I could get an initial read on whether this avenue is worth exploring further.

**Granularity and resume.** I check for preemption once per layer at the attention op; the paper checks at every operator boundary (matmul, layernorm). Coarser keeps me out of CUDA-level code, and layer granularity feels like the right starting point. There's no mid-layer resume either: when a preempt fires, we discard the running prefill and re-prefill the request from scratch. Resuming from layer K isn't straightforward, and I wanted to keep the MVP scope tight. The wasted-work cost motivates the stubbornness rules in Part 2.

**Scope and scheduling.** The optimization only runs on the disaggregated prefill node, for the TTFT reasons we covered above. I kept vLLM's busy-loop scheduler instead of the paper's event-driven one; the polling cost is negligible against forward-pass time.

The new component is the SLO monitor: a daemon thread inside EngineCore that watches for deadline breaches alongside the forward pass. Part 2 covers the build: how it shares state with the scheduler, how the workers see the signal, and the design choices that shape it.
