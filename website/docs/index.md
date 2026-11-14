---
title: Introduction
description: dozer runs next dev only while pages are requested, then stops it, and keeps at most a few Next.js dev servers awake across all your repos and worktrees.
seo:
  title: Next.js dev servers that sleep
---

Each git worktree, one per AI coding agent session, runs its own `next dev`, and each one stays up whether or not anyone is looking at it. One awake Next.js 16 test app used about 563 MiB; Kortix measured 5.1–7.8 GB for one `next dev` of their own app on a 24 GB Mac (their measurement, not ours). A few idle worktrees can take most of a laptop's memory.

## What dozer does

- Your dev script becomes `dozer next dev`. dozer holds the app's normal port (3000, say) and runs the real `next dev` on a hidden loopback port, only while pages are being requested.
- After an idle period (10 minutes by default) it stops the whole Next.js process tree.
- A browser tab left open does not wake the app or keep it awake. dozer holds the tab's live-reload websocket while Next.js sleeps, and tells the page to reload once when Next.js wakes.
- A machine-wide coordinator keeps at most a set number of dev servers awake (2 by default) across every repo and worktree, and puts the least recently used one to sleep.

## What it costs

| Case | Measured |
|---|---|
| A sleeping app, no tab open | about 47 MiB (the dozer process; no Next.js process exists) |
| A sleeping app, one tab connected | about 57–60 MiB |
| The coordinator, one per machine | about 45 MiB |
| First request after sleep, small Next.js 16 app, warm cache | about 1 s |
| First request after sleep, 47-page Next.js 15 app, Turbopack | 5.8 s warm, 6.7 s cold |
| Same 47-page app on webpack | about 15 s |

In testing, an open tab caused 0 page loads during a 90 s sleep.

## When it helps

- You run several checkouts or worktrees of a Next.js app, and most of them sit idle at any moment.
- Tools start `pnpm dev` and then wait for the port, or `curl` it. The first request after sleep gets the real response, after a delay. There is no "starting" page.

## When it doesn't

- dozer does not make a running dev server any smaller. While an app is awake, Next.js uses what it uses.
- A single app you use all day stays awake, so you save little.
- A page that sends HTTP requests on a timer (polling, session checks) keeps waking the app.
- It runs on macOS and Linux only, with Next.js 15 and 16 (14 is best effort).

Install with `pnpm add -D next-dozer`. Source: [git.new/dozer](https://git.new/dozer).
