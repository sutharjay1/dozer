# dozer

dozer holds a Next.js app's dev port and runs the real `next dev` only while pages are
requested from it. When nobody has asked for a page for a while it stops the whole Next.js
process tree, and a machine-wide limit keeps only a few dev servers awake across all your
repos and worktrees.

Docs: https://dozer-docs.sutharjay3635.workers.dev. Source: `github.com/sutharjay1/dozer`.

## Install

dozer is not published to npm yet. The npm name `dozer` is taken, so the published package
name is still to be decided; the command stays `dozer`.

For now, build this checkout (`pnpm install && pnpm build`) and add it from disk:

```sh
pnpm add -D file:/path/to/dozer
```

Then put `dozer` in front of `next dev` in the app's dev script:

```json
{ "scripts": { "dev": "dozer next dev" } }
```

`dozer init` does both for every Next.js app in a workspace. It shows the diff and changes
nothing until you run `dozer init --yes`. It adds `"dozer": "^<version>"`, which only
installs once dozer is published; until then, change that entry to `file:/path/to/dozer`.

## Usage

- `dozer next dev [next dev options]`: the gate. It binds the port Next would have used
  (`-p`/`--port`, else `PORT`, else 3000) and prints
  `dozer listening on http://localhost:3000 (Next.js asleep; starts on first request)`.
  The first request starts `next dev` and waits for it; there is no interstitial page, so
  `curl`, tests and agents get the real response.
- `dozer status [--json]`: every gated app on the machine with its state, port, RSS and
  last request.
- `dozer sleep <name> | --all`: stop an app's Next.js now. `<name>` is an id, a name, or a
  unique part of a name such as `web`.
- `dozer wake <name>`: start it now.
- `dozer init [--yes]`: rewrite the dev scripts, see Install.

Names look like `<repo>/<app> @ <branch>`, from git and the package name, so each worktree
shows up on its own line.

## Settings

| Setting | Default | Environment | File |
|---|---|---|---|
| Idle time before sleep | `10m` | `DOZER_IDLE` | app `package.json` `dozer.idle` |
| Wake timeout (then 504) | `120s` | `DOZER_WAKE_TIMEOUT` | app `package.json` `dozer.wakeTimeout` |
| Pin (never evicted) | off | `DOZER_PIN=1` (`0` forces it off) | app `package.json` `dozer.pin` |
| Most apps awake at once | `2` | `DOZER_MAX_AWAKE` | `~/.dozer/config.json` `maxAwake` |
| Memory budget for awake apps, GB | none | `DOZER_MEMORY_BUDGET` | `~/.dozer/config.json` `memoryBudget` |
| Grace before an app may be evicted | `60s` | `DOZER_GRACE` | |
| dozer's home directory | `~/.dozer` | `DOZER_HOME` | |
| Run plain `next dev` | | `DOZER=0` | |
| No coordinator (idle rule only) | | `DOZER_COORDINATOR=0` | |

Durations are written like `500ms`, `120s`, `10m`, `1h`. Environment variables override
the files. Per-app settings:

```json
{ "dozer": { "idle": "20m", "wakeTimeout": "180s", "pin": true } }
```

Machine-wide settings, in `~/.dozer/config.json`:

```json
{ "maxAwake": 2, "memoryBudget": 12 }
```

Put machine-wide limits in that file. `DOZER_MAX_AWAKE` and `DOZER_MEMORY_BUDGET` in the
environment apply only through the gate that starts the coordinator (the first one to run);
gates started later cannot change them.

## How it works

- **Gate.** `dozer next dev` listens on the public port and starts asleep. A request that
  is not a websocket upgrade wakes the app: dozer starts `next dev` on a hidden loopback
  port, waits until that port accepts connections, then proxies the request, so Next
  compiles only the route asked for. `Host` is forwarded unchanged, and child log output
  has the hidden port rewritten to the public one.
- **Guard.** While an app is awake, one small dozer process leads Next's process group.
  If the gate dies in any way, even `kill -9`, the guard kills the whole group, so no
  Next.js process outlives dozer. It exists only while the app is awake.
- **Sleep.** After the idle time with no HTTP request (dev-websocket frames from Next to a
  browser also count, up to 60 min after the last request), dozer stops the whole process
  tree and checks that nothing survived.
- **Websocket hold.** dozer terminates the browser's dev websocket itself. While the app
  sleeps, open tabs stay connected and silent, so they neither wake it nor reload. On wake,
  each held socket gets one `{"action":"reloadPage","type":"reloadPage"}` frame and a 1012
  close, so the page reloads once onto the new server.
- **Coordinator.** The first gate starts a small background process; it exits 10 s after
  the last gate leaves. It sees every gate on the machine and enforces `maxAwake` and
  `memoryBudget` by putting the app with the oldest request to sleep. An app is never
  evicted while it has a request in flight, within its grace after a request or a wake, or
  when pinned; then the new app wakes anyway and the oldest sleeps as soon as it may.
- **Exit.** Ctrl+C, SIGTERM or a vanished parent stops the tree and frees the port. If
  Next.js crashes, dozer stops what is left of its tree, and the next request starts a
  fresh one. If dozer cannot set itself up at start-up, it runs plain `next dev` instead.

## Limits

- A tab that sends real HTTP requests on a timer (polling, session checks) wakes the app.
  dozer cannot tell that from a person.
- `PORT` inside the app is the hidden port. Use `DOZER_PUBLIC_PORT` for the public one.
- `maxAwake` should be at least the number of apps one page load touches (apps that call
  each other server-side).
- dozer does not make a running dev server any smaller. That is Next.js and Turbopack.
- After an unexpected Next.js crash, a Next 15 App Router tab loses live reload until you
  refresh it.
- If the coordinator crashes, running apps fall back to their idle rule until a new app
  starts it again.
- `--experimental-https` is not supported yet: with it, dozer runs plain `next dev`, and
  `dozer init` leaves such scripts alone.
- macOS and Linux only. Node 20 or newer; Next.js 15 and 16.

## Benefit, measured

- A sleeping app costs one gate process: about 47 MiB RSS each, measured on three real
  Next.js 16 apps (`pnpm test:e2e`, macOS, Node 22) with no tab open; about 57-60 MiB once
  a tab's dev websocket has connected (the websocket code then stays loaded). The one
  shared coordinator is about 45 MiB more. No Next.js process and no guard exist while an
  app sleeps; an awake app adds its guard (about 43 MiB) to the Next.js tree.
- Waking costs the time `next dev` takes to answer its first request. Measured in
  `spikes/RESULTS.md` (warm `.next` cache): about 1 s for a small Next 16 app on Turbopack,
  5.8 s for a large Next 15 app (47 pages) on Turbopack, 14.8 s for the same app on
  webpack. Through the gate, the acceptance suite's small Next 16 apps answered the first
  request after sleep in 0.9-1.4 s (2.0 s on the very first run, with no `.next` cache).
- For scale: Kortix measured 5.1-7.8 GB RSS for one `next dev` of its own app (their
  measurement, not ours). Three such worktrees cost 15-24 GB with plain `next dev`; with
  `maxAwake=2` the ceiling is two of them, and only the gates (about 47 MiB each) while no
  page is being viewed. The one-page Next 16 app in the acceptance suite used about
  560 MiB awake.

## Stack

Node.js 20+ and TypeScript, built into one CLI file with tsup. The only runtime dependency
is `ws`, for the websocket hold. It runs on your machine next to `next dev`; there is no
service and no hosting.
