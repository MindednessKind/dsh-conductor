/** DSH daemon adapter: process ownership is independent of every attached UI. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from './conductor/service.ts'
import { DaemonServer } from './conductor/server.ts'

export const name = 'dsh-conductor-daemon'
export const inject = ['conductor']
export const Config = s.object({ port: s.number().min(0).max(65535).step(1).default(0) })
export async function apply(ctx: Context, config: ReturnType<typeof Config>): Promise<void> {
  await ctx.conductor.ready
  const appExit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (!appExit) throw new Error('Conductor daemon requires a DSH launcher providing appExit')
  const server = new DaemonServer({ api: ctx.conductor, stateDir: ctx.conductor.stateDir, port: config.port,
    shutdown: () => { appExit(0) } })
  ctx.effect(() => () => server.close())
  const connection = await server.start()
  ctx.logger.info('DSH Conductor daemon ready at %s (pid %d)', connection.url, connection.pid)
}
