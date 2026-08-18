/** UI-owned contract between the terminal renderer and a DSH implementation. */

import type { ActivityState } from 'dsh-working-activity/status'
import type { CommandCompletion, LocalCommand } from '../commands.js'
import type { SpinnerMode } from '../components/Spinner/spinnerMode.js'
import type { ProviderSetupHost } from './provider-setup.js'
import type { SessionModeSpec } from '../sessionModes.js'
import type { PreviewEntry, SessionSummary } from './sessions.js'
import type { SettingsHost } from './settings.js'
import type { TuiSettingsSection } from '../tui-runtime/settings-sections.js'
import type { TuiSceneDescriptor } from './scenes.js'
import type {
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceTarget,
} from './workspaces.js'
import { homeDir } from '../utils/paths.js'

export type ChannelStatus = 'idle' | 'running'
export type ChannelModelModality = 'text' | 'image'

export interface ChannelModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly ChannelModelModality[]
}

export interface ChannelEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

export interface ChannelToolResultData {
  readonly turn: number
  readonly step: number
  readonly message: unknown
  readonly error?: { readonly name: string; readonly code: string }
  readonly meta?: unknown
}

export interface StagedImageInput {
  data: Uint8Array
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name?: string
}

export interface ToolFileDiff { readonly path: string; readonly oldText: string | null; readonly newText: string }

export type ToolCallView =
  | { readonly card: 'generic'; readonly title: string; readonly kind?: string }
  | { readonly card: 'terminal'; readonly title: string; readonly description?: string; readonly cwd?: string }
  | { readonly card: 'diff'; readonly title: string; readonly diffs: readonly ToolFileDiff[] }

export type ToolResultView =
  | { readonly card: 'generic'; readonly title?: string; readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }
  | { readonly card: 'terminal'; readonly title?: string; readonly output?: string; readonly exitCode?: number; readonly signal?: string }
  | { readonly card: 'diff'; readonly title?: string; readonly diffs: readonly ToolFileDiff[] }
  | { readonly card: 'read'; readonly title?: string; readonly path?: string; readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }
  | { readonly card: 'search'; readonly shape: 'matches'; readonly title?: string; readonly files: ReadonlyArray<{ readonly path: string; readonly matches: ReadonlyArray<{ readonly lineNumber: number; readonly line: string }> }>; readonly truncated: boolean; readonly total: number }
  | { readonly card: 'search'; readonly shape: 'paths'; readonly title?: string; readonly paths: readonly string[]; readonly truncated: boolean; readonly total: number }

export interface ToolRow {
  readonly callId: string
  readonly name: string
  readonly argsText: string
  argsFull?: string
  status: 'running' | 'ok' | 'error'
  resultText?: string
  resultFull?: string
  errorText?: string
  callView?: ToolCallView
  resultView?: ToolResultView
  startedAt: number
  durationMs?: number
}

export interface ToolViewPresenter {
  call(name: string, rawArgs: string): ToolCallView | undefined
  result(name: string, rawArgs: string, data: ChannelToolResultData): ToolResultView | undefined
}

export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact'
  label?: string
  executionTarget?: string
  text: string
  streaming?: boolean
  tool?: ToolRow
  time?: number
  durationMs?: number
  seq?: number
  folded?: boolean
  restored?: boolean
}

export interface TokenUsage { input: number; output: number }
export type ActivityStatus = ActivityState

export interface NotificationItem {
  id: number
  text: string
  color?: 'error' | 'warning' | 'success'
  timeoutMs: number
}

export interface ChannelGoal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  maxGoalRounds: number
  roundsStarted: number
  blockedReason?: { code: string; message: string }
}

export interface CredentialStatus { configured: boolean; source?: string; writable: boolean }
export interface TodoPanelItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface LoadedContextEntry { readonly name: string; readonly text: string }
export interface LoadedContextFile { readonly displayPath: string }
export interface LoadedContextSkill { readonly name: string; readonly description: string }
export interface SkillInfo { readonly name: string; readonly description: string; readonly userInvocable: boolean; readonly source: string }
export interface LoadedContextTool { readonly name: string; readonly description: string }
export interface LoadedContext {
  readonly sections: readonly LoadedContextEntry[]
  readonly contexts: readonly LoadedContextEntry[]
  readonly files: readonly LoadedContextFile[]
  readonly skills: readonly LoadedContextSkill[]
  readonly tools: readonly LoadedContextTool[]
}

export interface PresetOption { id: string; name?: string; description?: string; broken?: string; isDefault: boolean }
export interface PendingMessage { id: string; text: string; placement: 'steer' | 'followup' }
export interface EffortOption { id: string; name: string; description?: string }
export interface ChannelRewindMode { id: string; label: string; description?: string }

/** The observable outcome of adopting a persisted session. */
export type ResumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'working' }
  | { readonly ok: false; readonly reason: 'unavailable' }
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

export interface Channel {
  readonly version: number
  readonly rows: readonly ChatRow[]
  readonly status: ChannelStatus | 'starting' | 'disposed'
  readonly sessionTitle: string
  readonly agentId: string
  readonly model: string
  readonly provider: string
  readonly tokens: TokenUsage
  readonly cwd: string
  readonly displayCwd: string
  readonly homeDir: string
  readonly pathCaseInsensitive: boolean
  readonly gitBranch: string | undefined
  readonly working: boolean
  readonly spinnerMode: SpinnerMode
  readonly responseChars: number
  readonly activeToolCount: number
  readonly turnStart: number
  readonly lastUserText: string
  readonly notifications: readonly NotificationItem[]
  readonly contextWindow: number | undefined
  readonly reasoningEffort: string | undefined
  readonly lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
  readonly tps: number | undefined
  readonly tpsSamples: readonly { tps: number; at: number }[]
  readonly workingActivity: ActivityStatus | undefined
  readonly activityFrames: string | undefined
  readonly diffLayout: 'auto' | 'split' | 'unified'
  setDiffLayout(layout: 'auto' | 'split' | 'unified'): void
  readonly activityEnabled: boolean
  readonly contextBarEnabled: boolean
  readonly goal: ChannelGoal | undefined
  readonly todos: readonly TodoPanelItem[]
  readonly loadedContext: LoadedContext | undefined
  readonly pending: readonly PendingMessage[]
  readonly commandList: readonly LocalCommand[]
  commandCompletions(input: string): readonly CommandCompletion[]
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  readonly pluginScene: TuiSceneDescriptor | undefined
  openPluginScene(id: string): boolean
  closePluginScene(): void
  sideQuestion(question: string, options?: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<{ answer: string | null; error?: string }>
  readonly contextSegments: { system: number; prompt: number; assistant: number; thinking: number; tools: number }
  subscribe(listener: () => void): () => void
  stageImage(input: StagedImageInput): Promise<string>
  submit(text: string): void
  steer(text: string): void
  removePending(id: string): boolean
  cancel(): void
  interruptAndDeliver(texts: readonly string[]): number
  promptRewind(row: ChatRow): Promise<{ modes: readonly ChannelRewindMode[] } | 'cancel' | null>
  rewindTo(row: ChatRow, mode?: string | null): Promise<string | null>
  resumeTo(sessionId: string): Promise<ResumeResult>
  newSession(): Promise<boolean>
  listWorkspaces(): Promise<readonly WorkspaceTarget[]>
  resolveWorkspace(reference: string): Promise<WorkspaceTarget | undefined>
  switchWorkspace(target: WorkspaceTarget): Promise<boolean>
  renameWorkspace(title: string): Promise<boolean>
  workspaceCommands(): readonly Pick<WorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runWorkspaceCommand(name: string, input: string): Promise<WorkspaceCommandResult | undefined>
  switchModel(provider: string, model: string): Promise<boolean>
  listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }>
  setEffort(id: string): Promise<boolean>
  readonly mode: SessionModeSpec
  readonly modeIndex: number
  cycleMode(): Promise<void>
  readonly agentPreset: string | undefined
  listPresets(): Promise<readonly PresetOption[]>
  switchPreset(presetId: string): Promise<boolean>
  clear(): void
  readonly hasOlder?: boolean
  loadOlder(): number | Promise<number>
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): () => void
  setActivityFrames(name: string): boolean
  listModels(): Promise<readonly ChannelModelInfo[]>
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  describeCredential(ref: string): Promise<CredentialStatus | undefined>
  providerSetup(): ProviderSetupHost | undefined
  settingsHost(): SettingsHost | undefined
  settingsSections(): readonly TuiSettingsSection[]
  subscribeSettingsSections(listener: () => void): () => void
  listFiles(): Promise<readonly string[]>
  listSessions(): Promise<readonly SessionSummary[]>
  previewSession(sessionId: string): Promise<readonly PreviewEntry[]>
  setResumeTarget(sessionId: string): void
  renameSession(title: string): void
  deleteSession(sessionId: string): Promise<boolean>
  renameSessionTo(sessionId: string, title: string): Promise<boolean>
  compact(): void
  pushLocal(title: string, lines: readonly string[]): void
  mcpStatus(): string[]
  exportSession(): string | null | Promise<string | null>
  initWorkspace(): string | null | Promise<string | null>
  configInfo(): string[]
  doctorInfo(): string[]
  pluginsInfo(args: string): string[] | Promise<string[]>
  listSubagents(): Promise<string[]>
  releaseContributions(): void
  traceEvents(): readonly ChannelEvent[]
}

function normalizeCwd(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

export function sessionCwdMatches(
  stateCwd: string,
  headerCwd: string,
  caseInsensitive: boolean = process.platform === 'win32',
  authorityHome: string = homeDir(),
): boolean {
  const cwd = normalizeCwd(stateCwd, caseInsensitive)
  const recorded = normalizeCwd(headerCwd, caseInsensitive)
  if (recorded === '' || cwd === '') return false
  const home = normalizeCwd(authorityHome, caseInsensitive)
  const isContainer = (path: string): boolean =>
    (home !== '' && path === home)
    || /^[a-z]:$/iu.test(path)
    || /^\/\/[^/]+\/[^/]+$/u.test(path)
    || /^\/\/\?\/[a-z]:$/iu.test(path)
    || /^\/\/\?\/unc\/[^/]+\/[^/]+$/iu.test(path)
  if (isContainer(cwd) || isContainer(recorded)) return recorded === cwd
  return recorded === cwd || recorded.startsWith(`${cwd}/`) || cwd.startsWith(`${recorded}/`)
}
