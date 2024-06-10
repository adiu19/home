---
title: "Client-Side Service Discovery"
date: 2024-01-09T02:37:04-04:00
categories:
  - Distributed Systems
tags:
  - Distributed Systems
  - Microservice Patterns
--- 

## Why do we need Service Discovery?
Applications we build today have one commonality - they all, more or less, make network calls to external processes. To successfully make such a call, the application will need to know the IP address and port of the process. We could, in theory, keep those fields static, but in modern applications, the server instance on which the process is hosted changes frequently owing to failures and auto-scaling.

There are two ways in which our application can _discover_ said external process - server-side discovery or client-side discovery. Server-side discovery is usually achieved via load balancers, but today, we'll focus on client-side service discovery.

## Service Registry

An important component of every service discovery process (be it server-side or client-side) is service registry. It can be thought of as a database (possibly AZ-aware) that holds the location of all instances of a service. When a new instance of a service comes up, it needs to log its presence in the registry in order to be reachable. Once the instance is registered, it needs to send periodic hearbeats to ensure its liveness.

```rust
fn register_instance(config: SvcInstanceCfg) -> Boolean {
}

fn heartbeat(config: SvcInstanceCfg) -> Boolean {
}

fn fetch_instances(svc: String) -> Vec<SvcInstance>{

}
```

## Flow

1. Client-Side abstraction
2. Sidecar pattern
