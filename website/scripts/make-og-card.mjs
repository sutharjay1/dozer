#!/usr/bin/env node
/**
 * make-og-card.mjs: the 1200x630 Open Graph card at public/og/default.png.
 *
 * Not part of the build. Run it by hand (`pnpm og`) and commit the PNG.
 *
 * resvg needs ttf/otf, and inter-ui ships woff2, so wawoff2 decompresses the static
 * subsets back to sfnt in a temp directory that is removed afterwards.
 *
 * inter-ui's static SemiBold names its family "Inter SemiBold" (subfamily "Regular"), and
 * resvg does not merge that into "Inter" at weight 600, so the semibold text names that
 * family outright.
 *
 * dozer has no mark, so the eyebrow starts at the left inset.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import wawoff2 from "wawoff2";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "public/og");
const INTER_DIR = join(ROOT, "node_modules/inter-ui/web-latin");

const FONT_REGULAR = "Inter";
const FONT_SEMIBOLD = "Inter SemiBold";

const CARD = {
  file: "default",
  eyebrow: "dozer",
  title: "Next.js dev servers that sleep",
  sub: "next dev runs only while pages are requested, then stops.",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Horizontal and vertical inset of the card's content. */
const PAD = 64;
const TITLE_MAX = 88;

/**
 * The largest size at which the title fits one line. resvg cannot measure text; Inter
 * SemiBold at -1.5 letter-spacing averages about 0.53em per character.
 */
function titleSize(text) {
  const fit = Math.floor((1200 - PAD * 2) / (text.length * 0.53));
  return Math.min(TITLE_MAX, fit);
}

function card(c) {
  const size = titleSize(c.title);
  // Anchored to the bottom: the sub line's baseline sits PAD above the edge (plus room for
  // descenders), the title one step above it.
  const subY = 630 - PAD - 8;
  const titleY = subY - 66;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f8f8f8"/>
  <g font-family="${FONT_REGULAR}">
    <text x="${PAD}" y="${PAD + 28}" font-family="${FONT_SEMIBOLD}" font-size="26" font-weight="600" fill="#ea580c" letter-spacing="4">${esc(c.eyebrow.toUpperCase())}</text>
    <text x="${PAD}" y="${titleY}" font-family="${FONT_SEMIBOLD}" font-size="${size}" font-weight="600" fill="#0a0a0a" letter-spacing="-1.5">${esc(c.title)}</text>
    <text x="${PAD}" y="${subY}" font-size="29" font-weight="400" fill="#525252">${esc(c.sub)}</text>
  </g>
</svg>`;
}

async function extractFonts(dir) {
  const files = [];
  for (const weight of ["Regular", "SemiBold"]) {
    const woff2 = readFileSync(join(INTER_DIR, `Inter-${weight}-subset.woff2`));
    const ttf = Buffer.from(await wawoff2.decompress(woff2));
    // A real sfnt starts with 0x00010000; anything else would render in a fallback face.
    if (ttf.readUInt32BE(0) !== 0x00010000) {
      throw new Error(`Inter-${weight}: not an sfnt after decompress`);
    }
    const path = join(dir, `Inter-${weight}.ttf`);
    writeFileSync(path, ttf);
    files.push(path);
  }
  return files;
}

const fontDir = mkdtempSync(join(tmpdir(), "dozer-og-"));
try {
  const fontFiles = await extractFonts(fontDir);
  mkdirSync(OUT_DIR, { recursive: true });
  const resvg = new Resvg(card(CARD), {
    font: {
      fontFiles,
      // Nothing from the OS, so the card renders the same on every machine.
      loadSystemFonts: false,
      defaultFontFamily: FONT_REGULAR,
    },
    fitTo: { mode: "width", value: 1200 },
  });
  const out = join(OUT_DIR, `${CARD.file}.png`);
  writeFileSync(out, resvg.render().asPng());
  console.log(`wrote ${out}`);
} finally {
  rmSync(fontDir, { recursive: true, force: true });
}
