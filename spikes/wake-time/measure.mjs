// usage: node measure.mjs <appDir> [--webpack] [--runs=5] [--keep-cache]
// Times spawn -> first response byte of GET / for `next dev`; run 1 cold (.next removed), rest warm.
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith("--")));
const webpack = args.includes("--webpack");
const turbo = args.includes("--turbopack");
const runs = Number((args.find((a) => a.startsWith("--runs=")) || "--runs=5").slice(7));

const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssKb = (pgid) => {
  try {
    const out = execFileSync("ps", ["-axo", "pgid=,rss="], { encoding: "utf8" });
    return out.split("\n").reduce((n, l) => { const [g, r] = l.trim().split(/\s+/).map(Number); return g === pgid ? n + r : n; }, 0);
  } catch { return 0; }
};
const firstByte = (port, t0) => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
    const ms = performance.now() - t0; res.resume(); resolve({ ms, status: res.statusCode });
  });
  req.on("error", reject);
});

async function once(cold) {
  if (cold) rmSync(path.join(dir, ".next"), { recursive: true, force: true });
  const port = await freePort();
  const t0 = performance.now();
  const child = spawn(path.join(dir, "node_modules/.bin/next"), ["dev", "-p", String(port), "-H", "127.0.0.1", ...(webpack ? ["--webpack"] : []), ...(turbo ? ["--turbopack"] : [])], {
    cwd: dir, detached: true, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: undefined },
  });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, rssKb(child.pid)); }, 500);
  let result;
  try {
    for (;;) {
      if (performance.now() - t0 > 300000) throw new Error("timeout");
      try { result = await firstByte(port, t0); break; } catch (e) { if (e.code !== "ECONNREFUSED" && e.code !== "ECONNRESET") throw e; await sleep(25); }
    }
    peak = Math.max(peak, rssKb(child.pid));
  } finally {
    clearInterval(sampler);
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await sleep(1500);
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  return { sec: result.ms / 1000, status: result.status, rssMb: Math.round(peak / 1024) };
}

const rows = [];
for (let i = 0; i < runs; i++) {
  const r = await once(i === 0);
  rows.push(r);
  console.log(`run ${i + 1} ${i === 0 ? "cold" : "warm"}: ${r.sec.toFixed(2)} s status ${r.status} peakRSS ${r.rssMb} MB`);
}
const warm = rows.slice(1).map((r) => r.sec).sort((a, b) => a - b);
const med = warm.length ? (warm[(warm.length - 1) >> 1] + warm[warm.length >> 1]) / 2 : NaN;
console.log(`${path.basename(dir)}${webpack ? " webpack" : ""}${turbo ? " turbopack" : ""}: cold ${rows[0].sec.toFixed(2)} s, warm median ${med.toFixed(2)} s`);
