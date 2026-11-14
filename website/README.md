# dozer docs

The public documentation site for dozer, built with [Blume](https://useblume.dev) 2.2.7 and
served as static assets by a Cloudflare Worker (`dozer-docs`).

This folder is its own package with its own lockfile. It is not part of any workspace.

## Where things live

- `docs/*.md`: the pages, one Markdown file each. The number prefix sets the sidebar order
  and is dropped from the URL (`02-quickstart.md` is `/quickstart`).
- `blume.config.ts`: site title, theme (Inter, Geist Mono, orange accent), SEO settings and
  the site URL. Change `SITE` there if the Workers URL changes, and the URLs in
  `public/robots.txt` and `public/llms.txt` with it.
- `public/robots.txt`, `public/llms.txt`: written by hand; Blume ships them in place of its
  own. Blume generates `sitemap.xml`.
- `public/og/default.png`: the social card for every page. Regenerate it with `pnpm og`
  (`scripts/make-og-card.mjs`) and commit the PNG; it is not built.
- `scripts/seo-head.mjs`: runs after `blume build` and adds the head tags Blume has no
  setting for (robots `max-image-preview:large`, `theme-color` per colour scheme, the card's
  size and alt, `featureList`, and the FAQPage JSON-LD built from `docs/06-limits.md`).
- `wrangler.jsonc`: the Worker; static assets from `dist/`, no script.

## Commands

Node 22.19 or newer.

```sh
pnpm install
pnpm dev            # http://localhost:4321 with hot reload
pnpm run build      # dist/
pnpm preview        # serve dist/ locally
pnpm run deploy     # build, then wrangler deploy (needs `wrangler login`)
```

Use `pnpm run deploy`, not `pnpm deploy`, which is a different pnpm command.

## Rules

- Only facts from the dozer README, design spec and measured results. No analytics.
- Do not link to the source repository; it is private.
