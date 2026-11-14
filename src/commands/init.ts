// `napdev init`: find every Next.js app in a workspace and put napdev in front of its `next dev`.
// package.json files are edited as text, never re-serialized, so formatting survives byte for byte.
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface InitChange { file: string; before: string; after: string }
/** A script left as it is because napdev cannot gate it yet. */
export interface InitSkip { file: string; script: string; reason: string }

const SKIP = new Set(['node_modules', '.git', '.next', 'dist'])

/** Replace each bare `next dev` not already preceded by `napdev ` with `napdev next dev`. */
export function rewriteScript(script: string): string {
  return script.replace(/(^|\s|&&|;|\||\(|--)next dev(?=$|[\s;&|)])/g, (m, pre: string, offset: number) => {
    if (pre === '' || /\s/.test(pre)) {
      if (script.slice(0, offset + pre.length).endsWith('napdev ')) return m
    }
    return `${pre}napdev next dev`
  })
}

// ---- minimal JSON scanner: just enough to locate values by offset -------------------------------

interface Entry { key: string; keyStart: number; valStart: number; valEnd: number }

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i]!)) i++
  return i
}

function scanString(t: string, i: number): number {
  i++
  while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1
  return i + 1
}

function scanValue(t: string, i: number): number {
  const c = t[i]
  if (c === '"') return scanString(t, i)
  if (c === '{' || c === '[') {
    let depth = 0
    for (; i < t.length; i++) {
      const ch = t[i]!
      if (ch === '"') i = scanString(t, i) - 1
      else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') if (--depth === 0) return i + 1
    }
    throw new Error('unterminated JSON')
  }
  while (i < t.length && !/[\s,}\]]/.test(t[i]!)) i++
  return i
}

/** Entries of the object whose `{` is at `start`. */
function scanObject(t: string, start: number): Entry[] {
  const out: Entry[] = []
  let i = skipWs(t, start + 1)
  while (t[i] !== '}') {
    const keyStart = i
    const keyEnd = scanString(t, i)
    const key = JSON.parse(t.slice(keyStart, keyEnd)) as string
    i = skipWs(t, keyEnd)
    i = skipWs(t, i + 1) // the colon
    const valEnd = scanValue(t, i)
    out.push({ key, keyStart, valStart: i, valEnd })
    i = skipWs(t, valEnd)
    if (t[i] === ',') i = skipWs(t, i + 1)
  }
  return out
}

interface Layout { nl: string; unit: string }

function layoutOf(text: string): Layout {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const m = /\n([ \t]+)\S/.exec(text)
  return { nl, unit: m ? m[1]! : '  ' }
}

function leadingWs(t: string, keyStart: number): string {
  let s = keyStart
  while (s > 0 && (t[s - 1] === ' ' || t[s - 1] === '\t')) s--
  return t.slice(s, keyStart)
}

/** Add `"name": value` to the object at `objStart`, sorted if the keys already are, else last. */
function insertEntry(t: string, objStart: number, name: string, value: string, depth: number, lay: Layout): string {
  const entries = scanObject(t, objStart)
  const entry = `${JSON.stringify(name)}: ${value}`
  if (entries.length === 0) {
    const objEnd = scanValue(t, objStart)
    const inner = lay.unit.repeat(depth + 1)
    return t.slice(0, objStart) + `{${lay.nl}${inner}${entry}${lay.nl}${lay.unit.repeat(depth)}}` + t.slice(objEnd)
  }
  const keys = entries.map((e) => e.key)
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1]! <= k)
  const idx = sorted ? entries.findIndex((e) => e.key > name) : -1
  if (idx >= 0) {
    const e = entries[idx]!
    const ws = t.slice(skipBack(t, e.keyStart), e.keyStart)
    return t.slice(0, e.keyStart) + `${entry},${ws}` + t.slice(e.keyStart)
  }
  const last = entries[entries.length - 1]!
  const ws = t.slice(skipBack(t, last.keyStart), last.keyStart)
  return t.slice(0, last.valEnd) + `,${ws}${entry}` + t.slice(last.valEnd)
}

/** Start of the whitespace run directly before `i`. */
function skipBack(t: string, i: number): number {
  while (i > 0 && /\s/.test(t[i - 1]!)) i--
  return i
}

interface Pkg { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }

// the gate speaks plain HTTP to Next; a TLS dev server cannot sit behind it yet
const HTTPS_FLAG = '--experimental-https'

interface Edit { after: string | null; skipped: string[] }

function editPackage(text: string, version: string): Edit {
  const none: Edit = { after: null, skipped: [] }
  let pkg: Pkg
  try {
    pkg = JSON.parse(text) as Pkg
  } catch {
    return none
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return none
  if (!(pkg.dependencies && 'next' in pkg.dependencies) && !(pkg.devDependencies && 'next' in pkg.devDependencies)) return none
  const rootStart = skipWs(text, 0)
  const top = scanObject(text, rootStart)
  const scripts = top.find((e) => e.key === 'scripts')
  if (!scripts || text[scripts.valStart] !== '{') return none

  // rewrite script string literals right to left so earlier offsets stay valid
  let out = text
  let changed = false
  const skipped: string[] = []
  for (const e of scanObject(text, scripts.valStart).reverse()) {
    if (text[e.valStart] !== '"') continue
    const raw = text.slice(e.valStart, e.valEnd)
    const next = `"${rewriteScript(raw.slice(1, -1))}"`
    if (next === raw) continue
    if (raw.includes(HTTPS_FLAG)) {
      skipped.unshift(e.key)
      continue
    }
    out = out.slice(0, e.valStart) + next + out.slice(e.valEnd)
    changed = true
  }
  if (!changed) return { after: null, skipped }

  const hasNapdev = (pkg.dependencies && 'napdev' in pkg.dependencies) || (pkg.devDependencies && 'napdev' in pkg.devDependencies)
  if (hasNapdev) return { after: out, skipped }
  const lay = layoutOf(text)
  const value = JSON.stringify(`^${version}`)
  const rootStartOut = skipWs(out, 0)
  const dev = scanObject(out, rootStartOut).find((e) => e.key === 'devDependencies')
  if (dev && out[dev.valStart] === '{') return { after: insertEntry(out, dev.valStart, 'napdev', value, 1, lay), skipped }
  const last = top[top.length - 1]!
  const ws = leadingWs(text, last.keyStart)
  const block = `${JSON.stringify('devDependencies')}: {${lay.nl}${ws}${lay.unit}${JSON.stringify('napdev')}: ${value}${lay.nl}${ws}}`
  const lastOut = scanObject(out, rootStartOut).at(-1)!
  const wsOut = text.slice(skipBack(text, last.keyStart), last.keyStart)
  return { after: out.slice(0, lastOut.valEnd) + `,${wsOut}${block}` + out.slice(lastOut.valEnd), skipped }
}

// ---- workspace discovery -------------------------------------------------------------------------

/** The `packages:` list of pnpm-workspace.yaml (block or one-line flow form); null when it cannot be read. */
function pnpmPackages(yaml: string): string[] | null {
  const unquote = (v: string): string => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v)
  const out: string[] = []
  let inList = false
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    if (!line.trim()) continue
    const isItem = /^\s*-(\s|$)/.test(line)
    if (!isItem && /^\S/.test(line)) {
      const key = /^packages\s*:(.*)$/.exec(line)
      inList = key !== null
      if (key) {
        const rest = key[1]!.trim()
        if (rest === '') continue
        const flow = /^\[(.*)\]$/.exec(rest)
        if (!flow) return null
        for (const part of flow[1]!.split(',')) {
          const v = unquote(part.trim())
          if (v) out.push(v)
        }
        inList = false
      }
      continue
    }
    if (!inList || !isItem) continue
    const v = unquote(/^\s*-\s*(.*?)\s*$/.exec(line)![1]!)
    if (v) out.push(v)
  }
  return out
}

async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory()
  } catch {
    return false
  }
}

async function subdirs(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const n of names.sort()) if (!SKIP.has(n) && (await isRealDir(join(dir, n)))) out.push(n)
  return out
}

/** Directories (relative, posix) a pattern made of literal, `*` and `**` segments matches. */
async function expand(root: string, pattern: string): Promise<string[]> {
  const segs = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter((s) => s && s !== '.')
  let current = ['']
  for (const seg of segs) {
    const next: string[] = []
    for (const base of current) {
      if (seg === '*' || seg === '**') {
        const walk = async (rel: string): Promise<void> => {
          for (const n of await subdirs(join(root, rel))) {
            const r = rel ? `${rel}/${n}` : n
            next.push(r)
            if (seg === '**') await walk(r)
          }
        }
        await walk(base)
      } else if (!SKIP.has(seg)) {
        const r = base ? `${base}/${seg}` : seg
        if (await isRealDir(join(root, r))) next.push(r)
      }
    }
    current = next
  }
  return current
}

async function workspaceDirs(root: string): Promise<string[]> {
  let patterns: string[] | null = null
  const yamlPath = join(root, 'pnpm-workspace.yaml')
  if (existsSync(yamlPath)) {
    patterns = pnpmPackages(await readFile(yamlPath, 'utf8'))
    if (patterns === null) throw new Error('could not read packages from pnpm-workspace.yaml')
  } else {
    try {
      const w = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }).workspaces
      if (Array.isArray(w)) patterns = w.filter((x): x is string => typeof x === 'string')
      else if (w && typeof w === 'object' && Array.isArray((w as { packages?: unknown }).packages)) {
        patterns = ((w as { packages: unknown[] }).packages).filter((x): x is string => typeof x === 'string')
      }
    } catch {
      /* no root package.json: nothing to find */
    }
  }
  const included = new Set<string>([''])
  const excluded = new Set<string>()
  for (const p of patterns ?? []) {
    if (p.startsWith('!')) for (const d of await expand(root, p.slice(1))) excluded.add(d)
    else for (const d of await expand(root, p)) included.add(d)
  }
  return [...included].filter((d) => !excluded.has(d)).sort()
}

export async function planInit(rootDir: string, napdevVersion: string): Promise<InitChange[]> {
  return (await plan(rootDir, napdevVersion)).changes
}

async function plan(rootDir: string, napdevVersion: string): Promise<{ changes: InitChange[]; skipped: InitSkip[] }> {
  const changes: InitChange[] = []
  const skipped: InitSkip[] = []
  for (const dir of await workspaceDirs(rootDir)) {
    const file = dir ? `${dir}/package.json` : 'package.json'
    let before: string
    try {
      before = await readFile(join(rootDir, file), 'utf8')
    } catch {
      continue
    }
    const edit = editPackage(before, napdevVersion)
    for (const script of edit.skipped) skipped.push({ file, script, reason: `${HTTPS_FLAG} is not supported yet` })
    if (edit.after !== null && edit.after !== before) changes.push({ file, before, after: edit.after })
  }
  return { changes, skipped }
}

// ---- command ----------------------------------------------------------------------------------------

/** Line diff via longest common subsequence; package.json files are small. */
function diffLines(before: string, after: string): string[] {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) (i++, j++)
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  return out
}

function ownVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const p = join(dir, 'package.json')
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'napdev' && pkg.version) return pkg.version
    }
    const up = dirname(dir)
    if (up === dir) throw new Error('could not find napdev package.json')
    dir = up
  }
}

export async function runInit(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  void env
  const yes = argv.includes('--yes')
  if (argv.some((a) => a !== '--yes')) {
    process.stderr.write('usage: napdev init [--yes]\n')
    return 1
  }
  let changes: InitChange[]
  let skipped: InitSkip[]
  try {
    ({ changes, skipped } = await plan(cwd, ownVersion()))
  } catch (err) {
    process.stderr.write(`napdev: ${(err as Error).message}\n`)
    return 1
  }
  for (const s of skipped) process.stdout.write(`Skipped ${s.file} script "${s.script}": ${s.reason}.\n`)
  if (skipped.length) process.stdout.write('\n')
  if (changes.length === 0) {
    process.stdout.write('Nothing to change.\n')
    return 0
  }
  for (const c of changes) {
    process.stdout.write(`--- ${c.file}\n+++ ${c.file}\n${diffLines(c.before, c.after).join('\n')}\n\n`)
  }
  if (!yes) {
    process.stdout.write('Run napdev init --yes to apply.\n')
    return 0
  }
  for (const c of changes) await writeFile(join(cwd, c.file), c.after)
  process.stdout.write(`Updated ${changes.length} file${changes.length === 1 ? '' : 's'}.\nRun your package manager's install to finish.\n`)
  return 0
}
