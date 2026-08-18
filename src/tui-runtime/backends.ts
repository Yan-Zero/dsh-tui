/** Optional backend composition for the terminal surface. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Channel } from '../tui-contract/channel.js'
import type { ApprovalStore } from '../dsh-adapter/approvals.js'
import type { QuestionStore } from '../dsh-adapter/questions.js'
import type { WorkspaceCommandResult } from './workspaces.js'
import type { Lang } from '../i18n.js'

export interface TuiBackendHost {
  /** Channel produced by the preceding provider, initially the local DSH adapter. */
  channel: Channel
  /** Invocation-scoped presentation owned by the visible terminal. */
  askQuestions: QuestionStore['ask']
  requestApproval: ApprovalStore['parkExternal']
  locale(): Lang
}

export interface TuiBackendCommandRequest {
  channel: Channel
  name: string
  input: string
  present(result: WorkspaceCommandResult): void
}

export interface TuiBackendAdapter {
  channel?: Channel
  handleCommand?(request: TuiBackendCommandRequest): boolean
  dispose?(): void | Promise<void>
}

export interface TuiBackendProvider {
  readonly id: string
  attach(host: TuiBackendHost): TuiBackendAdapter | Promise<TuiBackendAdapter>
}

export interface TuiBackendBinding {
  readonly channel: Channel
  handleCommand(request: TuiBackendCommandRequest): boolean
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiBackends: TuiBackendRuntime
  }
}

export const name = 'dsh-tui-backends'

/**
 * Product-owned backend registry. With no providers it is an identity layer;
 * the ordinary local TUI does not know that a remote connector may exist.
 */
export class TuiBackendRuntime extends Service {
  private readonly providers = new Map<string, TuiBackendProvider>()
  private readonly bindings = new Set<LiveBackendBinding>()

  constructor(ctx: Context) {
    super(ctx, 'tuiBackends')
  }

  register(provider: TuiBackendProvider): () => void {
    const id = provider.id.trim()
    if (id === '') throw new TypeError('TUI backend provider id must not be empty')
    if (this.providers.has(id)) throw new Error(`TUI backend provider ${JSON.stringify(id)} is already registered`)
    this.providers.set(id, provider)
    this.refreshBindings()
    return () => {
      if (this.providers.get(id) !== provider) return
      this.providers.delete(id)
      this.refreshBindings()
    }
  }

  async bind(host: TuiBackendHost): Promise<TuiBackendBinding> {
    const binding = new LiveBackendBinding(host, () => [...this.providers.values()], () => {
      this.bindings.delete(binding)
    })
    this.bindings.add(binding)
    await binding.refresh()
    return binding
  }

  private refreshBindings(): void {
    for (const binding of this.bindings) {
      void binding.refresh().catch(error => {
        this.ctx.logger.warn(`dsh-tui: backend refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
}

class LiveBackendBinding implements TuiBackendBinding {
  readonly channel: Channel
  private readonly slot: TuiBackendChannelSwitch
  private adapters: TuiBackendAdapter[] = []
  private refreshQueue = Promise.resolve()
  private disposed = false

  constructor(
    private readonly host: TuiBackendHost,
    private readonly providers: () => readonly TuiBackendProvider[],
    private readonly onDispose: () => void,
  ) {
    this.slot = new TuiBackendChannelSwitch(host.channel)
    this.channel = this.slot.proxy
  }

  handleCommand(request: TuiBackendCommandRequest): boolean {
    for (let index = this.adapters.length - 1; index >= 0; index -= 1) {
      if (this.adapters[index]?.handleCommand?.(request) === true) return true
    }
    return false
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const task = this.refreshQueue.then(() => this.rebuild())
    this.refreshQueue = task.catch(() => undefined)
    return task
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.onDispose()
    await this.refreshQueue
    await disposeAdapters(this.adapters)
    this.adapters = []
    this.slot.dispose()
  }

  private async rebuild(): Promise<void> {
    if (this.disposed) return
    this.slot.switchTo(this.host.channel)
    await disposeAdapters(this.adapters)
    this.adapters = []
    let channel = this.host.channel
    const next: TuiBackendAdapter[] = []
    try {
      for (const provider of this.providers()) {
        const adapter = await provider.attach({ ...this.host, channel })
        channel = adapter.channel ?? channel
        next.push(adapter)
      }
    } catch (error) {
      await disposeAdapters(next)
      throw error
    }
    if (this.disposed) {
      await disposeAdapters(next)
      return
    }
    this.adapters = next
    this.slot.switchTo(channel)
  }
}

/** Identity-stable Channel facade for a backend that connects and disconnects at runtime. */
export class TuiBackendChannelSwitch {
  readonly proxy: Channel
  private readonly listeners = new Set<() => void>()
  private readonly settingsSectionListeners = new Set<() => void>()
  private readonly methods = new Map<PropertyKey, (...args: unknown[]) => unknown>()
  private unsubscribe: (() => void) | undefined
  private unsubscribeSettingsSections: (() => void) | undefined
  private viewVersion: number

  constructor(readonly base: Channel, private delegate: Channel = base) {
    this.viewVersion = base.version
    const subscribe = (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    }
    const subscribeSettingsSections = (listener: () => void): (() => void) => {
      this.settingsSectionListeners.add(listener)
      return () => { this.settingsSectionListeners.delete(listener) }
    }
    this.proxy = new Proxy({} as Channel, {
      get: (_target, property) => {
        if (property === 'subscribe') return subscribe
        if (property === 'subscribeSettingsSections') return subscribeSettingsSections
        // A backend swap is itself a visible state change. Delegates can
        // legitimately have the same version number, so exposing theirs
        // would let useSyncExternalStore discard the switch notification.
        if (property === 'version') return this.viewVersion
        const value = Reflect.get(this.delegate, property, this.delegate) as unknown
        if (typeof value !== 'function') return value
        let method = this.methods.get(property)
        if (method === undefined) {
          method = (...args: unknown[]) => {
            const current = Reflect.get(this.delegate, property, this.delegate) as unknown
            if (typeof current !== 'function') throw new TypeError(`Channel member ${String(property)} is not callable`)
            return Reflect.apply(current, this.delegate, args) as unknown
          }
          this.methods.set(property, method)
        }
        return method
      },
      set: (_target, property, value) => Reflect.set(this.delegate, property, value, this.delegate),
      has: (_target, property) => property in this.delegate,
      ownKeys: () => Reflect.ownKeys(this.delegate),
      getOwnPropertyDescriptor: (_target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(this.delegate, property)
        return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
      },
    })
    this.bind()
  }

  switchTo(delegate: Channel): void {
    if (this.delegate === delegate) return
    this.unsubscribe?.()
    this.unsubscribeSettingsSections?.()
    this.delegate = delegate
    this.methods.clear()
    this.bind()
    this.emit()
    this.emitSettingsSections()
  }

  restore(): void { this.switchTo(this.base) }

  get current(): Channel { return this.delegate }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribeSettingsSections?.()
    this.unsubscribe = undefined
    this.unsubscribeSettingsSections = undefined
    this.listeners.clear()
    this.settingsSectionListeners.clear()
    this.methods.clear()
  }

  private bind(): void {
    this.unsubscribe = this.delegate.subscribe(() => this.emit())
    this.unsubscribeSettingsSections = this.delegate.subscribeSettingsSections(() => this.emitSettingsSections())
  }

  private emit(): void {
    this.viewVersion += 1
    for (const listener of this.listeners) listener()
  }

  private emitSettingsSections(): void {
    for (const listener of this.settingsSectionListeners) listener()
  }
}

async function disposeAdapters(adapters: readonly TuiBackendAdapter[]): Promise<void> {
  for (let index = adapters.length - 1; index >= 0; index -= 1) await adapters[index]?.dispose?.()
}

export default TuiBackendRuntime
