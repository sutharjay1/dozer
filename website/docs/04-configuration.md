---
title: Configuration
description: dozer settings, their defaults, the package.json dozer key, the DOZER_ environment variables, and the machine-wide ~/.dozer/config.json file.
---

## Settings

| Setting | Default | `package.json` `dozer` key | Environment variable |
|---|---|---|---|
| Idle time before sleep | `10m` | `idle` | `DOZER_IDLE` |
| Wake timeout, then 504 | `120s` | `wakeTimeout` | `DOZER_WAKE_TIMEOUT` |
| Pin: never put to sleep by the limit | off | `pin` | `DOZER_PIN=1` |
| Most apps awake at once | `2` | none, see below | `DOZER_MAX_AWAKE` |
| Memory budget for awake apps, in GB | none | none, see below | `DOZER_MEMORY_BUDGET` |
| Grace before an app may be put to sleep by the limit | `60s` | | `DOZER_GRACE` |
| dozer's home directory | `~/.dozer` | | `DOZER_HOME` |
| Run plain `next dev` | | | `DOZER=0` |
| No coordinator, idle rule only | | | `DOZER_COORDINATOR=0` |

Durations are written like `500ms`, `120s`, `10m`, `1h`. Environment variables override the files.

## Per app: package.json

In the app's own `package.json`:

```json
{ "dozer": { "idle": "20m", "wakeTimeout": "180s", "pin": true } }
```

## Machine-wide: ~/.dozer/config.json

`maxAwake` and `memoryBudget` (in GB) apply across every repo and worktree on the machine:

```json
{ "maxAwake": 2, "memoryBudget": 12 }
```

Put these in the file rather than in the environment. The limit is enforced by the coordinator, and the coordinator is started by whichever app happens to start first, so `DOZER_MAX_AWAKE` or `DOZER_MEMORY_BUDGET` only take effect when they are set for that app. The file applies no matter which app starts it.

## Inside the app

`PORT` inside the app is the hidden port Next.js really listens on. dozer sets `DOZER_PUBLIC_PORT` to the public one, the port you open in the browser.
