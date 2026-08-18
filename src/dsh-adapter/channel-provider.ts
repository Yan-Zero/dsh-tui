/** Headless DSH adapter that publishes the TUI Channel capability. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import UserQuestionService, {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { createChannel } from './channel.js'
import {
  mountTuiChannelProvider,
  type TuiChannelOpenRequest,
  type TuiChannelServerBinding,
} from '../std-adapter/channel-connection.js'
import { TuiWorkspaceRuntime } from '../tui-runtime/workspaces.js'
import { attachSessionToWorkspace } from './workspace.js'
import { composePreset, resolvePersistedPreset, runningPresetOf } from './presets.js'
import { resolveModelRoute, validateModelRoute, type ModelRoute } from '../modelRoute.js'
import { approvalCommandOf } from './approvals.js'
import type { TuiPresentationRuntime } from '../std-adapter/presentation-participant.js'
import type { TuiPresentationRelay } from '../std-adapter/presentation-relay.js'
import {
  presentationFailureToApproval,
  type TuiAgentPresentationRoute,
} from './agent-presentation.js'
import type { TuiProfileConfig } from './index.js'
import { resolveSessionCwd } from '../utils/workspaceRoot.js'
import { isLang, type Lang } from '../i18n.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshStd: DshStandardAdapter
  }
}

export const name = 'dsh-tui-channel-provider'
export const inject = ['agents', 'dshStd']

interface ChannelOpenOptions {
  provider?: string
  model?: string
  effort?: string
  preset?: string
  activity?: boolean
  activityFrames?: string
  contextBar?: boolean
  diffLayout?: 'auto' | 'split' | 'unified'
  locale?: Lang
}

/** Mount no renderer and no terminal services; only expose DSH-backed Channels. */
export async function apply(ctx: Context, defaults: TuiProfileConfig = {}): Promise<void> {
  if (ctx.get('tuiWorkspaces') === undefined) new TuiWorkspaceRuntime(ctx)
  const presentation = ctx.get('tuiPresentation') as TuiPresentationRuntime | undefined
  const interactions = new RemoteInteractionBroker(ctx, presentation?.invocationScope())
  const userQuestions = ctx.get('userQuestions') ?? new UserQuestionService(ctx)
  const unregisterQuestions = userQuestions.registerProvider({ ask: request => interactions.ask(request) })
  const unregisterApprovals = ctx.on('approval/request', (request, next) => interactions.approve(request, next))
  const binding = await mountTuiChannelProvider(ctx.dshStd, {
    open: (request, signal) => openDshTuiChannel(ctx, request, signal, interactions, defaults),
  }, presentation?.invocationScope())
  ctx.effect(() => async () => {
    unregisterApprovals()
    unregisterQuestions()
    interactions.dispose()
    await binding.dispose()
  }, 'dsh-tui headless Channel provider')
}

/** Build the same Channel used by the terminal without starting a renderer. */
export async function openDshTuiChannel(
  ctx: Context,
  request: TuiChannelOpenRequest,
  signal: AbortSignal,
  interactions?: RemoteInteractionBroker,
  defaults: TuiProfileConfig = {},
): Promise<TuiChannelServerBinding> {
  signal.throwIfAborted()
  const options = channelOptions(request.options)
  const requestedWorkspace = request.workspace ?? defaults.workspace ?? process.env.DSH_TUI_WORKSPACE_TARGET
  const workspaceService = ctx.get('tuiWorkspaces') as TuiWorkspaceRuntime | undefined
  const target = requestedWorkspace === undefined
    ? undefined
    : await workspaceService?.resolve(requestedWorkspace, process.cwd(), signal)
  if (requestedWorkspace !== undefined && target === undefined) {
    throw new Error(`dsh-tui: unsupported or unavailable workspace target: ${requestedWorkspace}`)
  }
  const cwd = target?.cwd ?? resolveSessionCwd(defaults.cwd)
  const authorityOptions: ChannelOpenOptions = {
    ...options,
    ...(defaults.provider === undefined ? {} : { provider: defaults.provider }),
    ...(defaults.model === undefined ? {} : { model: defaults.model }),
    ...(defaults.effort === undefined ? {} : { effort: defaults.effort }),
    ...(defaults.preset === undefined ? {} : { preset: defaults.preset }),
  }
  const resolved = await resolveRemoteAgent(ctx, request.sessionId ?? defaults.sessionId, cwd, authorityOptions, signal)
  const route = routeOf(resolved.agent, resolved.route)
  const interactionRoute = interactions?.attach(resolved.agent)
  try {
    await attachSessionToWorkspace(ctx, resolved.agent.session.header.cwd ?? cwd, resolved.agent.session.id)
  } catch (error) {
    ctx.logger.warn(`dsh-tui: remote session workspace attachment failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const channel = createChannel(ctx, resolved.agent, {
    model: route.model,
    provider: route.provider,
    cwd: resolved.agent.session.header.cwd ?? cwd,
    configuredModel: authorityOptions.model,
    configuredProvider: authorityOptions.provider,
    effort: authorityOptions.effort,
    activity: options.activity,
    activityFrames: options.activityFrames,
    contextBar: options.contextBar,
    configuredPreset: authorityOptions.preset,
    agentPreset: resolved.agentPreset,
    modes: defaults.modes,
    locale: options.locale,
    diffLayout: options.diffLayout,
    isolatedScenes: true,
    handle: resolved.handle,
  })
  return {
    channel,
    dispose() {
      // The daemon owns live Agents independently from a client connection;
      // disconnecting releases only this projection and its contributions.
      channel.releaseContributions()
      interactionRoute?.dispose()
    },
  }
}

export class RemoteInteractionBroker {
  private readonly routes = new Map<string, RemoteInteractionRoute>()

  constructor(
    private readonly ctx: Context,
    private readonly relay?: TuiPresentationRelay,
  ) {}

  attach(agent: Agent): RemoteInteractionRoute {
    const sessionId = String(agent.session.id)
    if (this.routes.has(sessionId)) throw new Error(`Agent ${JSON.stringify(String(agent.id))} already has a remote terminal`)
    const route = new RemoteInteractionRoute(
      this.relay?.captureAgentPresentation(),
      () => this.routes.delete(sessionId),
    )
    this.routes.set(sessionId, route)
    return route
  }

  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const route = request.agent === undefined ? undefined : this.routeFor(request.agent)
    if (route === undefined) throw new UserQuestionError('No remote terminal owns this Agent', 'PROVIDER_UNAVAILABLE')
    return route.question(request)
  }

  approve(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const route = this.routeFor(request.agent)
    return route === undefined ? next() : route.approval(request)
  }

  dispose(): void {
    for (const route of [...this.routes.values()]) route.dispose()
    this.routes.clear()
  }

  private routeFor(subject: Agent): RemoteInteractionRoute | undefined {
    let current: Agent | undefined = subject
    const visited = new Set<string>()
    while (current !== undefined) {
      const sessionId = String(current.session.id)
      if (visited.has(sessionId)) return undefined
      visited.add(sessionId)
      const route = this.routes.get(sessionId)
      if (route !== undefined) return route
      const parent = current.session.header.parentSession
      if (parent === undefined) return undefined
      current = this.ctx.agents.get(SessionId(String(parent)))
    }
    return undefined
  }
}

class RemoteInteractionRoute {
  private readonly lifetime = new AbortController()
  private closed = false

  constructor(
    private readonly client: TuiAgentPresentationRoute | undefined,
    private readonly detached: () => void,
  ) {}

  async question(input: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (this.closed || this.client === undefined) {
      throw new UserQuestionError('Remote terminal is disconnected or cannot present Agent questions', 'PROVIDER_UNAVAILABLE')
    }
    const signal = input.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, input.signal])
    const result = await this.client.ask(input.questions, signal).catch(error => {
      if (signal.aborted) throw new UserQuestionError('Question was cancelled', 'CANCELLED', { cause: error })
      throw error
    })
    if (result.status === 'submitted') return result.value
    throw new UserQuestionError(
      (result.status === 'unavailable' ? result.reason : undefined)
        ?? (result.status === 'cancelled' ? 'Question was cancelled' : 'Remote terminal could not answer'),
      result.status === 'cancelled' ? 'CANCELLED' : 'PROVIDER_UNAVAILABLE',
    )
  }

  async approval(input: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.closed || this.client === undefined) return 'unavailable'
    const command = approvalCommandOf(input.callId, input.agent.session.events)
    const signal = input.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, input.signal])
    try {
      const result = await this.client.approve({
        toolName: input.toolName,
        ...(input.callId === undefined ? {} : { callId: String(input.callId) }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(command === undefined ? {} : { command }),
      }, signal)
      if (result.status === 'submitted') return result.value
      return presentationFailureToApproval(result)
    } catch {
      return signal.aborted ? 'cancelled' : 'unavailable'
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.detached()
    this.lifetime.abort(new Error('Remote terminal disconnected'))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function resolveRemoteAgent(
  ctx: Context,
  requestedSessionId: string | undefined,
  cwd: string,
  options: ChannelOpenOptions,
  signal: AbortSignal,
): Promise<{ agent: Agent; handle?: AgentHandle; agentPreset?: string; route?: ModelRoute }> {
  const explicitRoute = options.provider !== undefined && options.model !== undefined
    ? { provider: options.provider, model: options.model }
    : undefined
  if (requestedSessionId !== undefined) {
    const sessionId = SessionId(requestedSessionId)
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return { agent: live, agentPreset: runningPresetOf(live.session) }
    const persistedPreset = await resolvePersistedPreset(ctx, sessionId)
    const composed = await composePreset(ctx, persistedPreset)
    const resumed = await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(explicitRoute === undefined ? {} : { agentOptions: explicitRoute }),
      ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      signal,
    })
    return { agent: resumed.agent, handle: resumed, agentPreset: composed.agentPreset, route: explicitRoute }
  }

  const configuredDefault = (ctx.get('agentDefaultModel') as {
    currentSelection?(): { provider?: unknown; model?: unknown }
  } | undefined)?.currentSelection?.()
  const harnessDefault = typeof configuredDefault?.provider === 'string'
    && typeof configuredDefault.model === 'string'
    ? { provider: configuredDefault.provider, model: configuredDefault.model }
    : undefined
  const startupRoute = resolveModelRoute(
    { provider: options.provider, model: options.model },
    undefined,
    harnessDefault,
  )
  const { route } = await validateModelRoute(ctx.get('llm') as never, startupRoute)
  const composed = await composePreset(ctx, options.preset)
  const created = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: {
      cwd,
      ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
    },
    agentOptions: route,
    ...(composed.setup === undefined ? {} : { setup: composed.setup }),
    signal,
  })
  return { agent: created.agent, handle: created, agentPreset: composed.agentPreset, route }
}

function routeOf(agent: Agent, fallback?: ModelRoute): ModelRoute {
  const provider = agent.options.provider ?? fallback?.provider
  const model = agent.options.model ?? fallback?.model
  if (provider === undefined || model === undefined) {
    throw new Error('remote Agent did not resolve a provider/model route')
  }
  return { provider, model }
}

function channelOptions(value: unknown): ChannelOpenOptions {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Channel options must be an object')
  const row = value as Record<string, unknown>
  const output: ChannelOpenOptions = {}
  for (const key of ['provider', 'model', 'effort', 'preset', 'activityFrames'] as const) {
    if (row[key] !== undefined && typeof row[key] !== 'string') throw new TypeError(`Channel options.${key} must be a string`)
    if (typeof row[key] === 'string') output[key] = row[key]
  }
  if (row.locale !== undefined) {
    if (!isLang(row.locale)) throw new TypeError('Channel options.locale must be a supported language')
    output.locale = row.locale
  }
  for (const key of ['activity', 'contextBar'] as const) {
    if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new TypeError(`Channel options.${key} must be boolean`)
    if (typeof row[key] === 'boolean') output[key] = row[key]
  }
  if (row.diffLayout !== undefined) {
    if (row.diffLayout !== 'auto' && row.diffLayout !== 'split' && row.diffLayout !== 'unified') {
      throw new TypeError('Channel options.diffLayout is invalid')
    }
    output.diffLayout = row.diffLayout
  }
  return output
}

export default apply
