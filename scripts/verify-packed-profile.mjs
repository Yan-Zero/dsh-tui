import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const harness = resolve(process.env.DSH_TUI_VERIFY_HARNESS ?? '../../deepseek-harness')
const npmExecPath = process.env.npm_execpath
if (npmExecPath === undefined) {
  throw new Error('verify:packed-profile must be run through pnpm or npm')
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  return { child, output: () => ({ stdout, stderr }) }
}

async function run(command, args, options = {}) {
  const running = start(command, args, options)
  const code = await new Promise((resolveExit, reject) => {
    running.child.once('error', reject)
    running.child.once('exit', resolveExit)
  })
  const output = running.output()
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(code)}\n${output.stdout}\n${output.stderr}`)
  }
  return output
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-tui-packed-profile-'))
const dshHome = join(temporaryRoot, 'home')
let server

try {
  await run(process.execPath, [npmExecPath, 'pack', '--pack-destination', temporaryRoot], { cwd: root })
  const tarballs = (await readdir(temporaryRoot)).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`)
  const tarball = join(temporaryRoot, tarballs[0])

  const environment = { ...process.env, DSH_HOME: dshHome }
  await run(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'plugin', '--profile', 'packed', 'add', tarball,
  ], { cwd: harness, env: environment })

  const profileRoot = join(dshHome, 'profiles', 'packed')
  const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  const directDependencies = Object.keys(manifest.dependencies ?? {})
  if (directDependencies.length !== 1 || directDependencies[0] !== '@deepseek-harness-tui/dsh-tui') {
    throw new Error(`packed profile has unexpected direct dependencies: ${directDependencies.join(', ')}`)
  }
  await access(join(
    profileRoot, 'node_modules', '@deepseek-harness-tui', 'dsh-tui',
    'node_modules', '@dsh-std', 'adapter-dsh', 'lib', 'index.js',
  ))

  server = start(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'packed', '--server',
  ], { cwd: harness, env: environment })

  const deadline = Date.now() + 20_000
  for (;;) {
    if (server.child.exitCode !== null) {
      const output = server.output()
      throw new Error(`packed server exited with ${String(server.child.exitCode)}\n${output.stdout}\n${output.stderr}`)
    }
    try {
      const response = await fetch('http://127.0.0.1:10721/dsh-tui/v1/health')
      if (response.ok && (await response.json()).ok === true) break
    } catch {}
    if (Date.now() >= deadline) {
      const output = server.output()
      throw new Error(`packed server did not become ready\n${output.stdout}\n${output.stderr}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 250))
  if (server.child.exitCode !== null) {
    const output = server.output()
    throw new Error(`packed server exited after health check\n${output.stdout}\n${output.stderr}`)
  }

  console.log('packed profile installs only dsh-tui and boots its bundled dsh-std adapter')
} finally {
  if (server?.child.exitCode === null) {
    server.child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolveExit => server.child.once('exit', resolveExit)),
      new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000)),
    ])
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
}
