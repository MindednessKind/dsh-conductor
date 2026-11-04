/** Terminal UI built exclusively with the React and components supplied by dsh-tui. */
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import type { TuiPanelProps } from '@deepseek-harness-tui/dsh-tui/panels'
import type { ConductorTuiStore } from './store.ts'
import { commandHelp, executeConductorCommand } from './commands.ts'
import stringWidth from 'string-width'

const clean = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = '', cells = 0
  for (const { segment } of segments.segment(text)) {
    const size = stringWidth(segment)
    if (cells + size > width && line) { lines.push(line); line = ''; cells = 0 }
    line += segment; cells += size
  }
  lines.push(line)
  return lines
}
export function conductorScene(store: ConductorTuiStore): (props: TuiSceneProps) => ReturnType<TuiSceneProps['React']['createElement']> {
  return function ConductorScene({ React, ui, close }: TuiSceneProps) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const [draft, setDraft] = React.useState(''), [output, setOutput] = React.useState(''), [busy, setBusy] = React.useState(false)
    const [offset, setOffset] = React.useState(0)
    const inFlight = React.useRef(false)
    const { columns, rows } = ui.useTerminalSize()
    const snapshot = state.snapshot
    const transcript = snapshot?.host.conversation.map(entry => `${entry.role === 'user' ? 'You' : 'Host'}: ${clean(entry.text)}`).join('\n\n') ?? ''
    const available = Math.max(3, rows - 9), width = Math.max(10, columns - 4)
    const lines = clean(output || transcript || 'Type an instruction for the background Host. /tasks and /workers show execution state.').split('\n').flatMap(line => wrap(line, width))
    const start = Math.max(0, lines.length - available - offset)
    ui.useInput((input, key) => {
      if (key.escape) { close(); return }
      if (key.pageUp) { setOffset(value => Math.min(lines.length, value + available)); return }
      if (key.pageDown) { setOffset(value => Math.max(0, value - available)); return }
      if (key.ctrl || key.meta) return
      if (key.return) {
        if (inFlight.current || !draft.trim()) return
        const text = draft.trim(); inFlight.current = true; setBusy(true); setDraft(''); setOffset(0)
        const operation = text === '/help' ? Promise.resolve(commandHelp)
          : text.startsWith('/') ? executeConductorCommand(store, text.slice(1))
          : store.say(text).then(() => '')
        void operation.then(setOutput, error => setOutput(`Error: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => { inFlight.current = false; setBusy(false) })
        return
      }
      if (key.backspace || key.delete) { setDraft(value => Array.from(value).slice(0, -1).join('')); return }
      if (!key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) setDraft(value => (value + clean(input)).slice(0, 20_000))
    })
    const h = React.createElement
    return h(ui.Box, { flexDirection: 'column', height: Math.max(10, rows - 1), paddingX: 1 },
      h(ui.Text, { bold: true }, 'DSH Conductor · Background Host'),
      h(ui.Text, { dimColor: !state.connected }, clean(state.error ?? `${snapshot?.host.sessionId ?? 'Connecting…'} · ${snapshot?.host.status ?? 'starting'}`)),
      h(ui.Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' }, h(ui.Text, null, lines.slice(start, start + available).join('\n'))),
      h(ui.Text, { dimColor: true }, `${snapshot?.graphs.length ?? 0} task graphs · ${snapshot?.workers.length ?? 0} worker roles · PgUp/PgDn history`),
      h(ui.Text, { dimColor: true }, '/tasks /workers /inspect /instruct /cancel /retry /help · Esc detach'),
      h(ui.Text, { bold: true }, `${busy ? 'Sending…' : 'Host >'} ${wrap(draft, Math.max(1, width - 10)).at(-1) ?? ''}`))
  }
}
export function conductorPanel(store: ConductorTuiStore): (props: TuiPanelProps) => ReturnType<TuiPanelProps['React']['createElement']> {
  return function ConductorPanel({ React, ui }: TuiPanelProps) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot), h = React.createElement
    const tasks = state.snapshot?.graphs.flatMap(graph => graph.tasks.map(task => `${task.status} · ${task.worker}\n${task.title}`)) ?? []
    return h(ui.Box, { flexDirection: 'column' }, h(ui.Text, { bold: true }, 'Conductor'),
      h(ui.Text, null, clean(state.connected ? `Host: ${state.snapshot?.host.status}` : state.error ?? 'Connecting…')),
      h(ui.Text, null, clean(tasks.join('\n\n') || 'No tasks yet. /conductor opens Host.')))
  }
}
