export interface CatalogProviderCandidate {
  readonly provider: string
  readonly displayName: string
}

export interface ProviderDiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

export interface ProviderSetupHost {
  listCatalogProviders(): readonly CatalogProviderCandidate[] | Promise<readonly CatalogProviderCandidate[]>
  routeExists(route: string): boolean | Promise<boolean>
  discoverModels(request: {
    readonly provider?: string
    readonly baseURL?: string
    readonly api?: string
    readonly apiKey?: string
  }): Promise<readonly ProviderDiscoveredModel[]>
  envShadows(ref: string): boolean | Promise<boolean>
  readCredential(ref: string): Promise<string | undefined>
  writeCredential(ref: string, value: string): void | Promise<void>
  removeCredential(ref: string): void | Promise<void>
  writeProfile(route: string, profile: Record<string, unknown>): Promise<void>
  commitProvider?(request: {
    readonly route: string
    readonly profile: Record<string, unknown>
    readonly credential?: { readonly ref: string; readonly value: string }
  }): Promise<void>
}
