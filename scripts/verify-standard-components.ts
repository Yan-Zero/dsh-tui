import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { defineComponentManifest } from '@dsh-std/manifest'
import { contributionHostRequirement, type ContributionHostClient } from '@dsh-std/ui'
import { registerProfileProtocols, registerTuiContributionExtensions } from 'dsh-ecosystem-spec/protocols'
import { SCENE, SETTINGS_SECTION } from 'dsh-ecosystem-spec/tui-contributions'
import { ApprovalStore } from '../src/dsh-adapter/approvals.js'
import { QuestionStore } from '../src/dsh-adapter/questions.js'
import { mountTuiStandardParticipant } from '../src/std-adapter/standard-participant.js'
import TuiWorkspaceRuntime from '../src/tui-runtime/workspaces.js'
import TuiCommandTreeRuntime from '../src/tui-runtime/command-trees.js'
import TuiSettingsSectionsRuntime from '../src/tui-runtime/settings-sections.js'
import TuiSceneRuntime from '../src/tui-runtime/scenes.js'
import { bindTuiContributions } from '../src/std-adapter/component-loader.js'
import TuiStandardUiHost from '../src/std-adapter/ui-host.js'

const temporaryRoot = mkdtempSync(join(process.cwd(), '.verify-standard-components-'))
const notices: string[] = []
const openedUris: string[] = []
const context = new Context()

try {
  const tuiRequire = createRequire(new URL('../package.json', import.meta.url))
  // Resolve peers from the profile's installed adapter path. The source
  // workspace may itself contain a standalone node_modules tree; it is not
  // part of the profile dependency graph and must not create a second Cordis.
  const adapterRequire = createRequire(new URL('../node_modules/@dsh-std/adapter-dsh/lib/index.js', import.meta.url))
  const tuiCordis = realpathSync(tuiRequire.resolve('@deepseek-ai/cordis/package.json'))
  const adapterCordis = realpathSync(adapterRequire.resolve('@deepseek-ai/cordis/package.json'))
  // A source checkout can retain a standalone dependency tree inside the
  // std submodule. Runtime interoperability below is authoritative; packed
  // profiles have one dependency closure and therefore one physical Cordis.
  if (tuiCordis !== adapterCordis) process.stderr.write('standard component verification: source checkout has duplicate Cordis paths\n')

  const commandEvents: Array<{ readonly type: string; readonly data: unknown }> = []
  const agent = {
    id: 'standard-component-verification',
    session: {
      append(type: string, data: unknown) {
        const event = Object.freeze({ type, data })
        commandEvents.push(event)
        return event
      },
    },
  }
  context.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
  await context.plugin(CommandRuntime)
  await context.plugin(TuiWorkspaceRuntime)
  await context.plugin(TuiCommandTreeRuntime)
  await context.plugin(TuiSettingsSectionsRuntime)
  await context.plugin(TuiSceneRuntime)
  const adapter = new DshStandardAdapter(context, { profile: 'verification' })
  const disposePrivateProtocols = registerProfileProtocols(adapter.protocols)
  const disposePrivateExtensions = registerTuiContributionExtensions(adapter.manifestDefinitions)
  await context.plugin(TuiStandardUiHost)
  await verifyStandardUi(adapter, context)
  const presentation = await mountTuiStandardParticipant(adapter, {
    questions: new QuestionStore(),
    approvals: new ApprovalStore(),
    notify: text => { notices.push(text) },
    openExternal: uri => { openedUris.push(uri) },
  })

  const componentDir = join(temporaryRoot, 'node_modules', 'standard-consumer')
  mkdirSync(componentDir, { recursive: true })
  writeFileSync(join(temporaryRoot, 'package.json'), JSON.stringify({
    name: 'standard-component-verification',
    private: true,
    dependencies: { 'standard-consumer': '1.0.0' },
  }))
  writeFileSync(join(componentDir, 'package.json'), JSON.stringify({
    name: 'standard-consumer',
    version: '1.0.0',
    type: 'module',
  }))
  writeFileSync(join(componentDir, 'dsh-plugin.json'), JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    manifestVersion: '0.15',
    id: 'org.omdsh.verification.standard-consumer',
    name: 'Standard Consumer Verification',
    version: '1.0.0',
    facets: { host: { entry: 'standard.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [
      { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
      { apiVersion: 'presentation.dsh/v1alpha1', kind: 'Notification' },
      { apiVersion: 'presentation.dsh/v1alpha1', kind: 'OpenExternal' },
    ] },
    permissions: [],
    contributes: {
      commands: [{ id: 'org.omdsh.verification.ping', title: 'Ping' }],
      'x-dsh-tui': [
        {
          apiVersion: 'commands.dsh/v1alpha1', kind: 'Command',
          id: 'org.omdsh.verification.configure', name: 'configure',
          spec: {
            title: 'Configure', titles: { zh: '配置' },
            children: [{
              name: 'set',
              spec: {
                title: 'Set a value', titles: { zh: '设置值' },
                children: [{ name: 'theme', spec: { title: 'Set theme', aliases: ['appearance'] } }],
              },
            }],
          },
        },
        {
          apiVersion: 'workspace.dsh/v1alpha1', kind: 'WorkspaceProvider',
          id: 'org.omdsh.verification.workspace', name: 'verification-workspace',
          spec: {
            title: 'Verification', workspaceDomain: 'verification.workspaces',
            operations: ['list', 'get', 'resolve'], locatorKinds: ['verify'], mutationConcurrency: 'serialized',
          },
        },
        {
          apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'SettingsSection',
          id: 'org.omdsh.verification.settings', name: 'verification_settings',
          spec: {
            namespace: 'verification', title: 'Verification settings',
            fields: [{ path: ['enabled'], label: 'Enabled', kind: 'boolean' }],
          },
        },
        {
          apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'Scene',
          id: 'org.omdsh.verification.scene', name: 'verification_scene',
          spec: { title: 'Verification scene' },
        },
      ],
    },
    subscriptions: [],
    license: 'MIT',
  }))
  writeFileSync(join(componentDir, 'standard.js'), `
const workspace = cwd => ({
  workspace: { provider: 'verification-workspace', id: 'verify-root' },
  title: 'Verify', location: { kind: 'file', display: cwd, canonical: { kind: 'file', spec: { path: cwd } } },
  state: 'available', revision: 1,
})
export default {
  activate(context) {
    context.extensions.publish(
      { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
      'configure',
      { execute() { return { kind: 'success', text: 'configured' } } },
    )
    context.extensions.publish(
      { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
      'ping',
      {
        async execute(_input, invocation) {
          if (invocation.presentation?.notification === undefined) {
            throw new Error('Notification was not bound to the command invocation')
          }
          await invocation.presentation.notification.notify({ text: 'standard component reached dsh-tui' })
          if (invocation.presentation.openExternal === undefined) {
            throw new Error('OpenExternal was not bound to the command invocation')
          }
          await invocation.presentation.openExternal.openExternal({ uri: 'https://example.com/verify' })
          return { kind: 'success', text: 'pong from standard component' }
        },
      },
    )
    context.extensions.publish(
      { apiVersion: 'workspace.dsh/v1alpha1', kind: 'WorkspaceProvider' },
      'verification-workspace',
      {
        list() { return { catalogRevision: 1, workspaces: [workspace('/verify')] } },
        get(reference) { return reference.id === 'verify-root' ? workspace('/verify') : undefined },
        resolve(input) { return input.locator.kind === 'verify' ? { workspace: workspace('/verify') } : {} },
      },
    )
    context.extensions.publish(
      { apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'SettingsSection' },
      'verification_settings',
      {},
    )
    context.extensions.publish(
      { apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'Scene' },
      'verification_scene',
      { component() { return null } },
    )
  },
}
`)

  const disposers = await adapter.mountProfileComponents(temporaryRoot)
  if (disposers.length !== 1) throw new Error(`expected one standard component, received ${String(disposers.length)}`)
  const contributionDisposers = bindTuiContributions(
    context,
    adapter.publications.list().flatMap(publication => publication.extensions),
  )
  const commands = context.get('commands') as CommandRuntime
  if (!commands.list(agent as never).some(command => command.name === 'ping')) {
    throw new Error('standard Command did not enter the DSH command catalog used by dsh-tui')
  }
  const execution = await commands.execute(agent as never, '/ping', new AbortController().signal)
  if (execution?.result.text !== 'pong from standard component') {
    throw new Error(`standard Command returned an unexpected result: ${JSON.stringify(execution)}`)
  }
  if (notices.length !== 1 || notices[0] !== 'standard component reached dsh-tui') {
    throw new Error(`standard Notification did not reach dsh-tui: ${JSON.stringify(notices)}`)
  }
  if (openedUris.join(',') !== 'https://example.com/verify') {
    throw new Error(`standard OpenExternal did not reach dsh-tui: ${JSON.stringify(openedUris)}`)
  }
  if (commandEvents.map(event => event.type).join(',') !== 'command/run,command/done') {
    throw new Error(`standard Command did not use DSH command lifecycle: ${JSON.stringify(commandEvents)}`)
  }
  if (context.tuiCommandTrees.children(['configure', 'set'])[0]?.name !== 'theme'
    || context.tuiCommandTrees.descriptions('configure')?.zh !== '配置') {
    throw new Error('standard Command tree did not enter TUI completion metadata')
  }
  if ((await context.tuiWorkspaces.resolve('verify://root'))?.cwd !== '/verify') {
    throw new Error('standard WorkspaceProvider did not enter the TUI workspace runtime')
  }
  if (context.tuiSettingsSections.section('verification')?.title !== 'Verification settings') {
    throw new Error('private SettingsSection did not enter the TUI settings runtime')
  }
  if (!context.tuiScenes.open('verification_scene') || context.tuiScenes.active?.title !== 'Verification scene') {
    throw new Error('private Scene did not enter the TUI scene runtime')
  }

  for (const dispose of [...contributionDisposers].reverse()) dispose()
  if ((await context.tuiWorkspaces.list(process.cwd())).some(target => target.cwd === '/verify')) {
    throw new Error('WorkspaceProvider survived contribution cleanup')
  }
  if (context.tuiSettingsSections.section('verification') !== undefined) {
    throw new Error('SettingsSection survived contribution cleanup')
  }
  if (context.tuiScenes.active !== undefined || context.tuiCommandTrees.children(['configure']).length !== 0) {
    throw new Error('Scene or standard Command metadata survived contribution cleanup')
  }
  for (const dispose of disposers.reverse()) await dispose()
  await presentation.dispose()
  disposePrivateExtensions()
  disposePrivateProtocols()
  process.stdout.write('standard component activation, Command/Presentation, and TUI contributions OK\n')
} finally {
  await context.fiber.dispose()
  rmSync(temporaryRoot, { recursive: true, force: true })
}

async function verifyStandardUi(adapter: DshStandardAdapter, context: Context): Promise<void> {
  const disposeUiFacet = await adapter.mount({
    manifest: defineComponentManifest({
      apiVersion: 'manifest.dsh/internal/v1alpha1', kind: 'Component',
      metadata: { name: 'org.omdsh.verification.standard-ui', version: '1.0.0' },
      spec: { facets: [{
        name: 'tui',
        activation: { apiVersion: 'lifecycle.dsh/v1alpha1', kind: 'FacetModule', spec: { module: 'ui' } },
        protocols: { requires: [contributionHostRequirement({ surfaces: [
          { ...SETTINGS_SECTION, mode: 'host-rendered' },
          { ...SCENE, mode: 'local-module' },
        ] })] },
      }] },
    }),
    facet: 'tui',
    activate(activation) {
      const ui = activation.protocols.client<ContributionHostClient>({
        apiVersion: 'ui.dsh/v1alpha1', kind: 'ContributionHost',
      })
      if (ui === undefined) throw new Error('TUI ContributionHost client was not negotiated')
      ui.register({
        descriptor: {
          id: 'standard_ui_settings', surface: SETTINGS_SECTION,
          content: {
            namespace: 'standard_ui', title: 'Standard UI settings',
            fields: [{ path: ['enabled'], label: 'Enabled', kind: 'boolean' }],
          },
        },
      })
      ui.register({
        descriptor: {
          id: 'standard_ui_scene', surface: SCENE,
          content: { title: 'Standard UI scene' },
        },
        localModule: { component() { return null } },
      })
    },
  })
  if (context.tuiSettingsSections.section('standard_ui')?.title !== 'Standard UI settings') {
    throw new Error('ContributionHost SettingsSection did not enter the TUI settings runtime')
  }
  if (!context.tuiScenes.open('standard_ui_scene') || context.tuiScenes.active?.title !== 'Standard UI scene') {
    throw new Error('ContributionHost Scene did not enter the TUI scene runtime')
  }
  await disposeUiFacet()
  if (context.tuiSettingsSections.section('standard_ui') !== undefined || context.tuiScenes.active !== undefined) {
    throw new Error('standard UI contribution survived facet cleanup')
  }
}
