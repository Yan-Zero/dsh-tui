import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { registerProfileProtocols } from 'dsh-ecosystem-spec/protocols'
import type { Channel } from '../src/tui-contract/channel.js'
import { listenTuiChannelHttp } from '../src/std-adapter/channel-http.js'
import { mountTuiChannelProvider, tuiConnectionEndpoint } from '../src/std-adapter/channel-connection.js'
import { DirectTuiBackend } from '../src/std-adapter/direct-backend.js'

const serverContext = new Context()
const clientContext = new Context()

try {
  const serverAdapter = new DshStandardAdapter(serverContext, { profile: 'direct-backend-server' })
  const clientAdapter = new DshStandardAdapter(clientContext, { profile: 'direct-backend-client' })
  const unregisterServerProtocols = registerProfileProtocols(serverAdapter.protocols)
  const unregisterClientProtocols = registerProfileProtocols(clientAdapter.protocols)
  const authority = simpleChannel('/remote')
  const terminal = simpleChannel('/local')
  let released = 0
  let opened = 0
  let openedOptions: unknown
  const provider = await mountTuiChannelProvider(serverAdapter, {
    open: request => {
      opened += 1
      openedOptions = request.options
      return { channel: authority.channel, dispose() { released += 1 } }
    },
  })
  const http = await listenTuiChannelHttp(tuiConnectionEndpoint(serverAdapter.connectionEndpoint), serverAdapter.protocols, { port: 0 })
  const backend = new DirectTuiBackend(clientAdapter)
  const binding = backend.attach({
    channel: terminal.channel,
    askQuestions: async () => ({ answers: [] }),
    requestApproval: async () => 'allowed-once',
    locale: () => 'en',
  })
  const channel = binding.channel as Channel
  const request = (name: string, input = '') => ({ channel, name, input, present() {} })
  let settingsSectionChanges = 0
  const unsubscribeSettingsSections = channel.subscribeSettingsSections(() => { settingsSectionChanges += 1 })

  const versionBeforeConnect = channel.version
  let observedConnectVersion = versionBeforeConnect
  const unsubscribeVersion = channel.subscribe(() => { observedConnectVersion = channel.version })
  if (binding.handleCommand?.(request('connect', http.origin)) !== true) throw new Error('/connect was not claimed')
  if (channel.version <= versionBeforeConnect || observedConnectVersion !== channel.version) {
    throw new Error('backend switch did not advance the observable Channel version')
  }
  unsubscribeVersion()
  if (channel.commandList.some(command => command.name === 'connect')) throw new Error('/connect remained visible while connecting')
  if (!channel.commandList.some(command => command.name === 'disconnect')) throw new Error('/disconnect was not available to cancel a connection')
  if (binding.handleCommand?.(request('connect', http.origin)) !== true) throw new Error('concurrent /connect was not claimed')
  await eventually(() => channel.cwd === '/remote')
  if (settingsSectionChanges === 0) throw new Error('settings-section subscription did not survive the backend switch')
  const settingsChangesBeforeAuthorityEvent = settingsSectionChanges
  authority.addSettingsSection()
  await eventually(() => settingsSectionChanges > settingsChangesBeforeAuthorityEvent)
  if (opened !== 1) throw new Error(`concurrent /connect opened ${String(opened)} remote Channels`)
  if (isRecord(openedOptions) && Object.hasOwn(openedOptions, 'modes')) {
    throw new Error('/connect leaked terminal session modes into the Agent authority')
  }
  if (channel.commandList.some(command => command.name === 'connect')) throw new Error('/connect remained visible while connected')
  if (!channel.commandList.some(command => command.name === 'disconnect')) throw new Error('/disconnect was not visible while connected')
  if (binding.handleCommand?.(request('disconnect')) !== true) throw new Error('/disconnect was not claimed')
  await eventually(() => channel.cwd === '/local' && released === 1)

  if (binding.handleCommand?.(request('connect', http.origin)) !== true) throw new Error('second /connect was not claimed')
  await eventually(() => channel.cwd === '/remote')
  await http.close()
  await eventually(() => channel.cwd === '/local' && released === 2)

  const stalled = createServer(() => undefined)
  await new Promise<void>((resolve, reject) => {
    stalled.once('error', reject)
    stalled.listen(0, '127.0.0.1', () => resolve())
  })
  const stalledPort = (stalled.address() as AddressInfo).port
  if (binding.handleCommand?.(request('connect', `127.0.0.1:${String(stalledPort)}`)) !== true) {
    throw new Error('stalled /connect was not claimed')
  }
  if (binding.handleCommand?.(request('disconnect')) !== true) throw new Error('/disconnect did not cancel a pending connection')
  await eventually(() => channel.cwd === '/local' && channel.commandList.some(command => command.name === 'connect'))
  stalled.closeAllConnections()
  await new Promise<void>((resolve, reject) => stalled.close(error => error === undefined ? resolve() : reject(error)))

  if (binding.handleCommand?.(request('connect', 'ssh user@example')) !== false) throw new Error('SSH syntax was claimed by the direct HTTP backend')
  unsubscribeSettingsSections()
  await binding.dispose?.()
  await backend.dispose()
  await provider.dispose()
  unregisterClientProtocols()
  unregisterServerProtocols()
  process.stdout.write('/connect progress, cancellation, /disconnect and transport-loss restoration OK\n')
} finally {
  await clientContext.fiber.dispose()
  await serverContext.fiber.dispose()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function simpleChannel(cwd: string) {
  const listeners = new Set<() => void>()
  const settingsSectionListeners = new Set<() => void>()
  const state: Record<string, unknown> = {
    version: 1, rows: [], status: 'idle', sessionTitle: cwd, agentId: cwd, model: 'model', provider: 'provider',
    tokens: { input: 0, output: 0 }, cwd, displayCwd: cwd, working: false, spinnerMode: 'thinking', responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: '', notifications: [], tpsSamples: [], activityEnabled: true,
    contextBarEnabled: true, diffLayout: 'auto', todos: [], pending: [],
    commandList: [{ name: 'connect', description: 'connect' }, { name: 'help', description: 'help' }],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, mode: { id: 'default' }, modeIndex: 0,
    settingsSections: [],
  }
  const methods: Record<string, (...args: any[]) => any> = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    commandCompletions: () => [], workspaceCommands: () => [], traceEvents: () => [], mcpStatus: () => [], configInfo: () => [], doctorInfo: () => [],
    settingsHost: () => undefined, providerSetup: () => undefined, settingsSections: () => state.settingsSections,
    subscribeSettingsSections: (listener: () => void) => {
      settingsSectionListeners.add(listener)
      return () => { settingsSectionListeners.delete(listener) }
    },
    setDiffLayout: () => {}, setActivityFrames: () => true, openPluginScene: () => false, closePluginScene: () => {},
    releaseContributions: () => {}, notify: () => {}, pushLocal: () => {}, listFiles: async () => [],
  }
  return {
    channel: new Proxy({} as Channel, {
      get(_target, property) {
        if (typeof property === 'string' && property in methods) return methods[property]
        if (typeof property === 'string' && property in state) return state[property]
        return undefined
      },
    }),
    addSettingsSection() {
      state.settingsSections = [{ ns: 'remote.test', title: 'Remote test', fields: [] }]
      for (const listener of settingsSectionListeners) listener()
    },
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
