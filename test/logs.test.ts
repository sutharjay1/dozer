import { describe, expect, it } from 'vitest'
import { createLogRewriter, LogTail } from '../src/logs.js'

describe('createLogRewriter', () => {
  it('rewrites the hidden port to the public one', () => {
    const rw = createLogRewriter(54123, 3000)
    expect(rw('   - Local:        http://localhost:54123\n')).toBe('   - Local:        http://localhost:3000\n')
  })
  it('handles every loopback host form', () => {
    const rw = createLogRewriter(54123, 3000)
    expect(rw('127.0.0.1:54123 0.0.0.0:54123 [::1]:54123\n')).toBe('127.0.0.1:3000 0.0.0.0:3000 [::1]:3000\n')
  })
  it('rewrites a port split across chunks', () => {
    const rw = createLogRewriter(54123, 3000)
    expect(rw('http://localhost:541') + rw('23/a\n')).toBe('http://localhost:3000/a\n')
  })
  it('does not touch longer port numbers', () => {
    const rw = createLogRewriter(5412, 3000)
    expect(rw('localhost:54123\n')).toBe('localhost:54123\n')
  })
  it('only rewrites whole hosts', () => {
    const rw = createLogRewriter(54123, 3000)
    expect(rw('10.0.0.0:54123 notlocalhost:54123\n')).toBe('10.0.0.0:54123 notlocalhost:54123\n')
  })
  it('flush returns the held tail', () => {
    const rw = createLogRewriter(54123, 3000)
    expect(rw('at localhost:54123')).toBe('')
    expect(rw.flush()).toBe('at localhost:3000')
    expect(rw.flush()).toBe('')
  })
})

describe('LogTail', () => {
  it('keeps the last N lines', () => {
    const t = new LogTail(2)
    t.push('a\nb\nc\n')
    expect(t.lines()).toEqual(['b', 'c'])
  })
  it('includes a trailing partial line', () => {
    const t = new LogTail(5)
    t.push('a\nb')
    expect(t.lines()).toEqual(['a', 'b'])
  })
})
