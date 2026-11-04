/** Optional legacy Web management adapter; the core has no HTTP dependency. */
import type { Context } from '@deepseek-ai/cordis'
import { registerHttp } from './app/http.ts'

export const name = 'dsh-conductor-web'
export const inject = ['orchestrator', 'webServer']
export function apply(ctx: Context): void {
  // This adapter owns the legacy Source management surface; new clients use conductor.
  const runtime = ctx.orchestrator as typeof ctx.orchestrator & { management(): import('./app/http.ts').HttpHost }
  ctx.effect(() => registerHttp(ctx, runtime.management()))
}
