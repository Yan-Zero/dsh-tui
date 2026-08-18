import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const harness = resolve(process.env.DSH_TUI_VERIFY_HARNESS ?? '../../deepseek-harness')
const profile = process.env.DSH_TUI_VERIFY_PROFILE ?? 'tui'
const port = Number(process.env.DSH_TUI_VERIFY_PORT ?? 10721)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DSH_TUI_VERIFY_PORT is invalid')
const endpoint = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', profile, '--server', '--port', String(port),
], {
  cwd: harness,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })

try {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited with ${String(child.exitCode)}\n${stdout}\n${stderr}`)
    try {
      const response = await fetch(`${endpoint}/dsh-tui/v1/health`)
      if (response.ok && (await response.json()).ok === true) break
    } catch {}
    if (Date.now() >= deadline) throw new Error(`server did not become ready\n${stdout}\n${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  if (!stdout.includes(`dsh-tui server: ${endpoint}`)) {
    throw new Error(`server did not report its endpoint\n${stdout}\n${stderr}`)
  }
  process.stdout.write(`dsh --profile ${profile} --server boot and health endpoint OK\n`)
} finally {
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}
