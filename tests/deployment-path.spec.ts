import { describe, expect, it } from 'vitest'
import { Config, machineOf } from '../src/deployment.ts'

describe('state directory paths', () => {
  it('accepts an absolute path native to the runtime platform', () => {
    const stateDir = process.platform === 'win32' ? 'D:/dsh/state/superagent' : '/tmp/dsh/state/superagent'
    expect(machineOf(Config({ stateDir })).stateDir).toBe(stateDir)
  })

  it('rejects relative paths and absolute paths from another platform', () => {
    const foreign = process.platform === 'win32' ? '/tmp/dsh/state' : 'D:/dsh/state'
    expect(() => Config({ stateDir: 'relative/state' })).toThrow()
    expect(() => Config({ stateDir: foreign })).toThrow()
  })
})
