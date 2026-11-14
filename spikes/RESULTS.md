# Spike: websocket hold across sleep and wake

Versions: next 15.5.29, next 16.4.6, react/react-dom 19.3.1, typescript 5.9 (TS 7 breaks Next 15), ws 8.23.0, playwright 1.65.1 (Chromium headless shell). Ports 4000 proxy / 4001 upstream (both were free).

Method (`ws-hold/proxy.mjs`, `ws-hold/run.mjs`): load a page through the proxy, SIGUSR1 (kill upstream tree, keep browser sockets open and silent), hold 180 s, assert zero proxy HTTP requests and zero full page loads (Playwright `load` events); SIGUSR2 (restart upstream, close held sockets with 1012), assert exactly one reload within the following 20 s; edit the route source and assert the new text appears.
Note: `framenavigated` fires twice per load (and on history updates), so full loads are counted with the page `load` event.

## Results, brief behavior (wake = close held sockets with 1012; reproduce with `WAKE_MODE=close`)

| Next | bundler | router | result |
|---|---|---|---|
| 15.5.29 | webpack | app | FAIL: 0 reloads after wake; edit not reflected |
| 15.5.29 | webpack | pages | PASS |
| 15.5.29 | turbopack (`--turbopack`) | app | FAIL: 0 reloads after wake; edit not reflected |
| 15.5.29 | turbopack (`--turbopack`) | pages | PASS |
| 16.4.6 | turbopack (default) | app | PASS |
| 16.4.6 | turbopack (default) | pages | PASS |
| 16.4.6 | webpack (`--webpack`) | app | PASS |
| 16.4.6 | webpack (`--webpack`) | pages | PASS |

The hold half passes in all 8 rows: 0 HTTP requests, 0 navigations, 0 new upgrades during 180 s (the client stayed silent; webpack clients keep sending 2.5 s pings, which the proxy drops).

## Earlier variant (superseded by the full 8-row run below): two Next 15 app rows with `WAKE_MODE=both`

| Next | bundler | router | result |
|---|---|---|---|
| 15.5.29 | webpack | app | PASS (1 reload, edit applied) |
| 15.5.29 | turbopack | app | PASS (1 reload, edit applied) |

## Where the spec's websocket rule is wrong or incomplete

- Next 15 app router: the client (`client/dev/hot-reloader/app/use-websocket.js`) opens `/_next/webpack-hmr` once and has no onclose/onerror handler. After a 1012 close it never reconnects, so it never reloads and HMR is dead for that tab. Observed: `WS close` then nothing for 80 s. Applies to both webpack and Turbopack in Next 15.
- Next 15 pages router: reconnects after 1 s. Webpack: reload comes from the `sync` hash differing (client sends `client-full-reload`). Turbopack: `turbopack-connected` session id differs, then reload. Both reload exactly once.
- Next 16 (all four rows): client reconnects after close (`/_next/hmr`, app router adds `?id=...`), gets a new session id / hash and reloads exactly once. In 16 webpack/app, reload happened on the reconnect `sync`/`built` flow without turbopack-connected.
- Fix for Next 15 app: on wake the proxy additionally sends a reload frame to each held socket (the client replies `client-reload-page` and calls `location.reload()`). Superseded by the full 8-row variant run below.
- HMR socket paths: Next 15 `/_next/webpack-hmr` (both bundlers, both routers); Next 16 `/_next/hmr` (app router adds `?id=`).

## Gate

Superseded: the close-only wake gave 6/8 and the Next 15 app-router rows failed. See the variant below.

## Variant: reload message on wake

Earlier note that only the two Next 15 app rows were re-run with the variant: superseded, the full 8-row matrix was re-run (below).

Proxy wake (now the default, `WAKE_MODE=both`): send one text frame `{"action":"reloadPage","type":"reloadPage"}` to every held browser socket, then close it with 1012. Same assertions as above, plus: each row must show exactly 2 full page loads in total (initial + one reload), so a reload-message plus session-id reload cannot double up.

Which shape each client handles (the other key is ignored, so one frame carrying both works):
- Next 15.5.29 keys on `action`: `HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE = "reloadPage"`, handled in `next/dist/client/dev/hot-reloader/app/hot-reloader-app.js` (case at line ~337, `if (!('action' in obj)) return` at ~160) and `.../pages/hot-reloader-pages.js` (~319). Client answers `client-reload-page` and calls `location.reload()`.
- Next 16.4.6 keys on `type`: `HMR_MESSAGE_SENT_TO_BROWSER.RELOAD_PAGE = "reloadPage"` (`next/dist/server/dev/hot-reloader-types.js` line 27), handled in `.../hot-reloader/app/hot-reloader-app.js` (`switch(message.type)` at ~217, case ~379) and `.../pages/hot-reloader-pages.js` (~324).

| Next | bundler | router | result |
|---|---|---|---|
| 15.5.29 | webpack | app | PASS |
| 15.5.29 | webpack | pages | PASS |
| 15.5.29 | turbopack (`--turbopack`) | app | PASS |
| 15.5.29 | turbopack (`--turbopack`) | pages | PASS |
| 16.4.6 | turbopack (default) | app | PASS |
| 16.4.6 | turbopack (default) | pages | PASS |
| 16.4.6 | webpack (`--webpack`) | app | PASS |
| 16.4.6 | webpack (`--webpack`) | pages | PASS |

8/8 PASS: hold half unchanged (0 HTTP, 0 navigations over 180 s), exactly one reload after wake in every row, no double reload, HMR edit visible in every row without a manual reload.

Upgrades during the 180 s hold, per row, quoted from the variant run's `hold done` log lines (`upgrades N`): next15/webpack/app 0, next15/webpack/pages 0, next15/turbopack/app 0, next15/turbopack/pages 0, next16/turbopack/app 0, next16/turbopack/pages 0, next16/webpack/app 0, next16/webpack/pages 0. That run only logged the count; `run.mjs` now also asserts it is 0 (added afterwards, matrix not re-run since the logged counts already show 0).

Known untested: background-tab timer throttling (Playwright page stays foreground), and reloads arriving more than 20 s after wake (the quiet window is 20 s).

## Gate verdict: GO

The proxy must send the reload frame `{"action":"reloadPage","type":"reloadPage"}` to every held socket first, then close it with 1012. With that, 8/8 rows pass on Next 15.5.29 and 16.4.6 (webpack and Turbopack, app and pages routers). Close-only does not work on Next 15 app router (client never reconnects). The designer has accepted this technique change (spec updated in 6e78ec2).
