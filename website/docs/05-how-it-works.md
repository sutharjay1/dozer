---
title: How it works
description: The gate and hidden port, the websocket hold and reload frame, the machine-wide coordinator and its soft limit, and the guard process.
---

```txt
browser ──► localhost:3000  dozer (always running, ~47 MiB)
                 │
                 │  only while awake
                 ▼
            127.0.0.1:<hidden port>  next dev + its process tree
                                     guard (kills Next.js if dozer is killed)

every dozer ◄──► coordinator (one per machine, unix socket, ~45 MiB)
```

## The gate and the hidden port

`dozer next dev` listens on the app's public port and starts asleep, with no Next.js process. Any HTTP request that is not a websocket upgrade wakes the app: dozer starts `next dev` on a free loopback port, holds the request until Next.js answers, then proxies it. There is no interstitial page, so `curl`, tests and agents get the real response.

The `Host` header is passed through unchanged, so server-side URL building and Server Actions origin checks see the public port. In Next.js's log output, dozer rewrites the hidden port to the public one, so nobody copies a URL that skips the gate.

## Sleep

Activity is an HTTP request, or a live-reload message sent from Next.js to a browser. Those messages keep the app awake while you edit without navigating, but only up to 60 minutes after the last HTTP request. Messages from the browser to the server do not count.

After the idle time with no activity, dozer stops the whole Next.js process tree and checks that nothing survived. On Ctrl+C, SIGTERM or a vanished parent it does the same and frees the port.

## The websocket hold

A Next.js page keeps a live-reload websocket open. If the server goes away, the page tries to reconnect and then reloads itself, which would wake the app again. dozer prevents that by terminating the websocket itself instead of passing it through:

- While Next.js sleeps, open tabs stay connected and get no messages. New connection attempts are accepted and held too. None of this wakes the app.
- When Next.js wakes, each held socket gets one frame, `{"action":"reloadPage","type":"reloadPage"}`, then a close with code 1012. The page reloads once and connects to the new server. Next.js 15 reads `action`, Next.js 16 reads `type`.

## The coordinator

The first dozer on the machine starts a small background process that the others talk to over a unix socket. It exits 10 seconds after the last one leaves. It sees every app on the machine, across all repos and worktrees, and enforces `maxAwake` and `memoryBudget` by putting to sleep the app whose last request is oldest.

The limit is soft. An app is never put to sleep while it has a request in flight, within its grace period (60 s by default) after a request or a wake, or when it is pinned. If no app qualifies, the new app wakes anyway, and the oldest one sleeps as soon as it may.

If dozer cannot reach the coordinator, it keeps working with the idle rule alone.

## The guard

While an app is awake, a small guard process runs beside Next.js. If dozer itself is killed and cannot clean up, the guard kills the Next.js process tree, so it is not left running. The guard exists only while the app is awake.
