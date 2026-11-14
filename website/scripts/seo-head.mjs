#!/usr/bin/env node
/**
 * seo-head.mjs: adds the head tags Blume 2.2.7 has no setting for, after `blume build`.
 *
 * Blume already writes title, description, canonical, og:* and twitter:* tags, and the
 * WebSite, page and SoftwareApplication JSON-LD. It refuses `robots` and `og:image:*` in
 * `seo.metatags`, cannot give `theme-color` a media query, declares image size only for
 * cards it generates itself, and has no featureList or FAQPage. This fills those gaps in
 * dist/ and nothing else:
 *
 * - robots meta with max-image-preview:large (noindex on 404.html; skipped where Blume set noindex)
 * - theme-color for light and for dark
 * - og:image:type/width/height/alt and twitter:image:alt for the committed card
 * - featureList on the home page's SoftwareApplication node
 * - a FAQPage node on the Limits page, built from that page's own questions and answers
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
/** Present once this script has run on a file, so a second run changes nothing. */
const DONE = 'name="theme-color" content=';

const OG_ALT = "dozer: Next.js dev servers that sleep";
const THEME = { light: "#ffffff", dark: "#0a0a0a" };

const FEATURES = [
  "Holds the app's dev port and runs next dev on a hidden loopback port only while pages are requested",
  "Stops the whole Next.js process tree after an idle period (10 minutes by default)",
  "Holds open browser tabs' live-reload websockets while Next.js sleeps, then reloads each page once on wake",
  "Machine-wide limit on awake dev servers across every repo and git worktree (2 by default)",
  "Never puts to sleep an app with a request in flight, one used in the last grace period, or one that is pinned",
  "dozer status, sleep, wake and init commands",
];

const LIMITS_SOURCE = join(ROOT, "docs/06-limits.md");

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** JSON inside <script>: keep "</script>" from closing the element. */
const ldJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Markdown inline code and links to plain text, for JSON-LD answers. */
const plain = (s) =>
  s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** `## Question` headings and the paragraphs under each, from the Limits page source. */
function faqEntries() {
  const body = readFileSync(LIMITS_SOURCE, "utf8").replace(/^---[\s\S]*?\n---\n/, "");
  const entries = [];
  for (const block of body.split(/^## /m).slice(1)) {
    const [question, ...rest] = block.split("\n");
    const answer = plain(rest.join("\n"));
    if (question.trim() && answer) entries.push({ question: plain(question), answer });
  }
  if (entries.length === 0) throw new Error("no questions found in docs/06-limits.md");
  return entries;
}

function canonicalOf(html) {
  return html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;
}

function patch(file) {
  let html = readFileSync(file, "utf8");
  if (html.includes(DONE)) return false;

  const noindex = /<meta name="robots" content="noindex"/.test(html);
  const head = [];
  if (file === join(DIST, "404.html")) {
    head.push('<meta name="robots" content="noindex">');
  } else if (!noindex) {
    head.push('<meta name="robots" content="index, follow, max-image-preview:large">');
  }
  head.push(
    `<meta name="theme-color" content="${THEME.light}" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="${THEME.dark}" media="(prefers-color-scheme: dark)">`,
  );

  // Size and alt for the one committed card, right after Blume's og:image.
  html = html.replace(
    /(<meta property="og:image" content="[^"]+\/og\/default\.png">)/,
    `$1<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${attr(OG_ALT)}">`,
  );
  html = html.replace(
    /(<meta name="twitter:image" content="[^"]+\/og\/default\.png">)/,
    `$1<meta name="twitter:image:alt" content="${attr(OG_ALT)}">`,
  );

  // featureList on the SoftwareApplication node Blume emits on the home page.
  html = html.replace(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    (whole, json) => {
      const data = JSON.parse(json);
      const graph = data["@graph"] ?? [];
      const software = graph.find((n) => n["@type"] === "SoftwareApplication");
      if (!software) return whole;
      software.featureList = FEATURES;
      return `<script type="application/ld+json">${ldJson(data)}</script>`;
    },
  );

  const canonical = canonicalOf(html);
  if (canonical && new URL(canonical).pathname === "/limits") {
    const faq = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "@id": `${canonical}#faq`,
      url: canonical,
      mainEntity: faqEntries().map((e) => ({
        "@type": "Question",
        name: e.question,
        acceptedAnswer: { "@type": "Answer", text: e.answer },
      })),
    };
    head.push(`<script type="application/ld+json">${ldJson(faq)}</script>`);
  }

  html = html.replace("</head>", `${head.join("")}</head>`);
  writeFileSync(file, html);
  return true;
}

const files = htmlFiles(DIST);
const changed = files.filter(patch).length;
console.log(`seo-head: patched ${changed} of ${files.length} HTML files`);
