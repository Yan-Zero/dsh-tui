/** DSH Agent interaction shapes adapted onto the standard Presentation protocol. */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  ApprovalInput,
  PresentationResult,
  QuestionAnswers,
  QuestionInput,
  QuestionField,
  QuestionRequest,
  UserInteractionClient,
} from '@dsh-std/presentation'

export interface AgentApprovalPresentationInput {
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly command?: string
}

export interface TuiAgentPresentationRoute {
  ask(
    questions: readonly AskUserQuestionItem[],
    signal?: AbortSignal,
  ): Promise<PresentationResult<AskUserQuestionAnswer>>
  approve(
    input: AgentApprovalPresentationInput,
    signal?: AbortSignal,
  ): Promise<PresentationResult<'allowed-once' | 'rejected'>>
}

interface QuestionBinding {
  readonly source: AskUserQuestionItem
  readonly fieldId: string
  readonly customFieldId?: string
  readonly options: ReadonlyMap<string, string>
  readonly text: boolean
}

export interface AgentQuestionPresentation {
  readonly questions: readonly AskUserQuestionItem[]
  answer(value: AskUserQuestionAnswer): QuestionAnswers
}

/** Bind DSH's native Agent callbacks to a negotiated standard interaction client. */
export function agentPresentationRoute(client: UserInteractionClient): TuiAgentPresentationRoute {
  return Object.freeze({
    async ask(questions, signal) {
      const mapped = questionInput(questions)
      const result = await invokePresentation(
        () => client.interact(mapped.input, { signal }),
        signal,
      )
      if (result.status !== 'submitted') return result
      return { status: 'submitted' as const, value: questionAnswer(mapped.bindings, result.value) }
    },
    async approve(input, signal) {
      const result = await invokePresentation(
        () => client.interact(approvalInput(input), { signal }),
        signal,
      )
      if (result.status !== 'submitted') return result
      const outcome: 'allowed-once' | 'rejected' = result.value.decision === 'approved'
        ? 'allowed-once'
        : 'rejected'
      return {
        status: 'submitted' as const,
        value: outcome,
      }
    },
  })
}

async function invokePresentation<T>(
  invoke: () => Promise<PresentationResult<T>>,
  signal: AbortSignal | undefined,
): Promise<PresentationResult<T>> {
  try {
    return await invoke()
  } catch (error) {
    return signal?.aborted === true
      ? { status: 'cancelled' }
      : { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

function questionInput(questions: readonly AskUserQuestionItem[]): {
  readonly input: QuestionInput
  readonly bindings: readonly QuestionBinding[]
} {
  if (questions.length === 0) throw new TypeError('Agent question request must not be empty')
  const singleTitle = questions.length === 1 ? questions[0]?.header : undefined
  const bindings: QuestionBinding[] = []
  const fields: QuestionField[] = []
  for (const [questionIndex, question] of questions.entries()) {
    const planReview = question.intent?.kind === 'plan-review'
    const fieldId = `dsh_agent_${planReview ? 'plan' : 'question'}_${String(questionIndex + 1)}`
    const optionLabels = new Map<string, string>()
    const description = questions.length === 1 || question.header === undefined
      ? question.detail
      : [question.header, question.detail].filter((value): value is string => value !== undefined).join('\n')
    if (question.options !== undefined && question.options.length > 0) {
      const options = question.options.map((option, optionIndex) => {
        const id = `${planReview && option.label === question.intent?.approve ? 'approve' : 'option'}_${String(optionIndex + 1)}`
        optionLabels.set(id, option.label)
        return { id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) }
      })
      const customFieldId = `${fieldId}_custom`
      bindings.push({ source: question, fieldId, customFieldId, options: optionLabels, text: false })
      fields.push({
        id: fieldId,
        kind: 'select',
        label: question.question,
        ...(description === undefined ? {} : { description }),
        multiple: question.multiSelect === true,
        options,
      })
      fields.push({
        id: customFieldId,
        kind: 'text',
        label: `${question.question} — Other`,
      })
      continue
    }
    bindings.push({ source: question, fieldId, options: optionLabels, text: true })
    fields.push({
      id: fieldId,
      kind: 'text',
      label: question.question,
      ...(description === undefined ? {} : { description }),
      required: true,
    })
  }
  return {
    input: {
      kind: 'question',
      ...(singleTitle === undefined ? {} : { title: singleTitle }),
      fields,
    },
    bindings,
  }
}

function questionAnswer(
  bindings: readonly QuestionBinding[],
  value: QuestionAnswers,
): AskUserQuestionAnswer {
  return {
    answers: bindings.map(binding => {
      const answer = value.answers[binding.fieldId]
      if (binding.text) {
        return {
          id: binding.source.id,
          selected: [],
          ...(typeof answer === 'string' ? { custom: answer } : {}),
        }
      }
      const selected = (Array.isArray(answer) ? answer : [answer])
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map(candidate => binding.options.get(candidate))
        .filter((candidate): candidate is string => candidate !== undefined)
      const custom = binding.customFieldId === undefined ? undefined : value.answers[binding.customFieldId]
      return {
        id: binding.source.id,
        selected,
        ...(typeof custom === 'string' && custom !== '' ? { custom } : {}),
      }
    }),
  }
}

/** Recognize and restore the adapter's lossless encoding of native Agent questions. */
export function agentQuestionPresentation(request: QuestionRequest): AgentQuestionPresentation | undefined {
  const mains = request.fields.filter(field => /^dsh_agent_(?:question|plan)_\d+$/u.test(field.id))
  if (mains.length === 0) return undefined
  const allowed = new Set(mains.flatMap(field => [field.id, `${field.id}_custom`]))
  if (request.fields.some(field => !allowed.has(field.id))) return undefined
  const questions: AskUserQuestionItem[] = []
  for (const field of mains) {
    if (field.kind === 'confirm') return undefined
    if (field.kind === 'text') {
      questions.push({
        id: field.id,
        question: field.label,
        ...(field.description === undefined ? {} : { detail: field.description }),
        ...(request.title === undefined ? {} : { header: request.title }),
      })
      continue
    }
    const approve = field.options.find(option => option.id.startsWith('approve_'))?.label
    questions.push({
      id: field.id,
      question: field.label,
      ...(field.description === undefined ? {} : { detail: field.description }),
      ...(request.title === undefined ? {} : { header: request.title }),
      options: field.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      multiSelect: field.multiple === true,
      ...(field.id.startsWith('dsh_agent_plan_') && approve !== undefined
        ? { intent: { kind: 'plan-review' as const, approve } }
        : {}),
    })
  }
  return Object.freeze({
    questions: Object.freeze(questions),
    answer(value: AskUserQuestionAnswer): QuestionAnswers {
      const answers: Record<string, string | readonly string[]> = {}
      for (const field of mains) {
        const submitted = value.answers.find(answer => answer.id === field.id)
        if (submitted === undefined) continue
        if (field.kind === 'text') {
          const text = submitted.custom ?? submitted.selected[0]
          if (text !== undefined) answers[field.id] = text
          continue
        }
        if (field.kind !== 'select') continue
        const optionIds = submitted.selected.map(label => field.options.find(option => option.label === label)?.id)
          .filter((id): id is string => id !== undefined)
        if (field.multiple === true) answers[field.id] = optionIds
        else if (optionIds[0] !== undefined) answers[field.id] = optionIds[0]
        if (submitted.custom !== undefined) answers[`${field.id}_custom`] = submitted.custom
      }
      return { answers }
    },
  })
}

function approvalInput(input: AgentApprovalPresentationInput): ApprovalInput {
  const details = [
    ...(input.callId === undefined ? [] : [{ label: 'Call ID', value: input.callId }]),
    ...(input.command === undefined ? [] : [{ label: 'Command', value: input.command }]),
  ]
  return {
    kind: 'approval',
    action: input.toolName,
    summary: input.reason ?? `Allow ${input.toolName} for this request?`,
    ...(details.length === 0 ? {} : { details }),
  }
}

export function presentationFailureToApproval(
  result: Exclude<PresentationResult<unknown>, { readonly status: 'submitted' }>,
): ApprovalOutcome {
  return result.status === 'cancelled' ? 'cancelled' : 'unavailable'
}
