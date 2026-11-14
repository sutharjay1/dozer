<h1 align="center">dozer</h1>

<p align="center">
  <strong>Next.js dev servers that sleep until you need them.</strong><br>
  One <code>next dev</code> per git worktree, but only the ones you are looking at stay awake.
</p>

<p align="center">
  <a href="https://dozer-docs.sutharjay3635.workers.dev">Docs</a> ·
  <a href="https://dozer-docs.sutharjay3635.workers.dev/quickstart">Quick start</a> ·
  <a href="https://www.npmjs.com/package/next-dozer">npm</a> ·
  <a href="https://git.new/dozer">GitHub</a>
</p>

<p align="center">
  <img src="https://dozer-docs.sutharjay3635.workers.dev/readme/hero-terminal.png" alt="A terminal running pnpm dev, which prints 'dozer listening on http://localhost:3000 (Next.js asleep; starts on first request)', then dozer status listing four apps: shop/web @ main awake at 563 MB, and shop/docs @ main, shop/web @ agent-checkout and shop/web @ fix-cart asleep." width="100%">
</p>

## Why

Every git worktree runs its own `next dev`, and with an AI coding agent in each one you
can have several open at once. Each stays up whether or not anyone is looking at it, and
each one costs hundreds of megabytes to several gigabytes of RAM.

dozer keeps your app's normal port and starts the real `next dev` only when a page is
requested. After 10 idle minutes it stops the whole Next.js process tree. Across every repo
and worktree on the machine, at most two dev servers stay awake by default.

<p align="center">
  <img src="https://dozer-docs.sutharjay3635.workers.dev/readme/before-after.png" alt="Memory for three worktrees. Plain next dev: three awake servers at 563 MiB each, 1,689 MiB in total. dozer next dev: one awake at 563 MiB, two asleep at 47 MiB each, plus the 45 MiB coordinator, 702 MiB in total, 987 MiB less." width="100%">
</p>
<p align="center"><sub>Measured with a one-page Next.js 16 test app on macOS. Real apps use far more per awake server, so the saving grows with them.</sub></p>

## Install

```sh
pnpm add -D next-dozer
```

<sub>npm: `npm i -D next-dozer` · yarn: `yarn add -D next-dozer` · bun: `bun add -d next-dozer`</sub>

Put `dozer` in front of `next dev`:

```json
{ "scripts": { "dev": "dozer next dev" } }
```

Or let dozer do it for every Next.js app in the workspace. It prints the diff first and
changes nothing until you add `--yes`:

```sh
npx dozer init          # show the changes
npx dozer init --yes    # apply them
```

Then run `pnpm dev` as usual:

```txt
dozer listening on http://localhost:3000 (Next.js asleep; starts on first request)
```

Open the page and Next.js starts. To watch it sleep, try `DOZER_IDLE=30s pnpm dev`. To skip
dozer for one run, use `DOZER=0 pnpm dev`.

## What you get

| | |
|---|---|
| **Sleeps when idle** | No request for 10 minutes and the whole Next.js tree stops, verified. |
| **Wakes on demand** | The first request starts `next dev` and waits for the real answer: no "starting" page, so `curl`, tests and agents just work. |
| **Open tabs stay quiet** | dozer holds the tab's live-reload socket while Next.js sleeps, and reloads the page once when it wakes. An idle tab never keeps a server up. |
| **One limit for the machine** | A small coordinator keeps at most 2 servers awake across every repo and worktree, and sleeps the least recently used one, never mid-request. |
| **Nothing left behind** | Ctrl+C, a closed terminal, a crashed Next.js, even `kill -9` on dozer: no Next.js process survives. |
| **Plain `next dev` underneath** | Your config, flags, Turbopack or webpack: dozer only decides when it runs. |

## Commands

```sh
dozer next dev [next dev options]   # the gate; use it in your dev script
dozer status [--json]               # every app on the machine: state, port, RSS, last request
dozer sleep <name> | --all          # stop an app's Next.js now
dozer wake <name>                   # start it now
dozer init [--yes]                  # rewrite dev scripts across the workspace
```

Names look like `<repo>/<app> @ <branch>`, so each worktree gets its own line. `<name>` can
be any unique part of it, such as `fix-cart`.

## Settings

| Setting | Default | Environment | File |
|---|---|---|---|
| Idle time before sleep | `10m` | `DOZER_IDLE` | app `package.json` → `dozer.idle` |
| Wake timeout (then 504) | `120s` | `DOZER_WAKE_TIMEOUT` | app `package.json` → `dozer.wakeTimeout` |
| Never evict this app | off | `DOZER_PIN=1` | app `package.json` → `dozer.pin` |
| Most apps awake at once | `2` | `DOZER_MAX_AWAKE` | `~/.dozer/config.json` → `maxAwake` |
| Memory budget for awake apps (GB) | none | `DOZER_MEMORY_BUDGET` | `~/.dozer/config.json` → `memoryBudget` |
| Grace before an app may be evicted | `60s` | `DOZER_GRACE` | |
| Run plain `next dev` | | `DOZER=0` | |

```json
// package.json of an app
{ "dozer": { "idle": "20m", "pin": true } }
```

```json
// ~/.dozer/config.json, machine-wide
{ "maxAwake": 2, "memoryBudget": 12 }
```

Environment variables override the files. Put machine-wide limits in
`~/.dozer/config.json`: in the environment they only apply through whichever app starts the
coordinator first.

## How it works

```txt
browser ──▶ :3000  dozer gate ──(only while awake)──▶ 127.0.0.1:<hidden>  next dev
                      │
                      └── coordinator: one per machine, keeps at most N awake
```

- **Gate.** Listens on your port and starts asleep. A request wakes the app: dozer starts
  `next dev` on a hidden loopback port, waits until it accepts connections, then proxies the
  request unchanged, `Host` included.
- **Websocket hold.** dozer answers the browser's dev websocket itself. While the app sleeps
  the tab stays connected and silent; on wake it gets one reload message.
- **Guard.** While an app is awake, a small dozer process leads Next's process group and
  kills it if dozer dies for any reason.
- **Coordinator.** Started by the first app and gone 10 s after the last one exits. It sees
  every app on the machine and sleeps the one used longest ago when too many are awake.
  Never one with a request in flight, one used in the last minute, or a pinned one.

More detail is in the [docs](https://dozer-docs.sutharjay3635.workers.dev/how-it-works).

## Measured

| | |
|---|---|
| Sleeping app (the dozer process) | ~47 MiB, ~57–60 MiB with a tab connected |
| Coordinator, one per machine | ~45 MiB |
| Wake, small Next.js 16 app | ~1 s |
| Wake, 47-page Next.js 15 app, Turbopack | 5.8 s warm, 6.7 s cold |
| Wake, same app, webpack | ~15 s |
| Open tab during a 90 s sleep | 0 page loads |

For scale, Kortix measured 5.1–7.8 GB for one `next dev` of its own app on a 24 GB Mac
(their measurement, not ours). Three such worktrees cost 15–24 GB with plain `next dev`.

## Limits

- A page that sends requests on a timer (polling, session checks) wakes the app. dozer can't
  tell that from a person.
- `PORT` inside the app is the hidden port. Use `DOZER_PUBLIC_PORT` for the public one.
- Set `maxAwake` to at least the number of apps one page load touches.
- dozer doesn't make a running server smaller. Awake, Next.js uses what it uses.
- `--experimental-https` isn't supported yet: dozer runs plain `next dev` instead.
- After an unexpected Next.js crash, a Next 15 App Router tab needs a refresh to get live
  reload back.
- macOS and Linux. Node 20+. Next.js 15 and 16 (14 best effort).

## License

MIT
