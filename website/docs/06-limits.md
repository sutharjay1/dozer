---
title: Limits and troubleshooting
description: Known dozer limits and fixes, polling tabs, the PORT variable, maxAwake for apps that call each other, HTTPS, live reload after a crash, and platforms.
---

## Why does my app keep waking up with nobody using it?

A page that sends real HTTP requests on a timer, such as polling or session checks, wakes the app every time. dozer cannot tell those requests from a person. Close that tab, or let it wake; the live-reload websocket alone never wakes the app.

## Why does PORT inside my app have the wrong value?

`PORT` inside the app is the hidden port Next.js really listens on. Use `DOZER_PUBLIC_PORT` for the port you open in the browser.

## Why do two apps keep putting each other to sleep?

When one page load touches several apps (apps that call each other server-side), set `maxAwake` to at least that number in `~/.dozer/config.json`. Apps with a request in flight, or one in the last grace period, are never put to sleep, but a lower limit still sleeps them between page loads.

## Does it work with --experimental-https?

No. With `--experimental-https`, dozer runs plain `next dev` instead, with no gate.

## Why did live reload stop after Next.js crashed?

After an unexpected Next.js crash, a Next.js 15 App Router tab loses live reload. Refresh the tab to get it back.

## What happens if the coordinator crashes?

Running apps keep working and fall back to their own idle rule. The machine-wide limit returns when the next app starts a new coordinator.

## Does it run on Windows?

No. dozer runs on macOS and Linux only, with Next.js 15 and 16. Next.js 14 is best effort.
