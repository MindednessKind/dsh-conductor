#!/usr/bin/env node
/** Cross-platform daemon process manager; the terminal never owns the running host. */
import { spawn } from 'node:child_process'
import { existsSync, openSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { ConductorClient } from './conductor/client.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'state-dir': { type: 'string' }, profile: { type: 'string', default: 'conductor' }, 'dsh-bin': { type: 'string' },
  workers: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} })
const usage = `DSH Conductor
  dsh-conductor init --state-dir <absolute directory> [--profile conductor] [--workers <JSON file>]
  dsh-conductor start|status|stop --state-dir <directory> [--profile conductor]
  dsh-conductor say --state-dir <directory> "instruction for Host"
  dsh-conductor tasks --state-dir <directory>

init creates a NEW daemon profile. start detaches the DSH process; closing this terminal or TUI leaves it running.
stop explicitly shuts down Host and Workers. Logs: <state-dir>/daemon.log.
--dsh-bin accepts the absolute path to DSH's JavaScript CLI entry.`

function dshBin(): string {
  if (values['dsh-bin']) {
    const path = resolve(values['dsh-bin'])
    if (!existsSync(path)) throw new Error(`DSH entry does not exist: ${path}`)
    return path
  }
  try { return join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js') } catch { /* Global install. */ }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const root of [join(directory, 'node_modules/@deepseek-ai/dsh'), join(directory, '../lib/node_modules/@deepseek-ai/dsh')]) {
      const candidate = resolve(root, 'lib/bin.js')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('Cannot locate DSH; install it or pass --dsh-bin <path to dsh/lib/bin.js>')
}
async function run(): Promise<void> {
  if (values.help || !positionals[0]) { process.stdout.write(usage + '\n'); return }
  const command = positionals[0], stateDir = values['state-dir']
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('--state-dir must be an absolute path')
  const profile = values.profile!
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error('Invalid profile name')
  if (command === 'init') {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const profileDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile)
    if (existsSync(profileDir)) throw new Error(`Profile already exists: ${profileDir}; use another name`)
    const bin = dshBin()
    await mkdir(profileDir, { recursive: true })
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const workerPath = join(stateDir, 'workers.json')
    if (!existsSync(workerPath)) {
      const workers = await readFile(values.workers ? resolve(values.workers) : join(root, 'examples/workers.coding.json'), 'utf8')
      const { WorkerConfigSchema } = await import('./tasks/workers.ts')
      WorkerConfigSchema.parse(JSON.parse(workers))
      await writeFile(workerPath, workers, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}`, private: true,
      dependencies: { 'dsh-conductor': `link:${root.replaceAll('\\', '/')}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-conductor'] } } }, null, 2) + '\n', { flag: 'wx' })
    await writeFile(join(profileDir, 'cordis.patch.yml'), `- id: dsh-conductor\n  config:\n    stateDir: ${JSON.stringify(stateDir.replaceAll('\\', '/'))}\n- id: dsh-conductor-daemon\n  disabled: false\n`, { flag: 'wx' })
    const install = spawn(process.execPath, [bin, 'plugin', '--profile', profile, 'install'], { stdio: 'inherit', windowsHide: true })
    const code = await new Promise<number | null>((resolve, reject) => { install.once('error', reject); install.once('exit', resolve) })
    if (code !== 0) throw new Error(`Profile dependency installation failed (${code}); rerun dsh plugin --profile ${profile} install`)
    process.stdout.write(`Created profile ${profile}. Configure its model/provider, review ${workerPath}, then run start.\n`)
    return
  }
  const connect = () => ConductorClient.connect(stateDir)
  if (command === 'start') {
    const existing = await connect().then(async client => { await client.state(); return client }).catch(() => undefined)
    if (existing) { process.stdout.write(`Conductor already running (pid ${existing.connection.pid})\n`); return }
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const log = openSync(join(stateDir, 'daemon.log'), 'a', 0o600)
    let launchError: Error | undefined
    const child = spawn(process.execPath, [dshBin(), '--profile', profile], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true,
    })
    child.once('error', error => { launchError = error })
    child.unref(); closeSync(log)
    for (let attempt = 0; attempt < 120; attempt++) {
      if (launchError) throw launchError
      const client = await connect().catch(() => undefined)
      if (client && client.connection.pid === child.pid) {
        try { await client.state(); process.stdout.write(`Conductor running (pid ${client.connection.pid}); ${client.connection.url}\n`); return } catch { /* Still starting. */ }
      }
      await delay(250)
    }
    throw new Error(`Daemon has not become ready; inspect ${join(stateDir, 'daemon.log')}. Do not start another copy before checking its process.`)
  }
  const client = await connect()
  if (command === 'status') {
    const state = await client.state()
    process.stdout.write(JSON.stringify({ pid: client.connection.pid, url: client.connection.url, host: state.host.sessionId,
      status: state.host.status, workers: state.workers.length, graphs: state.graphs.length, health: state.health }, null, 2) + '\n')
  } else if (command === 'stop') {
    await client.stop()
    for (let attempt = 0; attempt < 120; attempt++) {
      const alive = await client.state(AbortSignal.timeout(500)).then(() => true).catch(() => false)
      const discovery = await readFile(join(stateDir, 'conductor-daemon.json'), 'utf8').catch(() => '')
      if (!alive && (!discovery || !discovery.includes(client.connection.instanceId))) { process.stdout.write('Conductor stopped.\n'); return }
      await delay(250)
    }
    throw new Error('Shutdown is still in progress; check daemon.log')
  } else if (command === 'say') {
    const text = positionals.slice(1).join(' ')
    if (!text.trim()) throw new Error('say requires an instruction')
    process.stdout.write(JSON.stringify(await client.act({ type: 'host.say', requestId: randomUUID(), text })) + '\n')
  } else if (command === 'tasks') process.stdout.write(JSON.stringify((await client.state()).graphs, null, 2) + '\n')
  else throw new Error(`Unknown command: ${command}\n${usage}`)
}
await run().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1 })
