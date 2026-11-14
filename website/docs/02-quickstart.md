---
title: Quick start
description: Add dozer to a Next.js app, start it asleep, watch the first request wake it, and make it sleep again after 30 seconds.
---

## Install

Add dozer to each Next.js app as a dev dependency. The npm package is `next-dozer`; the command it installs is `dozer`.

```sh
pnpm add -D next-dozer
# npm i -D next-dozer
# yarn add -D next-dozer
# bun add -d next-dozer
```

## Change the dev script

Put `dozer` in front of `next dev`:

```json
{ "scripts": { "dev": "dozer next dev" } }
```

Or let `dozer init` do it for every Next.js app in the workspace. It prints the diff and changes nothing:

```sh
dozer init
```

Then apply it:

```sh
dozer init --yes
```

`init` also adds `"next-dozer": "^<version>"` to the dev dependencies; run your package manager's install afterwards.

## Start it

```sh
pnpm dev
```

```txt
dozer listening on http://localhost:3000 (Next.js asleep; starts on first request)
```

No Next.js process is running yet. Check from another terminal:

```sh
dozer status
```

The app shows as `asleep`.

## Wake it

Open `http://localhost:3000`. The request starts `next dev`, waits for it to answer, and you get the page. On a small app that takes about a second. `dozer status` now shows the app `awake`, with its RSS.

## Watch it sleep

Start it with a short idle time:

```sh
DOZER_IDLE=30s pnpm dev
```

Load the page, then leave it. After 30 seconds with no requests, dozer stops Next.js. The open tab stays as it is and does not wake the app. Reload it and Next.js starts again.

## Turn it off

Run plain `next dev`, untouched:

```sh
DOZER=0 pnpm dev
```
