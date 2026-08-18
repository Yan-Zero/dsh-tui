/** Built-in direct HTTP backend for connecting one dsh-tui to another. */

import type { Context } from '@deepseek-ai/cordis'
import type { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import type { StandardConnection } from '@dsh-std/connection'
import { connectTuiChannelHttp } from './channel-http.js'
import { mountTuiChannelConsumer, openRemoteTuiChannel, tuiConnectionEndpoint, type TuiChannelParticipantBinding } from './channel-connection.js'
import {
  TuiBackendChannelSwitch,
  type TuiBackendAdapter,
  type TuiBackendCommandRequest,
  type TuiBackendHost,
  type TuiBackendProvider,
  type TuiBackendRuntime,
} from '../tui-runtime/backends.js'
import type { Channel } from '../tui-contract/channel.js'
import type { TuiLaunchRuntime } from '../dsh-adapter/launch.js'

export const name = 'dsh-tui-direct-backend'
export const inject = ['tuiBackends', 'dshStd', 'tuiLaunch']

export async function apply(ctx: Context): Promise<void> {
  if ((ctx.tuiLaunch as TuiLaunchRuntime).server) return
  const backend = new DirectTuiBackend(ctx.dshStd as DshStandardAdapter)
  const unregister = (ctx.tuiBackends as TuiBackendRuntime).register(backend)
  ctx.effect(() => async () => {
    unregister()
    await backend.dispose()
  }, 'dsh-tui direct HTTP backend')
}

export class DirectTuiBackend implements TuiBackendProvider {
  readonly id = 'dsh-tui-direct'
  private host: TuiBackendHost | undefined
  private switched: TuiBackendChannelSwitch | undefined
  private consumer: Promise<TuiChannelParticipantBinding> | undefined
  private active: { readonly remote: { dispose(): Promise<void> }; readonly connection: StandardConnection } | undefined
  private pending: {
    readonly address: string
    readonly controller: AbortController
    connection?: StandardConnection
  } | undefined

  constructor(private readonly adapter: DshStandardAdapter) {}

  attach(host: TuiBackendHost): TuiBackendAdapter {
    if (this.host !== undefined) throw new Error('dsh-tui direct backend was attached more than once')
    this.host = host
    this.switched = new TuiBackendChannelSwitch(host.channel)
    return {
      channel: this.switched.proxy,
      handleCommand: request => this.handleCommand(request),
      dispose: () => this.detach(),
    }
  }

  async dispose(): Promise<void> {
    await this.detach()
    const consumer = this.consumer
    this.consumer = undefined
    if (consumer !== undefined) await (await consumer).dispose()
  }

  private handleCommand(request: TuiBackendCommandRequest): boolean {
    if (request.name === 'disconnect' && (this.active !== undefined || this.pending !== undefined)) {
      void this.disconnect().then(() => request.channel.notify('Disconnected.', { timeoutMs: 2500 }), error => {
        request.channel.notify(message(error), { color: 'error', timeoutMs: 8000 })
      })
      return true
    }
    if (request.name !== 'connect') return false
    const address = request.input.trim()
    // `ssh ...` belongs to an SSH connector when one is installed.
    if (/^(?:ssh|plink)(?:\.exe)?\s/iu.test(address)) return false
    if (address === '') {
      request.channel.pushLocal('/connect', ['Usage: /connect <host[:port] | http[s]://host[:port]>'])
      return true
    }
    if (this.pending !== undefined) {
      request.channel.notify(`Already connecting to ${this.pending.address}.`, { color: 'warning', timeoutMs: 3000 })
      return true
    }
    void this.connect(address, request.channel).catch(error => {
      request.channel.notify(message(error), { color: 'error', timeoutMs: 8000 })
    })
    return true
  }

  private async connect(address: string, visible: Channel): Promise<void> {
    if (this.active !== undefined) throw new Error('A remote dsh-tui is already connected; use /disconnect first.')
    if (this.pending !== undefined) throw new Error(`Already connecting to ${this.pending.address}.`)
    const host = this.host
    const switched = this.switched
    if (host === undefined || switched === undefined) throw new Error('dsh-tui backend is not attached')
    const pending = { address, controller: new AbortController() } as {
      address: string
      controller: AbortController
      connection?: StandardConnection
    }
    this.pending = pending
    switched.switchTo(connectingCommands(host.channel, address))
    visible.notify(`Connecting to ${address}…`, { timeoutMs: 3000 })
    try {
      const consumer = await (this.consumer ??= mountTuiChannelConsumer(this.adapter))
      pending.controller.signal.throwIfAborted()
      const endpoint = tuiConnectionEndpoint(this.adapter.connectionEndpoint)
      const connection = await connectTuiChannelHttp(address, endpoint, this.adapter.protocols, pending.controller.signal)
      pending.connection = connection
      if (this.pending !== pending) {
        await connection.close('TUI connection was cancelled')
        return
      }
      const remote = await openRemoteTuiChannel(connection, endpoint.participantId(consumer.participantId), {
        terminalChannel: host.channel,
        onDisconnect: error => this.connectionLost(connection, error),
        signal: pending.controller.signal,
        options: {
          locale: host.locale(),
          activity: host.channel.activityEnabled,
          ...(host.channel.activityFrames === undefined ? {} : { activityFrames: host.channel.activityFrames }),
          contextBar: host.channel.contextBarEnabled,
        },
      })
      if (this.pending !== pending) {
        await remote.dispose()
        await connection.close('TUI connection was cancelled')
        return
      }
      const connected = connectedCommands(remote.channel, host.channel)
      this.pending = undefined
      this.active = { remote, connection }
      switched.switchTo(connected)
      connected.notify(`Connected to ${address}.`, { color: 'success', timeoutMs: 3000 })
    } catch (error) {
      if (this.pending === pending) {
        this.pending = undefined
        switched.restore()
      }
      await pending.connection?.close('TUI Channel open failed')
      if (pending.controller.signal.aborted) return
      throw error
    }
  }

  private async disconnect(): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    const active = this.active
    this.active = undefined
    this.switched?.restore()
    if (pending !== undefined) {
      pending.controller.abort(new Error('TUI connection cancelled by user'))
      await pending.connection?.close('TUI client cancelled connection')
    }
    if (active === undefined) return
    await active.remote.dispose()
    await active.connection.close('TUI client disconnected')
  }

  private connectionLost(connection: StandardConnection, error: unknown): void {
    if (this.active?.connection !== connection) return
    this.active = undefined
    this.switched?.restore()
    connection.close('TUI transport disconnected')
    this.host?.channel.notify(`Remote dsh-tui disconnected: ${message(error)}`, { color: 'error', timeoutMs: 8000 })
  }

  private async detach(): Promise<void> {
    await this.disconnect()
    this.switched?.dispose()
    this.switched = undefined
    this.host = undefined
  }
}

function connectingCommands(channel: Channel, address: string): Channel {
  const disconnect = { name: 'disconnect', description: `Cancel connection to ${address}` }
  return new Proxy(channel, {
    get(target, property, receiver) {
      if (property === 'commandList') {
        return [...target.commandList.filter(command => command.name !== 'connect' && command.name !== 'disconnect'), disconnect]
      }
      if (property === 'commandCompletions') return (input: string) => {
        const local = target.commandCompletions(input).filter(row => row.name !== 'connect' && row.name !== 'disconnect')
        const query = input.startsWith('/') ? input.slice(1).trim().toLowerCase() : ''
        return 'disconnect'.startsWith(query) ? [...local, { ...disconnect, replacement: '/disconnect ', commandLine: '/disconnect' }] : local
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

function connectedCommands(remote: Channel, terminal: Channel): Channel {
  const disconnect = { name: 'disconnect', description: 'Disconnect from the remote dsh-tui' }
  return new Proxy(remote, {
    get(target, property, receiver) {
      if (property === 'commandList') {
        const list = target.commandList.filter(command => command.name !== 'connect' && command.name !== 'disconnect')
        return [...list, disconnect]
      }
      if (property === 'commandCompletions') return (input: string) => {
        const local = target.commandCompletions(input).filter(row => row.name !== 'connect' && row.name !== 'disconnect')
        const query = input.startsWith('/') ? input.slice(1).trim().toLowerCase() : ''
        return 'disconnect'.startsWith(query) ? [...local, { ...disconnect, replacement: '/disconnect ', commandLine: '/disconnect' }] : local
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export default apply
