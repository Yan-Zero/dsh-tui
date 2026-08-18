import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@dsh-std/adapter-dsh'
import type { UiContributionProvider, UiContributionRegistration } from '@dsh-std/ui'
import {
  SCENE,
  SETTINGS_SECTION,
  assertSceneHandler,
  validateSceneSpec,
  validateSettingsSectionSpec,
  type SceneHandler,
} from 'dsh-ecosystem-spec/tui-contributions'
import type { TuiSceneDescriptor, TuiSceneProps, TuiSceneRuntime } from '../tui-runtime/scenes.js'
import type { TuiSettingsSectionsRuntime } from '../tui-runtime/settings-sections.js'
import { settingsSection } from './ui-surfaces.js'

export const name = 'dsh-tui-standard-ui-host'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStandardUiHost: TuiStandardUiHost
  }
}

export class TuiStandardUiHost extends Service {
  constructor(ctx: Context, dispose: readonly (() => Promise<void>)[]) {
    super(ctx, 'tuiStandardUiHost')
    ctx.effect(() => async () => {
      for (const close of [...dispose].reverse()) await close()
    }, 'dsh-tui standard UI surface hosts')
  }
}

/** Publish the concrete TUI surfaces consumed through @dsh-std/ui. */
export async function apply(ctx: Context): Promise<void> {
  const adapter = ctx.get('dshStd')
  const settings = ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined
  const scenes = ctx.get('tuiScenes') as TuiSceneRuntime | undefined
  if (adapter === undefined) throw new Error('dsh-tui UI host requires the dsh standard adapter')
  if (settings === undefined || scenes === undefined) throw new Error('dsh-tui UI host requires its surface runtimes')

  const disposeSettings = adapter.registerUiContributionProvider(settingsProvider(settings))
  try {
    const disposeScenes = adapter.registerUiContributionProvider(sceneProvider(scenes))
    new TuiStandardUiHost(ctx, [disposeSettings, disposeScenes])
  } catch (error) {
    await disposeSettings()
    throw error
  }
}

apply.inject = ['dshStd', 'tuiSettingsSections', 'tuiScenes']

function settingsProvider(runtime: TuiSettingsSectionsRuntime): UiContributionProvider {
  return Object.freeze({
    participantId: 'dsh-tui/ui/settings-section',
    support: { surfaces: [{ ...SETTINGS_SECTION, modes: ['host-rendered'] as const }] },
    register(_owner, contribution) {
      return runtime.register(settingsSection(validateSettingsSectionSpec(contribution.descriptor.content)))
    },
  })
}

function sceneProvider(runtime: TuiSceneRuntime): UiContributionProvider {
  return Object.freeze({
    participantId: 'dsh-tui/ui/scene',
    support: { surfaces: [{ ...SCENE, modes: ['local-module'] as const }] },
    register(_owner, contribution) {
      const spec = validateSceneSpec(contribution.descriptor.content)
      const handler = localSceneHandler(contribution)
      return runtime.register({
        id: contribution.descriptor.id,
        ...(spec.title === undefined ? {} : { title: spec.title }),
        component: handler.component.bind(handler) as TuiSceneDescriptor['component'],
      })
    },
  })
}

function localSceneHandler(contribution: UiContributionRegistration): SceneHandler<TuiSceneProps, unknown> {
  assertSceneHandler(contribution.localModule)
  return contribution.localModule as SceneHandler<TuiSceneProps, unknown>
}

export default apply
