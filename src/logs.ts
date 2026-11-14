export interface LogRewriter {
  (text: string): string
  /** Returns the held-back unterminated tail (rewritten) and clears it. Call on child exit. */
  flush(): string
}

export function createLogRewriter(hiddenPort: number, publicPort: number): LogRewriter {
  const re = new RegExp(`(?<![\\w.-])(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):${hiddenPort}(?!\\d)`, 'g')
  const sub = (s: string) => s.replace(re, `$1:${publicPort}`)
  let held = ''
  const rw = ((text: string): string => {
    const all = held + text
    const cut = all.lastIndexOf('\n')
    if (cut < 0) {
      held = all
      return ''
    }
    held = all.slice(cut + 1)
    return sub(all.slice(0, cut + 1))
  }) as LogRewriter
  rw.flush = () => {
    const out = sub(held)
    held = ''
    return out
  }
  return rw
}

export class LogTail {
  private buf: string[] = []
  private partial = ''
  constructor(private maxLines = 40) {}
  push(text: string): void {
    const parts = (this.partial + text).split('\n')
    this.partial = parts.pop() ?? ''
    this.buf.push(...parts)
    if (this.buf.length > this.maxLines) this.buf.splice(0, this.buf.length - this.maxLines)
  }
  lines(): string[] {
    return this.partial ? [...this.buf, this.partial].slice(-this.maxLines) : [...this.buf]
  }
}
