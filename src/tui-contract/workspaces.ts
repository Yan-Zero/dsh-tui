/** TUI-only projection after a standard Workspace has been bound to an execution cwd. */
export interface WorkspaceTarget {
  readonly uri: string
  readonly cwd: string
  readonly label: string
  readonly description?: string
  readonly kind: 'local' | 'provider'
  readonly badge: string
}

export interface WorkspaceProgress { readonly label: string; readonly ratio?: number }
export interface WorkspaceChoice {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly badge?: string
  choose(signal?: AbortSignal, reportProgress?: (progress: WorkspaceProgress) => void): WorkspaceCommandResult | Promise<WorkspaceCommandResult>
  readonly input?: {
    readonly initialValue?: string
    readonly placeholder?: string
    submit(value: string, signal?: AbortSignal, reportProgress?: (progress: WorkspaceProgress) => void): WorkspaceCommandResult | Promise<WorkspaceCommandResult>
  }
}
export type WorkspaceCommandResult =
  | { readonly kind: 'choices'; readonly title: string; readonly choices: readonly WorkspaceChoice[] }
  | { readonly kind: 'target'; readonly target: WorkspaceTarget }
export interface WorkspaceCommand {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  run(input: string, context: { readonly cwd: string }, signal?: AbortSignal): WorkspaceCommandResult | Promise<WorkspaceCommandResult>
}
export interface WorkspaceCommandShell {
  resolve(request: { readonly command: string; readonly workdir?: string; readonly timeoutMs?: number }): unknown
  run(spec: unknown): Promise<{
    readonly exitCode: number | null
    readonly stdout: { readonly text: string }
    readonly stderr: { readonly text: string }
    readonly timedOut: boolean
  }>
}
