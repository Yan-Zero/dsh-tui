import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@dsh-std/adapter-dsh'
import { sameProtocol } from '@dsh-std/core'
import type { ManifestExtension } from '@dsh-std/manifest'
import {
  WORKSPACE_PROVIDER_KIND,
  assertWorkspaceProviderHandler,
  type WorkspaceDescriptor,
  type WorkspaceProviderHandler,
  type WorkspaceProviderSpec,
} from '@dsh-std/workspace'
import {
  API_VERSION as COMMAND_API_VERSION,
  KIND as COMMAND_KIND,
  type CommandNode,
  type CommandNodeSpec,
  type CommandResource,
} from '@dsh-std/command'
import {
  SCENE,
  SETTINGS_SECTION,
  assertSceneHandler,
  assertSettingsSectionHandler,
  type SceneHandler,
  type SceneSpec,
  type SettingsSectionSpec,
} from 'dsh-ecosystem-spec/tui-contributions'
import { localWorkspaceUri, type TuiWorkspaceProvider, type TuiWorkspaceRuntime, type WorkspaceTarget } from '../tui-runtime/workspaces.js'
import type { TuiCommandTreeRuntime } from '../tui-runtime/command-trees.js'
import type { CommandCompletionNode, LocalizedDescriptions } from '../commands.js'
import type { TuiSettingsSectionsRuntime } from '../tui-runtime/settings-sections.js'
import type { TuiSceneDescriptor, TuiSceneProps, TuiSceneRuntime } from '../tui-runtime/scenes.js'
import { settingsSection } from './ui-surfaces.js'

export interface TuiComponentLoaderConfig {
  readonly profileBaseUrl?: string
}

interface LiveExtension {
  readonly extension: ManifestExtension
  readonly handler: unknown
}

export const name = 'dsh-tui-standard-component-loader'

/**
 * Load portable facets, then bind TUI-owned private contributions through
 * their lifecycle publications. Standard Command/Model/Tool publications
 * remain the responsibility of @dsh-std/adapter-dsh.
 */
export async function apply(ctx: Context, config: TuiComponentLoaderConfig = {}): Promise<void> {
  const adapter = ctx.get('dshStd')
  if (adapter === undefined) throw new Error('dsh-tui component loader requires the dsh standard adapter')
  const profileDir = profileDirectory(config.profileBaseUrl?.trim() || ctx.baseUrl)
  if (profileDir === undefined) return

  const previous = new Set(adapter.publications.list().map(publication => publication.identity.instanceId))
  const componentDisposers = await adapter.mountProfileComponents(profileDir)
  const contributionDisposers: Array<() => void> = []
  try {
    const extensions = adapter.publications.list()
      .filter(publication => !previous.has(publication.identity.instanceId))
      .flatMap(publication => publication.extensions)
    contributionDisposers.push(...bindTuiContributions(ctx, extensions))
  } catch (error) {
    for (const dispose of contributionDisposers.reverse()) dispose()
    for (const dispose of [...componentDisposers].reverse()) await dispose()
    throw error
  }

  ctx.effect(() => async () => {
    for (const dispose of contributionDisposers.reverse()) dispose()
    for (const dispose of [...componentDisposers].reverse()) await dispose()
  }, 'dsh-tui standard component discovery')
}

apply.inject = ['dshStd']

/** Bind lifecycle-owned private contribution publications to TUI runtimes. */
export function bindTuiContributions(ctx: Context, rows: readonly LiveExtension[]): readonly (() => void)[] {
  const disposers: Array<() => void> = []
  try {
    for (const row of rows) {
      if (sameProtocol(row.extension, { apiVersion: COMMAND_API_VERSION, kind: COMMAND_KIND })) {
        const runtime = ctx.get('tuiCommandTrees') as TuiCommandTreeRuntime | undefined
        if (runtime !== undefined) disposers.push(bindCommandTree(runtime, row.extension as CommandResource))
        continue
      }
      if (sameProtocol(row.extension, { apiVersion: 'workspace.dsh/v1alpha1', kind: WORKSPACE_PROVIDER_KIND })) {
        const runtime = ctx.get('tuiWorkspaces') as TuiWorkspaceRuntime | undefined
        if (runtime === undefined) throw new Error('WorkspaceProvider contribution requires the TUI workspace runtime')
        const spec = row.extension.spec as WorkspaceProviderSpec
        assertWorkspaceProviderHandler(row.handler, spec)
        const handler = row.handler as WorkspaceProviderHandler
        const provider: TuiWorkspaceProvider = {
          schemes: spec.locatorKinds.filter(kind => kind !== 'file'),
          async list(signal) {
            const snapshot = await handler.list({ signal })
            return snapshot.workspaces.map(workspace => standardWorkspaceTarget(workspace, spec.title)).filter(isPresent)
          },
          async resolve(uri, signal) {
            const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(uri)?.[1]?.toLowerCase()
            if (scheme === undefined || !spec.locatorKinds.includes(scheme)) return undefined
            const result = await handler.resolve({ locator: { kind: scheme, spec: { uri } } }, { signal })
            return result.workspace === undefined ? undefined : standardWorkspaceTarget(result.workspace, spec.title)
          },
          describe: () => undefined,
        }
        disposers.push(runtime.register(provider))
        continue
      }
      if (sameProtocol(row.extension, SETTINGS_SECTION)) {
        const runtime = ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined
        if (runtime === undefined) throw new Error('SettingsSection contribution requires the TUI settings runtime')
        assertSettingsSectionHandler(row.handler)
        disposers.push(runtime.register(settingsSection(row.extension.spec as SettingsSectionSpec)))
        continue
      }
      if (sameProtocol(row.extension, SCENE)) {
        const runtime = ctx.get('tuiScenes') as TuiSceneRuntime | undefined
        if (runtime === undefined) throw new Error('Scene contribution requires the TUI scene runtime')
        assertSceneHandler(row.handler)
        const spec = row.extension.spec as SceneSpec
        const handler = row.handler as SceneHandler<TuiSceneProps, unknown>
        disposers.push(runtime.register({
          id: row.extension.metadata.name,
          ...(spec.title === undefined ? {} : { title: spec.title }),
          component: handler.component.bind(handler) as TuiSceneDescriptor['component'],
        }))
      }
    }
    return Object.freeze(disposers)
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
}

function bindCommandTree(runtime: TuiCommandTreeRuntime, resource: CommandResource): () => void {
  const descriptions = localized(resource.spec.titles)
  return runtime.register({
    root: resource.metadata.name,
    ...(descriptions === undefined ? {} : { descriptions }),
    children(path) {
      let spec: CommandNodeSpec | undefined = resource.spec
      for (const token of path.slice(1)) {
        const child: CommandNode | undefined = spec.children?.find(candidate =>
          candidate.name === token || candidate.spec.aliases?.includes(token))
        if (child === undefined) return []
        spec = child.spec
      }
      return (spec.children ?? []).map(commandNode)
    },
  })
}

function commandNode(node: CommandNode): CommandCompletionNode {
  const descriptions = localized(node.spec.titles)
  return {
    name: node.name,
    ...(node.spec.aliases === undefined ? {} : { aliases: node.spec.aliases }),
    description: node.spec.description ?? node.spec.title,
    ...(descriptions === undefined ? {} : { descriptions }),
  }
}

function localized(value: Readonly<Record<string, string>> | undefined): LocalizedDescriptions | undefined {
  if (value === undefined) return undefined
  const descriptions: Partial<Record<'zh' | 'en', string>> = {}
  if (value.zh !== undefined) descriptions.zh = value.zh
  if (value.en !== undefined) descriptions.en = value.en
  return Object.keys(descriptions).length === 0 ? undefined : descriptions
}

function standardWorkspaceTarget(workspace: WorkspaceDescriptor, providerTitle: string): WorkspaceTarget | undefined {
  const locator = workspace.location.canonical
  if (locator?.kind !== 'file' || !isRecord(locator.spec) || typeof locator.spec.path !== 'string') return undefined
  return {
    uri: localWorkspaceUri(locator.spec.path),
    cwd: locator.spec.path,
    label: workspace.title,
    description: workspace.location.display,
    kind: 'provider',
    badge: providerTitle,
  }
}

function isPresent<T>(value: T | undefined): value is T { return value !== undefined }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function profileDirectory(baseUrl: string | URL | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  try {
    const path = fileURLToPath(typeof baseUrl === 'string' ? new URL(baseUrl) : baseUrl)
    return /[/\\]$/u.test(path) ? path.replace(/[/\\]+$/u, '') : dirname(path)
  } catch {
    return undefined
  }
}

export default apply
