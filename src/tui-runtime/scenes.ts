/** Provider-neutral full-screen scene registry for terminal front doors. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import type { TuiSceneDescriptor, TuiSceneSelection } from '../tui-contract/scenes.js'
export type { TuiSceneDescriptor, TuiSceneProps, TuiSceneSelection } from '../tui-contract/scenes.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiScenes: TuiSceneRuntime
  }
}

export const name = 'dsh-tui-scenes'

/**
 * Small host-only registry; command execution remains owned by dsh-commands.
 *
 * A plugin registers a scene once (`ctx.tuiScenes.register(...)`, keep the
 * dispose) and opens it from anywhere host-side — typically its own
 * dsh-commands handler: `ctx.tuiScenes.open('my-scene')` plus a silent
 * `success` result, so the conversation stays untouched while the scene
 * takes the whole terminal the way the trajectory scene does.
 */
export class TuiSceneRuntime extends Service {
  private readonly scenes = new Map<string, TuiSceneDescriptor>()
  private readonly selections = new Set<SceneSelection>()
  private readonly invocation = new AsyncLocalStorage<SceneSelection>()
  private readonly global = new SceneSelection(this)

  constructor(ctx: Context) {
    super(ctx, 'tuiScenes')
  }

  /**
   * Register a full-screen scene; returns the dispose function (caller
   * scopes it with `ctx.effect`). The optional trailing `identity` (the
   * plugin's own ctx) only feeds the effect ledger's pluginId — omitting it
   * records `undeclared` (C-060).
   */
  register(descriptor: TuiSceneDescriptor, identity?: Context): () => void {
    const id = descriptor.id.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI scene id: ${descriptor.id}`)
    if (this.scenes.has(id)) {
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'scene', id },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      throw new Error(`TUI scene "${id}" is already registered`)
    }
    const normalized = { ...descriptor, id }
    this.scenes.set(id, normalized)
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'scene', id }, result: 'applied' },
      identity,
    )
    return () => {
      if (this.scenes.get(id) !== normalized) return
      this.scenes.delete(id)
      this.ctx.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'scene', id }, result: 'applied' },
        identity,
      )
      // Disposing an open scene must clear every independently selected
      // Channel as well as the legacy global selection.
      this.global.remove(normalized)
      for (const selection of this.selections) selection.remove(normalized)
    }
  }

  /** Create an independently selected view for one server-side Channel. */
  createSelection(): TuiSceneSelection & { dispose(): void } {
    const selection = new SceneSelection(this, () => this.selections.delete(selection))
    this.selections.add(selection)
    return selection
  }

  /** Route legacy `ctx.tuiScenes.open()` calls made by a command to its Channel. */
  runWith<T>(selection: TuiSceneSelection, callback: () => T): T {
    if (!(selection instanceof SceneSelection)) return callback()
    return this.invocation.run(selection, callback)
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id — a mistyped id must fail visibly in
   * the log, not silently do nothing in the UI.
   */
  open(id: string): boolean {
    return (this.invocation.getStore() ?? this.global).open(id)
  }

  close(): void {
    (this.invocation.getStore() ?? this.global).close()
  }

  /** The scene currently replacing the conversation, if any. */
  get active(): TuiSceneDescriptor | undefined {
    return (this.invocation.getStore() ?? this.global).active
  }

  /** UI-side change feed: fired after every open/close/dispose transition. */
  subscribe(listener: () => void): () => void {
    return this.global.subscribe(listener)
  }

  resolve(id: string): TuiSceneDescriptor | undefined {
    return this.scenes.get(id.trim().toLowerCase())
  }

  warnMissing(id: string): void {
    this.ctx.logger.warn(`dsh-tui: no TUI scene registered as "${id}"`)
  }
}

class SceneSelection implements TuiSceneSelection {
  private readonly listeners = new Set<() => void>()
  private current: TuiSceneDescriptor | undefined
  private disposed = false

  constructor(private readonly runtime: TuiSceneRuntime, private readonly onDispose?: () => void) {}

  get active(): TuiSceneDescriptor | undefined { return this.current }

  open(id: string): boolean {
    if (this.disposed) return false
    const scene = this.runtime.resolve(id)
    if (scene === undefined) {
      this.runtime.warnMissing(id)
      return false
    }
    if (scene === this.current) return true
    this.current = scene
    this.notify()
    return true
  }

  close(): void {
    if (this.current === undefined) return
    this.current = undefined
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  remove(scene: TuiSceneDescriptor): void {
    if (this.current !== scene) return
    this.current = undefined
    this.notify()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.current = undefined
    this.listeners.clear()
    this.onDispose?.()
  }

  private notify(): void { for (const listener of this.listeners) listener() }
}

export default TuiSceneRuntime
