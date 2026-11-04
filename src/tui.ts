/** Optional dsh-tui client plugin. It never loads or shuts down a Runtime. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-harness-tui/dsh-tui/extensions'
import type {} from '@deepseek-harness-tui/dsh-tui/plugin-host'
import type {} from '@deepseek-harness-tui/dsh-tui/command-trees'
import type {} from '@deepseek-harness-tui/dsh-tui/scenes'
import type {} from '@deepseek-harness-tui/dsh-tui/panels'
import { ConductorTuiStore } from './tui/store.ts'
import { commandHelp, executeConductorCommand } from './tui/commands.ts'
import { conductorPanel, conductorScene } from './tui/views.ts'

export const name = 'dsh-conductor-tui'
export const inject = ['commands']
export const Config = s.object({ stateDir: s.string().required().description('Absolute daemon state directory; the TUI only reads its connection file.') })
export function apply(ctx: Context, config: ReturnType<typeof Config>): void {
  const store = new ConductorTuiStore(config.stateDir)
  ctx.effect(() => () => store.stop())
  // UI seams are optional. Entry-level inject in this bundle establishes ordering on dsh-tui.
  const scenes = ctx.get('tuiScenes'), panels = ctx.get('tuiPanels'), status = ctx.get('tuiStatus')
  if (scenes) ctx.effect(() => scenes.register({ id: 'conductor', title: 'DSH Conductor', component: conductorScene(store) }, ctx))
  if (panels) {
    const dispose = panels.register({ apiVersion: 1, id: 'tasks', title: 'Conductor tasks', component: conductorPanel(store) }, ctx)
    if (dispose) ctx.effect(() => dispose)
  }
  let clearStatus: (() => void) | undefined
  ctx.effect(() => store.subscribe(() => {
    const state = store.getSnapshot(), tasks = state.snapshot?.graphs.flatMap(graph => graph.tasks) ?? []
    clearStatus?.()
    clearStatus = status?.set('conductor', state.connected
      ? `Conductor: ${tasks.filter(task => task.status === 'running').length} running · ${tasks.filter(task => task.status === 'blocked').length} blocked`
      : 'Conductor: disconnected', ctx)
  }))
  ctx.effect(() => () => clearStatus?.())
  const definition = { name: 'conductor', description: 'Direct the background Host and manage its Worker tasks',
    recordInput: false,
    handler: async ({ rawInput }: { rawInput: string }) => {
      try {
        const input = rawInput.trim()
        if (!input || input === 'host') {
          if (scenes?.open('conductor')) return { kind: 'success' as const }
          return { kind: 'success' as const, text: await executeConductorCommand(store, 'host') + '\n' + commandHelp }
        }
        if (input === 'panel') {
          const id = panels?.list().find(panel => panel.id.endsWith(':tasks'))?.id
          return id && panels?.open(id)
            ? { kind: 'success' as const, text: 'Task panel requested. If hidden, widen the terminal and enable the panel and split view in /settings. /conductor tasks works at any width.' }
            : { kind: 'error' as const, text: 'Task panel is unavailable; use /conductor tasks.' }
        }
        return { kind: 'success' as const, text: await executeConductorCommand(store, input) }
      } catch (error) { return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) } }
    } }
  const host = ctx.get('tuiPluginHost')
  // Admitted Components use mediated registration; legacy hosts keep the official registry.
  ctx.effect(() => {
    if (!host) return ctx.commands.register(definition)
    try { return host.registerCommand(ctx, 'dsh.conductor', definition) }
    catch (error) {
      if ((error as { code?: string }).code !== 'COMPONENT_NOT_ADMITTED') throw error
      ctx.logger.info('Conductor: using the official DSH command registry (legacy bundle activation)')
      return ctx.commands.register(definition)
    }
  })
  const trees = ctx.get('tuiCommandTrees')
  if (trees) ctx.effect(() => trees.register({ root: 'conductor', children: path => path.length === 1
    ? ['host', 'status', 'tasks', 'workers', 'inspect', 'say', 'instruct', 'cancel', 'retry', 'panel', 'help'].map(name => ({ name, description: `Conductor ${name}` })) : [] }))
  void store.run().catch(error => { ctx.logger.warn('Conductor client: %s', String(error)) })
}
