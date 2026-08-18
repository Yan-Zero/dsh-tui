import { Context } from '@deepseek-ai/cordis'
import { apply as applyDshStandardAdapter, type AdapterConfig } from '@dsh-std/adapter-dsh'
import { registerProfileProtocols, registerTuiContributionExtensions } from 'dsh-ecosystem-spec/protocols'

export const name = 'dsh-tui-standards'

export interface TuiStandardsConfig {
  readonly profileBaseUrl?: string
}

/** Own the DSH standard adapter and register the TUI profile on its catalogs. */
export async function apply(ctx: Context, config: TuiStandardsConfig = {}): Promise<void> {
  const adapterConfig: AdapterConfig = {
    ...(config.profileBaseUrl === undefined ? {} : { profileBaseUrl: config.profileBaseUrl }),
    discover: false,
  }
  await applyDshStandardAdapter(ctx, adapterConfig)
  const adapter = ctx.dshStd
  ctx.effect(
    () => {
      const disposeProtocols = registerProfileProtocols(adapter.protocols)
      const disposeExtensions = registerTuiContributionExtensions(adapter.manifestDefinitions)
      return () => {
        disposeExtensions()
        disposeProtocols()
      }
    },
    'dsh-tui private protocol and contribution definitions',
  )
}

apply.inject = ['agents', 'commands', 'llm']

export default apply
