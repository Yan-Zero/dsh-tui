import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { registerProfileProtocols } from 'dsh-ecosystem-spec/protocols'
import type { Channel } from '../src/tui-contract/channel.js'
import { ApprovalStore } from '../src/dsh-adapter/approvals.js'
import { QuestionStore } from '../src/dsh-adapter/questions.js'
import { RemoteInteractionBroker } from '../src/dsh-adapter/channel-provider.js'
import { TuiPresentationRelay, mountTuiPresentationRelay } from '../src/std-adapter/presentation-relay.js'
import { mountTuiStandardParticipant } from '../src/std-adapter/standard-participant.js'
import { connectTuiChannelHttp, listenTuiChannelHttp } from '../src/std-adapter/channel-http.js'
import {
  mountTuiChannelConsumer,
  mountTuiChannelProvider,
  openRemoteTuiChannel,
  tuiConnectionEndpoint,
} from '../src/std-adapter/channel-connection.js'

const serverContext = new Context()
const clientContext = new Context()
let executed = 0

await serverContext.plugin(SystemPrompt)
await serverContext.plugin(ToolRuntime)
await serverContext.plugin(ApprovalService)

const events: Array<{ type: string; data: Record<string, unknown> }> = [
  { type: 'turn/start', data: { turn: 1 } },
]
const agent = {
  id: 'remote-approval-agent',
  session: {
    id: 'remote-approval-session',
    header: {},
    events,
    append(type: string, data: Record<string, unknown>) {
      const event = { type, data }
      events.push(event)
      return event
    },
  },
} as unknown as Agent

const shellProbe = defineTool({
  name: 'shell_probe',
  description: 'Executes a command only after the configured policy permits it.',
  parameters: { command: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    executed += 1
    return args.command
  },
})
serverContext.tools.register(shellProbe)
serverContext.on('tools/pre-execute', async (execution, next): Promise<PreToolDecision> => {
  const command = (execution.arguments as { command?: unknown }).command
  if (typeof command !== 'string' || !/(?:^|\s)rm(?:\s|$)/u.test(command)) return next()
  return { kind: 'ask', reason: `Policy requires a human for: ${command}` }
})

const serverAdapter = new DshStandardAdapter(serverContext, { profile: 'remote-approval-server' })
const clientAdapter = new DshStandardAdapter(clientContext, { profile: 'remote-approval-client' })
const unregisterServerProtocols = registerProfileProtocols(serverAdapter.protocols)
const unregisterClientProtocols = registerProfileProtocols(clientAdapter.protocols)
const remoteChannel = fakeChannel('/remote/workspace')
const terminalChannel = fakeChannel(process.cwd())
const approvalStore = new ApprovalStore()
const questionStore = new QuestionStore()
const relay = new TuiPresentationRelay()
const relayBinding = await mountTuiPresentationRelay(serverAdapter, relay)
const presentation = await mountTuiStandardParticipant(clientAdapter, {
  questions: questionStore,
  approvals: approvalStore,
  notify() {},
})
const interactions = new RemoteInteractionBroker(serverContext, relay)
const unregisterApprovals = serverContext.on('approval/request', (request, next) => interactions.approve(request, next))
const provider = await mountTuiChannelProvider(serverAdapter, {
  open: () => {
    const route = interactions.attach(agent)
    return { channel: remoteChannel, dispose: () => route.dispose() }
  },
}, relay)
const consumer = await mountTuiChannelConsumer(clientAdapter)
const serverEndpoint = tuiConnectionEndpoint(serverAdapter.connectionEndpoint)
const clientEndpoint = tuiConnectionEndpoint(clientAdapter.connectionEndpoint)
const releaseRelayDeclaration = serverEndpoint.registerDeclaration(relayBinding.consumerDeclaration)
const http = await listenTuiChannelHttp(serverEndpoint, serverAdapter.protocols, {
  port: 0,
  onConnection: connection => relay.attach(connection, serverEndpoint.participantId(relayBinding.consumerParticipantId)),
})
const connection = await connectTuiChannelHttp(http.origin, clientEndpoint, clientAdapter.protocols)
const remote = await openRemoteTuiChannel(connection, clientEndpoint.participantId(consumer.participantId), {
  terminalChannel,
})

try {
  const safe = await execute('pwd', 'safe')
  assert(!safe.isError, 'the policy unexpectedly blocked a command without rm')
  assert(executed === 1, 'the safe command did not execute exactly once')
  assert(approvalStore.getSnapshot() === null, 'the safe command opened an approval prompt')

  const allowed = execute('rm -rf ./build-cache', 'allow')
  await eventually(() => approvalStore.getSnapshot() !== null)
  const allowedSnapshot = approvalStore.getSnapshot()
  assert(allowedSnapshot?.toolName === 'shell_probe', 'the visible terminal received the wrong tool identity')
  assert(allowedSnapshot.command === 'rm -rf ./build-cache', 'the visible terminal did not receive the gated command')
  assert(allowedSnapshot.reason?.includes('rm -rf ./build-cache') === true, 'the visible terminal did not receive the policy reason')
  assert(executed === 1, 'the remote tool executed before the user answered')
  assert(!(await settledWithin(allowed, 40)), 'the remote tool call settled before the user answered')
  approvalStore.decide('allowed-once')
  const allowedResult = await allowed
  assert(!allowedResult.isError, 'allowed-once did not release the remote tool call')
  assert(executed === 2, 'allowed-once did not execute the remote tool exactly once')

  const rejected = execute('rm ./important.txt', 'reject')
  await eventually(() => approvalStore.getSnapshot()?.command === 'rm ./important.txt')
  assert(executed === 2, 'the rejected remote tool executed before the user answered')
  approvalStore.decide('rejected')
  const rejectedResult = await rejected
  assert(rejectedResult.isError, 'a rejected approval returned a successful tool result')
  assert(executed === 2, 'a rejected remote tool was executed')

  const answered = interactions.ask({
    agent,
    questions: [{
      id: 'remote-question',
      question: 'Which terminal answered?',
      detail: 'The native Agent question must cross through standard Presentation.',
      header: 'Plan review',
      options: [{ label: 'visible-terminal' }, { label: 'other-terminal' }],
      intent: { kind: 'plan-review', approve: 'visible-terminal' },
    }],
  })
  await eventually(() => questionStore.getSnapshot()?.question.id === 'dsh_agent_plan_1')
  assert(questionStore.getSnapshot()?.question.header === 'Plan review', 'Agent question heading was lost in the Presentation adapter')
  assert(questionStore.getSnapshot()?.question.detail?.includes('standard Presentation') === true, 'Agent question detail was lost in the Presentation adapter')
  assert(questionStore.getSnapshot()?.question.options?.[0]?.label === 'visible-terminal', 'Agent question options were not mapped to Presentation fields')
  assert(questionStore.getSnapshot()?.question.intent?.kind === 'plan-review', 'Agent question presentation intent was not restored by the TUI adapter')
  questionStore.answerCurrent({ selected: ['other-terminal'], custom: 'revise the plan' })
  const answer = await answered
  assert(answer.answers[0]?.selected[0] === 'other-terminal', 'remote question selection did not return to the Agent authority')
  assert(answer.answers[0]?.custom === 'revise the plan', 'remote question feedback did not return to the Agent authority')

  const disconnected = execute('rm ./while-disconnecting', 'disconnect')
  await eventually(() => approvalStore.getSnapshot()?.command === 'rm ./while-disconnecting')
  assert(executed === 2, 'the disconnect probe executed before approval')
  await remote.dispose()
  const disconnectedResult = await disconnected
  assert(disconnectedResult.isError, 'disconnecting a pending approval returned a successful tool result')
  assert(executed === 2, 'disconnecting a pending approval released the remote tool')
  assert(approvalStore.getSnapshot() === null, 'disconnect left a stale approval panel behind')

  const unattended = await execute('rm ./without-terminal', 'unattended')
  assert(unattended.isError, 'an rm command without a connected terminal was allowed')
  assert(executed === 2, 'an rm command without a connected terminal executed')

  const decisions = events
    .filter(event => event.type === 'approval/decided')
    .map(event => event.data.outcome)
  assert(decisions[0] === 'allowed-once', 'the remote allowed-once decision was not audited')
  assert(decisions[1] === 'rejected', 'the remote rejection was not audited')
  assert(decisions.slice(2).every(outcome => outcome !== 'allowed-once'), 'a fail-closed path was audited as allowed')

  process.stdout.write('remote Agent callbacks use standard Presentation and approval fails closed on disconnect OK\n')
} finally {
  await remote.dispose()
  connection.close('remote approval verification complete')
  await http.close()
  await consumer.dispose()
  await provider.dispose()
  releaseRelayDeclaration()
  await presentation.dispose()
  await relayBinding.dispose()
  interactions.dispose()
  unregisterApprovals()
  unregisterClientProtocols()
  unregisterServerProtocols()
  await clientContext.fiber.dispose()
  await serverContext.fiber.dispose()
}

async function execute(command: string, suffix: string) {
  const callId = CallId(`remote-approval-${suffix}`)
  agent.session.append('tool/call', {
    callId,
    name: 'shell_probe',
    arguments: JSON.stringify({ command }),
  })
  return serverContext.tools.execute({
    callId,
    name: 'shell_probe',
    arguments: { command },
    agent,
    signal: new AbortController().signal,
  })
}

function fakeChannel(cwd: string): Channel {
  const listeners = new Set<() => void>()
  const state: Record<string, unknown> = {
    version: 1, rows: [], status: 'idle', sessionTitle: 'Remote approval verification',
    agentId: String(agent.id), model: 'verification-model', provider: 'verification-provider',
    tokens: { input: 0, output: 0 }, cwd, displayCwd: cwd, working: false,
    spinnerMode: 'thinking', responseChars: 0, activeToolCount: 0, turnStart: 0,
    lastUserText: '', notifications: [], tpsSamples: [], activityEnabled: true,
    contextBarEnabled: true, diffLayout: 'auto', todos: [], pending: [], commandList: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default' }, modeIndex: 0,
  }
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    subscribe: listener => { listeners.add(listener as () => void); return () => listeners.delete(listener as () => void) },
    commandCompletions: () => [], settingsSections: () => [], subscribeSettingsSections: () => () => {},
    workspaceCommands: () => [], traceEvents: () => [], mcpStatus: () => [], configInfo: () => [], doctorInfo: () => [],
    settingsHost: () => undefined, providerSetup: () => undefined, setDiffLayout: () => {},
    setActivityFrames: () => true, openPluginScene: () => false, closePluginScene: () => {},
    releaseContributions: () => {}, notify: () => {}, pushLocal: () => {},
  }
  return new Proxy({} as Channel, {
    get(_target, property) {
      if (typeof property === 'string' && property in methods) return methods[property]
      if (typeof property === 'string' && property in state) return state[property]
      return undefined
    },
  })
}

async function eventually(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('remote approval condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const marker = Symbol('pending')
  return await Promise.race([promise.then(() => true), new Promise<typeof marker>(resolve => setTimeout(() => resolve(marker), timeoutMs))]) !== marker
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
