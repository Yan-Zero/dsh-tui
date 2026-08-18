export interface SettingsNamespaceView {
  readonly ns: string
  readonly revision: number
  readonly applies: 'live' | 'restart'
  readonly value: unknown
  readonly user: unknown
}

export interface SettingsHost {
  listNamespaces(): readonly SettingsNamespaceView[]
  write(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  credentialConfigured(ref: string): Promise<boolean>
  writeCredential(ref: string, value: string): Promise<void>
}

export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }
