import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DshStandardAdapter } from '@dsh-std/adapter-dsh'
import { registerProfileProtocols } from 'dsh-ecosystem-spec/protocols'
import type { Channel } from '../src/tui-contract/channel.js'
import { DirectTuiBackend } from '../src/std-adapter/direct-backend.js'
import { ApprovalStore } from '../src/dsh-adapter/approvals.js'
import { QuestionStore } from '../src/dsh-adapter/questions.js'
import { mountTuiStandardParticipant } from '../src/std-adapter/standard-participant.js'

const harness = resolve(process.env.DSH_TUI_VERIFY_HARNESS ?? '../../deepseek-harness')
const profile = process.env.DSH_TUI_VERIFY_PROFILE ?? 'tui'
const root = await mkdtemp(join(tmpdir(), 'dsh-tui-live-'))
const workspace = join(root, 'workspace')
const sessionRoot = join(root, 'sessions')
await mkdir(workspace)
const clientContext = new Context()
let child: ReturnType<typeof spawn> | undefined
let stdout = ''
let stderr = ''

try {
  try {
    const occupied = await fetch('http://127.0.0.1:10721/dsh-tui/v1/health')
    if (occupied.ok) throw new Error('port 10721 is already serving a dsh-tui endpoint')
  } catch (error) {
    if (error instanceof Error && error.message.includes('already serving')) throw error
  }
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', profile, '--server'], {
    cwd: harness,
    env: {
      ...process.env,
      DSH_TUI_SESSION_ROOT: sessionRoot,
      DSH_TUI_WORKSPACE_TARGET: workspace,
      DSH_TUI_PRESET: 'minimal',
      DSH_TUI_LANG: 'zh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  await waitForHealth(child, () => stdout, () => stderr)

  const adapter = new DshStandardAdapter(clientContext, { profile: 'live-client' })
  const unregisterProtocols = registerProfileProtocols(adapter.protocols)
  const questions = new QuestionStore()
  const approvals = new ApprovalStore()
  const presentation = await mountTuiStandardParticipant(adapter, { questions, approvals, notify() {} })
  const terminal = terminalChannel()
  const backend = new DirectTuiBackend(adapter)
  const binding = backend.attach({
    channel: terminal,
    askQuestions: request => questions.ask(request),
    requestApproval: request => approvals.parkExternal(request),
    locale: () => 'en',
  })
  const channel = binding.channel as Channel
  if (binding.handleCommand?.({ channel, name: 'connect', input: '127.0.0.1', present() {} }) !== true) {
    throw new Error('live /connect was not claimed')
  }
  await eventually(() => resolve(channel.cwd) === resolve(workspace))
  if (resolve(channel.cwd) !== resolve(workspace)) throw new Error(`live server opened wrong workspace: ${channel.cwd}`)
  if (channel.agentId === '') throw new Error('live server did not create an Agent')
  if (channel.agentPreset !== 'minimal') {
    throw new Error(`live server ignored its profile preset: ${String(channel.agentPreset)}`)
  }
  await channel.setEffort('__invalid_remote_effort__')
  const localeNotice = channel.notifications.find(item =>
    item.text.startsWith('Unknown reasoning effort')
    || item.text.startsWith('Reasoning effort switching unavailable')
    || item.text.startsWith('Current model'))
  if (localeNotice === undefined) {
    throw new Error(`remote Channel ignored the terminal locale: ${JSON.stringify(channel.notifications.map(item => item.text))}`)
  }
  const initialAgent = channel.agentId
  const initialized = await channel.initWorkspace()
  if (typeof initialized !== 'string' || resolve(initialized) !== resolve(join(workspace, 'AGENTS.md'))) {
    throw new Error(`live /init returned ${String(initialized)}`)
  }
  if (!(await channel.listFiles()).some(path => path.replace(/\\/gu, '/').endsWith('AGENTS.md'))) {
    throw new Error('live remote filesystem did not expose AGENTS.md')
  }
  channel.submit('!node -p "process.cwd()"')
  await eventually(() => channel.rows.some(row => row.kind === 'local-output'
    && resolve(row.text.trim()) === resolve(workspace)))
  const shellOutput = [...channel.rows].reverse().find(row => row.kind === 'local-output')?.text.trim()
  if (shellOutput === undefined || resolve(shellOutput) !== resolve(workspace)) {
    throw new Error(`live remote shell returned ${String(shellOutput)}`)
  }
  channel.renameSession('Live remote verification')
  await eventually(() => channel.sessionTitle === 'Live remote verification')
  if (!(await channel.listModels()).length) throw new Error('live remote model catalog is empty')
  if (!(await channel.listPresets()).length) throw new Error('live remote preset catalog is empty')
  if (channel.settingsHost() === undefined) throw new Error('live remote settings host is unavailable')
  if (!(await channel.newSession())) throw new Error('live remote /new failed')
  await eventually(() => channel.agentId !== initialAgent)
  if (resolve(channel.cwd) !== resolve(workspace)) throw new Error('live /new lost the remote workspace')

  if (binding.handleCommand?.({ channel, name: 'disconnect', input: '', present() {} }) !== true) {
    throw new Error('live /disconnect was not claimed')
  }
  await eventually(() => channel.cwd === terminal.cwd)
  await binding.dispose?.()
  await backend.dispose()
  await presentation.dispose()
  unregisterProtocols()
  process.stdout.write('real dsh --profile tui --server with /connect, Agent, remote shell, session, filesystem, settings and /disconnect OK\n')
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`, { cause: error })
} finally {
  if (child !== undefined) {
    child.kill('SIGTERM')
    await waitForExit(child, 3000)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child, 3000)
    }
  }
  await clientContext.fiber.dispose()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function terminalChannel(): Channel {
  const listeners = new Set<() => void>()
  const state: Record<string, unknown> = {
    version: 1, rows: [], status: 'idle', sessionTitle: 'terminal', agentId: 'terminal', model: '', provider: '',
    tokens: { input: 0, output: 0 }, cwd: process.cwd(), displayCwd: process.cwd(), working: false,
    spinnerMode: 'thinking', responseChars: 0, activeToolCount: 0, turnStart: 0, lastUserText: '', notifications: [],
    tpsSamples: [], activityEnabled: true, contextBarEnabled: true, diffLayout: 'auto', todos: [], pending: [],
    commandList: [], contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default' }, modeIndex: 0,
  }
  const methods: Record<string, (...args: any[]) => any> = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    commandCompletions: () => [], settingsSections: () => [], subscribeSettingsSections: () => () => {},
    setDiffLayout: () => {}, setActivityFrames: () => true, openPluginScene: () => false, closePluginScene: () => {},
    settingsHost: () => undefined, providerSetup: () => undefined, notify: () => {}, pushLocal: () => {}, releaseContributions: () => {},
  }
  return new Proxy({} as Channel, {
    get(_target, property) {
      if (typeof property === 'string' && property in methods) return methods[property]
      if (typeof property === 'string' && property in state) return state[property]
      return undefined
    },
  })
}

async function waitForHealth(
  processHandle: ReturnType<typeof spawn>,
  out: () => string,
  err: () => string,
): Promise<void> {
  const deadline = Date.now() + 25_000
  for (;;) {
    if (processHandle.exitCode !== null) throw new Error(`server exited with ${String(processHandle.exitCode)}\n${out()}\n${err()}`)
    try {
      const response = await fetch('http://127.0.0.1:10721/dsh-tui/v1/health')
      if (response.ok && (await response.json() as { ok?: unknown }).ok === true) return
    } catch {}
    if (Date.now() >= deadline) throw new Error(`server did not become ready\n${out()}\n${err()}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
}

function waitForExit(processHandle: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return Promise.resolve()
  return new Promise(resolveExit => {
    const timer = setTimeout(done, timeoutMs)
    const exited = (): void => done()
    function done(): void {
      clearTimeout(timer)
      processHandle.off('exit', exited)
      resolveExit()
    }
    processHandle.once('exit', exited)
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) done()
  })
}

async function eventually(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('live Channel state did not update')
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}
