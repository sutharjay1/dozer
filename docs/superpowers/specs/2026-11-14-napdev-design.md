# napdev — design

Working name `napdev` (free on npm as of 2026-11-14). Status: draft for approval.

## Intent and why

Running several checkouts of a Next.js monorepo at once (git worktrees, one per
agent session) starts one `next dev` per checkout. Each stays up whether or not
anyone is looking at it. On a 24 GB laptop that leaves no room for the browser,
Docker, the agent apps and everything else.

`napdev` makes a Next.js dev server cost memory and CPU **only while someone is
requesting pages from it**. It must work in any Next.js app, in any monorepo
(Turborepo, pnpm/npm/yarn/bun workspaces, or a single app), without the app
knowing it is there.

Jay asked for: a dev tool/package that makes Next.js development in a monorepo
lighter, for every Next.js repo and not one company's. Everything below marked
**(my call)** is a decision made by the designer, not something Jay stated.

## Evidence this rests on

- One `next dev` process tree is large and upgrades do not fix it. The Kortix
  repo measured 5.1–7.8 GB RSS for one dev server (46 routes, 24 GB Mac) on
  Next 16.2 and 16.3 under every memory-eviction setting
  (`apps/web/next.config.ts` in `kortix-ai/suna`).
- Killing a dev server by its port leaks most of it. The same repo documents
  ~15 child processes per `next dev`, of which only one holds the port; leaked
  workers keep 1–3 GB each until reboot (`scripts/worktree/README.md`).
- A browser tab left open will restart a stopped server by itself. The Next.js
  dev client reloads the page after `WEB_SOCKET_MAX_RECONNECTIONS` failed
  websocket reconnects, and hard-reloads when it sees a new server session id
  (`packages/next/src/client/dev/hot-reloader/pages/websocket.ts`).
- Existing tools: `carte` (Rust) starts on request, stops when idle, names
  worktrees and evicts least-recently-used, but needs its own hostnames and
  setup. `portless` names worktrees but never starts or stops anything. Neither
  is Next-aware, and neither works by keeping the app's own port.

## Goals

1. A sleeping app costs a few tens of MB and 0% CPU. Target: under 60 MB RSS
   per sleeping app, counted per gate process; the one shared coordinator is
   extra **(my call, to be measured)**.
2. Nothing in the repo changes except the dev script and one devDependency
   (see Install). `localhost:3000` stays `localhost:3000`; env files, OAuth
   callbacks, CORS lists and other services keep working.
3. A machine-wide limit on how many dev servers are awake at once, across all
   repos and worktrees.
4. Tools that start a dev server and wait for it (Turborepo `dev`, Playwright
   `webServer`, agents running `pnpm dev` then `curl`) keep working unchanged.
5. No orphan processes, ever.

## Non-goals (this stage)

- Making a single *running* dev server smaller. That is Next/Turbopack's memory.
- Gating things with no HTTP port (`tsc --watch`, `tsup --watch`).
- Working without any change to the repo (see Later stages).
- Pausing with SIGSTOP instead of stopping (see Later stages).
- Starting only the apps a worktree changed and sharing the rest (see Later stages).
- Named `.localhost` URLs, HTTPS, Windows, production use.

## Anti-goals

- Dev must never be blocked by napdev. If napdev itself fails to start (cannot
  set up its listener or state), it runs plain `next dev` on the original port
  instead. This applies at start-up only; there is no live hand-back of the
  port later. A server started this way is outside the limit and not shown in
  `status`. After start-up the escape hatch is `NAPDEV=0`.
- A tab left open must never keep a server awake, or wake it, through the dev
  websocket or the reload that follows a lost websocket. A tab that sends real
  HTTP requests on a timer (polling, session checks) does wake the app; napdev
  cannot tell that from a person. Documented limit.
- The app must not behave differently in the browser, apart from a delay on the
  first request after sleep.

## Constraints

- macOS and Linux. Node 20+ **(my call)**. TypeScript, published to npm, as few
  dependencies as practical **(my call)**.
- Supports Next.js 15 and 16, webpack and Turbopack, App and Pages router.
  Next 14 is best effort: not in the spike matrix and not a reason to stop
  **(my call)**.
- Works under pnpm, npm, yarn and bun, and as a Turborepo persistent task.

## Install

napdev is a devDependency of the repo, and the dev script change is committed,
so every teammate and every fresh worktree gets it **(my call)**. `napdev init`
adds the dependency and rewrites the scripts. Repos whose files cannot be
changed wait for the "No repo change" stage. Gates from different napdev
versions can meet on one machine: a gate that cannot talk to the running
coordinator works with the idle rule only.

## Approaches considered

1. **Port gate in place of `next dev` (chosen).** The dev script becomes
   `napdev next dev …`. napdev listens on the port Next would have used and
   runs the real `next dev` on a hidden port only while there is traffic.
   Trade-off: one edit to each dev script; app code that reads `PORT` sees the
   hidden port.
2. **Central proxy with named hosts** (`feature-x.app.localhost`, like carte and
   portless). Trade-off: every URL the app knows about changes (env, OAuth,
   CORS), plus certificates and a privileged port. Rejected because it breaks
   goal 2, and carte already covers it.
3. **Watchdog with no proxy.** A background job stops servers that look idle
   and refuses new ones above a cap. Trade-off: cannot see requests, so "idle"
   is a guess, and waking is manual. Rejected because it breaks goal 4.

Jay asked for the best plan rather than a choice, so approach 1 is **my call**.

## How it behaves

### States

`asleep` (no Next process) → `waking` → `awake` → `asleep`.

- **Start.** `napdev next dev [args]` binds the public port (from `--port`/`-p`,
  else `PORT`, else 3000) and starts **asleep**. It prints a ready line with the
  public URL so tools that wait on output continue. Exact wording is the
  builder's, but it must contain the public URL and must not claim Next is
  running.
- **Port taken.** Same as Next: if no port was given, take the next free one
  and print it; if a port was given explicitly and is taken, fail with a clear
  error. A sleeping gate keeps its port, so a worktree's URL is stable.
- **Wake.** Any HTTP request that is not a websocket upgrade wakes the app.
  napdev starts the real `next dev` on a free loopback port and holds the
  request until Next answers, then proxies it. No interstitial page **(my
  call)**: `curl`, tests and agents must receive the real response. Wake
  timeout default 120 s, then 504.
- **Activity.** An HTTP request, or a dev-websocket frame sent from Next to a
  connected browser. Browser-to-server pings are not activity. Websocket frames
  keep a person's server awake while they edit without navigating, but only up
  to 60 min after the last HTTP request **(my call)**, so an agent editing
  files in a worktree with a forgotten tab cannot hold it awake forever.
- **Sleep.** No activity for `idle` (default 10 min **(my call)**) stops the
  whole process tree and confirms nothing survived.
- **Limit.** At most `maxAwake` servers awake on the machine (default 2 **(my
  call)**). Waking one more sleeps the one whose last HTTP request is oldest.
  Optional `memoryBudget` in GB does the same using the measured RSS of each
  awake tree. An app can be pinned so it is never chosen.
- **The limit is soft when there is no safe victim (my call).** An app is never
  put to sleep while it has a request in flight, had one in the last 60 s, or
  is pinned. If no app qualifies, the new one wakes anyway and the coordinator
  sleeps the oldest as soon as one qualifies. Apps that call each other
  server-side therefore stay up together while in use; `maxAwake` should be at
  least the number of apps one page load touches.
- **Exit.** When the wrapper gets SIGINT/SIGTERM or its parent dies, it stops
  the tree and frees the port.
- **Crash.** If Next exits while awake, the app becomes asleep. After 3 failed
  wakes in a row, requests get a 502 showing the last log lines and pointing at
  `NAPDEV=0`, until the next successful wake.
- **Bypass.** `NAPDEV=0` runs the real `next dev` untouched.

### The websocket rule (the part most likely to go wrong)

napdev terminates the browser's dev websocket itself; it does not pipe the TCP
connection through.

- While asleep, browser sockets stay open and silent, and new upgrade attempts
  are accepted and held. Neither wakes the app. This stops the client's
  reconnect counter and its page reload.
- On wake, napdev closes the held sockets. Each client reconnects, sees a new
  session id and reloads. That reload is correct: the server is new.

### Hidden port

- `Host` is forwarded unchanged, so server-side URL building, Server Actions
  origin checks and HMR all see the public port.
- Child log output passes through with the hidden port rewritten to the public
  one, so nobody copies the hidden URL and bypasses the gate.
- `PORT` inside the app is the hidden port. napdev also sets
  `NAPDEV_PUBLIC_PORT`. Known wart, documented.

### Coordinator

A small background process, started by the first gate and exiting when the last
one leaves, holds the machine-wide view: each gate's repo, app, branch, public
port, state, last request time and RSS. It decides who sleeps when the limit is
hit. If it is unreachable, gates keep working with the idle rule only.

Names shown to people are `<repo>/<app> @ <branch>`, from git and the package
name. Worktrees are detected through git, not through any one tool's folder
layout (Claude Code, Codex and hand-made worktrees all differ).

### Commands

- `napdev next dev [args]` — the gate.
- `napdev status` — every gated app: name, state, public port, RSS, last request.
- `napdev sleep <name> | --all`, `napdev wake <name>`.
- `napdev init` — finds Next apps in the workspace and rewrites their dev
  scripts. Shows the diff and changes nothing without confirmation.

### Settings

Machine-wide (`maxAwake`, `memoryBudget`) live in a file in the user's home,
because the limit spans repos. Per-app (`idle`, wake timeout, `pin`) live in the
app's `package.json`. Environment variables override both.

## Order of work

Two spikes come before any product code, because the design depends on them:

1. **Websocket hold.** Prove on Next 15 and 16 (App and Pages router, Turbopack
   and webpack) that a background tab neither wakes nor reloads while the app
   sleeps, and that HMR works after wake.
2. **Wake time.** Measure cold wake with the Turbopack disk cache on a small app
   and a large one. If typical wake exceeds about 20 s, bring the SIGSTOP tier
   forward.

If spike 1 fails on a supported version, stop and return to the designer.

## Done means

On a monorepo with three gated apps started: with none visited, no Next process
exists and each gate process is under the goal-1 target; after visiting one,
exactly one Next tree exists; after `idle`, none; after `Ctrl+C`, no process
from the tree remains and the ports are free. A run with `maxAwake=1` visiting
two independent apps more than 60 s apart has one tree alive once the second
has answered.

## Later stages (not designed here)

- **No repo change.** Gate `next dev` in repos whose scripts cannot be edited.
- **Pause tier.** SIGSTOP after a short idle for instant resume, stop later.
- **Agent plugin.** A Claude Code / Codex add-on that sleeps a worktree's apps
  when its session ends.
- **Affected-only.** Start only the apps a worktree changed and route the rest
  to the main checkout.

## Left to the builder

Package layout, proxy and websocket libraries, IPC between gates and
coordinator, how RSS is sampled, exact log wording, test framework, and how the
process tree is killed and verified, provided goal 5 holds.

## Expected benefit (estimate, not measured)

Using the 5–8 GB per server measured in Kortix: three started worktrees cost
15–24 GB today. With napdev and `maxAwake=2` the ceiling is 10–16 GB while two
are in use, 5–8 GB with `maxAwake=1`, and near zero when nothing is being
viewed. Sleeping servers use no CPU, including when an agent edits their files.
