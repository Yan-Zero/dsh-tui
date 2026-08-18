import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { TuiExternalRedirectReceiver } from '../src/std-adapter/external-redirect.js'

const receiver = new TuiExternalRedirectReceiver()

try {
  let announceDefault!: (value: { readonly redirectUri: string }) => void
  const defaultReady = new Promise<{ readonly redirectUri: string }>(resolve => { announceDefault = resolve })
  const defaultResult = receiver.receive({
    requestId: 'generated-redirect',
    invocationId: 'verify-external-redirect',
    origin: 'verify',
    mode: 'http-get',
  }, {
    signal: new AbortController().signal,
    progress: announceDefault,
  } as never)
  const generatedUri = (await defaultReady).redirectUri
  assert.match(generatedUri, /^http:\/\/127\.0\.0\.1:\d+\/dsh\/callback\/[A-Za-z0-9_-]+$/u)
  assert.equal((await fetch(`${generatedUri}?code=generated`)).status, 200)
  assert.deepEqual(await defaultResult, {
    status: 'submitted',
    value: { query: { code: ['generated'] } },
  })

  const port = await unusedPort()
  const exactRedirectUri = `http://127.0.0.1:${String(port)}/vendor/oauth/callback`
  let announce!: (value: { readonly redirectUri: string }) => void
  const ready = new Promise<{ readonly redirectUri: string }>(resolve => { announce = resolve })
  const result = receiver.receive({
    requestId: 'exact-redirect',
    invocationId: 'verify-external-redirect',
    origin: 'verify',
    mode: 'http-get',
    exactRedirectUri,
  } as never, {
    signal: new AbortController().signal,
    progress: announce,
  } as never)

  assert.equal((await ready).redirectUri, exactRedirectUri)
  const response = await fetch(`${exactRedirectUri}?code=accepted&scope=one&scope=two`)
  assert.equal(response.status, 200)
  assert.deepEqual(await result, {
    status: 'submitted',
    value: { query: { code: ['accepted'], scope: ['one', 'two'] } },
  })

  const blocker = createServer()
  await listen(blocker, 0)
  try {
    const occupiedPort = portOf(blocker)
    let announced = false
    const occupied = await receiver.receive({
      requestId: 'occupied-redirect',
      invocationId: 'verify-external-redirect',
      origin: 'verify',
      mode: 'http-get',
      exactRedirectUri: `http://127.0.0.1:${String(occupiedPort)}/vendor/oauth/callback`,
    } as never, {
      signal: new AbortController().signal,
      progress: () => { announced = true },
    } as never)
    assert.deepEqual(occupied, { status: 'unavailable', reason: 'redirect-address-in-use' })
    assert.equal(announced, false)
  } finally {
    await close(blocker)
  }
} finally {
  await receiver.dispose()
}

console.log('external redirect verification passed')

async function unusedPort(): Promise<number> {
  const server = createServer()
  await listen(server, 0)
  const port = portOf(server)
  await close(server)
  return port
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}
