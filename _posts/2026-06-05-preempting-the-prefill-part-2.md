---
layout: post
title: "Preempting the Prefill, Part 2: Build"
date: 2026-06-05
description: "Implementing FlowPrefill in vLLM: the urgency math, the components, the policy on top of them, and the subtle races that nearly broke it all."
categories:
  - LLM Infrastructure
tags:
  - vLLM
giscus_comments: false
published: true
---

This post covers the intuition behind FlowPrefill and the components that power a variant of its preempt path inside vLLM.

<img src="/assets/img/llm_b2_overview_light.svg" alt="High-level overview of FlowPrefill in vLLM: the SLO monitor inside EngineCore writes a preempt target to shared memory, workers vote at attention-op boundaries via all-reduce, and the scheduler re-admits the urgent waiter when the vote unwinds the forward pass. Numbered arrows trace the cycle." class="vllm-overview-light">
<img src="/assets/img/llm_b2_overview_dark.svg" alt="High-level overview of FlowPrefill in vLLM: the SLO monitor inside EngineCore writes a preempt target to shared memory, workers vote at attention-op boundaries via all-reduce, and the scheduler re-admits the urgent waiter when the vote unwinds the forward pass. Numbered arrows trace the cycle." class="vllm-overview-dark">

<style>
.vllm-overview-light, .vllm-overview-dark { width: 60%; height: auto; margin: 0 auto; }
html[data-theme="dark"] .vllm-overview-light { display: none; }
html[data-theme="dark"] .vllm-overview-dark { display: block; }
html:not([data-theme="dark"]) .vllm-overview-light { display: block; }
html:not([data-theme="dark"]) .vllm-overview-dark { display: none; }
</style>

The cycle is walked through in the diagram above: urgency flows from the SLO monitor through shared memory into the workers' attention-op vote, which unwinds the forward pass so the scheduler can re-admit the urgent waiter on the next step. The sections below walk this cycle piece by piece, then cover the policy refinements and the races that the live system surfaced.

## Defining urgency

**Slack** is the buffer a request has before missing its deadline, after accounting for the time the prefill itself will take.

First, the time left before the deadline:

<p style="text-align: center;"><code>time_to_deadline = deadline − now</code></p>

Then subtract the work the prefill still has to do:

<p style="text-align: center;"><code>slack = time_to_deadline − predicted_TTFT</code></p>

Positive slack means the request will meet its deadline with room to spare; negative means even if we started the prefill right now, we'd already overshoot.

<img src="/assets/img/llm_b2_slack_light.svg" alt="Slack timeline: a horizontal time axis from arrival through now to deadline, with predicted_TTFT drawn as a bar starting from now. Two side-by-side cases — one with positive slack (the bar fits inside the deadline, with leftover gap) and one with negative slack (the bar overshoots the deadline)." class="vllm-slack-light">
<img src="/assets/img/llm_b2_slack_dark.svg" alt="Slack timeline: a horizontal time axis from arrival through now to deadline, with predicted_TTFT drawn as a bar starting from now. Two side-by-side cases — one with positive slack (the bar fits inside the deadline, with leftover gap) and one with negative slack (the bar overshoots the deadline)." class="vllm-slack-dark">

<style>
.vllm-slack-light, .vllm-slack-dark { width: 50%; height: auto; margin: 0 auto; }
html[data-theme="dark"] .vllm-slack-light { display: none; }
html[data-theme="dark"] .vllm-slack-dark { display: block; }
html:not([data-theme="dark"]) .vllm-slack-light { display: block; }
html:not([data-theme="dark"]) .vllm-slack-dark { display: none; }
</style>

**Predicted TTFT** comes from a simple linear model. For a fixed (model, hardware) combination, we measure TTFT across a sweep of prompt sizes and fit a line:

<p style="text-align: center;"><code>predicted_TTFT = a · tokens + c</code></p>

A linear fit works for us because we fix model and hardware across the benchmark, which keeps things simple and lets the focus stay on preemption.

**Slack-aware EDF** ranks requests by:

<p style="text-align: center;"><code>sign(slack) / |time_to_deadline|</code></p>

Rescuable requests (positive slack) get positive scores and sort to the top; hopeless requests (negative slack) get negative scores and sink to the bottom.

## The SLO monitor

The monitor lives as a daemon thread inside EngineCore: the same process that owns the scheduler, but a separate thread so it can keep evaluating while the main thread is blocked dispatching the forward pass.

Every few milliseconds, the monitor reads a snapshot of scheduler state: the lists of waiting and running requests, with their per-request fields. It computes slack for each request using the formula above, ranks them, and picks the most urgent waiter. If that waiter is more urgent than something currently running (what counts as 'more urgent' is covered in *Picking the victim*), the monitor writes a `target_step_id` to a shared-memory location the workers will read inside the forward pass.

The scheduler publishes a frozen snapshot at the end of each scheduling step, and the monitor reads it via an atomic pointer swap: pausing the scheduler on the hot path would cost throughput, and holding a lock would block the main thread. Python's GIL makes the pointer swap atomic, and the snapshot is immutable from the monitor's side.

## Voting inside the forward pass

With a TP=N setup, N GPU workers carry out the forward pass together, already synchronizing at every layer through the normal TP all-reduces. If a preempt needs to fire, all N have to act in sync: one rank raising while the others continue would leave the next collective in the layer sitting forever waiting for the missing participant.

So the preempt decision is itself a collective. Each rank compares the monitor's `target_step_id` against its own *step id* and casts a 0 or 1, then an `all_reduce(MAX)` returns a unanimous answer to every rank. Any rank voting 1 raises an exception that unwinds the forward pass; otherwise the workers continue.

<img src="/assets/img/llm_b2_vote_light.svg" alt="The per-attention-op vote: each TP rank casts a local 0 or 1, all_reduce(MAX) takes the OR across ranks, and the same result returns to every rank. MAX=1 → all raise; MAX=0 → all continue." class="vllm-vote-light">
<img src="/assets/img/llm_b2_vote_dark.svg" alt="The per-attention-op vote: each TP rank casts a local 0 or 1, all_reduce(MAX) takes the OR across ranks, and the same result returns to every rank. MAX=1 → all raise; MAX=0 → all continue." class="vllm-vote-dark">

<style>
.vllm-vote-light, .vllm-vote-dark { width: 50%; height: auto; margin: 0 auto; }
html[data-theme="dark"] .vllm-vote-light { display: none; }
html[data-theme="dark"] .vllm-vote-dark { display: block; }
html:not([data-theme="dark"]) .vllm-vote-light { display: block; }
html:not([data-theme="dark"]) .vllm-vote-dark { display: none; }
</style>

vLLM's forward pass is mostly compiled, and we can't drop a Python callback into the middle of a compiled chunk: it'd either get captured into the graph or skipped at replay. The attention op is the one place vLLM still drops back into Python between compiled chunks, so it's where the hook lives (one check per transformer layer is plenty of opportunity in my opinion).

## Cleanup and re-admission

When the workers raise, the exception propagates back to EngineCore's main thread. The engine catches it as a preempt and runs the cleanup: the preempted request gives up its KV cache and goes back to the waiting queue.

The next scheduling step sees the freed slot, finds the monitor's chosen waiter at the top of the queue, and admits it, closing the cycle.

## Picking the victim

The monitor knows which request is more urgent. But my first implementation had a thrashing problem: the system would preempt a running request to admit a waiter that looked slightly more urgent, then preempt that newly-admitted request the moment another waiter looked fresher, burning through forward-pass cycles without anyone finishing. That pushed me to refine the paper's preempt rule in three ways:

- requiring the waiter to beat the *most-urgent* running request instead of just the *least-urgent* one.
- branching on slack signs so the multiplicative margin doesn't invert.
- adding stubbornness rules that protect requests once they've already been preempted or are nearing completion.

### Conservative vs aggressive

The paper's preempt gate is: preempt if the best waiting request's priority beats some running request's priority by a margin. The "some running request" is the loose part and has two interpretations:

- **Aggressive:** preempt if the best waiting beats the *least-urgent* running request by the margin.
- **Conservative:** preempt only if the best waiting beats the *most-urgent* running request by the margin.

In homogeneous workloads (similar SLOs, similar work sizes, similar arrival rates) the choice rarely matters: the running set is older than the waiting set, and neither gate fires often. The choice matters in heterogeneous workloads, where the running set might hold both urgent and non-urgent requests. Aggressive will displace a non-urgent running request (and with it any urgent requests tagging along) to rescue an urgent waiter. Conservative refuses unless the waiter is more urgent than every running request.

Layer-boundary preemption is expensive (more on that in *Adaptive stubbornness* below), so the cost of an unnecessary preempt is high. In my opinion, the right default is conservative; aggressive should be opt-in.

### The both-negative-slack edge case

The multiplicative margin only does the right thing when both slacks are positive. The full policy needs four cases:

- **Both positive:** preempt if the waiter is meaningfully more urgent (standard EDF with the margin).
- **Waiter doomed (negative slack):** never preempt for it, since there's no point sacrificing a running request to save the unsaveable.
- **Running request doomed:** always give up its slot, since it's already going to miss and the waiter can use the runtime.
- **Both doomed:** never preempt, since no reordering rescues anyone.

The original formula compared the waiter's priority against the running request's priority times the margin, treating all four cases the same, and the all-doomed case is where it broke. The priority formula gives doomed requests negative values, and multiplying a negative by the margin makes it more negative, so the inequality flipped meaning. The gate ended up firing for waiters that were less urgent than the running request.

### Adaptive stubbornness

Intuitively, the wasted work scales with how far into the forward pass the preempt fires (if we have 32 layers, preemption at layer 28 wastes 88% of the work, for instance). This means that even when the gate is firing for the right reasons, repeated preempts burn more work than they rescue.

Two rules limit when a preempt can fire, regardless of how urgent the waiter looks.

**Rule 1, scheduler-side:** a request that's been preempted once is immune to further preemption. This prevents any pattern where a request gets preempted, re-aged in the queue, re-admitted, and preempted again, protecting against oscillation regardless of why the gate keeps firing. Without Rule 1, ***one early run hit an infinite preempt loop: 21,360 wasted steps at zero tokens per second of progress.***

**Rule 2, worker-side:** a request that's past 90% of its layers (a magic number we chose to avoid preempting nearly complete requests) refuses preemption from inside the forward pass. The workers compute their progress fraction and override the local vote to 0 above the threshold. This also protects a request doing first-token generation on the prefill node (it has finished prefill and is generating one decode token before KV transfer, and preempting it throws away all the prefill work for negligible benefit).

<img src="/assets/img/llm_b2_adaptive_light.svg" alt="Adaptive stubbornness: Rule 1 filters running requests with num_preemptions > 0 out of the victim set (immune); Rule 2 forces the worker's local vote to 0 when past 90% of layers in the forward pass." class="vllm-adaptive-light">
<img src="/assets/img/llm_b2_adaptive_dark.svg" alt="Adaptive stubbornness: Rule 1 filters running requests with num_preemptions > 0 out of the victim set (immune); Rule 2 forces the worker's local vote to 0 when past 90% of layers in the forward pass." class="vllm-adaptive-dark">

<style>
.vllm-adaptive-light, .vllm-adaptive-dark { width: 50%; height: auto; margin: 0 auto; }
html[data-theme="dark"] .vllm-adaptive-light { display: none; }
html[data-theme="dark"] .vllm-adaptive-dark { display: block; }
html:not([data-theme="dark"]) .vllm-adaptive-light { display: block; }
html:not([data-theme="dark"]) .vllm-adaptive-dark { display: none; }
</style>

## Race conditions

Race conditions in distributed setups come with the territory, and I'm citing these three for science, since each one cost real debugging time.

### Stale flags landing on the wrong step

In the first version, the monitor was setting a bare boolean preempt signal and the engine was clearing it after each step. This meant hitting preempts on the wrong step: workers would raise an exception even though the most-urgent waiter the monitor had been reasoning about was already gone from the queue.

Between the engine clearing the flag at the end of step N and the workers reading the flag at the start of step N+1, the monitor could set it again, intending for a future step but landing on the current one. The receiver and sender had no way to agree on which step was current.

If we try to synchronize, we'd have to span three components: the monitor, the engine, and the workers driving the forward pass. The fix, instead, was to make the signal self-describing rather than stateful. Instead of a boolean meaning "preempt the current step," the monitor writes the *id of the step it wants preempted*. Each worker reads its own *step id* at the start of the forward pass and compares the two. A stale value can't accidentally match, because *step ids* monotonically increase.

### Rolling back the prior-step set

vLLM already has a preemption path that fires when KV admission can't make room for a continuing request, and I assumed it could be reused.

The first preempt fired correctly, but the next scheduling step hit an assertion that killed EngineCore. The scheduler asserts that a request admitted from waiting was not in the previous step's scheduled set: scheduled requests should keep running, not bounce back to waiting.

Stock preemption decides inside the scheduling step, moving its victim to PREEMPTED before the previous-step set is recorded. FlowPrefill's preempt fires mid-forward-pass, after the scheduling step has returned, so the request is already in the set when the next admission tries to re-admit it.

The fix is to roll the previous-step set back as part of the cleanup. Mid-step preemption touches scheduler internals, not just KV state, so a cleaner upstream design would expose a step-rollback hook and centralize this kind of undoing in one place.

### Order in the worker callback

If any rank raises before the all-reduce, it exits the function early and skips the collective. The others reach the all-reduce, block waiting for the absent participant, and hang until NCCL's watchdog fires. I caught this exactly once during development, after rearranging the function for readability.

(One related plumbing note: vLLM flattens exception types across IPC boundaries, so a typed exception raised in a worker arrives at EngineCore as a generic error. To distinguish preempt from crash, the worker sends a structured status alongside the exception, and EngineCore decodes it before deciding what to clean up.)

## What's next

The implementation was more involved than I initially expected, and there were multiple edge cases to be resolved in the live system. Part 3 answers whether all of that translates into TTFT-attainment under realistic load, and at what cost.

The code is on GitHub at [adiu19/vllm](https://github.com/adiu19/vllm).
