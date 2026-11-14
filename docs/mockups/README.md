# README mockups

Sources for `docs/images/hero-terminal.png` and `docs/images/before-after.png`
(also copied to `website/public/readme/`). Built with the stageshow skill's kit.

## Re-film

1. Copy `dozer-terminal/` and `dozer-memory/` into the stageshow skill's `examples/`
   (`~/.claude/skills/stageshow/examples/`; the imports expect `../../kit`).
2. In the skill folder: `npm install`, then `npm run dev` (or
   `npx vite playground --config playground/vite.config.ts --port 5391`).
3. Export each still at 2x:

```sh
node scripts/film.mjs "http://localhost:5391/?capture=dozer-terminal" --select '#example' --still --width 1100 --pad 0 --out hero-terminal.png
node scripts/film.mjs "http://localhost:5391/?capture=dozer-memory"   --select '#example' --still --width 1100 --pad 0 --out before-after.png
```

Add `--gate` (without `--still`) to run the rehearsal checks. If Chrome isn't
found, set `CHROME_PATH` to a Chrome/Chromium binary.

## Numbers

Only measured figures: awake Next.js 16 test app 563 MiB, asleep app (dozer's
own process) 47 MiB, coordinator 45 MiB. Put this caption under the before/after
image: "Measured RSS on a small Next.js 16 test app. An asleep app is dozer's
own process; bigger apps use far more per awake server."
