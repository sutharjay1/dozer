# AGENTS.md

napdev keeps a Next.js dev server asleep until a page is requested. Design:
`docs/superpowers/specs/2026-11-14-napdev-design.md`. Build plan:
`docs/superpowers/plans/2026-11-14-napdev.md`.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm test:e2e` (real Next.js apps, slow; after `pnpm build`)

All three of typecheck, test and build must pass before a commit lands on `main`.

## Rules

- Runtime dependencies: `ws` only. Anything else is a devDependency, added on purpose.
- Every process napdev starts is stopped and verified dead. A test that leaves a
  `fake-next` or `next` process behind is a failing test.
- `spikes/` is throwaway. Nothing in `src/` imports from it.
- No secrets exist in this project. If one ever appears, it goes in the local
  environment, never in git.
- Read `git status` before every commit; never `git add -A` blindly.
- Commit messages say what changed. No attribution lines, no tracker references.
