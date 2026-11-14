import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface Identity { id: string; name: string; repo: string; app: string; branch: string }

function git(cwd: string, ...args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd }, (err, out) => done(err ? null : out.trim() || null))
  })
}

function packageName(appDir: string): string | null {
  try {
    const name = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))?.name
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}

export async function identify(appDir: string): Promise<Identity> {
  const real = realpathSync(appDir)
  const app = packageName(real) ?? basename(real)
  let repo = basename(real)
  let branch = '-'
  const top = await git(real, 'rev-parse', '--show-toplevel')
  if (top !== null) {
    // the common dir is shared by every worktree, so they all get the same repo name
    const common = await git(real, 'rev-parse', '--git-common-dir')
    repo = basename(common ? dirname(resolve(real, common)) : top)
    const ref = await git(real, 'rev-parse', '--abbrev-ref', 'HEAD')
    branch = (ref && ref !== 'HEAD' ? ref : await git(real, 'rev-parse', '--short', 'HEAD')) ?? '-'
  }
  const id = createHash('sha1').update(real).digest('hex').slice(0, 12)
  return { id, name: `${repo}/${app} @ ${branch}`, repo, app, branch }
}
