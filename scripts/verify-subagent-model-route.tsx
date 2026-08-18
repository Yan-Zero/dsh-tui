/**
 * Regression for issue #191: a subagent whose AgentOptions do not carry a
 * route must still receive the TUI's active provider/model pair through the
 * agent/request waterfall. Complete child-specific routes remain untouched.
 *
 * Run with: node --import tsx/esm scripts/verify-subagent-model-route.tsx
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createChannel } from '../src/dsh-adapter/channel.js'
import TuiSceneRuntime from '../src/tui-runtime/scenes.js'
import { RemoteInteractionBroker } from '../src/dsh-adapter/channel-provider.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const root = new Context()
await root.plugin(CommandRuntime)
await root.plugin(TuiSceneRuntime)
root.tuiScenes.register({ id: 'verify-scene', component: () => null })
const sceneProbe = root.tuiScenes.createSelection()
root.tuiScenes.runWith(sceneProbe, () => root.tuiScenes.open('verify-scene'))
check('Scene runtime routes open through an isolated selection', sceneProbe.active?.id === 'verify-scene')
sceneProbe.dispose()
root.commands.register({
  name: 'open-verify-scene', description: 'Open the verification scene',
  handler: () => {
    root.tuiScenes.open('verify-scene')
    return { kind: 'success' }
  },
})
const verificationSkill = {
  name: 'verify-skill', description: 'Scoped verification skill',
  invocation: { modelInvocable: true, userInvocable: true },
  source: { kind: 'verification' }, provider: 'verification',
}
root.provide('skills' as never, {
  list: async () => [verificationSkill],
  snapshot: async () => ({ skills: [verificationSkill], complete: true }),
  get: async () => undefined,
} as never)
let parentScope: ReturnType<typeof createScope>
const parent = {
  id: 'parent-agent',
  status: 'idle',
  options: {},
  get ctx() { return parentScope.ctx },
  session: {
    id: 'parent-session', seq: 0, events: [], header: {},
    append(type: string, data: unknown) { return { seq: ++this.seq, type, data } },
  },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never
await root.plugin(Object.assign((inner: Context) => { parentScope = createScope(inner, parent) }, { inject: ['commands'] }))

const parentChannel = createChannel(root as never, parent, {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd: '/tmp',
  activity: false,
  isolatedScenes: true,
})

// A real sibling Agent scope stands in for the child. Scoped dispatch excludes
// the parent's installModelSelection listener while retaining unscoped root
// listeners, matching the spawn/fork routing boundary.
let childScope: ReturnType<typeof createScope>
const child = {
  id: 'child-agent',
  status: 'idle',
  options: {},
  get ctx() { return childScope.ctx },
  session: { id: 'child-session', seq: 0, events: [], header: { parentSession: 'parent-session' } },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never
childScope = createScope(root, child)
const childEvents = agentEvents(root, child)
const payload = { turn: 1, step: 1, signal: new AbortController().signal }
const inherited = (await childEvents.waterfall(
  'agent/request',
  payload,
  () => Promise.resolve({ maxTokens: 1024 }),
)) as { provider?: string; model?: string; maxTokens?: number }

check(
  'route-less child inherits the active TUI route (issue #191)',
  inherited.provider === 'deepseek-official' && inherited.model === 'deepseek-v4-flash',
  `provider=${String(inherited.provider)}, model=${String(inherited.model)}`,
)
check('unrelated request options survive fallback routing', inherited.maxTokens === 1024)

const explicit = (await childEvents.waterfall(
  'agent/request',
  payload,
  () => Promise.resolve({ provider: 'custom-provider', model: 'custom-model' }),
)) as { provider?: string; model?: string }

check(
  'complete child-specific routes are not overwritten',
  explicit.provider === 'custom-provider' && explicit.model === 'custom-model',
  `provider=${String(explicit.provider)}, model=${String(explicit.model)}`,
)

const partial = (await childEvents.waterfall(
  'agent/request',
  payload,
  () => Promise.resolve({ provider: 'orphaned-provider' }),
)) as { provider?: string; model?: string }

check(
  'partial routes are replaced atomically',
  partial.provider === 'deepseek-official' && partial.model === 'deepseek-v4-flash',
  `provider=${String(partial.provider)}, model=${String(partial.model)}`,
)

// Two server-side Channels share the daemon Context. Their root waterfalls
// must route only their own session lineage.
let otherScope: ReturnType<typeof createScope>
const other = {
  id: 'other-parent-agent',
  status: 'idle',
  options: {},
  get ctx() { return otherScope.ctx },
  session: {
    id: 'other-parent-session', seq: 0, events: [], header: {},
    append(type: string, data: unknown) { return { seq: ++this.seq, type, data } },
  },
  followup() {}, steer() {}, inbox: { remove() {} },
} as never
await root.plugin(Object.assign((inner: Context) => { otherScope = createScope(inner, other) }, { inject: ['commands'] }))
const otherChannel = createChannel(root as never, other, {
  provider: 'other-provider', model: 'other-model', cwd: '/tmp', activity: false, isolatedScenes: true,
})
let otherChildScope: ReturnType<typeof createScope>
const otherChild = {
  ...other,
  id: 'other-child-agent',
  get ctx() { return otherChildScope.ctx },
  session: { id: 'other-child-session', seq: 0, events: [], header: { parentSession: 'other-parent-session' } },
} as never
otherChildScope = createScope(root, otherChild)
const otherInherited = (await agentEvents(root, otherChild).waterfall(
  'agent/request', payload, () => Promise.resolve({}),
)) as { provider?: string; model?: string }
check(
  'concurrent Channels route only their own subagent lineage',
  otherInherited.provider === 'other-provider' && otherInherited.model === 'other-model',
  `provider=${String(otherInherited.provider)}, model=${String(otherInherited.model)}`,
)
await eventually(
  () => root.commands.find(parent, 'verify-skill') !== undefined
    && root.commands.find(other, 'verify-skill') !== undefined,
  () => `parent=[${root.commands.list(parent).map(command => command.name).join(',')}], `
    + `other=[${root.commands.list(other).map(command => command.name).join(',')}]`,
)
check(
  'concurrent Channels own distinct agent-scoped skill commands',
  root.commands.find(parent, 'verify-skill')?.handler !== root.commands.find(other, 'verify-skill')?.handler,
)
const parentSceneResult = await parentChannel.runExternalCommand('open-verify-scene', '')
check('a command opens its Scene only in the invoking Channel',
  parentChannel.pluginScene?.id === 'verify-scene' && otherChannel.pluginScene === undefined,
  `result=${String(parentSceneResult)}, parent=${String(parentChannel.pluginScene?.id)}, other=${String(otherChannel.pluginScene?.id)}`)
const otherSceneResult = await otherChannel.runExternalCommand('open-verify-scene', '')
parentChannel.closePluginScene()
check('concurrent Channels retain independent Scene selections',
  parentChannel.pluginScene === undefined && otherChannel.pluginScene?.id === 'verify-scene',
  `result=${String(otherSceneResult)}, parent=${String(parentChannel.pluginScene?.id)}, other=${String(otherChannel.pluginScene?.id)}`)

const interactionContext = new Context()
const grandchild = {
  ...other,
  id: 'grandchild-agent',
  session: { id: 'grandchild-session', header: { parentSession: 'child-session' } },
} as never
const liveAgents = new Map([
  ['parent-session', parent], ['child-session', child], ['grandchild-session', grandchild],
  ['other-parent-session', other], ['other-child-session', otherChild],
])
interactionContext.provide('agents' as never, { get: (id: unknown) => liveAgents.get(String(id)) } as never)
const parentCalls: string[] = []
const otherCalls: string[] = []
const routes = [
  {
    async ask() { parentCalls.push('ask'); return { status: 'submitted', value: { answers: [] } } as const },
    async approve() { parentCalls.push('approve'); return { status: 'submitted', value: 'allowed-once' } as const },
  },
  {
    async ask() { otherCalls.push('ask'); return { status: 'submitted', value: { answers: [] } } as const },
    async approve() { otherCalls.push('approve'); return { status: 'submitted', value: 'allowed-once' } as const },
  },
]
const interactions = new RemoteInteractionBroker(interactionContext, {
  captureAgentPresentation: () => routes.shift(),
} as never)
interactions.attach(parent)
interactions.attach(other)
await interactions.ask({ agent: grandchild, questions: [], signal: new AbortController().signal } as never)
check('nested subagent question routes to its root Channel',
  parentCalls.join(',') === 'ask' && otherCalls.length === 0)
let approvalFallbacks = 0
const approval = interactions.approve({
  agent: otherChild, toolName: 'bash', signal: new AbortController().signal, events: [],
} as never, async () => { approvalFallbacks += 1; return 'unavailable' })
const approvalResult = await approval
check('subagent approval stays inside its own root Channel',
  parentCalls.join(',') === 'ask' && otherCalls.join(',') === 'approve')
check('remote subagent approval result returns without host fallback',
  approvalResult === 'allowed-once' && approvalFallbacks === 0)
interactions.dispose()
await interactionContext.fiber.dispose()

parentChannel.releaseContributions()
check('released Channel removes only its scoped skill command',
  root.commands.find(parent, 'verify-skill') === undefined
  && root.commands.find(other, 'verify-skill') !== undefined)
let detachedChildScope: ReturnType<typeof createScope>
const detachedChild = {
  ...other,
  id: 'detached-child-agent',
  get ctx() { return detachedChildScope.ctx },
  session: { id: 'detached-child-session', seq: 0, events: [], header: { parentSession: 'parent-session' } },
} as never
detachedChildScope = createScope(root, detachedChild)
const detached = (await agentEvents(root, detachedChild).waterfall(
  'agent/request', payload, () => Promise.resolve({}),
)) as { provider?: string; model?: string }
check(
  'released Channel no longer participates in request routing',
  detached.provider === undefined && detached.model === undefined,
  `provider=${String(detached.provider)}, model=${String(detached.model)}`,
)
otherChannel.releaseContributions()
await root.fiber.dispose()

process.exit(failed === 0 ? 0 : 1)

async function eventually(
  predicate: () => boolean,
  describe: () => string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition did not become true: ${describe()}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
