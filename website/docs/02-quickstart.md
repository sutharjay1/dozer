---
title: Quick start
description: Add dozer to a Next.js app, start it asleep, watch the first request wake it, and make it sleep again after 30 seconds.
---

## Install

dozer is not published to npm yet, so there is no public install command today. Once it is published it will be a dev dependency of each Next.js app (`pnpm add -D dozer`).

If you have a checkout of the source, build it (`pnpm install && pnpm build`) and add it from disk:

```sh
pnpm add -D file:/path/to/dozer
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

`init` also adds `"dozer": "^<version>"` to the dev dependencies. That entry only installs once dozer is on npm, so until then change it to `file:/path/to/dozer`.

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
