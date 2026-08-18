/** Application-owned parsing of arguments handed through dsh cmdlineArgs. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'

export interface TuiLaunchOptions {
  readonly server: boolean
  readonly host: string
  readonly port: number
  readonly resume?: string
  readonly prompt: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context { tuiLaunch: TuiLaunchRuntime }
}

export const name = 'dsh-tui-launch'

export class TuiLaunchRuntime extends Service implements TuiLaunchOptions {
  readonly server: boolean
  readonly host: string
  readonly port: number
  readonly resume?: string
  readonly prompt: readonly string[]

  constructor(ctx: Context, options: TuiLaunchOptions) {
    super(ctx, 'tuiLaunch')
    this.server = options.server
    this.host = options.host
    this.port = options.port
    this.resume = options.resume
    this.prompt = options.prompt
  }
}

export function apply(ctx: Context): void {
  new TuiLaunchRuntime(ctx, parseTuiLaunchArgs(ctx.get('cmdlineArgs')?.get() ?? []))
}

export function parseTuiLaunchArgs(args: readonly string[]): TuiLaunchOptions {
  let server = false
  let host = '127.0.0.1'
  let port = 10721
  let resume: string | undefined
  const prompt: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--server') { server = true; continue }
    if (arg === '--host') { host = nextValue(args, ++index, '--host'); continue }
    if (arg.startsWith('--host=')) { host = arg.slice('--host='.length); continue }
    if (arg === '--port') { port = portValue(nextValue(args, ++index, '--port')); continue }
    if (arg.startsWith('--port=')) { port = portValue(arg.slice('--port='.length)); continue }
    if (arg === '--resume') { resume = nextValue(args, ++index, '--resume'); continue }
    if (arg.startsWith('--resume=')) { resume = arg.slice('--resume='.length); continue }
    if (arg === '--') { prompt.push(...args.slice(index + 1)); break }
    if (arg === '-h' || arg === '--help') continue
    if (arg.startsWith('-')) throw new Error(`dsh-tui: unknown option ${JSON.stringify(arg)}`)
    prompt.push(arg)
  }
  if (host.trim() === '') throw new Error('dsh-tui: --host must not be empty')
  if (resume !== undefined && resume.trim() === '') throw new Error('dsh-tui: --resume must not be empty')
  if (server && (resume !== undefined || prompt.length > 0)) {
    throw new Error('dsh-tui: --server cannot be combined with --resume or an initial prompt')
  }
  return Object.freeze({ server, host, port, ...(resume === undefined ? {} : { resume }), prompt: Object.freeze(prompt) })
}

function nextValue(args: readonly string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('-')) throw new Error(`dsh-tui: ${option} requires a value`)
  return value
}

function portValue(value: string): number {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('dsh-tui: --port must be an integer from 1 to 65535')
  return port
}

export default apply
