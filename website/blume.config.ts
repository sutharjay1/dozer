import { defineConfig } from "blume";

/** The deployed Workers URL. Canonicals, the sitemap and og:image are built from it. */
export const SITE = "https://dozer-docs.sutharjay3635.workers.dev";

export default defineConfig({
  title: "dozer",
  description:
    "dozer runs next dev only while pages are requested, then stops it, and keeps at most a few Next.js dev servers awake across all your repos and worktrees.",
  // Plain text wordmark; there is no logo mark.
  logo: { text: "dozer" },

  theme: {
    // orange-600 in light mode, orange-500 in dark mode; the only accent.
    accent: { light: "#ea580c", dark: "#f97316" },
    background: { light: "#ffffff", dark: "#0a0a0a" },
    radius: "sm",
    mode: "light",
    toggle: true,
    // Self-hosted by Blume at build time; no runtime font requests.
    fonts: {
      display: "inter",
      body: "inter",
      mono: "geist-mono",
    },
  },

  seo: {
    // One committed card (scripts/make-og-card.mjs) for every page, instead of generated ones.
    og: { image: "/og/default.png" },
    sitemap: true,
    structuredData: true,
    software: {
      name: "dozer",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      price: 0,
    },
  },

  deployment: {
    site: SITE,
  },
});
