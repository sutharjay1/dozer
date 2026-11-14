import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { identify } from '../src/identity.js'

let root: string
let mainApp: string
let worktreeApp: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, stdio: 'ignore' })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'napdev-identity-'))
  const repo = join(root, 'myrepo')
  mainApp = join(repo, 'apps', 'web')
  mkdirSync(mainApp, { recursive: true })
  writeFileSync(join(mainApp, 'package.json'), JSON.stringify({ name: 'web' }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature-x', join(root, 'wt-feature'))
  worktreeApp = join(root, 'wt-feature', 'apps', 'web')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('identify', () => {
  it('names the app by repo, package name and branch', async () => {
    expect((await identify(mainApp)).name).toBe('myrepo/web @ main')
  })

  it('a linked worktree shares the repo name but not the id', async () => {
    expect((await identify(worktreeApp)).name).toBe('myrepo/web @ feature-x')
    expect((await identify(worktreeApp)).id).not.toBe((await identify(mainApp)).id)
  })

  it('id is the first 12 hex chars of the SHA-1 of the real path', async () => {
    const want = createHash('sha1').update(realpathSync(mainApp)).digest('hex').slice(0, 12)
    expect((await identify(mainApp)).id).toBe(want)
  })

  it('a detached HEAD uses the short commit', async () => {
    const wt = join(root, 'wt-detached')
    git(mainApp, 'worktree', 'add', '-q', '--detach', wt)
    const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim()
    const id = await identify(join(wt, 'apps', 'web'))
    expect(id.branch).toBe(short)
    expect(id.repo).toBe('myrepo')
  })

  it('outside git uses the directory name and "-"', async () => {
    const dir = join(root, 'loose-app')
    mkdirSync(dir)
    const id = await identify(dir)
    expect(id).toMatchObject({ repo: 'loose-app', app: 'loose-app', branch: '-', name: 'loose-app/loose-app @ -' })
  })
})
