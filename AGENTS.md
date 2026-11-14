# AGENTS.md

dozer keeps a Next.js dev server asleep until a page is requested. Design:
`docs/superpowers/specs/2026-11-14-dozer-design.md`. Build plan:
`docs/superpowers/plans/2026-11-14-dozer.md`.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm test:e2e`: acceptance on three real Next.js 16 apps. Local only, not in CI;
  slow (about 4 min). It builds first, and on its first run installs Next 16 into a temp
  dir outside the repo. Needs Chromium: `pnpm exec playwright install chromium`.

All three of typecheck, test and build must pass before a commit lands on `main`.

## Rules

- Runtime dependencies: `ws` only. Anything else is a devDependency, added on purpose.
- Every process dozer starts is stopped and verified dead. A test that leaves a
  `fake-next` or `next` process behind is a failing test.
- `spikes/` is throwaway. Nothing in `src/` imports from it.
- No secrets exist in this project. If one ever appears, it goes in the local
  environment, never in git.
- Read `git status` before every commit; never `git add -A` blindly.
- Commit messages say what changed. No attribution lines, no tracker references.
