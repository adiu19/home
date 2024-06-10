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
Applications we build today have one commonality - they all, more or less, make network calls to external processes and to make such a call, we require the _address_ of the process. We could, in theory, keep those fields somewhere in a static configuration assuming we know them, but the server instance on which the process is hosted changes frequently owing to failures and auto-scaling.

There are two ways in which we can _discover_ said external process - server-side discovery and client-side discovery. Server-side discovery is usually done via load balancers, but today, our focus will be on client-side service discovery.

## Service Registry

An important component of every service discovery process (be it server-side or client-side) is service registry. It can be thought of as a database (possibly AZ-aware) that holds the location of all instances of a service. When a new instance comes up, it needs to log its presence in the registry in order to be reachable. That's not the end of it however; it needs to send periodic hearbeats to broadcast its liveness.

```golang
func RegisterInstance(config SvcInstanceCfg) Boolean {
}

func Heartbeat(config SvcInstanceCfg) Boolean {
}

func FetchInstances(svc String) []SvcInstance {

}
```

## Flow

1. Client-Side abstraction
2. Sidecar pattern
