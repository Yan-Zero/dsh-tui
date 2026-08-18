/** Server-side bridge from standard plugin Presentation calls to the terminal connection that invoked them. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { defineProtocolDeclaration, type ProtocolDeclaration, type ProtocolSupport } from '@dsh-std/core'
import type { StandardConnection } from '@dsh-std/connection'
import { defineComponentManifest } from '@dsh-std/manifest'
import {
  copyTextImplementation,
  copyTextSupport,
  notificationImplementation,
  notificationSupport,
  openExternalImplementation,
  openExternalSupport,
  userInteractionImplementation,
  userInteractionClient,
  userInteractionSupport,
  type PresentationResult,
  type UserInteractionHandler,
  type UserInteractionRequest,
  type UserInteractionSupportSpec,
  type UserInteractionValue,
} from '@dsh-std/presentation'
import {
  externalRedirectImplementation,
  externalRedirectSupport,
  type ExternalRedirectReady,
  type ExternalRedirectValue,
} from '@dsh-std/presentation/callback'
import type { TuiChannelInvocationScope } from './channel-connection.js'
import { agentPresentationRoute, type TuiAgentPresentationRoute } from '../dsh-adapter/agent-presentation.js'

const COMPONENT = 'org.omdsh.dsh-tui.presentation-relay'
const FACET = 'presentation'
const VERSION = '0.8.0'
const CONSUMER_PARTICIPANT = `${COMPONENT}/terminal`
const INTERACTION_SPEC: UserInteractionSupportSpec = Object.freeze({
  operations: Object.freeze(['question', 'approval', 'secret-input'] as const),
  limits: Object.freeze({ maxConcurrentRequests: 1, maxFields: 32, maxOptionsPerField: 64, maxTextLength: 65_536 }),
})
const INTERACTION_REQUIREMENT = Object.freeze({
  apiVersion: 'presentation.dsh/v1alpha1',
  kind: 'UserInteraction',
  spec: Object.freeze({ operations: INTERACTION_SPEC.operations }),
})
const INTERACTION_PROTOCOL: ProtocolSupport = Object.freeze({
  apiVersion: 'presentation.dsh/v1alpha1',
  kind: 'UserInteraction',
})
const PRESENTATION_REQUIREMENTS = Object.freeze([
  notificationSupport,
  copyTextSupport,
  openExternalSupport,
  externalRedirectSupport,
  INTERACTION_REQUIREMENT,
])

interface RelayConnection {
  readonly connection: StandardConnection
  readonly consumerParticipantId: string
}

export interface TuiPresentationRelayBinding {
  readonly providerParticipantId: string
  readonly consumerParticipantId: string
  readonly consumerDeclaration: ProtocolDeclaration
  dispose(): Promise<void>
}

/** Route a standard Presentation invocation only to the terminal that initiated its Channel call. */
export class TuiPresentationRelay implements TuiChannelInvocationScope {
  private readonly scope = new AsyncLocalStorage<{ readonly connectionId: string; readonly invocationId: string }>()
  private readonly connections = new Map<string, RelayConnection>()

  run<T>(invocation: { readonly connectionId: string; readonly invocationId: string }, operation: () => T): T {
    return this.scope.run(invocation, operation)
  }

  attach(connection: StandardConnection, consumerParticipantId: string): () => void {
    const route = Object.freeze({ connection, consumerParticipantId })
    this.connections.set(connection.id, route)
    return () => {
      if (this.connections.get(connection.id) === route) this.connections.delete(connection.id)
    }
  }

  async forward<T>(
    protocol: ProtocolSupport,
    operation: string,
    input: unknown,
    signal: AbortSignal,
    progress?: (value: unknown) => void,
  ): Promise<PresentationResult<T>> {
    const active = this.scope.getStore()
    const route = active === undefined ? undefined : this.connections.get(active.connectionId)
    if (route === undefined) return { status: 'unavailable', reason: 'no terminal is attached to this invocation' }
    const client = route.connection.client(route.consumerParticipantId)
    if (client.binding(protocol) === undefined) {
      return { status: 'unavailable', reason: `terminal does not provide ${protocol.kind}` }
    }
    try {
      const call = client.invoke<unknown, PresentationResult<T>, unknown>(protocol, operation, input, { signal })
      const forwarding = progress === undefined ? undefined : (async () => {
        for await (const value of call.progress) progress(value)
      })()
      const result = await call.result
      await forwarding
      return result
    } catch (error) {
      return signal.aborted
        ? { status: 'cancelled' }
        : { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Capture a standard UserInteraction client while Channel.open owns the physical invocation. */
  captureAgentPresentation(): TuiAgentPresentationRoute | undefined {
    const active = this.scope.getStore()
    if (active === undefined) return undefined
    const route = this.connections.get(active.connectionId)
    if (route === undefined) return undefined
    const client = route.connection.client(route.consumerParticipantId)
    if (client.binding(INTERACTION_PROTOCOL) === undefined) return undefined
    let requestSequence = 0
    return agentPresentationRoute(userInteractionClient(client, {
      invocationId: active.invocationId,
      origin: route.consumerParticipantId,
      nextRequestId: () => `${active.invocationId}:agent:${String(++requestSequence)}`,
    }))
  }
}

/** Publish one generic Presentation provider for every standard component on the server. */
export async function mountTuiPresentationRelay(
  adapter: DshStandardAdapter,
  relay: TuiPresentationRelay,
): Promise<TuiPresentationRelayBinding> {
  const manifest = defineComponentManifest({
    apiVersion: 'manifest.dsh/internal/v1alpha1',
    kind: 'Component',
    metadata: { name: COMPONENT, displayName: 'dsh-TUI Presentation Relay', version: VERSION },
    spec: {
      facets: [{
        name: FACET,
        activation: {
          apiVersion: 'lifecycle.dsh/v1alpha1',
          kind: 'FacetModule',
          spec: { module: '@deepseek-harness-tui/dsh-tui/standards' },
        },
        protocols: {
          supports: [
            notificationSupport,
            copyTextSupport,
            openExternalSupport,
            externalRedirectSupport,
            userInteractionSupport(INTERACTION_SPEC),
          ],
        },
      }],
    },
  })

  let providerParticipantId: string | undefined
  const disposeProvider = await adapter.mount({
    manifest,
    facet: FACET,
    activate(context) {
      providerParticipantId = context.identity.participantId
      context.protocols.implement(notificationSupport, notificationImplementation(providerParticipantId, {
        notify: (request, capability) => relay.forward(notificationSupport, 'notify', request, capability.signal),
      }))
      context.protocols.implement(copyTextSupport, copyTextImplementation(providerParticipantId, {
        copyText: (request, capability) => relay.forward(copyTextSupport, 'copyText', request, capability.signal),
      }))
      context.protocols.implement(openExternalSupport, openExternalImplementation(providerParticipantId, {
        openExternal: (request, capability) => relay.forward(openExternalSupport, 'openExternal', request, capability.signal),
      }))
      context.protocols.implement(externalRedirectSupport, externalRedirectImplementation(providerParticipantId, {
        receive: (request, capability) => relay.forward<ExternalRedirectValue>(
          externalRedirectSupport,
          'receive',
          request,
          capability.signal,
          value => capability.progress(value as ExternalRedirectReady),
        ),
      }))
      context.protocols.implement(
        userInteractionSupport(INTERACTION_SPEC),
        userInteractionImplementation(providerParticipantId, INTERACTION_SPEC, {
          interact: ((request: UserInteractionRequest, capability) => relay.forward<UserInteractionValue>(
            INTERACTION_PROTOCOL,
            'interact',
            request,
            capability.signal,
          )) as UserInteractionHandler['interact'],
        }),
      )
    },
  })
  if (providerParticipantId === undefined) {
    await disposeProvider()
    throw new Error('dsh-tui Presentation relay activated without a provider identity')
  }
  const consumerDeclaration = defineProtocolDeclaration({
    participant: { id: CONSUMER_PARTICIPANT },
    requires: PRESENTATION_REQUIREMENTS,
  })
  return Object.freeze({
    providerParticipantId,
    consumerParticipantId: CONSUMER_PARTICIPANT,
    consumerDeclaration,
    dispose: disposeProvider,
  })
}
