/** dsh-TUI private protocol registration on the shared dsh-std catalog. */

import { ProtocolCatalog } from '@dsh-std/core'
import { ManifestDefinitionCatalog } from '@dsh-std/manifest'
import { register as registerCommand } from '@dsh-std/command'
import { register as registerMessages } from '@dsh-std/messages'
import { register as registerPresentation } from '@dsh-std/presentation'
import { register as registerStorage } from '@dsh-std/storage'
import { register as registerUi, registerManifest as registerUiManifest } from '@dsh-std/ui'
import { register as registerWorkspace } from '@dsh-std/workspace'
import {
  DECISION_EVENTS,
  registerProfileProtocols,
  registerTuiContributionExtensions,
} from 'dsh-ecosystem-spec/protocols'
import type { ContractCoordinate } from './types.js'

export const TUI_EXTENSION_API_VERSION = DECISION_EVENTS.apiVersion

export const DECISION_EVENTS_COORDINATE: Readonly<ContractCoordinate> = Object.freeze({
  ...DECISION_EVENTS,
})

export const TUI_DECISION_EVENT_NAMES = Object.freeze([
  'tui/input',
  'tui/rewind-prompt',
  'tui/rewind-done',
  'tui/session-switch',
  'tui/session-switched',
  'tui/compact',
] as const)

export const TUI_EXTENSION_PERMISSION_NAMES = Object.freeze([
  'session.input.intercept',
  'session.rewind.intercept',
  'session.switch.intercept',
  'session.compact.intercept',
] as const)

export interface AdmissionCatalog {
  protocols: ProtocolCatalog
  manifests: ManifestDefinitionCatalog
}

/** Register public and private definitions into one evaluator-owned catalog. */
export function createAdmissionCatalog(): AdmissionCatalog {
  const protocols = new ProtocolCatalog({ name: 'dsh-tui-admission', version: '0.15' })
  const manifests = new ManifestDefinitionCatalog()
  registerCommand(protocols, manifests)
  registerStorage(protocols)
  registerMessages(protocols)
  registerPresentation(protocols)
  registerWorkspace(protocols, manifests)
  registerUi(protocols)
  registerUiManifest(manifests)
  registerProfileProtocols(protocols)
  registerTuiContributionExtensions(manifests)
  return { protocols, manifests }
}
