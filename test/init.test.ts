import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planInit, rewriteScript, runInit } from '../src/commands/init.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function make(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'dozer-init-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  }
  return root
}
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')
const files = (c: { file: string }[]): string[] => c.map((x) => x.file).sort()
const next = (name: string, dev = 'next dev'): object => ({
  name, scripts: { dev, build: 'next build' }, dependencies: { next: '^15.0.0' },
})
const KORTIX = "node a.mjs && NODE_OPTIONS='--max-old-space-size=4096' dotenvx run -- next dev --port ${WEB_PORT:-3000}"

function silence(): { out: () => string } {
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s)
    return true
  })
  return { out: () => out }
}
afterEach(() => vi.restoreAllMocks())

describe('rewriteScript', () => {
  it('rewrites only the bare next dev token', () => {
    expect(rewriteScript('next dev')).toBe('dozer next dev')
    expect(rewriteScript('next dev -p 3001')).toBe('dozer next dev -p 3001')
    expect(rewriteScript('a &&next dev ; b |next dev')).toBe('a &&dozer next dev ; b |dozer next dev')
    expect(rewriteScript('next dev;echo x')).toBe('dozer next dev;echo x')
    expect(rewriteScript('(next dev)')).toBe('(dozer next dev)')
    expect(rewriteScript('next dev&&x')).toBe('dozer next dev&&x')
    expect(rewriteScript('next dev|tee log')).toBe('dozer next dev|tee log')
    expect(rewriteScript('(next dev )')).toBe('(dozer next dev )')
    expect(rewriteScript('x -- next dev')).toBe('x -- dozer next dev')
    expect(rewriteScript('x --next dev')).toBe('x --dozer next dev')
  })
  it('leaves other commands and already-wrapped scripts alone', () => {
    for (const s of ['next build', 'next start', 'nextjs dev', 'my-next dev', 'dozer next dev', 'next developer', 'next devx']) {
      expect(rewriteScript(s)).toBe(s)
    }
  })
})

describe('planInit', () => {
  it('rewrites a Kortix-style script and leaves the rest alone', async () => {
    const root = make({ 'package.json': next('web', KORTIX) })
    const [c] = await planInit(root, '0.1.0')
    const after = JSON.parse(c!.after)
    expect(after.scripts.dev).toBe(
      "node a.mjs && NODE_OPTIONS='--max-old-space-size=4096' dotenvx run -- dozer next dev --port ${WEB_PORT:-3000}",
    )
    expect(after.scripts.build).toBe('next build')
    expect(after.devDependencies['next-dozer']).toBe('^0.1.0')
  })

  it('finds apps through pnpm-workspace.yaml, with comments, quotes and negation', async () => {
    const root = make({
      'pnpm-workspace.yaml': "# c\npackages:\n  - 'apps/*'\n  - \"packages/**\" # x\n  - !apps/docs\nother:\n  - nope/*\n",
      'package.json': { name: 'root' },
      'apps/web/package.json': next('web'),
      'apps/docs/package.json': next('docs'),
      'apps/blog/package.json': next('blog'),
      'packages/ui/package.json': { name: 'ui', dependencies: { react: '1' } },
      'nope/x/package.json': next('x'),
    })
    const changes = await planInit(root, '0.1.0')
    expect(files(changes)).toEqual(['apps/blog/package.json', 'apps/web/package.json'])
    expect(files(changes)).not.toContain('packages/ui/package.json')
  })

  it('reads column-0 and flow-style package lists', async () => {
    for (const yaml of ['packages:\n- "apps/*"\n', "packages: ['apps/*', packages/x]\n", 'packages: [apps/*]\nother: 1\n']) {
      const root = make({ 'pnpm-workspace.yaml': yaml, 'apps/web/package.json': next('web') })
      expect(files(await planInit(root, '0.1.0'))).toEqual(['apps/web/package.json'])
    }
  })

  it('fails loudly on an unreadable packages value', async () => {
    const root = make({ 'pnpm-workspace.yaml': 'packages: *anchor\n', 'apps/web/package.json': next('web') })
    await expect(planInit(root, '0.1.0')).rejects.toThrow('could not read packages from pnpm-workspace.yaml')
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await runInit([], {}, root)).toBe(1)
    expect(String(err.mock.calls[0]![0])).toBe('dozer: could not read packages from pnpm-workspace.yaml\n')
  })

  it('finds apps through npm workspaces (array and {packages})', async () => {
    for (const workspaces of [['apps/*'], { packages: ['apps/*'] }]) {
      const root = make({
        'package.json': { name: 'root', workspaces },
        'apps/web/package.json': next('web'),
        'apps/docs/package.json': next('docs'),
      })
      expect(files(await planInit(root, '0.1.0'))).toEqual(['apps/docs/package.json', 'apps/web/package.json'])
    }
  })

  it('handles dir/** and skips node_modules', async () => {
    const root = make({
      'package.json': { name: 'root', workspaces: ['apps/**'] },
      'apps/a/b/package.json': next('b'),
      'apps/node_modules/x/package.json': next('x'),
    })
    expect(files(await planInit(root, '0.1.0'))).toEqual(['apps/a/b/package.json'])
  })

  it('treats a lone Next app as a single-app repo', async () => {
    const root = make({ 'package.json': next('solo') })
    expect(files(await planInit(root, '0.1.0'))).toEqual(['package.json'])
  })

  it('keeps tab indentation, key order and trailing newline; adds devDependencies at the end', async () => {
    const original = '{\n\t"name": "web",\n\t"scripts": {\n\t\t"dev": "next dev"\n\t},\n\t"dependencies": {\n\t\t"next": "15"\n\t}\n}\n'
    const root = make({ 'package.json': original })
    const [c] = await planInit(root, '0.1.0')
    expect(c!.after).toBe(
      '{\n\t"name": "web",\n\t"scripts": {\n\t\t"dev": "dozer next dev"\n\t},\n\t"dependencies": {\n\t\t"next": "15"\n\t},\n\t"devDependencies": {\n\t\t"next-dozer": "^0.1.0"\n\t}\n}\n',
    )
  })

  it('preserves no trailing newline, 4-space indent and inserts devDependency in sorted place', async () => {
    const original = '{\n    "scripts": { "dev": "next dev" },\n    "devDependencies": {\n        "next": "15",\n        "zod": "3"\n    }\n}'
    const root = make({ 'package.json': original })
    const [c] = await planInit(root, '0.1.0')
    expect(c!.after).toBe(
      '{\n    "scripts": { "dev": "dozer next dev" },\n    "devDependencies": {\n        "next": "15",\n        "next-dozer": "^0.1.0",\n        "zod": "3"\n    }\n}',
    )
  })

  it('leaves an existing next-dozer dependency but still rewrites scripts', async () => {
    const root = make({ 'package.json': { ...next('w'), devDependencies: { 'next-dozer': '^0.0.9' } } })
    const [c] = await planInit(root, '0.1.0')
    expect(JSON.parse(c!.after).devDependencies['next-dozer']).toBe('^0.0.9')
    expect(JSON.parse(c!.after).scripts.dev).toBe('dozer next dev')
  })

  it('does nothing for an already-initialized app and skips packages without next', async () => {
    const root = make({
      'package.json': { name: 'r', workspaces: ['apps/*'] },
      'apps/a/package.json': { ...next('a', 'dozer next dev'), devDependencies: { 'next-dozer': '^0.1.0' } },
      'apps/b/package.json': { name: 'b', scripts: { dev: 'next dev' } },
    })
    expect(await planInit(root, '0.1.0')).toEqual([])
  })

  it('does not follow symlinks', async () => {
    const { symlinkSync } = await import('node:fs')
    const root = make({ 'package.json': { name: 'r', workspaces: ['apps/*'] }, 'real/package.json': next('real') })
    mkdirSync(join(root, 'apps'))
    symlinkSync(join(root, 'real'), join(root, 'apps/link'))
    expect(await planInit(root, '0.1.0')).toEqual([])
  })
})

describe('runInit', () => {
  const setup = (): string =>
    make({ 'package.json': { name: 'r', workspaces: ['apps/*'] }, 'apps/web/package.json': next('web', KORTIX) })

  it('writes nothing without --yes and prints a diff', async () => {
    const root = setup()
    const original = read(root, 'apps/web/package.json')
    const io = silence()
    expect(await runInit([], {}, root)).toBe(0)
    expect(read(root, 'apps/web/package.json')).toBe(original)
    expect(io.out()).toContain('--- apps/web/package.json')
    expect(io.out()).toContain('+++ apps/web/package.json')
    expect(io.out()).toContain('+     "dev": "node a.mjs')
    expect(io.out()).toContain('Run dozer init --yes to apply.')
  })

  it('writes with --yes and is idempotent', async () => {
    const root = setup()
    const io = silence()
    expect(await runInit(['--yes'], {}, root)).toBe(0)
    expect(io.out()).toContain("Run your package manager's install to finish.")
    expect(JSON.parse(read(root, 'apps/web/package.json')).devDependencies['next-dozer']).toMatch(/^\^\d/)
    expect(await planInit(root, '0.1.0')).toEqual([])
    const io2 = silence()
    expect(await runInit(['--yes'], {}, root)).toBe(0)
    expect(io2.out()).toContain('Nothing to change.')
  })

  it('leaves --experimental-https scripts unchanged and lists them as skipped', async () => {
    const root = make({
      'package.json': { name: 'r', workspaces: ['apps/*'] },
      'apps/web/package.json': { name: 'web', dependencies: { next: '^16.0.0' },
        scripts: { dev: 'next dev', 'dev:https': 'next dev --experimental-https -p 3443' } },
      'apps/tls/package.json': { name: 'tls', dependencies: { next: '^16.0.0' },
        scripts: { dev: 'next dev --experimental-https-key k.pem --experimental-https' } },
    })
    const tls = read(root, 'apps/tls/package.json')
    const io = silence()
    expect(await runInit(['--yes'], {}, root)).toBe(0)
    const web = JSON.parse(read(root, 'apps/web/package.json'))
    expect(web.scripts).toEqual({ dev: 'dozer next dev', 'dev:https': 'next dev --experimental-https -p 3443' })
    expect(read(root, 'apps/tls/package.json')).toBe(tls)
    expect(io.out()).toContain('Skipped apps/tls/package.json script "dev": --experimental-https is not supported yet.')
    expect(io.out()).toContain('Skipped apps/web/package.json script "dev:https": --experimental-https is not supported yet.')
    expect(io.out()).toContain('Updated 1 file.')
    expect(files(await planInit(root, '0.1.0'))).toEqual([])
  })

  it('rejects unknown arguments', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await runInit(['--bogus'], {}, setup())).toBe(1)
  })
})
