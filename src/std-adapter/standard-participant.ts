import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import type { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { defineComponentManifest } from '@dsh-std/manifest'
import {
  copyTextImplementation,
  copyTextSupport,
  notificationImplementation,
  notificationSupport,
  openExternalImplementation,
  openExternalSupport,
  userInteractionImplementation,
  userInteractionSupport,
  type ApprovalRequest,
  type PresentationResult,
  type QuestionAnswers,
  type QuestionField,
  type QuestionRequest,
  type SecretInputRequest,
  type UserInteractionRequest,
  type UserInteractionHandler,
  type UserInteractionSupportSpec,
  type UserInteractionValue,
} from '@dsh-std/presentation'
import type { CapabilityHandlerContext } from '@dsh-std/connection'
import { externalRedirectImplementation, externalRedirectSupport } from '@dsh-std/presentation/callback'
import { setClipboard } from '../ink/termio/osc.js'
import type { QuestionStore } from '../dsh-adapter/questions.js'
import type { ApprovalStore } from '../dsh-adapter/approvals.js'
import { agentQuestionPresentation } from '../dsh-adapter/agent-presentation.js'
import { TuiExternalRedirectReceiver } from './external-redirect.js'

const COMPONENT = 'org.omdsh.dsh-tui'
const FACET = 'presentation'
const VERSION = '0.8.0'
const INTERACTION_SPEC: UserInteractionSupportSpec = Object.freeze({
  operations: Object.freeze(['question', 'approval', 'secret-input'] as const),
  limits: Object.freeze({ maxConcurrentRequests: 1, maxFields: 32, maxOptionsPerField: 64, maxTextLength: 65_536 }),
})

export interface TuiStandardParticipantHost {
  readonly questions: QuestionStore
  readonly approvals: ApprovalStore
  notify(text: string, options?: { readonly color?: 'error' | 'warning'; readonly timeoutMs?: number }): void
  readonly writeRaw?: (value: string) => void
  readonly openExternal?: (uri: string, signal: AbortSignal) => void | Promise<void>
}

export interface TuiStandardParticipantBinding {
  readonly participantId: string
  dispose(): Promise<void>
}

export interface TuiStandardParticipantReady {
  readonly participantId: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStandardParticipant: TuiStandardParticipantReady
  }
}

/** Publish the terminal's real presentation capabilities through the standard lifecycle. */
export async function mountTuiStandardParticipant(
  adapter: DshStandardAdapter,
  host: TuiStandardParticipantHost,
): Promise<TuiStandardParticipantBinding> {
  const redirects = new TuiExternalRedirectReceiver()
  const manifest = defineComponentManifest({
    apiVersion: 'manifest.dsh/internal/v1alpha1',
    kind: 'Component',
    metadata: { name: COMPONENT, displayName: 'dsh-TUI', version: VERSION },
    spec: {
      facets: [{
        name: FACET,
        activation: {
          apiVersion: 'lifecycle.dsh/v1alpha1',
          kind: 'FacetModule',
          spec: { module: '@deepseek-harness-tui/dsh-tui/standards' },
        },
        protocols: {
          supports: [
            notificationSupport,
            copyTextSupport,
            openExternalSupport,
            userInteractionSupport(INTERACTION_SPEC),
            externalRedirectSupport,
          ],
        },
      }],
    },
  })

  let participantId: string | undefined
  const dispose = await adapter.mount({
    manifest,
    facet: FACET,
    activate(context) {
      participantId = context.identity.participantId
      context.protocols.implement(
        notificationSupport,
        notificationImplementation(participantId, {
          notify(request) {
            host.notify(request.text, {
              ...(request.level === 'error' || request.level === 'warning' ? { color: request.level } : {}),
            })
            return { status: 'submitted', value: { accepted: true } }
          },
        }),
      )
      context.protocols.implement(
        copyTextSupport,
        copyTextImplementation(participantId, {
          async copyText(request) {
            const raw = await setClipboard(request.text)
            if (raw !== '') (host.writeRaw ?? (value => process.stdout.write(value)))(raw)
            return { status: 'submitted', value: { accepted: true } }
          },
        }),
      )
      context.protocols.implement(
        openExternalSupport,
        openExternalImplementation(participantId, {
          async openExternal(request, capabilityContext) {
            try {
              await (host.openExternal ?? launchExternalUri)(request.uri, capabilityContext.signal)
              return { status: 'submitted', value: { accepted: true } }
            } catch {
              return capabilityContext.signal.aborted ? { status: 'cancelled' } : { status: 'unavailable' }
            }
          },
        }),
      )
      context.protocols.implement(
        userInteractionSupport(INTERACTION_SPEC),
        userInteractionImplementation(participantId, INTERACTION_SPEC, {
          interact: ((request: UserInteractionRequest, capabilityContext: CapabilityHandlerContext) =>
            interact(host, request, capabilityContext)) as UserInteractionHandler['interact'],
        }),
      )
      context.protocols.implement(
        externalRedirectSupport,
        externalRedirectImplementation(participantId, redirects),
      )
    },
  })
  if (participantId === undefined) {
    await dispose()
    throw new Error('dsh-tui presentation participant activated without an identity')
  }
  return Object.freeze({
    participantId,
    async dispose() {
      await dispose()
      await redirects.dispose()
    },
  })
}

async function launchExternalUri(uri: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const invocation = process.platform === 'win32'
    ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', uri] }
    : process.platform === 'darwin'
      ? { command: 'open', args: [uri] }
      : { command: 'xdg-open', args: [uri] }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      child.removeListener('error', fail)
      child.removeListener('spawn', ready)
    }
    const abort = (): void => {
      cleanup()
      child.kill()
      reject(signal.reason instanceof Error ? signal.reason : new Error('open external cancelled'))
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const ready = (): void => {
      cleanup()
      child.unref()
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', fail)
    child.once('spawn', ready)
  })
}

async function interact(
  host: TuiStandardParticipantHost,
  request: UserInteractionRequest,
  context: CapabilityHandlerContext,
): Promise<PresentationResult<UserInteractionValue>> {
  const deadline = requestDeadline(request, context.signal)
  if (deadline.expired()) return { status: 'expired' }
  try {
    if (request.kind === 'question') return await askQuestion(host.questions, request, deadline.signal)
    if (request.kind === 'approval') return await askApproval(host.approvals, request, deadline.signal)
    return await askSecret(host.questions, request, deadline.signal)
  } catch {
    return deadline.expired() ? { status: 'expired' } : { status: 'cancelled' }
  } finally {
    deadline.dispose()
  }
}

async function askQuestion(
  store: QuestionStore,
  request: QuestionRequest,
  signal: AbortSignal,
): Promise<PresentationResult<QuestionAnswers>> {
  const agentQuestion = agentQuestionPresentation(request)
  if (agentQuestion !== undefined) {
    const answer = await store.ask({ questions: [...agentQuestion.questions], signal })
    return { status: 'submitted', value: agentQuestion.answer(answer) }
  }
  const fields = request.fields.map(field => presentField(field, request))
  const answer = await store.ask({ questions: fields.map(row => row.item), signal })
  const answers: Record<string, string | boolean | readonly string[]> = {}
  for (const submitted of answer.answers) {
    const field = fields.find(row => row.item.id === submitted.id)
    if (field === undefined) continue
    const value = field.read(submitted.selected, submitted.custom)
    if (value !== undefined) answers[submitted.id] = value
  }
  return { status: 'submitted', value: { answers } }
}

async function askApproval(
  store: ApprovalStore,
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<PresentationResult<{ readonly decision: 'approved' | 'denied' }>> {
  const command = request.details?.find(row => row.label === 'Command')?.value
  const details = request.details?.filter(row => row.label !== 'Command').map(row => `${row.label}: ${row.value}`).join('\n')
  const outcome = await store.parkExternal({
    toolName: request.action,
    reason: details === undefined ? request.summary : `${request.summary}\n${details}`,
    ...(command === undefined ? {} : { command }),
    events: [],
    signal,
  })
  if (outcome === 'cancelled' || outcome === 'unavailable') return { status: 'cancelled' }
  return { status: 'submitted', value: { decision: outcome === 'allowed-once' ? 'approved' : 'denied' } }
}

async function askSecret(
  store: QuestionStore,
  request: SecretInputRequest,
  signal: AbortSignal,
): Promise<PresentationResult<{ readonly secret: string }>> {
  const answer = await store.ask({
    questions: [{ id: 'secret', question: request.label, detail: request.description }],
    signal,
  }, { redact: true })
  const submitted = answer.answers[0]
  return { status: 'submitted', value: { secret: submitted?.custom ?? submitted?.selected[0] ?? '' } }
}

function presentField(field: QuestionField, request: QuestionRequest): {
  item: {
    id: string
    question: string
    detail?: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }
  read(selected: readonly string[], custom: string | undefined): string | boolean | readonly string[] | undefined
} {
  const detail = [request.description, field.description].filter(Boolean).join('\n') || undefined
  if (field.kind === 'text') {
    return {
      item: { id: field.id, question: field.label, detail, header: request.title },
      read: (_selected, custom) => custom,
    }
  }
  if (field.kind === 'confirm') {
    return {
      item: {
        id: field.id, question: field.label, detail, header: request.title,
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
      read: selected => selected[0] === 'Yes' ? true : selected[0] === 'No' ? false : undefined,
    }
  }
  const duplicateLabels = new Set(field.options
    .filter((option, index, all) => all.findIndex(candidate => candidate.label === option.label) !== index)
    .map(option => option.label))
  const labels = new Map(field.options.map(option => {
    const label = duplicateLabels.has(option.label) ? `${option.label} [${option.id}]` : option.label
    return [label, option.id] as const
  }))
  return {
    item: {
      id: field.id, question: field.label, detail, header: request.title,
      options: field.options.map(option => ({
        label: duplicateLabels.has(option.label) ? `${option.label} [${option.id}]` : option.label,
        description: option.description,
      })),
      multiSelect: field.multiple,
    },
    read: selected => {
      const values = selected.map(label => labels.get(label)).filter((value): value is string => value !== undefined)
      return field.multiple === true ? values : values[0]
    },
  }
}

function requestDeadline(request: { readonly deadline?: string }, parent: AbortSignal): {
  readonly signal: AbortSignal
  expired(): boolean
  dispose(): void
} {
  const controller = new AbortController()
  let expired = request.deadline !== undefined && Date.parse(request.deadline) <= Date.now()
  const abort = (): void => controller.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  let timer: NodeJS.Timeout | undefined
  if (!expired && request.deadline !== undefined) {
    timer = setTimeout(() => {
      expired = true
      controller.abort(new Error('presentation request expired'))
    }, Math.max(0, Date.parse(request.deadline) - Date.now()))
    timer.unref()
  }
  if (parent.aborted) abort()
  if (expired) controller.abort(new Error('presentation request expired'))
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose() {
      parent.removeEventListener('abort', abort)
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

export function provideTuiStandardParticipant(ctx: Context, binding: TuiStandardParticipantBinding): void {
  ctx.provide('tuiStandardParticipant', Object.freeze({ participantId: binding.participantId }))
}
