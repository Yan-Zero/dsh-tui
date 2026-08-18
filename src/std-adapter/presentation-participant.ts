import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@dsh-std/adapter-dsh'
import type { StandardConnection } from '@dsh-std/connection'
import { ApprovalStore } from '../dsh-adapter/approvals.js'
import { QuestionStore } from '../dsh-adapter/questions.js'
import {
  mountTuiPresentationRelay,
  TuiPresentationRelay,
  type TuiPresentationRelayBinding,
} from './presentation-relay.js'
import { mountTuiStandardParticipant } from './standard-participant.js'
import type { TuiConnectionEndpoint } from './channel-connection.js'

interface Notice {
  readonly text: string
  readonly options?: { readonly color?: 'error' | 'warning'; readonly timeoutMs?: number }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiPresentation: TuiPresentationRuntime
  }
}

export const name = 'dsh-tui-presentation-participant'

/** TUI-owned state behind both the standard Presentation protocols and the local panels. */
export class TuiPresentationRuntime extends Service {
  readonly questions = new QuestionStore()
  readonly approvals = new ApprovalStore()
  private readonly buffered: Notice[] = []
  private sink: ((notice: Notice) => void) | undefined
  private relay: TuiPresentationRelay | undefined
  private relayBinding: TuiPresentationRelayBinding | undefined

  constructor(ctx: Context) {
    super(ctx, 'tuiPresentation')
  }

  notify(text: string, options?: Notice['options']): void {
    const notice = Object.freeze({ text, ...(options === undefined ? {} : { options }) })
    if (this.sink === undefined) this.buffered.push(notice)
    else this.sink(notice)
  }

  bindNotifications(sink: (notice: Notice) => void): () => void {
    this.sink = sink
    for (const notice of this.buffered.splice(0)) sink(notice)
    return () => {
      if (this.sink === sink) this.sink = undefined
    }
  }

  disposePending(): void {
    this.questions.rejectAll()
    this.approvals.settleAll('cancelled')
  }

  bindRelay(relay: TuiPresentationRelay, binding: TuiPresentationRelayBinding): void {
    if (this.relay !== undefined) throw new Error('dsh-tui Presentation relay was bound more than once')
    this.relay = relay
    this.relayBinding = binding
  }

  invocationScope(): TuiPresentationRelay | undefined { return this.relay }

  attachEndpoint(endpoint: TuiConnectionEndpoint): () => void {
    if (this.relayBinding === undefined) return () => undefined
    return endpoint.registerDeclaration(this.relayBinding.consumerDeclaration)
  }

  attachConnection(connection: StandardConnection, projectedParticipantId: (id: string) => string): () => void {
    if (this.relay === undefined || this.relayBinding === undefined) return () => undefined
    return this.relay.attach(connection, projectedParticipantId(this.relayBinding.consumerParticipantId))
  }
}

export async function apply(ctx: Context): Promise<void> {
  const runtime = new TuiPresentationRuntime(ctx)
  const launch = ctx.get('tuiLaunch') as import('../dsh-adapter/launch.js').TuiLaunchRuntime | undefined
  if (launch?.server === true) {
    const adapter = ctx.get('dshStd')
    if (adapter === undefined) throw new Error('dsh-tui Presentation relay requires the dsh standard adapter')
    const relay = new TuiPresentationRelay()
    const binding = await mountTuiPresentationRelay(adapter, relay)
    runtime.bindRelay(relay, binding)
    ctx.provide('tuiStandardParticipant', Object.freeze({ participantId: binding.providerParticipantId }))
    ctx.effect(() => async () => {
      runtime.disposePending()
      await binding.dispose()
    }, 'dsh-tui standard Presentation relay')
    return
  }
  const adapter = ctx.get('dshStd')
  if (adapter === undefined) throw new Error('dsh-tui Presentation participant requires the dsh standard adapter')
  const binding = await mountTuiStandardParticipant(adapter, {
    questions: runtime.questions,
    approvals: runtime.approvals,
    notify: (text, options) => runtime.notify(text, options),
  })
  ctx.provide('tuiStandardParticipant', Object.freeze({ participantId: binding.participantId }))
  ctx.effect(() => async () => {
    runtime.disposePending()
    await binding.dispose()
  }, 'dsh-tui standard Presentation participant')
}

apply.inject = ['dshStd']

export default apply
