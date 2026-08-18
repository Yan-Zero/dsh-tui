import { Context } from '@deepseek-ai/cordis'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { registerProfileProtocols } from 'dsh-ecosystem-spec/protocols'
import type { Channel } from '../src/tui-contract/channel.js'
import { listenTuiChannelHttp, connectTuiChannelHttp } from '../src/std-adapter/channel-http.js'
import { mountTuiChannelConsumer, mountTuiChannelProvider, openRemoteTuiChannel, tuiConnectionEndpoint } from '../src/std-adapter/channel-connection.js'

const serverContext = new Context()
const clientContext = new Context()

try {
  const serverAdapter = new DshStandardAdapter(serverContext, { profile: 'tui-server-verification' })
  const clientAdapter = new DshStandardAdapter(clientContext, { profile: 'tui-client-verification' })
  const unregisterServerProtocols = registerProfileProtocols(serverAdapter.protocols)
  const unregisterClientProtocols = registerProfileProtocols(clientAdapter.protocols)
  const fake = fakeChannel('/remote/workspace')
  const provider = await mountTuiChannelProvider(serverAdapter, {
    open: request => {
      if (request.workspace !== '/remote/workspace') throw new Error(`unexpected workspace ${request.workspace}`)
      return { channel: fake.channel, dispose() {} }
    },
  })
  const consumer = await mountTuiChannelConsumer(clientAdapter)
  const serverEndpoint = tuiConnectionEndpoint(serverAdapter.connectionEndpoint)
  const clientEndpoint = tuiConnectionEndpoint(clientAdapter.connectionEndpoint)
  const http = await listenTuiChannelHttp(serverEndpoint, serverAdapter.protocols, { port: 0 })
  const health = await fetch(`${http.origin}/dsh-tui/v1/health`)
  if (!health.ok || (await health.json() as { ok?: unknown }).ok !== true) throw new Error('TUI Channel health endpoint failed')
  const connection = await connectTuiChannelHttp(http.origin, clientEndpoint, clientAdapter.protocols)
  const remote = await openRemoteTuiChannel(connection, clientEndpoint.participantId(consumer.participantId), {
    workspace: '/remote/workspace',
    terminalChannel: fake.channel,
  })
  if (remote.channel.cwd !== '/remote/workspace') throw new Error(`remote Channel snapshot has cwd ${remote.channel.cwd}`)
  remote.channel.submit('hello over HTTP')
  await eventually(() => fake.submitted.includes('hello over HTTP'))
  fake.setCwd('/remote/changed')
  await eventually(() => remote.channel.cwd === '/remote/changed')
  if ((await remote.channel.listFiles()).join(',') !== 'AGENTS.md,src/index.ts') throw new Error('remote Channel method result was not returned')
  await remote.dispose()
  connection.close('verification complete')
  await http.close()
  await consumer.dispose()
  await provider.dispose()
  unregisterClientProtocols()
  unregisterServerProtocols()
  process.stdout.write('dsh-tui HTTP endpoint, standard negotiation, Channel snapshot and invocation OK\n')
} finally {
  await clientContext.fiber.dispose()
  await serverContext.fiber.dispose()
}

function fakeChannel(initialCwd: string): {
  readonly channel: Channel
  readonly submitted: string[]
  setCwd(value: string): void
} {
  const listeners = new Set<() => void>()
  const submitted: string[] = []
  const state: Record<string, unknown> = {
    version: 1,
    rows: [],
    status: 'idle',
    sessionTitle: 'Remote verification',
    agentId: 'remote-verification',
    model: 'verification-model',
    provider: 'verification-provider',
    tokens: { input: 0, output: 0 },
    cwd: initialCwd,
    displayCwd: initialCwd,
    working: false,
    spinnerMode: 'thinking',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    notifications: [],
    tpsSamples: [],
    activityEnabled: true,
    contextBarEnabled: true,
    todos: [],
    pending: [],
    commandList: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default' },
    modeIndex: 0,
  }
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    subscribe: listener => { listeners.add(listener as () => void); return () => listeners.delete(listener as () => void) },
    submit: text => { submitted.push(String(text)) },
    listFiles: async () => ['AGENTS.md', 'src/index.ts'],
    workspaceCommands: () => [], traceEvents: () => [], mcpStatus: () => [], configInfo: () => [], doctorInfo: () => [],
    settingsHost: () => undefined, providerSetup: () => undefined, settingsSections: () => [],
    subscribeSettingsSections: () => () => {}, commandCompletions: () => [],
    setDiffLayout: () => {}, setActivityFrames: () => true, openPluginScene: () => false,
    closePluginScene: () => {}, releaseContributions: () => {}, notify: () => {}, pushLocal: () => {},
  }
  const channel = new Proxy({} as Channel, {
    get(_target, property) {
      if (typeof property === 'string' && property in methods) return methods[property]
      if (typeof property === 'string' && property in state) return state[property]
      return undefined
    },
  })
  return {
    channel,
    submitted,
    setCwd(value) {
      state.cwd = value
      state.displayCwd = value
      state.version = Number(state.version) + 1
      for (const listener of listeners) listener()
    },
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
