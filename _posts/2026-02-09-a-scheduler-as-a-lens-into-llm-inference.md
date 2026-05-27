---
layout: post
title: "A Scheduler as a Lens into LLM Inference"
date: 2026-02-09
description: "Building a job scheduler in Go and using it as a lens into LLM inference scheduling — tracing every design decision back to its vLLM parallel."
categories:
  - LLM Infrastructure
  - Systems Programming
tags:
  - Go
  - Schedulers
  - vLLM
  - LLM Inference
giscus_comments: false
---

A scheduler decides what runs next when there isn't enough capacity to run everything at once. LLM inference is a sharp version of that problem: GPUs are expensive, requests arrive concurrently with different priorities, and output lengths are unknown up front, so the cost of serving a request keeps growing as it runs. That last property is what makes the scheduling hard.

I've been digging into vLLM (the reference implementation for high-throughput LLM inference) lately, and the scheduler is the part that stood out. So I built a small one from scratch in Go and traced each design decision back to its vLLM equivalent. Mine is nowhere near a clone, but writing it taught me more about vLLM's scheduler than reading it did.

vLLM schedules at two layers. At the client level, a load balancer routes incoming requests across multiple *EngineCore* processes (how many is set by the data parallelism configuration). Inside each *EngineCore*, a scheduler handles admission and KV cache management. The parallels in this post are all with the latter.

## The tick loop

LLM inference is autoregressive: each request generates one token per decode step, and output lengths are unknown until a stop condition is hit. We need a loop that continuously reassesses: what finished, what capacity freed up, what runs next.

Schedulers can be initiated in two ways: on a fixed-interval timer (tick-based) or on events like a request arrival or a job completion (event-driven). I'm going to focus on a tick-based scheduler where each tick acquires a single lock, runs three phases in order, and releases the lock. Worker goroutines run concurrently but never touch scheduler state directly. They signal completion by sending a job ID onto a channel.

```go
func (s *Scheduler) Tick() {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.tick++
    s.drain()
    s.reclaim()
    s.admit()
}
```

<img src="/assets/img/sched_flow_diag_light.svg" alt="Scheduler tick flow: workers send job IDs to the completions channel, the tick drains them in batch" class="sched-flow-light">
<img src="/assets/img/sched_flow_diag_dark.svg" alt="Scheduler tick flow: workers send job IDs to the completions channel, the tick drains them in batch" class="sched-flow-dark">

<style>
html[data-theme="dark"] .sched-flow-light { display: none; }
html[data-theme="dark"] .sched-flow-dark { display: block; }
html:not([data-theme="dark"]) .sched-flow-light { display: block; }
html:not([data-theme="dark"]) .sched-flow-dark { display: none; }
</style>

The channel acts as the mailbox and the tick acts as the processing loop. Inside the tick, everything is synchronous and sequential, so we always know exactly what happened before the current step. Outside the tick, the world is async and that boundary is what keeps the state easy to reason about.

> **vLLM parallel:** EngineCore (the process that owns the scheduler and drives the step loop) runs a similar loop: process outputs from the previous step, schedule the next batch, dispatch to the GPU worker. The difference is that vLLM's loop is event-driven, not fixed-interval. It fires when there is work, triggered by arrivals and completions rather than a timer. The tick-based scheduler described above trades some responsiveness for predictability but I'm going to stick with this trade-off for now.

## Three phases: drain, reclaim, admit

**Drain** reads the completions channel. It snapshots the channel length at the start and reads exactly that many entries (completions arriving mid-drain wait for the next tick).

```go
func (s *Scheduler) drain() {
    n := len(s.completions)
    for i := 0; i < n; i++ {
        id := <-s.completions
        if j, ok := s.running[id]; ok {
            j.Status = job.Completed
        }
    }
}
```

The snapshot is deliberate and without it, a fast completion producer could make drain run indefinitely and starve the admit phase.

**Reclaim** frees capacity from completed jobs and removes them from the running map.

**Admit** pops jobs from the priority queue (in priority order of course), assigns each to a worker with available capacity, and dispatches. Jobs that do not fit are re-queued for the next tick.

> **vLLM parallel:** vLLM's scheduling step does the same three things: collect outputs (drain), free KV blocks from finished sequences (reclaim), build the next batch (admit). New work cannot be admitted until we know what capacity is available, and we cannot know that until completions have been processed. In our case, that happens once per tick. In vLLM, it happens at every decode step. This is continuous batching: the batch is reassembled after each forward pass, rather than waiting for all in-flight requests to finish.

## Capacity and cost

Each job declares a `Cost` and each worker has a `Capacity`, and admission is gated on whether a worker has enough remaining capacity. The admit phase uses best-fit: the worker with the smallest available capacity that still fits the job, minimizing fragmentation.

```go
func (wp *WorkerPool) Admit(jobID string, cost int) (string, bool) {
    var best *Worker
    for _, w := range wp.Workers {
        avail := w.Capacity - w.Used
        if avail >= cost {
            if best == nil || avail < best.Capacity-best.Used {
                best = w
            }
        }
    }
    ...
}
```

> **vLLM parallel:** vLLM's capacity unit is KV cache blocks. The number of KV blocks a request would need is computed from its current sequence length and the block size which typically is 16 tokens per block (a request cannot run without enough free blocks). The `Cost` I have defined in the tick-based scheduler is static, declared at submission but vLLM's cost is dynamic, growing as the request generates tokens. That is why preemption exists in vLLM and not in ours. Because our cost never changes, we never have to take capacity back from a running job, which is where most of the real difficulty in scheduling lives.

## Backpressure via rejection

When the pending queue hits `MaxPendingJobs`, new submissions are rejected immediately.

```go
if s.config.MaxPendingJobs > 0 && s.pending.Len() >= s.config.MaxPendingJobs {
    j.Status = job.Rejected
    return fmt.Errorf("pending queue full (%d/%d)", s.pending.Len(), s.config.MaxPendingJobs)
}
```

> **vLLM parallel:** vLLM caps concurrent sequences with `max_num_seqs`. When the cap is hit, new requests are not rejected. They wait at the API server until capacity opens up. Rejection is simpler and easier to reason about, but for an inference gateway serving many clients, queuing is the right call.

## The completions channel

Workers signal completion by sending a job ID onto a channel (`completions` in our running example). They never write to the running map, never touch the priority queue, never call any scheduler method. The scheduler is the sole writer of scheduler state, and workers are producers of signals only.

```go
go func() {
    defer func() {
        completions <- j.ID
    }()
    err := executor.Execute(j, onToken)
    if err != nil {
        j.Err = err
    }
}()
```

> **vLLM parallel:** The GPU worker sends outputs back to EngineCore over shared memory. EngineCore reads those outputs within the same step before the next scheduling decision and decides what to do, staying the sole decision-maker while workers only produce signals.

## Closing thoughts

Building even a stripped-down version is what made vLLM's design choices click for me. What vLLM builds on top of these foundations is where it gets interesting. The API server and EngineCore run as separate Python processes because the GIL rules out true in-process parallelism; coordination happens over ZMQ instead of a channel. The next post traces a request through that architecture end to end.

The scheduler code is on GitHub at [adiu19/chorus](https://github.com/adiu19/chorus/tree/main/scheduler).
