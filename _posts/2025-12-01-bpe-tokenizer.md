---
title: "Building a GPT-2 Tokenizer in Go"
date: 2025-12-01T02:37:04-04:00
categories:
  - Distributed Systems
  - Large Language Models
tags:
  - Distributed Systems
  - Large Language Models
--- 

There are easier ways to spend your weekends. Building a GPT-2 tokenizer from scratch is not one of them. But somewhere between reading Karpathy’s "Zero to Hero", benchmarking Go’s runtime behavior at 2AM, and debating whether my slice reallocation was "morally acceptable", I fell down a rabbit hole.

This post is the story of how that happened: what I built, what broke, what I optimized, and what I learned about systems engineering by reconstructing one of the most universally used components in modern LLMs: the tokenizer.

## Why Build a Tokenizer at All?
If one's interested in **LLM infrastructure**, tokenizers are not optional. They sit at the front of _every_ inference and training pipeline and dictate throughput, correctness, and latency.

I wanted to understand what was actually happening inside. So I rebuilt it - byte-pair encoding, vocab parsing, merges, greedy selection, token mapping, streaming semantics, all of it.

In Go.

Because why not.

## The Goal

The goal wasn’t just to encode text.

It was to build:

**A streaming-friendly, GPT-2 tokenizer in Go, with exact round-trip parity.**

I wanted:
- No hidden allocations.
- No unnecessary copies.
- Streaming support for chunked text.
- Benchmarks.

I quickly learned: this is way harder than it sounds.

## The Underestimate: BPE is simple, right?

Before this project, I thought tokenization was basically:
1. Load vocab.
2. Greedily merge pairs.
3. Done.

I was wrong.

What's usually hidden in subtext is that BPE merging is quite convoluted and involves:

- priority queues
- adjacency maintenance
- invalidation semantics
- versioning to prevent stale merges
- dealing with arbitrary Unicode byte sequences
- ensuring determinism
- avoiding pathological quadratic behavior
- and in streaming mode, dealing with **chunk boundaries**, which are an entire horror movie of their own

## The First Win: Offline Encoder Working

The offline greedy BPE encoder was the first major milestone.

It worked. It matched Hugging Face.  
It passed all round-trip tests.  
It handled odd Unicode, edge cases, and controlled merges correctly.

Performance was great (Go-great).

| Benchmark                      | Iterations |       ns/op |  MB/s |          B/op | allocs/op |
| ------------------------------ | ---------: | ----------: | ----: | ------------: | --------: |
| NaiveEncodeStreaming_4KBChunks |         10 | 462,254,429 | 11.34 | 1,830,937,034 | 2,343,413 |


This gave me the confidence to start the real challenge.

Streaming.

## Where Things Got Spicy: The Streaming Encoder

Streaming is not "offline but in chunks".

Streaming requires:

- maintaining adjacency across chunk boundaries
- scheduling merges correctly even when pieces arrive out of order
- maintaining liveness invariants
- tracking live version numbers
- updating linked lists of token nodes
- dynamically adjusting a tail-reserve so merges don’t cross uncommitted boundaries
- rewriting heap candidates without invalidating active merges
    
This part of the project consumed _weeks_.

I rewrote large sections and repeatedly reached states where invariants failed in unpredictable ways.

I hit issues like:

- stale heap candidates creating illegal merges
- cross-boundary merges misfiring
- node liveness drifting out of sync
- adjacency pointers failing in ways I wasn't aware of

Eventually, I stepped back.

I realized something important:

**Production tokenizers don’t use fully incremental streaming BPE. The complexity isn’t worth the cost.**

That was a turning point.

Streaming BPE is beautiful, but the right move at the time for me was to **stop, and optimize the naive streaming encoder instead.**

## The Optimization Journey

Once the incremental encoder was deprioritized, something magical happened. I could finally treat tokenization like an optimization problem, not a correctness war.

The naive streaming encoder is simple:
- break input into chunks
- run offline BPE on each chunk
- concatenate results


No cross-boundary merging but extremely practical.

And most importantly, much easier to optimize.