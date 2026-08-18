/** Standard-connection projection of the UI-owned Channel contract. */

import { randomUUID } from 'node:crypto'
import type { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { defineProtocolDeclaration, type ProtocolDeclaration } from '@dsh-std/core'
import type {
  CapabilityBinding,
  CapabilityClient,
  CapabilityDispatch,
  CapabilityHandlerContext,
  CapabilityImplementation,
  CapabilityParticipant,
  ConnectionEndpoint,
  EndpointOffer,
  StandardConnection,
} from '@dsh-std/connection'
import { defineComponentManifest } from '@dsh-std/manifest'
import {
  TUI_CHANNEL,
  TUI_CHANNEL_FEATURES,
  TUI_CHANNEL_WIRE_REVISION,
  validateTuiChannelInput,
  validateTuiChannelOutput,
  type JsonValue,
  type TuiChannelSnapshot,
  type TuiChannelWorkspaceFlowChoice,
  type TuiChannelWorkspaceFlowResult,
} from 'dsh-ecosystem-spec/tui-channel'
import type { Channel, ChatRow, NotificationItem, StagedImageInput } from '../tui-contract/channel.js'
import { completeCommands, type CommandCompletion } from '../commands.js'
import type { SettingsHost } from '../tui-contract/settings.js'
import type { TuiSettingsSection } from '../tui-runtime/settings-sections.js'
import type { ProviderSetupHost } from '../tui-contract/provider-setup.js'
import type {
  WorkspaceChoice,
  WorkspaceCommandResult,
  WorkspaceProgress,
  WorkspaceTarget,
} from '../tui-contract/workspaces.js'

const COMPONENT_VERSION = '0.8.0'
const PROVIDER_COMPONENT = 'org.omdsh.dsh-tui.channel-provider'
const PROVIDER_FACET = 'channel'
const CONSUMER_COMPONENT = 'org.omdsh.dsh-tui.channel-client'
const CONSUMER_FACET = 'client'
const SUPPORT = Object.freeze({
  ...TUI_CHANNEL,
  spec: Object.freeze({ wireRevision: TUI_CHANNEL_WIRE_REVISION, features: TUI_CHANNEL_FEATURES }),
})
const REQUIREMENT = Object.freeze({ ...SUPPORT })

export interface TuiChannelOpenRequest {
  readonly workspace?: string
  readonly sessionId?: string
  readonly options?: JsonValue
}

export interface TuiChannelServerBinding {
  readonly channel: Channel
  dispose(): void | Promise<void>
}

interface WorkspaceAction {
  readonly run: (
    value: string | undefined,
    signal: AbortSignal,
    reportProgress: (progress: WorkspaceProgress) => void,
  ) => WorkspaceCommandResult | Promise<WorkspaceCommandResult>
}

interface LocalRowGroup {
  /** Last authority row visible when the terminal-local report was inserted. */
  readonly afterRemoteRowId: number | undefined
  readonly rows: readonly ChatRow[]
}

interface OrderedLocalNotification {
  readonly order: number
  readonly item: NotificationItem
}

export interface TuiChannelServerFactory {
  open(request: TuiChannelOpenRequest, signal: AbortSignal): TuiChannelServerBinding | Promise<TuiChannelServerBinding>
}

export interface TuiChannelInvocationScope {
  run<T>(
    invocation: { readonly connectionId: string; readonly invocationId: string },
    operation: () => T,
  ): T
}

export interface TuiChannelParticipantBinding {
  readonly participantId: string
  dispose(): Promise<void>
}

export interface TuiConnectionEndpoint extends ConnectionEndpoint {
  /** Participant identity as carried in this endpoint's cross-runtime offer. */
  participantId(localParticipantId: string): string
  /** Add a declaration only to physical TUI connections, not adapter-local activation links. */
  registerDeclaration(declaration: ProtocolDeclaration): () => void
}

const endpointProjections = new WeakMap<ConnectionEndpoint, TuiConnectionEndpoint>()

/** Scope adapter-local participant names by endpoint instance for transport. */
export function tuiConnectionEndpoint(endpoint: ConnectionEndpoint): TuiConnectionEndpoint {
  const existing = endpointProjections.get(endpoint)
  if (existing !== undefined) return existing
  const prefix = `${endpoint.offer.endpoint.instanceId}::`
  const projectId = (id: string): string => `${prefix}${id}`
  const overlays = new Map<string, ProtocolDeclaration>()
  const listeners = new Set<(offer: EndpointOffer) => void>()
  let overlayRevision = 0
  const unproject = (participant: CapabilityParticipant): CapabilityParticipant =>
    participant.endpoint.instanceId !== endpoint.offer.endpoint.instanceId
      ? participant
      : Object.freeze({
          ...participant,
          participantId: participant.participantId.startsWith(prefix)
            ? participant.participantId.slice(prefix.length)
            : participant.participantId,
        })
  const projectDeclaration = (declaration: ProtocolDeclaration): ProtocolDeclaration => Object.freeze({
    ...declaration,
    participant: Object.freeze({ id: projectId(declaration.participant.id) }),
  })
  const projectOffer = (offer: EndpointOffer): EndpointOffer => Object.freeze({
    ...offer,
    revision: offer.revision + overlayRevision,
    declarations: Object.freeze(offer.declarations.map(declaration => Object.freeze({
      ...projectDeclaration(declaration),
    })).concat([...overlays.values()].map(projectDeclaration))),
  })
  const emitOffer = (): void => {
    const offer = projectOffer(endpoint.offer)
    for (const listener of listeners) listener(offer)
  }
  endpoint.onOfferChange(emitOffer)
  const projection: TuiConnectionEndpoint = {
    get offer() { return projectOffer(endpoint.offer) },
    participantId: projectId,
    onOfferChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    registerDeclaration(declaration) {
      const normalized = defineProtocolDeclaration(declaration)
      const id = normalized.participant.id
      if (overlays.has(id) || endpoint.offer.declarations.some(row => row.participant.id === id)) {
        throw new Error(`physical TUI participant ${JSON.stringify(id)} is already registered`)
      }
      overlays.set(id, normalized)
      overlayRevision += 1
      emitOffer()
      return () => {
        if (overlays.get(id) !== normalized) return
        overlays.delete(id)
        overlayRevision += 1
        emitOffer()
      }
    },
    dispatch<TInput = unknown, TOutput = unknown, TProgress = unknown>(invocation: CapabilityDispatch<TInput, TProgress>): Promise<TOutput> {
      const binding: CapabilityBinding = Object.freeze({
        ...invocation.binding,
        consumer: unproject(invocation.binding.consumer),
        provider: unproject(invocation.binding.provider),
      })
      return endpoint.dispatch<TInput, TOutput, TProgress>({ ...invocation, binding })
    },
  }
  endpointProjections.set(endpoint, projection)
  return projection
}

/** Publish a Channel factory without teaching the carrier or connector about TUI internals. */
export async function mountTuiChannelProvider(
  adapter: DshStandardAdapter,
  factory: TuiChannelServerFactory,
  invocationScope?: TuiChannelInvocationScope,
): Promise<TuiChannelParticipantBinding> {
  const server = new TuiChannelCapabilityServer(factory, invocationScope)
  let participantId: string | undefined
  const disposeFacet = await adapter.mount({
    manifest: channelManifest(PROVIDER_COMPONENT, PROVIDER_FACET, { supports: [SUPPORT] }),
    facet: PROVIDER_FACET,
    activate(context) {
      participantId = context.identity.participantId
      context.protocols.implement(SUPPORT, {
        participantId,
        protocol: SUPPORT,
        handle: (operation, input, invocation) => server.handle(operation, input, invocation),
      } satisfies CapabilityImplementation)
    },
    deactivate: () => server.dispose(),
  })
  if (participantId === undefined) {
    await disposeFacet()
    throw new Error('dsh-tui Channel provider activated without a participant identity')
  }
  return Object.freeze({ participantId, dispose: disposeFacet })
}

/** Declare the client side before a physical connection negotiates its offer. */
export async function mountTuiChannelConsumer(adapter: DshStandardAdapter): Promise<TuiChannelParticipantBinding> {
  const participantId = `${CONSUMER_COMPONENT}/${CONSUMER_FACET}`
  const unregister = adapter.connectionEndpoint.register({
    declaration: defineProtocolDeclaration({
      participant: { id: participantId },
      requires: [REQUIREMENT],
    }),
  })
  return Object.freeze({ participantId, dispose: async () => { unregister() } })
}

export interface RemoteTuiChannelOptions extends TuiChannelOpenRequest {
  /** Local presentation and executable plugin contributions stay on the visible terminal. */
  readonly terminalChannel: Channel
  readonly onDisconnect?: (error: unknown) => void
  readonly signal?: AbortSignal
}

/** Open a negotiated remote Channel and expose the ordinary local Channel shape. */
export async function openRemoteTuiChannel(
  connection: StandardConnection,
  participantId: string,
  options: RemoteTuiChannelOptions,
): Promise<{ readonly channel: Channel; dispose(): Promise<void> }> {
  const client = connection.client(participantId)
  if (client.binding(TUI_CHANNEL) === undefined) throw new Error('remote endpoint does not provide the TUI Channel protocol')
  const opened = await client.invoke<TuiChannelOpenRequest, TuiChannelSnapshot>(TUI_CHANNEL, 'open', {
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.options === undefined ? {} : { options: options.options }),
  }, { signal: options.signal }).result
  validateTuiChannelOutput('open', opened)
  const remote = new RemoteTuiChannel(client, opened, options.terminalChannel, options.onDisconnect)
  remote.start()
  return Object.freeze({ channel: remote.channel, dispose: () => remote.dispose() })
}

class TuiChannelCapabilityServer {
  private readonly channels = new Map<string, ServerChannel>()

  constructor(
    private readonly factory: TuiChannelServerFactory,
    private readonly invocationScope?: TuiChannelInvocationScope,
  ) {}

  async handle(operation: string, rawInput: unknown, context: CapabilityHandlerContext): Promise<unknown> {
    return this.invocationScope === undefined
      ? this.handleScoped(operation, rawInput, context)
      : this.invocationScope.run(context, () => this.handleScoped(operation, rawInput, context))
  }

  private async handleScoped(operation: string, rawInput: unknown, context: CapabilityHandlerContext): Promise<unknown> {
    const input = validateTuiChannelInput(operation, rawInput) as Record<string, unknown>
    if (operation === 'open') {
      const binding = await this.factory.open(input as TuiChannelOpenRequest, context.signal)
      const channelId = randomUUID()
      const channel = new ServerChannel(channelId, context.connectionId, binding)
      this.channels.set(channelId, channel)
      return channel.snapshot()
    }
    const channelId = requiredString(input.channelId, 'channelId')
    const channel = this.channels.get(channelId)
    if (channel === undefined) throw new Error(`TUI Channel ${JSON.stringify(channelId)} is not open`)
    if (operation === 'subscribe') {
      try {
        return await channel.after(requiredInteger(input.afterVersion, 'afterVersion'), context.signal)
      } catch (error) {
        if (context.signal.aborted) await this.disposeConnection(context.connectionId)
        throw error
      }
    }
    if (operation === 'invoke') {
      const value = await channel.invoke(
        requiredString(input.method, 'method'),
        Array.isArray(input.arguments) ? input.arguments : [],
        context.signal,
        context.progress,
      )
      return { value: json(value) ?? null, valueDefined: value !== undefined, snapshot: channel.snapshot() }
    }
    this.channels.delete(channelId)
    await channel.dispose()
    return { closed: true }
  }

  async dispose(): Promise<void> {
    const channels = [...this.channels.values()]
    this.channels.clear()
    await Promise.allSettled(channels.map(channel => channel.dispose()))
  }

  private async disposeConnection(connectionId: string): Promise<void> {
    const owned = [...this.channels.entries()].filter(([, channel]) => channel.connectionId === connectionId)
    for (const [channelId] of owned) this.channels.delete(channelId)
    await Promise.allSettled(owned.map(([, channel]) => channel.dispose()))
  }
}

class ServerChannel {
  private readonly waiters = new Set<() => void>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeSettingsSections: () => void
  private closed = false
  private projectionVersion = 1
  private mutationTail: Promise<unknown> = Promise.resolve()
  private readonly workspaceActions = new Map<string, WorkspaceAction>()

  constructor(readonly id: string, readonly connectionId: string, private readonly binding: TuiChannelServerBinding) {
    const changed = (): void => {
      this.projectionVersion += 1
      for (const wake of [...this.waiters]) wake()
    }
    this.unsubscribe = binding.channel.subscribe(changed)
    this.unsubscribeSettingsSections = binding.channel.subscribeSettingsSections(changed)
  }

  snapshot(): TuiChannelSnapshot {
    const channel = this.binding.channel
    const state: Record<string, JsonValue> = {}
    for (const key of CHANNEL_STATE_KEYS) {
      const value = json(Reflect.get(channel, key, channel))
      if (value !== undefined) state[key] = value
    }
    state.workspaceCommands = json(channel.workspaceCommands()) ?? []
    state.traceEvents = json(channel.traceEvents()) ?? []
    state.mcpStatus = json(channel.mcpStatus()) ?? []
    state.configInfo = json(channel.configInfo()) ?? []
    state.doctorInfo = json(channel.doctorInfo()) ?? []
    state.pluginScene = channel.pluginScene === undefined
      ? null
      : { id: channel.pluginScene.id, ...(channel.pluginScene.title === undefined ? {} : { title: channel.pluginScene.title }) }
    const settings = channel.settingsHost()
    state.settingsAvailable = settings !== undefined
    if (settings !== undefined) state.settingsNamespaces = json(settings.listNamespaces()) ?? []
    state.settingsSections = json(channel.settingsSections()) ?? []
    const provider = channel.providerSetup()
    state.providerSetupAvailable = provider !== undefined
    if (provider !== undefined) {
      state.providerSetupMethods = [...PROVIDER_METHODS].filter(method =>
        typeof Reflect.get(provider, method, provider) === 'function')
    }
    return Object.freeze({
      wireRevision: TUI_CHANNEL_WIRE_REVISION,
      channelId: this.id,
      version: this.projectionVersion,
      state: Object.freeze(state),
    })
  }

  async after(version: number, signal: AbortSignal): Promise<TuiChannelSnapshot> {
    if (this.projectionVersion > version || this.closed) return this.snapshot()
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.waiters.delete(wake)
        signal.removeEventListener('abort', abort)
      }
      const wake = (): void => { cleanup(); resolve() }
      const abort = (): void => { cleanup(); reject(signal.reason ?? new Error('Channel subscription cancelled')) }
      this.waiters.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    return this.snapshot()
  }

  async invoke(
    method: string,
    args: readonly unknown[],
    signal: AbortSignal,
    progress: (value: unknown) => void,
  ): Promise<unknown> {
    if (this.closed) throw new Error(`TUI Channel ${JSON.stringify(this.id)} is closed`)
    if (!SERIALIZED_REMOTE_METHODS.has(method)) return this.invokeNow(method, args, signal, progress)
    const invocation = this.mutationTail.then(() => this.invokeNow(method, args, signal, progress))
    this.mutationTail = invocation.catch(() => undefined)
    return invocation
  }

  private async invokeNow(
    method: string,
    args: readonly unknown[],
    signal: AbortSignal,
    progress: (value: unknown) => void,
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (method === 'settings.list') return this.binding.channel.settingsHost()?.listNamespaces() ?? []
    if (method === 'settings.write') {
      return this.settings().write(args[0] as string, args[1] as never, args[2] === null ? undefined : args[2] as number | undefined)
    }
    if (method === 'settings.credentialConfigured') return this.settings().credentialConfigured(args[0] as string)
    if (method === 'settings.writeCredential') return this.settings().writeCredential(args[0] as string, args[1] as string)
    if (method === 'workspace.continue') {
      if (!isRecord(args[0])) throw new TypeError('workspace continuation must be an object')
      const action = requiredString(args[0].action, 'workspace action id')
      const value = args[0].value === undefined ? undefined : requiredString(args[0].value, 'workspace action value')
      return this.runWorkspaceAction(action, value, signal, progress)
    }
    if (method.startsWith('provider.')) return invokeProvider(this.provider(), method.slice('provider.'.length), args)
    if (!REMOTE_METHODS.has(method)) throw new Error(`TUI Channel method ${JSON.stringify(method)} is not remotely callable`)
    const member = Reflect.get(this.binding.channel, method, this.binding.channel) as unknown
    if (typeof member !== 'function') throw new TypeError(`Channel member ${JSON.stringify(method)} is not callable`)
    if (method === 'sideQuestion') {
      return this.binding.channel.sideQuestion(requiredString(args[0], 'question'), {
        signal,
        onText: delta => progress({ type: 'side-question/text', delta }),
      })
    }
    if (method === 'runWorkspaceCommand') {
      const result = await this.binding.channel.runWorkspaceCommand(
        requiredString(args[0], 'workspace command name'),
        typeof args[1] === 'string' ? args[1] : '',
      )
      return result === undefined ? undefined : this.projectWorkspaceResult(result)
    }
    const decoded = method === 'stageImage' ? [decodeImage(args[0])] : args
    return Reflect.apply(member, this.binding.channel, decoded)
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.unsubscribeSettingsSections()
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
    this.workspaceActions.clear()
    await this.mutationTail.catch(() => undefined)
    await this.binding.dispose()
  }

  private settings(): SettingsHost {
    const host = this.binding.channel.settingsHost()
    if (host === undefined) throw new Error('remote Channel has no settings host')
    return host
  }

  private provider(): ProviderSetupHost {
    const host = this.binding.channel.providerSetup()
    if (host === undefined) throw new Error('remote Channel has no provider setup host')
    return host
  }

  private async runWorkspaceAction(
    id: string,
    value: string | undefined,
    signal: AbortSignal,
    progress: (value: unknown) => void,
  ): Promise<TuiChannelWorkspaceFlowResult> {
    const action = this.workspaceActions.get(id)
    if (action === undefined) throw new Error(`workspace action ${JSON.stringify(id)} is stale or unknown`)
    const result = await action.run(value, signal, update => {
      progress({ type: 'workspace/progress', value: json(update) ?? {} })
    })
    signal.throwIfAborted()
    return this.projectWorkspaceResult(result)
  }

  private projectWorkspaceResult(result: WorkspaceCommandResult): TuiChannelWorkspaceFlowResult {
    this.workspaceActions.clear()
    if (result.kind === 'target') return { kind: 'target', target: result.target }
    return {
      kind: 'choices',
      title: result.title,
      choices: result.choices.map(choice => {
        const chooseAction = randomUUID()
        this.workspaceActions.set(chooseAction, {
          run: (_value, signal, reportProgress) => choice.choose(signal, reportProgress),
        })
        let input: TuiChannelWorkspaceFlowChoice['input']
        const inputHandler = choice.input
        if (inputHandler !== undefined) {
          const action = randomUUID()
          this.workspaceActions.set(action, {
            run: (value, signal, reportProgress) => inputHandler.submit(value ?? '', signal, reportProgress),
          })
          input = {
            action,
            ...(inputHandler.initialValue === undefined ? {} : { initialValue: inputHandler.initialValue }),
            ...(inputHandler.placeholder === undefined ? {} : { placeholder: inputHandler.placeholder }),
          }
        }
        return {
          id: choice.id,
          label: choice.label,
          ...(choice.description === undefined ? {} : { description: choice.description }),
          ...(choice.badge === undefined ? {} : { badge: choice.badge }),
          action: chooseAction,
          ...(input === undefined ? {} : { input }),
        }
      }),
    }
  }
}

class RemoteTuiChannel {
  readonly channel: Channel
  private snapshot: TuiChannelSnapshot
  /**
   * Revision of the complete terminal view, including state that intentionally
   * stays on the client (local reports and notifications).  The authority's
   * Channel version cannot represent those mutations, and React's
   * useSyncExternalStore suppresses a listener wake when this getter does not
   * change.
   */
  private viewVersion: number
  private readonly listeners = new Set<() => void>()
  private readonly abort = new AbortController()
  private readonly localRowGroups: LocalRowGroup[] = []
  private readonly localNotifications: OrderedLocalNotification[] = []
  private readonly remoteNotificationOrder = new Map<number, number>()
  private readonly terminalNotificationOrder = new Map<number, number>()
  private notificationOrder = 0
  private localSequence = 0
  private terminalSignature: string
  private readonly unsubscribeTerminal: () => void
  private subscribeTask: Promise<void> | undefined
  private readonly completionCache = new Map<string, readonly CommandCompletion[]>()
  private readonly completionPending = new Map<string, symbol>()
  private readonly settingsSectionListeners = new Set<() => void>()
  private readonly settingsSectionUnsubscribers = new Set<() => void>()
  private disposed = false
  private released = false
  private mirroredSceneId: string | undefined
  private unavailableSceneId: string | undefined

  constructor(
    private readonly client: CapabilityClient,
    initial: TuiChannelSnapshot,
    private readonly local: Channel,
    private readonly onDisconnect?: (error: unknown) => void,
  ) {
    this.snapshot = initial
    this.viewVersion = initial.version
    this.syncRemoteNotifications(initial)
    this.syncTerminalNotifications()
    this.terminalSignature = this.terminalViewSignature()
    this.unsubscribeTerminal = this.local.subscribe(() => {
      const signature = this.terminalViewSignature()
      if (signature === this.terminalSignature) return
      this.terminalSignature = signature
      this.syncTerminalNotifications()
      this.emit()
    })
    this.channel = new Proxy({} as Channel, { get: (_target, property) => this.member(property) })
  }

  start(): void {
    this.synchronizeScene()
    this.subscribeTask = this.subscribeLoop()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (!this.abort.signal.aborted) this.abort.abort(new Error('remote TUI Channel closed'))
    try {
      await this.client.invoke(TUI_CHANNEL, 'close', { channelId: this.snapshot.channelId }).result
    } catch {}
    await this.subscribeTask?.catch(() => undefined)
    this.releaseLocalSubscriptions()
  }

  private member(property: PropertyKey): unknown {
    if (property === 'subscribe') return (listener: () => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    }
    if (property === 'version') return this.viewVersion
    if (property === 'rows') return this.rows()
    if (property === 'notifications') return this.notifications()
    if (property === 'diffLayout' || property === 'activityFrames' || property === 'activityEnabled'
      || property === 'contextBarEnabled' || property === 'pluginScene') return Reflect.get(this.local, property, this.local)
    if (property === 'setDiffLayout' || property === 'setActivityFrames' || property === 'openPluginScene'
      || property === 'closePluginScene') {
      if (property === 'openPluginScene') return (id: string) => {
        const opened = this.local.openPluginScene(id)
        if (opened) {
          this.mirroredSceneId = id
          this.fire('openPluginScene', [id])
        }
        return opened
      }
      if (property === 'closePluginScene') return () => {
        this.local.closePluginScene()
        this.mirroredSceneId = undefined
        this.fire('closePluginScene', [])
      }
      const member = Reflect.get(this.local, property, this.local)
      return typeof member === 'function' ? member.bind(this.local) : member
    }
    if (property === 'settingsSections') return () => this.settingsSections()
    if (property === 'subscribeSettingsSections') return (listener: () => void) => {
      this.settingsSectionListeners.add(listener)
      const unsubscribeLocal = this.local.subscribeSettingsSections(listener)
      this.settingsSectionUnsubscribers.add(unsubscribeLocal)
      return () => {
        unsubscribeLocal()
        this.settingsSectionUnsubscribers.delete(unsubscribeLocal)
        this.settingsSectionListeners.delete(listener)
      }
    }
    if (property === 'commandCompletions') return (input: string) => this.commandCompletions(input)
    if (property === 'workspaceCommands') return () => this.stateArray('workspaceCommands')
    if (property === 'traceEvents') return () => this.stateArray('traceEvents')
    if (property === 'mcpStatus') return () => this.stateArray('mcpStatus')
    if (property === 'configInfo') return () => this.stateArray('configInfo')
    if (property === 'doctorInfo') return () => this.stateArray('doctorInfo')
    if (property === 'settingsHost') return () => this.settingsHost()
    if (property === 'providerSetup') return () => this.providerSetup()
    if (property === 'notify') return (text: string, options?: Omit<NotificationItem, 'id' | 'text'>) => this.notify(text, options)
    if (property === 'pushLocal') return (title: string, lines: readonly string[]) => this.pushLocal(title, lines)
    if (property === 'removePending') return (id: string) => {
      const found = this.stateArray<{ id: string }>('pending').some(item => item.id === id)
      if (found) this.fire('removePending', [id])
      return found
    }
    if (property === 'interruptAndDeliver') return (texts: readonly string[]) => {
      if (texts.length > 0) this.fire('interruptAndDeliver', [texts])
      return texts.length
    }
    if (property === 'clear') return () => {
      this.localRowGroups.length = 0
      this.fire('clear', [])
      this.emit()
    }
    if (property === 'submit' || property === 'steer' || property === 'cancel'
      || property === 'compact' || property === 'renameSession' || property === 'setResumeTarget') {
      return (...args: unknown[]) => this.fire(String(property), args)
    }
    if (property === 'releaseContributions') return () => { void this.dispose() }
    if (property === 'sideQuestion') {
      return (question: string, options?: { signal?: AbortSignal; onText?: (delta: string) => void }) =>
        this.invoke('sideQuestion', [question], {
          signal: options?.signal,
          progress: value => {
            if (isRecord(value) && value.type === 'side-question/text' && typeof value.delta === 'string') {
              options?.onText?.(value.delta)
            }
          },
        })
    }
    if (property === 'runWorkspaceCommand') {
      return async (name: string, input: string): Promise<WorkspaceCommandResult | undefined> => {
        const value = await this.invoke('runWorkspaceCommand', [name, input])
        return value === undefined ? undefined : this.workspaceResult(value)
      }
    }
    if (ASYNC_REMOTE_METHODS.has(String(property))) return (...args: unknown[]) => this.invoke(String(property), args)
    if (typeof property === 'string' && Object.hasOwn(this.snapshot.state, property)) return this.snapshot.state[property]
    return CHANNEL_DEFAULTS[String(property)]
  }

  private async subscribeLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const next = await this.client.invoke<unknown, TuiChannelSnapshot>(TUI_CHANNEL, 'subscribe', {
          channelId: this.snapshot.channelId,
          afterVersion: this.snapshot.version,
        }, { signal: this.abort.signal }).result
        validateTuiChannelOutput('subscribe', next)
        this.applySnapshot(next)
      } catch (error) {
        if (!this.abort.signal.aborted) {
          this.notify(error instanceof Error ? error.message : String(error), { color: 'error', timeoutMs: 8000 })
          this.abort.abort(error)
          try {
            this.onDisconnect?.(error)
          } finally {
            this.releaseLocalSubscriptions()
          }
        }
        return
      }
    }
  }

  private async invoke(
    method: string,
    args: readonly unknown[],
    options: { readonly signal?: AbortSignal; readonly progress?: (value: unknown) => void } = {},
  ): Promise<unknown> {
    const signal = options.signal === undefined
      ? this.abort.signal
      : AbortSignal.any([this.abort.signal, options.signal])
    const call = this.client.invoke<unknown, { value: unknown; valueDefined?: boolean; snapshot?: TuiChannelSnapshot }, unknown>(TUI_CHANNEL, 'invoke', {
      channelId: this.snapshot.channelId,
      method,
      arguments: encodeArguments(method, args),
    }, { signal })
    const progress = options.progress === undefined ? undefined : (async () => {
      for await (const value of call.progress) options.progress?.(value)
    })()
    const output = await call.result
    await progress
    validateTuiChannelOutput('invoke', output)
    if (output.snapshot !== undefined) this.applySnapshot(output.snapshot)
    return output.valueDefined === false ? undefined : output.value
  }

  private applySnapshot(next: TuiChannelSnapshot): void {
    if (next.wireRevision !== TUI_CHANNEL_WIRE_REVISION) throw new Error('remote TUI Channel wire revision changed')
    if (next.channelId !== this.snapshot.channelId) throw new Error('remote TUI Channel identity changed')
    if (next.version < this.snapshot.version) return
    const previousAgentId = this.snapshot.state.agentId
    const oldCompletionState = JSON.stringify([
      this.snapshot.state.commandList ?? null,
      this.snapshot.state.workspaceCommands ?? null,
    ])
    const newCompletionState = JSON.stringify([
      next.state.commandList ?? null,
      next.state.workspaceCommands ?? null,
    ])
    const settingsSectionsChanged = JSON.stringify(this.snapshot.state.settingsSections ?? null)
      !== JSON.stringify(next.state.settingsSections ?? null)
    this.snapshot = next
    this.syncRemoteNotifications(next)
    if (previousAgentId !== next.state.agentId) this.localRowGroups.length = 0
    if (oldCompletionState !== newCompletionState) {
      this.completionCache.clear()
      this.completionPending.clear()
    }
    this.synchronizeScene()
    this.emit()
    if (settingsSectionsChanged) for (const listener of this.settingsSectionListeners) listener()
  }

  private commandCompletions(input: string): readonly CommandCompletion[] {
    const cached = this.completionCache.get(input)
    if (cached !== undefined) return cached
    if (!this.completionPending.has(input)) {
      const pending = Symbol(input)
      this.completionPending.set(input, pending)
      void this.invoke('commandCompletions', [input]).then(value => {
        if (this.completionPending.get(input) === pending && Array.isArray(value)) {
          this.completionCache.set(input, value as unknown as readonly CommandCompletion[])
        }
      }).catch(error => {
        if (this.completionPending.get(input) === pending) {
          this.notify(error instanceof Error ? error.message : String(error), { color: 'error', timeoutMs: 8000 })
        }
      }).finally(() => {
        if (this.completionPending.get(input) === pending) {
          this.completionPending.delete(input)
          this.emit()
        }
      })
    }
    return completeCommands(input, this.stateArray('commandList'))
  }

  private synchronizeScene(): void {
    const projected = this.snapshot.state.pluginScene
    const id = isRecord(projected) && typeof projected.id === 'string' ? projected.id : undefined
    if (id === undefined) {
      if (this.mirroredSceneId !== undefined && this.local.pluginScene?.id === this.mirroredSceneId) {
        this.local.closePluginScene()
      }
      this.mirroredSceneId = undefined
      this.unavailableSceneId = undefined
      return
    }
    if (this.local.pluginScene?.id === id) {
      this.mirroredSceneId = id
      this.unavailableSceneId = undefined
      return
    }
    if (this.local.openPluginScene(id)) {
      this.mirroredSceneId = id
      this.unavailableSceneId = undefined
      return
    }
    if (this.unavailableSceneId !== id) {
      this.unavailableSceneId = id
      this.notify(`Remote scene ${JSON.stringify(id)} is not installed in this terminal.`, { color: 'warning', timeoutMs: 8000 })
    }
  }

  private fire(method: string, args: readonly unknown[]): void {
    void this.invoke(method, args).catch(error => this.notify(error instanceof Error ? error.message : String(error), {
      color: 'error', timeoutMs: 8000,
    }))
  }

  private settingsHost(): SettingsHost | undefined {
    if (this.snapshot.state.settingsAvailable !== true) return undefined
    return {
      listNamespaces: () => this.stateArray('settingsNamespaces'),
      write: (ns, ops, expectedRevision) => this.invoke('settings.write', [ns, ops, expectedRevision]).then(() => undefined),
      credentialConfigured: ref => this.invoke('settings.credentialConfigured', [ref]) as Promise<boolean>,
      writeCredential: (ref, value) => this.invoke('settings.writeCredential', [ref, value]).then(() => undefined),
    }
  }

  private providerSetup(): ProviderSetupHost | undefined {
    if (this.snapshot.state.providerSetupAvailable !== true) return undefined
    const invoke = (method: string, args: readonly unknown[]) => this.invoke(`provider.${method}`, args)
    const methods = new Set(this.stateArray<string>('providerSetupMethods'))
    return {
      listCatalogProviders: () => invoke('listCatalogProviders', []) as never,
      routeExists: route => invoke('routeExists', [route]) as never,
      discoverModels: request => invoke('discoverModels', [request]) as never,
      envShadows: ref => invoke('envShadows', [ref]) as never,
      readCredential: ref => invoke('readCredential', [ref]) as never,
      writeCredential: (ref, value) => invoke('writeCredential', [ref, value]) as never,
      removeCredential: ref => invoke('removeCredential', [ref]) as never,
      writeProfile: (route, profile) => invoke('writeProfile', [route, profile]).then(() => undefined),
      ...(methods.has('commitProvider')
        ? { commitProvider: (request: Parameters<NonNullable<ProviderSetupHost['commitProvider']>>[0]) => invoke('commitProvider', [request]).then(() => undefined) }
        : {}),
    }
  }

  private settingsSections(): readonly TuiSettingsSection[] {
    const remote = this.stateArray<TuiSettingsSection>('settingsSections')
    const local = this.local.settingsSections()
    const localByNamespace = new Map(local.map(section => [section.ns, section] as const))
    return remote.map(section => localByNamespace.get(section.ns) ?? section)
  }

  private workspaceResult(value: unknown): WorkspaceCommandResult {
    if (!isRecord(value)) throw new TypeError('remote workspace result must be an object')
    if (value.kind === 'target') {
      return { kind: 'target', target: workspaceTarget(value.target) }
    }
    if (value.kind !== 'choices' || typeof value.title !== 'string' || !Array.isArray(value.choices)) {
      throw new TypeError('remote workspace result is invalid')
    }
    return {
      kind: 'choices',
      title: value.title,
      choices: value.choices.map((candidate, index) => {
        if (!isRecord(candidate)) throw new TypeError(`remote workspace choice ${String(index)} must be an object`)
        const id = requiredString(candidate.id, `remote workspace choice ${String(index)} id`)
        const label = requiredString(candidate.label, `remote workspace choice ${String(index)} label`)
        const action = requiredString(candidate.action, `remote workspace choice ${String(index)} action`)
        const description = optionalString(candidate.description, `remote workspace choice ${String(index)} description`)
        const badge = optionalString(candidate.badge, `remote workspace choice ${String(index)} badge`)
        let input: WorkspaceChoice['input']
        if (candidate.input !== undefined) {
          if (!isRecord(candidate.input)) throw new TypeError(`remote workspace choice ${String(index)} input must be an object`)
          const action = requiredString(candidate.input.action, `remote workspace choice ${String(index)} input action`)
          const initialValue = optionalString(candidate.input.initialValue, `remote workspace choice ${String(index)} initial value`)
          const placeholder = optionalString(candidate.input.placeholder, `remote workspace choice ${String(index)} placeholder`)
          input = {
            ...(initialValue === undefined ? {} : { initialValue }),
            ...(placeholder === undefined ? {} : { placeholder }),
            submit: (text, signal, reportProgress) => this.workspaceAction(action, text, signal, reportProgress),
          }
        }
        return {
          id,
          label,
          ...(description === undefined ? {} : { description }),
          ...(badge === undefined ? {} : { badge }),
          choose: (signal?: AbortSignal, reportProgress?: (progress: WorkspaceProgress) => void) =>
            this.workspaceAction(action, undefined, signal, reportProgress),
          ...(input === undefined ? {} : { input }),
        }
      }),
    }
  }

  private async workspaceAction(
    action: string,
    value?: string,
    signal?: AbortSignal,
    reportProgress?: (progress: WorkspaceProgress) => void,
  ): Promise<WorkspaceCommandResult> {
    const output = await this.invoke('workspace.continue', [{ action, ...(value === undefined ? {} : { value }) }], {
      signal,
      progress: frame => {
        if (!isRecord(frame) || frame.type !== 'workspace/progress') return
        reportProgress?.(workspaceProgress(frame.value))
      },
    })
    return this.workspaceResult(output)
  }

  private stateArray<T>(key: string): T[] {
    const value = this.snapshot.state[key]
    return Array.isArray(value) ? value as T[] : []
  }

  /** Merge terminal-local reports at their original transcript position. */
  private rows(): ChatRow[] {
    const remote = this.stateArray<ChatRow>('rows')
    if (this.localRowGroups.length === 0) return remote
    const remoteIds = new Set(remote.map(row => row.id))
    const leading: ChatRow[] = []
    const after = new Map<number, ChatRow[]>()
    for (const group of this.localRowGroups) {
      if (group.afterRemoteRowId === undefined) {
        leading.push(...group.rows)
        continue
      }
      // An authority-side clear can remove the anchor without changing the
      // agent id.  In that case the local report belongs to the cleared view
      // and must disappear with it.
      if (!remoteIds.has(group.afterRemoteRowId)) continue
      const rows = after.get(group.afterRemoteRowId) ?? []
      rows.push(...group.rows)
      after.set(group.afterRemoteRowId, rows)
    }
    const merged = [...leading]
    for (const row of remote) {
      merged.push(row)
      const local = after.get(row.id)
      if (local !== undefined) merged.push(...local)
    }
    return merged
  }

  /** Keep transient authority and terminal notices in first-seen order. */
  private notifications(): NotificationItem[] {
    const remote = this.stateArray<NotificationItem>('notifications').map(item => ({
      order: this.remoteNotificationOrder.get(item.id) ?? 0,
      item,
    }))
    const terminal = this.local.notifications.map(item => ({
      order: this.terminalNotificationOrder.get(item.id) ?? 0,
      item,
    }))
    return [...remote, ...terminal, ...this.localNotifications]
      .sort((left, right) => left.order - right.order)
      .map(entry => entry.item)
  }

  private syncRemoteNotifications(snapshot: TuiChannelSnapshot): void {
    const value = snapshot.state.notifications
    const notifications = Array.isArray(value) ? value as unknown as NotificationItem[] : []
    const live = new Set(notifications.map(item => item.id))
    for (const id of this.remoteNotificationOrder.keys()) {
      if (!live.has(id)) this.remoteNotificationOrder.delete(id)
    }
    for (const item of notifications) {
      if (!this.remoteNotificationOrder.has(item.id)) {
        this.remoteNotificationOrder.set(item.id, ++this.notificationOrder)
      }
    }
  }

  private syncTerminalNotifications(): void {
    const live = new Set(this.local.notifications.map(item => item.id))
    for (const id of this.terminalNotificationOrder.keys()) {
      if (!live.has(id)) this.terminalNotificationOrder.delete(id)
    }
    for (const item of this.local.notifications) {
      if (!this.terminalNotificationOrder.has(item.id)) {
        this.terminalNotificationOrder.set(item.id, ++this.notificationOrder)
      }
    }
  }

  /** Only terminal-owned state wakes the remote renderer; a dormant local
   * Agent may still emit session updates while this Channel is attached. */
  private terminalViewSignature(): string {
    return JSON.stringify([
      this.local.diffLayout,
      this.local.activityFrames ?? null,
      this.local.activityEnabled,
      this.local.contextBarEnabled,
      this.local.pluginScene?.id ?? null,
      this.local.notifications,
    ])
  }

  private notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): void {
    const item: NotificationItem = {
      id: -(++this.localSequence),
      text,
      ...(options?.color === undefined ? {} : { color: options.color }),
      timeoutMs: options?.timeoutMs ?? 4000,
    }
    const entry = { order: ++this.notificationOrder, item }
    this.localNotifications.push(entry)
    this.emit()
    const timer = setTimeout(() => {
      const index = this.localNotifications.indexOf(entry)
      if (index >= 0) this.localNotifications.splice(index, 1)
      this.emit()
    }, item.timeoutMs)
    timer.unref()
  }

  private pushLocal(title: string, lines: readonly string[]): void {
    // Preserve the same row structure as the in-process Channel.  The
    // renderer assigns the command-heading colour to `local` and the dimmed,
    // indented treatment to each `local-output` row; flattening the report
    // into one string loses that presentation contract.
    const rows: ChatRow[] = [{ id: -(++this.localSequence), kind: 'local', text: title }]
    for (const line of lines) {
      rows.push({
        id: -(++this.localSequence),
        kind: 'local-output',
        text: previewLocalOutput(line),
      })
    }
    this.localRowGroups.push({
      afterRemoteRowId: this.stateArray<ChatRow>('rows').at(-1)?.id,
      rows,
    })
    this.emit()
  }

  private emit(): void {
    this.viewVersion += 1
    for (const listener of this.listeners) listener()
  }

  /** Detach every listener owned by this projection after close or carrier loss. */
  private releaseLocalSubscriptions(): void {
    if (this.released) return
    this.released = true
    this.unsubscribeTerminal()
    for (const unsubscribe of this.settingsSectionUnsubscribers) unsubscribe()
    this.settingsSectionUnsubscribers.clear()
    this.listeners.clear()
    this.settingsSectionListeners.clear()
  }

}

function channelManifest(
  component: string,
  facet: string,
  protocols: { readonly requires?: readonly typeof REQUIREMENT[]; readonly supports?: readonly typeof SUPPORT[] },
) {
  return defineComponentManifest({
    apiVersion: 'manifest.dsh/internal/v1alpha1',
    kind: 'Component',
    metadata: { name: component, displayName: 'dsh-TUI Channel', version: COMPONENT_VERSION },
    spec: { facets: [{
      name: facet,
      activation: {
        apiVersion: 'lifecycle.dsh/v1alpha1', kind: 'FacetModule',
        spec: { module: '@deepseek-harness-tui/dsh-tui/channel-connection' },
      },
      protocols,
    }] },
  })
}

function invokeProvider(host: ProviderSetupHost, method: string, args: readonly unknown[]): unknown {
  const allowed = PROVIDER_METHODS.has(method)
  const member = allowed ? Reflect.get(host, method, host) as unknown : undefined
  if (typeof member !== 'function') throw new Error(`provider setup method ${JSON.stringify(method)} is unavailable`)
  return Reflect.apply(member, host, args)
}

function encodeArguments(method: string, args: readonly unknown[]): JsonValue[] {
  if (method === 'stageImage') {
    const image = args[0] as StagedImageInput
    return [{ mediaType: image.mediaType, data: Buffer.from(image.data).toString('base64'), ...(image.name === undefined ? {} : { name: image.name }) }]
  }
  return args.map((value, index) => {
    if (value === undefined) return null
    const encoded = json(value)
    if (encoded === undefined) throw new TypeError(`Channel argument ${index} for ${method} is not JSON-serializable`)
    return encoded
  })
}

function decodeImage(value: unknown): StagedImageInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('stageImage input must be an object')
  const row = value as Record<string, unknown>
  if (typeof row.data !== 'string' || typeof row.mediaType !== 'string') throw new TypeError('stageImage input is invalid')
  return { data: Uint8Array.from(Buffer.from(row.data, 'base64')), mediaType: row.mediaType as StagedImageInput['mediaType'], ...(typeof row.name === 'string' ? { name: row.name } : {}) }
}

function json(value: unknown): JsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  const text = JSON.stringify(value)
  return text === undefined ? undefined : JSON.parse(text) as JsonValue
}

/** Keep terminal-local reports byte-for-byte compatible with Channel.pushLocal. */
function previewLocalOutput(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 240 ? flat : `${flat.slice(0, 240)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function workspaceTarget(value: unknown): WorkspaceTarget {
  if (!isRecord(value)) throw new TypeError('remote workspace target must be an object')
  const kind = value.kind
  if (kind !== 'local' && kind !== 'provider') throw new TypeError('remote workspace target kind is invalid')
  return {
    uri: requiredString(value.uri, 'remote workspace target uri'),
    cwd: requiredString(value.cwd, 'remote workspace target cwd'),
    label: requiredString(value.label, 'remote workspace target label'),
    kind,
    badge: requiredString(value.badge, 'remote workspace target badge'),
    ...(optionalString(value.description, 'remote workspace target description') === undefined
      ? {}
      : { description: value.description as string }),
  }
}

function workspaceProgress(value: unknown): WorkspaceProgress {
  if (!isRecord(value)) throw new TypeError('remote workspace progress must be an object')
  const label = requiredString(value.label, 'remote workspace progress label')
  if (value.ratio !== undefined && (typeof value.ratio !== 'number' || !Number.isFinite(value.ratio))) {
    throw new TypeError('remote workspace progress ratio must be a finite number')
  }
  return { label, ...(value.ratio === undefined ? {} : { ratio: value.ratio as number }) }
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value as number
}

const CHANNEL_STATE_KEYS = Object.freeze([
  'version', 'rows', 'status', 'sessionTitle', 'agentId', 'model', 'provider', 'tokens', 'cwd', 'displayCwd',
  'homeDir', 'pathCaseInsensitive',
  'gitBranch', 'working', 'spinnerMode', 'responseChars', 'activeToolCount', 'turnStart', 'lastUserText',
  'notifications', 'contextWindow', 'reasoningEffort', 'lastUsage', 'tps', 'tpsSamples', 'workingActivity',
  'goal', 'todos', 'loadedContext', 'pending', 'commandList', 'contextSegments', 'mode', 'modeIndex',
  'agentPreset', 'hasOlder',
] as const satisfies readonly (keyof Channel)[])

const REMOTE_METHOD_NAMES = Object.freeze([
  'commandCompletions', 'runExternalCommand', 'openPluginScene', 'closePluginScene', 'sideQuestion', 'stageImage', 'submit', 'steer', 'removePending', 'cancel',
  'interruptAndDeliver', 'rewindTo', 'resumeTo', 'newSession', 'listWorkspaces', 'resolveWorkspace',
  'switchWorkspace', 'renameWorkspace', 'runWorkspaceCommand', 'switchModel', 'listEfforts', 'setEffort',
  'cycleMode', 'listPresets', 'switchPreset', 'clear', 'loadOlder', 'listModels', 'listSkills',
  'describeCredential', 'listFiles', 'listSessions', 'previewSession', 'setResumeTarget', 'renameSession',
  'deleteSession', 'renameSessionTo', 'compact', 'exportSession', 'initWorkspace', 'listSubagents',
  'promptRewind', 'pluginsInfo',
] as const satisfies readonly (keyof Channel)[])
const REMOTE_METHODS: ReadonlySet<string> = new Set(REMOTE_METHOD_NAMES)

const ASYNC_REMOTE_METHODS = new Set([
  'runExternalCommand', 'sideQuestion', 'stageImage', 'rewindTo', 'resumeTo', 'newSession', 'listWorkspaces',
  'resolveWorkspace', 'switchWorkspace', 'renameWorkspace', 'runWorkspaceCommand', 'switchModel', 'listEfforts',
  'setEffort', 'cycleMode', 'listPresets', 'switchPreset', 'loadOlder', 'listModels', 'listSkills',
  'describeCredential', 'listFiles', 'listSessions', 'previewSession', 'deleteSession', 'renameSessionTo',
  'exportSession', 'listSubagents', 'initWorkspace', 'promptRewind', 'pluginsInfo',
])

const PROVIDER_METHODS = new Set([
  'listCatalogProviders', 'routeExists', 'discoverModels', 'envShadows', 'readCredential', 'writeCredential',
  'removeCredential', 'writeProfile', 'commitProvider',
])

const SERIALIZED_REMOTE_METHODS = new Set([
  'promptRewind', 'rewindTo', 'resumeTo', 'newSession', 'switchWorkspace', 'switchModel', 'switchPreset',
  'workspace.continue',
])

const CHANNEL_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  version: 0, rows: [], status: 'starting', sessionTitle: '', agentId: '', model: '', provider: '',
  tokens: { input: 0, output: 0 }, cwd: '', displayCwd: '', homeDir: '', pathCaseInsensitive: false,
  gitBranch: undefined, working: false,
  spinnerMode: 'thinking', responseChars: 0, activeToolCount: 0, turnStart: 0, lastUserText: '',
  notifications: [], contextWindow: undefined, reasoningEffort: undefined, lastUsage: undefined, tps: undefined,
  tpsSamples: [], workingActivity: undefined, goal: undefined, todos: [], loadedContext: undefined, pending: [],
  commandList: [], contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  mode: { id: 'default' }, modeIndex: 0, agentPreset: undefined, hasOlder: false,
})

const TERMINAL_STATE_KEYS = Object.freeze([
  'activityFrames', 'diffLayout', 'activityEnabled', 'contextBarEnabled', 'pluginScene',
] as const satisfies readonly (keyof Channel)[])

const SNAPSHOT_METHOD_NAMES = Object.freeze([
  'workspaceCommands', 'traceEvents', 'mcpStatus', 'configInfo', 'doctorInfo',
] as const satisfies readonly (keyof Channel)[])

const PROJECTED_HOST_METHOD_NAMES = Object.freeze([
  'settingsHost', 'providerSetup', 'settingsSections', 'subscribeSettingsSections',
] as const satisfies readonly (keyof Channel)[])

const TERMINAL_METHOD_NAMES = Object.freeze([
  'subscribe', 'setDiffLayout', 'setActivityFrames', 'notify', 'pushLocal', 'releaseContributions',
] as const satisfies readonly (keyof Channel)[])

type MappedChannelMember =
  | typeof CHANNEL_STATE_KEYS[number]
  | typeof TERMINAL_STATE_KEYS[number]
  | typeof REMOTE_METHOD_NAMES[number]
  | typeof SNAPSHOT_METHOD_NAMES[number]
  | typeof PROJECTED_HOST_METHOD_NAMES[number]
  | typeof TERMINAL_METHOD_NAMES[number]

/** Fails compilation whenever Channel grows without an explicit ownership/mapping decision. */
export const CHANNEL_SURFACE_COMPLETE: Readonly<Record<Exclude<keyof Channel, MappedChannelMember>, never>> = Object.freeze({})
