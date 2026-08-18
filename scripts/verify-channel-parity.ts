import { Context } from '@deepseek-ai/cordis'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { registerProfileProtocols } from 'dsh-ecosystem-spec/protocols'
import { sessionCwdMatches, type Channel, type StagedImageInput } from '../src/tui-contract/channel.js'
import { connectTuiChannelHttp, listenTuiChannelHttp } from '../src/std-adapter/channel-http.js'
import {
  mountTuiChannelConsumer,
  mountTuiChannelProvider,
  openRemoteTuiChannel,
  tuiConnectionEndpoint,
} from '../src/std-adapter/channel-connection.js'

const serverContext = new Context()
const clientContext = new Context()
const REMOTE_METHODS = [
  'commandCompletions', 'runExternalCommand', 'openPluginScene', 'closePluginScene', 'sideQuestion', 'stageImage', 'submit', 'steer', 'removePending',
  'cancel', 'interruptAndDeliver', 'rewindTo', 'resumeTo', 'newSession', 'listWorkspaces', 'resolveWorkspace',
  'switchWorkspace', 'renameWorkspace', 'runWorkspaceCommand', 'switchModel', 'listEfforts', 'setEffort',
  'cycleMode', 'listPresets', 'switchPreset', 'clear', 'loadOlder', 'listModels', 'listSkills',
  'describeCredential', 'listFiles', 'listSessions', 'previewSession', 'setResumeTarget', 'renameSession',
  'deleteSession', 'renameSessionTo', 'compact', 'exportSession', 'initWorkspace', 'listSubagents',
] as const

try {
  const serverAdapter = new DshStandardAdapter(serverContext, { profile: 'tui-parity-server' })
  const clientAdapter = new DshStandardAdapter(clientContext, { profile: 'tui-parity-client' })
  const unregisterServerProtocols = registerProfileProtocols(serverAdapter.protocols)
  const unregisterClientProtocols = registerProfileProtocols(clientAdapter.protocols)
  const authority = fakeChannel('/authority/workspace')
  const terminal = fakeChannel('/terminal/workspace')
  const provider = await mountTuiChannelProvider(serverAdapter, {
    open: () => ({ channel: authority.channel, dispose() {} }),
  })
  const consumer = await mountTuiChannelConsumer(clientAdapter)
  const serverEndpoint = tuiConnectionEndpoint(serverAdapter.connectionEndpoint)
  const clientEndpoint = tuiConnectionEndpoint(clientAdapter.connectionEndpoint)
  const http = await listenTuiChannelHttp(serverEndpoint, serverAdapter.protocols, { port: 0 })
  const connection = await connectTuiChannelHttp(http.origin, clientEndpoint, clientAdapter.protocols)
  const remote = await openRemoteTuiChannel(connection, clientEndpoint.participantId(consumer.participantId), {
    terminalChannel: terminal.channel,
  })
  const channel = remote.channel

  // Complete state projection: authority-owned fields come from the server;
  // renderer preferences and executable UI contributions stay on the terminal.
  equal(channel.cwd, '/authority/workspace', 'cwd')
  equal(channel.homeDir, '/authority-home', 'authority home directory')
  equal(channel.pathCaseInsensitive, false, 'authority path case sensitivity')
  equal(sessionCwdMatches('/Repo', '/repo', channel.pathCaseInsensitive, channel.homeDir), false, 'authority path comparison')
  equal(sessionCwdMatches('/authority-home', '/authority-home/project', channel.pathCaseInsensitive, channel.homeDir), false, 'authority home boundary')
  equal(channel.sessionTitle, 'Authority session', 'sessionTitle')
  equal(channel.goal?.objective, 'remote goal', 'goal')
  equal(channel.diffLayout, 'split', 'terminal diffLayout')
  const versionBeforeTerminalPreference = channel.version
  channel.setDiffLayout('unified')
  await eventually(() => terminal.called('setDiffLayout'))
  if (channel.version <= versionBeforeTerminalPreference) {
    throw new Error('terminal-owned preference did not advance the observable Channel version')
  }
  if (authority.called('setDiffLayout')) throw new Error('renderer preference crossed the Channel boundary')
  equal(channel.openPluginScene('remote-scene'), true, 'scene open')
  await eventually(() => authority.called('openPluginScene'))
  channel.closePluginScene()
  await eventually(() => authority.called('closePluginScene'))
  authority.channel.openPluginScene('remote-scene')
  await eventually(() => channel.pluginScene?.id === 'remote-scene')
  authority.channel.closePluginScene()
  await eventually(() => channel.pluginScene === undefined)
  const versionBeforeLocalReport = channel.version
  let observedLocalReportVersion = versionBeforeLocalReport
  const unsubscribeLocalReport = channel.subscribe(() => { observedLocalReportVersion = channel.version })
  channel.pushLocal('/status', ['local presentation row'])
  unsubscribeLocalReport()
  if (channel.version <= versionBeforeLocalReport || observedLocalReportVersion !== channel.version) {
    throw new Error('local presentation row did not advance the observable Channel version')
  }
  const localReport = channel.rows.slice(-2)
  equal(localReport[0]?.kind, 'local', 'local report heading kind')
  equal(localReport[0]?.text, '/status', 'local report heading text')
  equal(localReport[1]?.kind, 'local-output', 'local report output kind')
  equal(localReport[1]?.text, 'local presentation row', 'local report output text')
  authority.appendRow({ id: 42, kind: 'notice', text: 'later authority row' })
  await eventually(() => channel.rows.some(row => row.text === 'later authority row'))
  const orderedRows = channel.rows
  if (orderedRows.findIndex(row => row.text === '/status') >= orderedRows.findIndex(row => row.text === 'later authority row')) {
    throw new Error('terminal-local report moved after a later authority row')
  }
  channel.clear()
  if (channel.rows.some(row => row.kind === 'local')) throw new Error('/clear retained a local presentation row')
  channel.pushLocal('/status', ['stale session row'])
  authority.setAgentId('agent-2')
  await eventually(() => channel.agentId === 'agent-2')
  if (channel.rows.some(row => row.kind === 'local')) throw new Error('agent switch retained a local presentation row')

  channel.notify('terminal warning', { color: 'warning', timeoutMs: 60_000 })
  equal(channel.notifications.at(-1)?.color, 'warning', 'terminal notification colour')
  authority.appendNotification({ id: 7, text: 'later authority error', color: 'error', timeoutMs: 60_000 })
  await eventually(() => channel.notifications.at(-1)?.text === 'later authority error')
  equal(channel.notifications.at(-1)?.color, 'error', 'authority notification colour and order')

  // Synchronous completion API warms a remote cache and repaints when the
  // exact authority-side completion result arrives.
  channel.commandCompletions('/workspace r')
  await eventually(() => channel.commandCompletions('/workspace r').some(row => row.name === 'workspace remote-child'))
  if (!authority.called('commandCompletions')) throw new Error('command completion did not execute on the authority')

  const sideText: string[] = []
  const side = await channel.sideQuestion('remote question', { onText: delta => sideText.push(delta) })
  equal(side.answer, 'remote answer', 'sideQuestion answer')
  equal(sideText.join(''), 'remote stream', 'sideQuestion progress')
  const sideAbort = new AbortController()
  const cancelled = channel.sideQuestion('cancel me', { signal: sideAbort.signal })
  sideAbort.abort(new Error('cancel parity check'))
  await rejects(cancelled, 'sideQuestion cancellation')

  const image = await channel.stageImage({ data: Uint8Array.from([1, 2, 3]), mediaType: 'image/png', name: 'p.png' })
  equal(image, '[image:remote]', 'stageImage')
  equal((authority.last('stageImage')?.[0] as StagedImageInput).data.join(','), '1,2,3', 'stageImage bytes')

  // Every authority operation exposed by Channel is invoked at least once.
  channel.submit('submit')
  channel.steer('steer')
  equal(channel.removePending('pending-1'), true, 'removePending prediction')
  channel.cancel()
  equal(channel.interruptAndDeliver(['a', 'b']), 2, 'interruptAndDeliver prediction')
  equal(await channel.rewindTo({ id: 1, kind: 'user', text: 'rewind' }), 'rewound', 'rewindTo')
  equal(await channel.resumeTo('session-2'), true, 'resumeTo')
  equal(await channel.newSession(), true, 'newSession')
  equal((await channel.listWorkspaces())[0]?.uri, 'file:///authority/workspace', 'listWorkspaces')
  equal((await channel.resolveWorkspace('/other'))?.cwd, '/other', 'resolveWorkspace')
  equal(await channel.resolveWorkspace('missing'), undefined, 'undefined workspace result')
  equal(await channel.switchWorkspace({ kind: 'local', uri: 'file:///other', cwd: '/other', label: 'other' }), true, 'switchWorkspace')
  equal(await channel.renameWorkspace('renamed'), true, 'renameWorkspace')
  equal(channel.workspaceCommands()[0]?.name, 'remote', 'workspaceCommands')
  const workspaceFlow = await channel.runWorkspaceCommand('remote', 'input')
  if (workspaceFlow?.kind !== 'choices') throw new Error('runWorkspaceCommand did not project a choice flow')
  const workspaceProgress: string[] = []
  const chosen = await workspaceFlow.choices[0]?.choose(undefined, progress => workspaceProgress.push(progress.label))
  equal(chosen?.kind === 'target' ? chosen.target.cwd : undefined, '/chosen', 'workspace choice continuation')
  const workspaceInputFlow = await channel.runWorkspaceCommand('remote', 'input')
  if (workspaceInputFlow?.kind !== 'choices') throw new Error('runWorkspaceCommand did not reopen its choice flow')
  const submitted = await workspaceInputFlow.choices[0]?.input?.submit('typed', undefined, progress => workspaceProgress.push(progress.label))
  equal(submitted?.kind === 'target' ? submitted.target.cwd : undefined, '/typed', 'workspace input continuation')
  equal(workspaceProgress.join(','), 'choosing,submitting', 'workspace continuation progress')
  equal(await channel.runWorkspaceCommand('missing', ''), undefined, 'undefined workspace command')
  equal(await channel.switchModel('provider-2', 'model-2'), true, 'switchModel')
  equal((await channel.listEfforts()).efforts[0]?.id, 'high', 'listEfforts')
  equal(await channel.setEffort('high'), true, 'setEffort')
  await channel.cycleMode()
  equal((await channel.listPresets())[0]?.id, 'standard', 'listPresets')
  equal(await channel.switchPreset('standard'), true, 'switchPreset')
  channel.clear()
  equal(await channel.loadOlder(), 4, 'loadOlder')
  equal((await channel.listModels())[0]?.id, 'remote-model', 'listModels')
  equal(await channel.listSkills(), undefined, 'undefined skill catalog')
  equal((await channel.describeCredential('REMOTE_API_KEY'))?.configured, true, 'describeCredential')
  equal(await channel.describeCredential('missing'), undefined, 'undefined credential status')
  equal(channel.settingsSections().map(section => section.ns).join(','), 'remote.settings', 'local-only settings sections stay out of the remote catalog')
  let settingsSectionChanges = 0
  const unsubscribeSettingsSections = channel.subscribeSettingsSections(() => { settingsSectionChanges += 1 })
  authority.addSettingsSection({ ns: 'remote.extra', title: 'Remote extra', fields: [] })
  await eventually(() => channel.settingsSections().some(section => section.ns === 'remote.extra'))
  if (settingsSectionChanges === 0) throw new Error('remote settings-section change was not published')
  unsubscribeSettingsSections()
  equal((await channel.listFiles())[0], 'AGENTS.md', 'listFiles')
  equal((await channel.listSessions())[0]?.id, 'session-2', 'listSessions')
  equal((await channel.previewSession('session-2'))[0]?.text, 'preview', 'previewSession')
  channel.setResumeTarget('session-2')
  channel.renameSession('new title')
  equal(await channel.deleteSession('session-old'), true, 'deleteSession')
  equal(await channel.renameSessionTo('session-old', 'old title'), true, 'renameSessionTo')
  channel.compact()
  equal(await channel.exportSession(), '/authority/export.md', 'exportSession')
  equal(await channel.initWorkspace(), '/authority/AGENTS.md', 'initWorkspace')
  equal((await channel.listSubagents())[0], 'remote subagent', 'listSubagents')
  equal(channel.mcpStatus()[0], 'remote mcp', 'mcpStatus')
  equal(channel.configInfo()[0], 'remote config', 'configInfo')
  equal(channel.doctorInfo()[0], 'remote doctor', 'doctorInfo')
  equal(channel.traceEvents()[0]?.type, 'user/message', 'traceEvents')
  equal(await channel.runExternalCommand('known', ''), 'external result', 'runExternalCommand')
  equal(await channel.runExternalCommand('missing', ''), undefined, 'undefined external command')

  const settings = channel.settingsHost()
  if (settings === undefined) throw new Error('settings host was not projected')
  equal(settings.listNamespaces()[0]?.ns, 'remote.settings', 'settings namespaces')
  await settings.write('remote.settings', [], undefined)
  equal(authority.last('settings.write')?.[2], undefined, 'undefined settings revision')
  equal(await settings.credentialConfigured('REMOTE_API_KEY'), true, 'settings credentialConfigured')
  await settings.writeCredential('REMOTE_API_KEY', 'secret')

  let setup = channel.providerSetup()
  if (setup === undefined) throw new Error('provider setup host was not projected')
  if (setup.commitProvider !== undefined) throw new Error('optional provider commit was invented by the consumer')
  equal((await setup.listCatalogProviders())[0]?.provider, 'remote-provider', 'provider catalog')
  equal(await setup.routeExists('remote-provider'), true, 'provider routeExists')
  equal((await setup.discoverModels({ provider: 'remote-provider' }))[0]?.id, 'remote-model', 'provider discoverModels')
  equal(await setup.envShadows('REMOTE_API_KEY'), false, 'provider envShadows')
  equal(await setup.readCredential('missing'), undefined, 'undefined provider credential')
  await setup.writeCredential('REMOTE_API_KEY', 'secret')
  await setup.removeCredential('REMOTE_API_KEY')
  await setup.writeProfile('remote-provider', {})
  authority.enableProviderCommit()
  await eventually(() => channel.providerSetup()?.commitProvider !== undefined)
  setup = channel.providerSetup()
  await setup?.commitProvider?.({ route: 'remote-provider', profile: {} })

  await eventually(() => REMOTE_METHODS.every(method => authority.called(method)))
  // Leave one settings observer attached deliberately: disposing the remote
  // projection must release both it and the always-on terminal view observer.
  channel.subscribeSettingsSections(() => {})
  equal(terminal.listenerCount(), 1, 'terminal view subscription before dispose')
  equal(terminal.settingsListenerCount(), 1, 'terminal settings subscription before dispose')
  await remote.dispose()
  equal(terminal.listenerCount(), 0, 'terminal view subscription after dispose')
  equal(terminal.settingsListenerCount(), 0, 'terminal settings subscription after dispose')
  equal(authority.listenerCount(), 0, 'authority view subscription after close')
  equal(authority.settingsListenerCount(), 0, 'authority settings subscription after close')
  connection.close('parity verification complete')
  await http.close()
  await consumer.dispose()
  await provider.dispose()
  unregisterClientProtocols()
  unregisterServerProtocols()
  process.stdout.write('all authority-owned Channel state and operations crossed the HTTP connection\n')
} finally {
  await clientContext.fiber.dispose()
  await serverContext.fiber.dispose()
}

function fakeChannel(cwd: string) {
  const listeners = new Set<() => void>()
  const settingsSectionListeners = new Set<() => void>()
  const calls = new Map<string, unknown[][]>()
  let providerCommit = false
  const state: Record<string, unknown> = {
    version: 1, rows: [], status: 'idle', sessionTitle: cwd.startsWith('/authority') ? 'Authority session' : 'Terminal session',
    agentId: 'agent-1', model: 'remote-model', provider: 'remote-provider', tokens: { input: 3, output: 4 },
    cwd, displayCwd: cwd,
    homeDir: cwd.startsWith('/authority') ? '/authority-home' : '/terminal-home',
    pathCaseInsensitive: false,
    gitBranch: 'main', working: false, spinnerMode: 'thinking', responseChars: 2,
    activeToolCount: 0, turnStart: 1, lastUserText: 'last', notifications: [], contextWindow: 128000,
    reasoningEffort: 'high', lastUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, tps: 9,
    tpsSamples: [{ tps: 9, at: 1 }], workingActivity: undefined, activityFrames: 'dots', diffLayout: 'split',
    activityEnabled: true, contextBarEnabled: true, goal: { id: 'g', revision: 1, objective: 'remote goal', phase: 'active', maxGoalRounds: 3, roundsStarted: 1 },
    todos: [{ content: 'remote todo', status: 'pending' }], loadedContext: undefined,
    pending: [{ id: 'pending-1', text: 'queued', placement: 'followup' }],
    commandList: [{ name: 'workspace', description: 'workspace' }, { name: 'known', description: 'known', external: true }],
    contextSegments: { system: 1, prompt: 2, assistant: 3, thinking: 4, tools: 5 },
    mode: { id: 'default' }, modeIndex: 0, agentPreset: 'standard', hasOlder: true,
    settingsSections: cwd.startsWith('/authority')
      ? [{ ns: 'remote.settings', title: 'Remote settings', fields: [] }]
      : [{ ns: 'local.settings', title: 'Local settings', fields: [] }],
  }
  const record = (name: string, args: unknown[]): void => {
    const rows = calls.get(name) ?? []
    rows.push(args)
    calls.set(name, rows)
  }
  const emit = (): void => { state.version = Number(state.version) + 1; for (const listener of listeners) listener() }
  const settings = {
    listNamespaces: () => [{ ns: 'remote.settings', revision: 2, applies: 'live' as const, value: {}, user: {} }],
    async write(...args: unknown[]) { record('settings.write', args) },
    async credentialConfigured(ref: string) { record('settings.credentialConfigured', [ref]); return ref === 'REMOTE_API_KEY' },
    async writeCredential(...args: unknown[]) { record('settings.writeCredential', args) },
  }
  const providerSetup = (): Record<string, (...args: never[]) => unknown> => ({
    listCatalogProviders: () => [{ provider: 'remote-provider', displayName: 'Remote' }],
    routeExists: (route: string) => route === 'remote-provider',
    discoverModels: async () => [{ provider: 'remote-provider', id: 'remote-model', name: 'Remote Model' }],
    envShadows: () => false,
    readCredential: async () => undefined,
    writeCredential: async (...args: never[]) => { record('provider.writeCredential', args) },
    removeCredential: async (...args: never[]) => { record('provider.removeCredential', args) },
    writeProfile: async (...args: never[]) => { record('provider.writeProfile', args) },
    ...(providerCommit ? { commitProvider: async (...args: never[]) => { record('provider.commitProvider', args) } } : {}),
  })
  const methods: Record<string, (...args: any[]) => any> = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    commandCompletions: (input: string) => {
      record('commandCompletions', [input])
      return [{ name: 'workspace remote-child', description: 'remote child', replacement: '/workspace remote-child ', commandLine: '/workspace remote-child' }]
    },
    sideQuestion: (question: string, options?: { signal?: AbortSignal; onText?: (delta: string) => void }) => {
      record('sideQuestion', [question])
      if (question === 'cancel me') return new Promise((_resolve, reject) => {
        const abort = () => reject(options?.signal?.reason ?? new Error('cancelled'))
        options?.signal?.addEventListener('abort', abort, { once: true })
        if (options?.signal?.aborted === true) abort()
      })
      options?.onText?.('remote '); options?.onText?.('stream')
      return Promise.resolve({ answer: 'remote answer' })
    },
    stageImage: (input: StagedImageInput) => { record('stageImage', [input]); return Promise.resolve('[image:remote]') },
    runExternalCommand: (name: string, input: string) => { record('runExternalCommand', [name, input]); return Promise.resolve(name === 'known' ? 'external result' : undefined) },
    submit: (...args: unknown[]) => record('submit', args), steer: (...args: unknown[]) => record('steer', args),
    removePending: (...args: unknown[]) => { record('removePending', args); return true },
    cancel: (...args: unknown[]) => record('cancel', args),
    interruptAndDeliver: (...args: unknown[]) => { record('interruptAndDeliver', args); return (args[0] as unknown[]).length },
    rewindTo: (...args: unknown[]) => { record('rewindTo', args); return Promise.resolve('rewound') },
    resumeTo: (...args: unknown[]) => { record('resumeTo', args); return Promise.resolve(true) },
    newSession: (...args: unknown[]) => { record('newSession', args); return Promise.resolve(true) },
    listWorkspaces: (...args: unknown[]) => { record('listWorkspaces', args); return Promise.resolve([{ kind: 'local', uri: 'file:///authority/workspace', cwd: '/authority/workspace', label: 'authority' }]) },
    resolveWorkspace: (reference: string) => { record('resolveWorkspace', [reference]); return Promise.resolve(reference === 'missing' ? undefined : { kind: 'local', uri: `file://${reference}`, cwd: reference, label: reference }) },
    switchWorkspace: (...args: unknown[]) => { record('switchWorkspace', args); return Promise.resolve(true) },
    renameWorkspace: (...args: unknown[]) => { record('renameWorkspace', args); return Promise.resolve(true) },
    workspaceCommands: () => [{ name: 'remote', aliases: ['r'], description: 'remote workspace command' }],
    runWorkspaceCommand: (name: string, input: string) => {
      record('runWorkspaceCommand', [name, input])
      return Promise.resolve(name === 'missing' ? undefined : {
        kind: 'choices',
        title: 'Remote workspace flow',
        choices: [{
          id: 'remote-choice', label: 'Remote choice',
          choose: (_signal?: AbortSignal, progress?: (value: { label: string }) => void) => {
            record('workspace.choose', [])
            progress?.({ label: 'choosing' })
            return { kind: 'target', target: { kind: 'provider', uri: 'verify://chosen', cwd: '/chosen', label: 'chosen', badge: 'VERIFY' } }
          },
          input: {
            placeholder: 'name',
            submit: (value: string, _signal?: AbortSignal, progress?: (item: { label: string }) => void) => {
              record('workspace.submit', [value])
              progress?.({ label: 'submitting', ratio: 1 })
              return { kind: 'target', target: { kind: 'provider', uri: `verify://${value}`, cwd: `/${value}`, label: value, badge: 'VERIFY' } }
            },
          },
        }],
      })
    },
    switchModel: (...args: unknown[]) => { record('switchModel', args); return Promise.resolve(true) },
    listEfforts: (...args: unknown[]) => { record('listEfforts', args); return Promise.resolve({ efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }) },
    setEffort: (...args: unknown[]) => { record('setEffort', args); return Promise.resolve(true) },
    cycleMode: (...args: unknown[]) => { record('cycleMode', args); return Promise.resolve() },
    listPresets: (...args: unknown[]) => { record('listPresets', args); return Promise.resolve([{ id: 'standard', isDefault: true }]) },
    switchPreset: (...args: unknown[]) => { record('switchPreset', args); return Promise.resolve(true) },
    clear: (...args: unknown[]) => record('clear', args), loadOlder: (...args: unknown[]) => { record('loadOlder', args); return 4 },
    listModels: (...args: unknown[]) => { record('listModels', args); return Promise.resolve([{ provider: 'remote-provider', id: 'remote-model', name: 'Remote Model' }]) },
    listSkills: (...args: unknown[]) => { record('listSkills', args); return Promise.resolve(undefined) },
    describeCredential: (ref: string) => { record('describeCredential', [ref]); return Promise.resolve(ref === 'missing' ? undefined : { configured: true, writable: true }) },
    settingsHost: () => settings, providerSetup,
    settingsSections: () => state.settingsSections,
    subscribeSettingsSections: (listener: () => void) => {
      settingsSectionListeners.add(listener)
      return () => settingsSectionListeners.delete(listener)
    },
    listFiles: (...args: unknown[]) => { record('listFiles', args); return Promise.resolve(['AGENTS.md']) },
    listSessions: (...args: unknown[]) => { record('listSessions', args); return Promise.resolve([{ id: 'session-2', title: 'Session 2', cwd: '/authority', updatedAt: 1, kind: 'conversation' }]) },
    previewSession: (...args: unknown[]) => { record('previewSession', args); return Promise.resolve([{ role: 'user', text: 'preview' }]) },
    setResumeTarget: (...args: unknown[]) => record('setResumeTarget', args), renameSession: (...args: unknown[]) => record('renameSession', args),
    deleteSession: (...args: unknown[]) => { record('deleteSession', args); return Promise.resolve(true) },
    renameSessionTo: (...args: unknown[]) => { record('renameSessionTo', args); return Promise.resolve(true) },
    compact: (...args: unknown[]) => record('compact', args),
    mcpStatus: () => ['remote mcp'], configInfo: () => ['remote config'], exportSession: (...args: unknown[]) => { record('exportSession', args); return '/authority/export.md' },
    initWorkspace: (...args: unknown[]) => { record('initWorkspace', args); return '/authority/AGENTS.md' }, doctorInfo: () => ['remote doctor'],
    listSubagents: (...args: unknown[]) => { record('listSubagents', args); return Promise.resolve(['remote subagent']) },
    traceEvents: () => [{ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [] } }],
    setDiffLayout: (...args: unknown[]) => { record('setDiffLayout', args); state.diffLayout = args[0]; emit() },
    setActivityFrames: (...args: unknown[]) => { record('setActivityFrames', args); state.activityFrames = args[0]; emit(); return true },
    openPluginScene: (...args: unknown[]) => { record('openPluginScene', args); state.pluginScene = { id: args[0], title: 'Remote scene', component: () => null }; emit(); return true },
    closePluginScene: (...args: unknown[]) => { record('closePluginScene', args); state.pluginScene = undefined; emit() },
    notify: () => {}, pushLocal: () => {}, releaseContributions: () => {},
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
    called: (name: string) => (calls.get(name)?.length ?? 0) > 0,
    last: (name: string) => calls.get(name)?.at(-1),
    listenerCount: () => listeners.size,
    settingsListenerCount: () => settingsSectionListeners.size,
    addSettingsSection(section: unknown) {
      state.settingsSections = [...state.settingsSections as unknown[], section]
      for (const listener of settingsSectionListeners) listener()
    },
    appendRow(row: unknown) { state.rows = [...state.rows as unknown[], row]; emit() },
    appendNotification(notification: unknown) {
      state.notifications = [...state.notifications as unknown[], notification]
      emit()
    },
    setAgentId(id: string) { state.agentId = id; emit() },
    enableProviderCommit() { providerCommit = true; emit() },
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`)
}

async function eventually(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function rejects(promise: Promise<unknown>, label: string): Promise<void> {
  try { await promise } catch { return }
  throw new Error(`${label}: expected rejection`)
}
