/** Standalone headless endpoint selected by the TUI application's --server flag. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dsh-std/adapter-dsh'
import { apply as applyChannelProvider } from './channel-provider.js'
import { listenTuiChannelHttp } from '../std-adapter/channel-http.js'
import { tuiConnectionEndpoint } from '../std-adapter/channel-connection.js'
import type { TuiLaunchRuntime } from './launch.js'
import type { TuiPresentationRuntime } from '../std-adapter/presentation-participant.js'
import type { TuiProfileConfig } from './index.js'

export const name = 'dsh-tui-channel-server'
export const inject = ['agents', 'dshStd', 'tuiLaunch', 'tuiPresentation']

export async function apply(ctx: Context): Promise<void> {
  const launch = ctx.tuiLaunch as TuiLaunchRuntime
  if (!launch.server) return
  await applyChannelProvider(ctx, ctx.get('tuiProfileConfig') as TuiProfileConfig | undefined)
  const endpoint = tuiConnectionEndpoint(ctx.dshStd.connectionEndpoint)
  const presentation = ctx.tuiPresentation as TuiPresentationRuntime
  const releasePresentationDeclaration = presentation.attachEndpoint(endpoint)
  const server = await listenTuiChannelHttp(endpoint, ctx.dshStd.protocols, {
    host: launch.host,
    port: launch.port,
    onConnection: connection => presentation.attachConnection(connection, endpoint.participantId),
  })
  process.stdout.write(`dsh-tui server: ${server.origin}\n`)
  ctx.effect(() => async () => {
    await server.close()
    releasePresentationDeclaration()
  }, 'dsh-tui Channel HTTP server')
}

export default apply
