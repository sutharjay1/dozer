import { describe, expect, it } from 'vitest'
import { parseDevArgs } from '../src/args.js'

describe('parseDevArgs', () => {
  it('defaults', () => {
    expect(parseDevArgs(['--turbopack'], {})).toEqual({ publicPort: 3000, portExplicit: false, hostname: null, passthrough: ['--turbopack'] })
  })
  it('-p / --port / --port=', () => {
    expect(parseDevArgs(['-p', '3100', 'apps/web'], {})).toMatchObject({ publicPort: 3100, portExplicit: true, passthrough: ['apps/web'] })
    expect(parseDevArgs(['--port', '3101'], {})).toMatchObject({ publicPort: 3101, portExplicit: true, passthrough: [] })
    expect(parseDevArgs(['--port=3200', '-H', '0.0.0.0'], {})).toMatchObject({ publicPort: 3200, hostname: '0.0.0.0', passthrough: [] })
  })
  it('hostname forms', () => {
    expect(parseDevArgs(['--hostname', 'a'], {}).hostname).toBe('a')
    expect(parseDevArgs(['--hostname=b'], {}).hostname).toBe('b')
  })
  it('preserves passthrough order', () => {
    expect(parseDevArgs(['--turbopack', '-p', '1', 'dir', '--inspect', '-H', 'h', '--x=1'], {}).passthrough)
      .toEqual(['--turbopack', 'dir', '--inspect', '--x=1'])
  })
  it('PORT env counts as explicit; flag beats it', () => {
    expect(parseDevArgs([], { PORT: '4000' })).toMatchObject({ publicPort: 4000, portExplicit: true })
    expect(parseDevArgs(['-p', '3100'], { PORT: '4000' })).toMatchObject({ publicPort: 3100, portExplicit: true })
  })
  it('rejects invalid ports', () => {
    expect(() => parseDevArgs(['-p', 'abc'], {})).toThrow(/port/i)
    expect(() => parseDevArgs(['-p'], {})).toThrow(/port/i)
  })
})
