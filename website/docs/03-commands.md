---
title: Commands
description: Every dozer command and flag, dozer next dev, status, sleep, wake and init, with example output.
---

## dozer next dev

```sh
dozer next dev [next dev options]
```

The gate, used in place of `next dev` in the dev script. Any `next dev` options are passed on.

- It binds the port Next.js would have used: `-p`/`--port`, else `PORT`, else 3000. If no port was given and that one is taken, it takes the next free one and prints it. If a port was given and is taken, it fails.
- It starts asleep and prints:

  ```txt
  dozer listening on http://localhost:3000 (Next.js asleep; starts on first request)
  ```

- The first request starts `next dev` and waits for it. If Next.js does not answer within the wake timeout (120 s by default), the request gets a 504.
- After 3 failed wakes in a row, requests get a 502 that shows the last log lines, until the next wake succeeds.
- Ctrl+C or SIGTERM stops the whole Next.js process tree and frees the port.
- If dozer cannot set itself up at start-up, it runs plain `next dev` instead.

## dozer status

```sh
dozer status [--json]
```

Every app running under dozer on the machine, awake ones first:

```txt
NAME                    STATE   PORT  RSS     LAST REQUEST
shop/web @ main         awake   3000  563 MB  12s ago
shop/web @ fix-cart     asleep  3001  -       14m ago
shop/admin @ main       asleep  3002  -       never
```

- Names are `<repo>/<app> @ <branch>`, from git and the package name, so each worktree gets its own line.
- `RSS` is shown for awake apps and is `-` for sleeping ones.
- A pinned app shows `(pinned)` after its state.
- `--json` prints the same list as JSON.

## dozer sleep

```sh
dozer sleep <name>
dozer sleep --all
```

Stops an app's Next.js now. `<name>` is an id, a full name, or a unique part of a name, such as `web`. If the part matches several apps, dozer lists them and does nothing.

```txt
Asleep: shop/web @ main
```

## dozer wake

```sh
dozer wake <name>
```

Starts an app's Next.js now, without waiting for a request. `<name>` works as for `sleep`.

```txt
Awake: shop/web @ main
```

## dozer init

```sh
dozer init [--yes]
```

Finds the Next.js apps in the workspace and puts `dozer` in front of `next dev` in their dev scripts. Without `--yes` it prints the diff and changes nothing. With `--yes` it writes the files; run your package manager's install afterwards. It adds `"dozer": "^<version>"` as a dev dependency, which only installs once dozer is published to npm.
