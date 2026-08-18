/** Standard plugin installation is authoritative on the Agent endpoint, not the visible terminal. */

import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { defineComponentManifest } from '@dsh-std/manifest'
import { notificationSupport } from '@dsh-std/presentation'
import { registerProfileProtocols } from 'dsh-ecosystem-spec/protocols'
import type { Channel } from '../src/tui-contract/channel.js'
import { completeCommands } from '../src/commands.js'
import { bindTuiContributions } from '../src/std-adapter/component-loader.js'
import TuiCommandTreeRuntime from '../src/tui-runtime/command-trees.js'
import TuiWorkspaceRuntime from '../src/tui-runtime/workspaces.js'
import TuiSettingsSectionsRuntime from '../src/tui-runtime/settings-sections.js'
import TuiSceneRuntime from '../src/tui-runtime/scenes.js'
import { connectTuiChannelHttp, listenTuiChannelHttp } from '../src/std-adapter/channel-http.js'
import {
  mountTuiChannelConsumer,
  mountTuiChannelProvider,
  openRemoteTuiChannel,
  tuiConnectionEndpoint,
} from '../src/std-adapter/channel-connection.js'
import { TuiPresentationRelay, mountTuiPresentationRelay } from '../src/std-adapter/presentation-relay.js'
import { ApprovalStore } from '../src/dsh-adapter/approvals.js'
import { QuestionStore } from '../src/dsh-adapter/questions.js'
import { mountTuiStandardParticipant } from '../src/std-adapter/standard-participant.js'

for (const remoteInstalled of [false, true]) {
  for (const localInstalled of [false, true]) {
    await verifyQuadrant(localInstalled, remoteInstalled)
  }
}
await verifyPresentationIsolation()
process.stdout.write('standard plugin four-endpoint matrix, commands, models, workspaces, settings, Scenes and Presentation routing OK\n')

async function verifyPresentationIsolation(): Promise<void> {
  const server = await runtime('server', false)
  const relay = new TuiPresentationRelay()
  const relayBinding = await mountTuiPresentationRelay(server.adapter, relay)
  const authority = standardChannel(server)
  const provider = await mountTuiChannelProvider(server.adapter, {
    open: () => ({ channel: authority, dispose() {} }),
  }, relay)
  await server.installPlugin()
  const serverEndpoint = tuiConnectionEndpoint(server.adapter.connectionEndpoint)
  const releaseRelayDeclaration = serverEndpoint.registerDeclaration(relayBinding.consumerDeclaration)
  const http = await listenTuiChannelHttp(serverEndpoint, server.adapter.protocols, {
    port: 0,
    onConnection: connection => relay.attach(connection, serverEndpoint.participantId(relayBinding.consumerParticipantId)),
  })
  const clients = await Promise.all(['a', 'b'].map(async label => {
    const fixture = await runtime('client', false)
    const notices: string[] = []
    const questions = new QuestionStore()
    const approvals = new ApprovalStore()
    const presentation = await mountTuiStandardParticipant(fixture.adapter, {
      questions, approvals, notify: text => { notices.push(text) },
      openExternal: async uri => { await fetch(`${uri}?code=${label}`) },
    })
    const consumer = await mountTuiChannelConsumer(fixture.adapter)
    const endpoint = tuiConnectionEndpoint(fixture.adapter.connectionEndpoint)
    const connection = await connectTuiChannelHttp(http.origin, endpoint, fixture.adapter.protocols)
    const remote = await openRemoteTuiChannel(connection, endpoint.participantId(consumer.participantId), {
      terminalChannel: standardChannel(fixture),
    })
    return { label, fixture, notices, questions, approvals, presentation, consumer, connection, remote }
  }))
  try {
    await clients[0]!.remote.channel.runExternalCommand('codex', ' status')
    await eventually(() => clients[0]!.notices.length === 1)
    if (clients[1]!.notices.length !== 0) throw new Error('Presentation leaked to a second connected terminal')
    await clients[1]!.remote.channel.runExternalCommand('codex', ' status')
    await eventually(() => clients[1]!.notices.length === 1)
    if (clients[0]!.notices.length !== 1) throw new Error('second invocation was routed to the first terminal')

    const question = clients[0]!.remote.channel.runExternalCommand('codex', ' question')
    await eventually(() => clients[0]!.questions.getSnapshot() !== null)
    if (clients[1]!.questions.getSnapshot() !== null) throw new Error('question leaked to a second connected terminal')
    clients[0]!.questions.answerCurrent({ selected: [], custom: 'terminal-a' })
    if (await question !== 'question:terminal-a') throw new Error('question response did not return to the remote command')

    const approval = clients[1]!.remote.channel.runExternalCommand('codex', ' approval')
    await eventually(() => clients[1]!.approvals.getSnapshot() !== null)
    if (clients[0]!.approvals.getSnapshot() !== null) throw new Error('approval leaked to a second connected terminal')
    clients[1]!.approvals.decide('allowed-once')
    if (await approval !== 'approval:approved') throw new Error('approval response did not return to the remote command')

    const secret = clients[0]!.remote.channel.runExternalCommand('codex', ' secret')
    await eventually(() => clients[0]!.questions.getSnapshot() !== null)
    clients[0]!.questions.answerCurrent({ selected: [], custom: 'top-secret' })
    if (await secret !== 'secret-length:10') throw new Error('secret response did not return to the remote command')
    const summaries = clients[0]!.questions.takeSummaries()
    if (JSON.stringify(summaries).includes('top-secret')) throw new Error('secret input leaked into a presentation summary')

    const callback = await clients[1]!.remote.channel.runExternalCommand('codex', ' callback')
    if (callback !== 'callback:b') throw new Error(`ExternalRedirect did not return through the invoking terminal: ${JSON.stringify(callback)}`)
  } finally {
    for (const client of clients) {
      await client.remote.dispose()
      client.connection.close('isolation case complete')
      await client.consumer.dispose()
      await client.presentation.dispose()
      await client.fixture.dispose()
    }
    await http.close()
    releaseRelayDeclaration()
    await provider.dispose()
    await relayBinding.dispose()
    await server.dispose()
  }
}

async function verifyQuadrant(localInstalled: boolean, remoteInstalled: boolean): Promise<void> {
  const server = await runtime('server', false)
  const client = await runtime('client', false)
  const notices: string[] = []
  const localPresentation = await mountTuiStandardParticipant(client.adapter, {
    questions: new QuestionStore(), approvals: new ApprovalStore(), notify: text => { notices.push(text) },
  })
  const relay = new TuiPresentationRelay()
  const relayBinding = await mountTuiPresentationRelay(server.adapter, relay)
  const authority = standardChannel(server)
  const terminal = standardChannel(client)
  const provider = await mountTuiChannelProvider(server.adapter, {
    open: () => ({ channel: authority, dispose() {} }),
  }, relay)
  // Mounting after Presentation is intentional: a standard plugin with a
  // required Notification contract must activate without knowing any carrier.
  // The Channel provider is infrastructure and is mounted before application
  // components, matching the real profile boot order.
  if (remoteInstalled) await server.installPlugin()
  if (localInstalled) await client.installPlugin()
  const consumer = await mountTuiChannelConsumer(client.adapter)
  const serverEndpoint = tuiConnectionEndpoint(server.adapter.connectionEndpoint)
  const clientEndpoint = tuiConnectionEndpoint(client.adapter.connectionEndpoint)
  const releaseRelayDeclaration = serverEndpoint.registerDeclaration(relayBinding.consumerDeclaration)
  const http = await listenTuiChannelHttp(serverEndpoint, server.adapter.protocols, {
    port: 0,
    onConnection: connection => relay.attach(connection, serverEndpoint.participantId(relayBinding.consumerParticipantId)),
  })
  const connection = await connectTuiChannelHttp(http.origin, clientEndpoint, client.adapter.protocols)
  const remote = await openRemoteTuiChannel(connection, clientEndpoint.participantId(consumer.participantId), {
    terminalChannel: terminal,
  })
  try {
    const hasCommand = remote.channel.commandList.some(command => command.name === 'codex')
    if (hasCommand !== remoteInstalled) {
      throw new Error(`command visibility followed the wrong endpoint (local=${localInstalled}, remote=${remoteInstalled})`)
    }
    const hasProvider = (await remote.channel.listModels()).some(model => model.provider === 'openai-codex')
    if (hasProvider !== remoteInstalled) {
      throw new Error(`provider visibility followed the wrong endpoint (local=${localInstalled}, remote=${remoteInstalled})`)
    }
    const hasWorkspace = (await remote.channel.listWorkspaces()).some(target => target.cwd === '/verify/remote-plugin')
    if (hasWorkspace !== remoteInstalled) {
      throw new Error(`workspace visibility followed the wrong endpoint (local=${localInstalled}, remote=${remoteInstalled})`)
    }
    const hasSettings = remote.channel.settingsSections().some(section => section.ns === 'verify_remote_plugin')
    if (hasSettings !== remoteInstalled) {
      throw new Error(`settings visibility followed the wrong endpoint (local=${localInstalled}, remote=${remoteInstalled})`)
    }
    if (remoteInstalled) {
      await eventually(() => remote.channel.commandCompletions('/codex ').some(row => row.name === 'codex login'))
      await eventually(() => remote.channel.commandCompletions('/codex login ').some(row => row.name === 'codex login device'))
      const result = await remote.channel.runExternalCommand('codex', ' status')
      if (result !== 'server codex status') throw new Error(`remote standard command returned ${JSON.stringify(result)}`)
      await eventually(() => notices.length === 1)
      if (notices[0] !== 'server standard command reached this terminal') {
        throw new Error(`Presentation was not routed to the invoking terminal: ${JSON.stringify(notices)}`)
      }
      const workspace = await remote.channel.resolveWorkspace('verify://selected')
      if (workspace?.cwd !== '/verify/selected') throw new Error('remote standard WorkspaceProvider did not resolve on the authority')
      const scene = await remote.channel.runExternalCommand('codex', ' scene')
      if (scene !== 'scene:opened') throw new Error(`remote Scene command returned ${JSON.stringify(scene)}`)
      if (localInstalled) {
        await eventually(() => remote.channel.pluginScene?.id === 'verify_scene')
      } else if (remote.channel.pluginScene !== undefined) {
        throw new Error('a remote executable Scene crossed into a terminal where its plugin is absent')
      }
    } else {
      if (remote.channel.commandCompletions('/codex ').length !== 0) {
        throw new Error(`local-only plugin leaked completion into remote Channel (local=${localInstalled})`)
      }
      if (await remote.channel.runExternalCommand('codex', ' status') !== undefined) {
        throw new Error('local-only plugin executed against a remote runtime where it is absent')
      }
      if (notices.length !== 0) throw new Error('local-only plugin produced remote Presentation')
    }
  } finally {
    await remote.dispose()
    connection.close('matrix case complete')
    await http.close()
    await consumer.dispose()
    await provider.dispose()
    releaseRelayDeclaration()
    await relayBinding.dispose()
    await localPresentation.dispose()
    await client.dispose()
    await server.dispose()
  }
}

async function runtime(side: 'server' | 'client', installImmediately: boolean) {
  const context = new Context()
  const commandEvents: unknown[] = []
  const agent = {
    id: `${side}-agent`,
    session: { id: `${side}-session`, append: (type: string, data: unknown) => { const event = { type, data }; commandEvents.push(event); return event } },
  }
  context.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
  await context.plugin(CommandRuntime)
  const llm = new LlmRuntime(context)
  const commandTrees = new TuiCommandTreeRuntime(context)
  const workspaces = new TuiWorkspaceRuntime(context)
  const settingsSections = new TuiSettingsSectionsRuntime(context)
  const scenes = new TuiSceneRuntime(context)
  const adapter = new DshStandardAdapter(context, { profile: `standard-plugin-${side}`, discover: false })
  const unregisterProtocols = registerProfileProtocols(adapter.protocols)
  const contributionDisposers: Array<() => void> = []
  let pluginDispose: (() => Promise<void>) | undefined

  const installPlugin = async (): Promise<void> => {
    if (pluginDispose !== undefined) return
    const previous = new Set(adapter.publications.list().map(row => row.identity.instanceId))
    pluginDispose = await mountPlugin(adapter, side, scenes)
    contributionDisposers.push(...bindTuiContributions(
      context,
      adapter.publications.list()
        .filter(row => !previous.has(row.identity.instanceId))
        .flatMap(row => row.extensions),
    ))
  }
  if (installImmediately) await installPlugin()
  return {
    context, adapter, llm, commandTrees, workspaces, settingsSections, scenes, agent, installPlugin,
    async dispose() {
      for (const dispose of contributionDisposers.reverse()) dispose()
      await pluginDispose?.()
      unregisterProtocols()
      await context.fiber.dispose()
    },
  }
}

async function mountPlugin(
  adapter: DshStandardAdapter,
  side: 'server' | 'client',
  scenes: TuiSceneRuntime,
): Promise<() => Promise<void>> {
  const command = {
    apiVersion: 'commands.dsh/v1alpha1', kind: 'Command', metadata: { name: 'codex' },
    spec: {
      title: 'Manage Codex',
      children: [
        { name: 'status', spec: { title: 'Show status' } },
        { name: 'scene', spec: { title: 'Open verification scene' } },
        { name: 'login', spec: { title: 'Sign in', children: [
          { name: 'browser', spec: { title: 'Browser sign-in' } },
          { name: 'device', spec: { title: 'Device-code sign-in' } },
        ] } },
      ],
    },
  } as const
  const model = {
    apiVersion: 'models.dsh/v1alpha1', kind: 'ModelProvider', metadata: { name: 'openai-codex' },
    spec: { title: 'OpenAI Codex', actions: { authenticate: { name: 'codex', path: ['login'] } } },
  } as const
  const workspace = {
    apiVersion: 'workspace.dsh/v1alpha1', kind: 'WorkspaceProvider',
    metadata: { name: 'verify-remote-workspace' },
    spec: {
      title: 'Verification', workspaceDomain: `verification.${side}`,
      operations: ['list', 'get', 'resolve'], locatorKinds: ['verify'], mutationConcurrency: 'serialized',
    },
  } as const
  const settings = {
    apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'SettingsSection',
    metadata: { name: 'verify_remote_settings' },
    spec: {
      namespace: 'verify_remote_plugin', title: 'Remote plugin settings',
      fields: [{ path: ['enabled'], label: 'Enabled', kind: 'boolean' }],
    },
  } as const
  const scene = {
    apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'Scene',
    metadata: { name: 'verify_scene' },
    spec: { title: 'Verification scene' },
  } as const
  const manifest = defineComponentManifest({
    apiVersion: 'manifest.dsh/internal/v1alpha1', kind: 'Component',
    metadata: { name: `org.omdsh.verification.codex-${side}`, version: '1.0.0' },
    spec: { facets: [{
      name: 'host',
      activation: { apiVersion: 'lifecycle.dsh/v1alpha1', kind: 'FacetModule', spec: { module: 'verification' } },
      protocols: { requires: [
        { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
        notificationSupport,
        { apiVersion: 'presentation.dsh/v1alpha1', kind: 'OpenExternal' },
        { apiVersion: 'presentation.dsh/v1alpha1', kind: 'ExternalRedirect' },
        {
          apiVersion: 'presentation.dsh/v1alpha1',
          kind: 'UserInteraction',
          spec: { operations: ['question', 'approval', 'secret-input'] },
        },
      ] },
      extensions: [command, model, workspace, settings, scene],
    }] },
  })
  return adapter.mount({
    manifest, facet: 'host',
    activate(activation) {
      activation.extensions.publish(command, 'codex', {
        async execute(
          input: { rawInput: string },
          invocation: {
            presentation?: {
              notification?: { notify(input: { text: string }): Promise<unknown> }
              interaction?: { interact(input: Record<string, unknown>): Promise<{
                status: string
                value?: Record<string, unknown>
              }> }
              openExternal?: { openExternal(input: { uri: string }): Promise<unknown> }
              externalRedirect?: { receive(): {
                ready: Promise<{ redirectUri: string }>
                result: Promise<{ status: string; value?: { query?: Record<string, string[]> } }>
              } }
            }
          },
        ) {
          if (invocation.presentation?.notification === undefined) throw new Error('Notification was not bound')
          await invocation.presentation.notification.notify({ text: `${side} standard command reached this terminal` })
          const action = input.rawInput.trim()
          if (action === 'scene') {
            return { kind: 'success', text: `scene:${scenes.open('verify_scene') ? 'opened' : 'missing'}` }
          }
          if (action === 'question') {
            const result = await invocation.presentation.interaction?.interact({
              kind: 'question', title: 'Remote question',
              fields: [{ id: 'answer', kind: 'text', label: 'Answer', required: true }],
            })
            const answers = result?.value?.answers
            const answer = typeof answers === 'object' && answers !== null
              ? (answers as Record<string, unknown>).answer
              : undefined
            return { kind: 'success', text: `question:${String(answer)}` }
          }
          if (action === 'approval') {
            const result = await invocation.presentation.interaction?.interact({
              kind: 'approval', action: 'remote-test', summary: 'Approve the remote test?', risk: 'low',
            })
            return { kind: 'success', text: `approval:${String(result?.value?.decision)}` }
          }
          if (action === 'secret') {
            const result = await invocation.presentation.interaction?.interact({
              kind: 'secret-input', label: 'Remote secret', minLength: 1,
            })
            const secret = result?.value?.secret
            return { kind: 'success', text: `secret-length:${typeof secret === 'string' ? secret.length : -1}` }
          }
          if (action === 'callback') {
            const redirect = invocation.presentation?.externalRedirect?.receive()
            if (redirect === undefined || invocation.presentation?.openExternal === undefined) throw new Error('ExternalRedirect was not bound')
            const ready = await redirect.ready
            await invocation.presentation.openExternal.openExternal({ uri: ready.redirectUri })
            const result = await redirect.result
            return { kind: 'success', text: `callback:${String(result.value?.query?.code?.[0])}` }
          }
          return { kind: 'success', text: `${side} codex status` }
        },
      })
      activation.extensions.publish(model, 'openai-codex', {
        listModels: () => [{ id: 'gpt-verification', name: 'GPT Verification', selectable: true }],
        async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
      })
      const descriptor = (name: string) => ({
        workspace: { provider: 'verify-remote-workspace', id: name }, title: name,
        location: { kind: 'file', display: `/verify/${name}`, canonical: { kind: 'file', spec: { path: `/verify/${name}` } } },
        state: 'available', revision: 1,
      })
      activation.extensions.publish(workspace, 'verify-remote-workspace', {
        list: () => ({ catalogRevision: 1, workspaces: [descriptor('remote-plugin')] }),
        get: (reference: { id: string }) => descriptor(reference.id),
        resolve: (input: { locator: { kind: string; spec: { uri?: string } } }) => {
          if (input.locator.kind !== 'verify' || typeof input.locator.spec.uri !== 'string') return {}
          const name = new URL(input.locator.spec.uri).hostname || new URL(input.locator.spec.uri).pathname.replace(/^\//u, '')
          return { workspace: descriptor(name) }
        },
      })
      activation.extensions.publish(settings, 'verify_remote_settings', {})
      activation.extensions.publish(scene, 'verify_scene', { component: () => null })
    },
  })
}

function standardChannel(runtime: Awaited<ReturnType<typeof runtime>>): Channel {
  const commands = runtime.context.get('commands') as {
    list(agent: unknown): Array<{ name: string; description: string; input?: { hint: string } }>
    execute(agent: unknown, line: string, signal: AbortSignal): Promise<{ result: { text?: string } } | undefined>
  }
  const state: Record<string, unknown> = {
    version: 1, rows: [], status: 'idle', sessionTitle: runtime.agent.id, agentId: runtime.agent.id,
    model: '', provider: '', tokens: { input: 0, output: 0 }, cwd: '/', displayCwd: '/', working: false,
    spinnerMode: 'thinking', responseChars: 0, activeToolCount: 0, turnStart: 0, lastUserText: '', notifications: [],
    tpsSamples: [], activityEnabled: true, contextBarEnabled: true, diffLayout: 'auto', todos: [], pending: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, mode: { id: 'default' }, modeIndex: 0,
  }
  const commandList = () => commands.list(runtime.agent).map(row => ({
    name: row.name, description: row.description, ...(row.input === undefined ? {} : { tag: row.input.hint }), external: true,
  }))
  const methods: Record<string, (...args: any[]) => any> = {
    subscribe: (listener: () => void) => runtime.scenes.subscribe(listener),
    commandCompletions: (input: string) => completeCommands(input, commandList(), path => runtime.commandTrees.children(path)),
    runExternalCommand: async (name: string, input: string) => (await commands.execute(runtime.agent, `/${name}${input}`, new AbortController().signal))?.result.text,
    listModels: async () => (await Promise.all(runtime.llm.listProviders().map(provider => runtime.llm.listModels(provider.id)))).flat(),
    listWorkspaces: () => runtime.workspaces.list('/'),
    resolveWorkspace: (reference: string) => runtime.workspaces.resolve(reference, '/'),
    workspaceCommands: () => runtime.workspaces.commands(),
    runWorkspaceCommand: (name: string, input: string) => runtime.workspaces.runCommand(name, input, '/'),
    traceEvents: () => [], mcpStatus: () => [], configInfo: () => [], doctorInfo: () => [],
    settingsSections: () => runtime.settingsSections.list(),
    settingsHost: () => undefined, providerSetup: () => undefined,
    subscribeSettingsSections: (listener: () => void) => runtime.settingsSections.subscribe(listener),
    setDiffLayout: () => {}, setActivityFrames: () => true,
    openPluginScene: (id: string) => runtime.scenes.open(id), closePluginScene: () => runtime.scenes.close(),
    releaseContributions: () => {}, notify: () => {}, pushLocal: () => {}, listFiles: async () => [],
  }
  return new Proxy({} as Channel, {
    get(_target, property) {
      if (property === 'commandList') return commandList()
      if (property === 'pluginScene') return runtime.scenes.active
      if (typeof property === 'string' && property in methods) return methods[property]
      if (typeof property === 'string' && property in state) return state[property]
      return undefined
    },
  })
}

async function eventually(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
