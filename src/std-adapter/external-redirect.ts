import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  ExternalRedirectHandler,
  ExternalRedirectReady,
  ExternalRedirectRequest,
  ExternalRedirectValue,
} from '@dsh-std/presentation/callback'
import type { PresentationResult } from '@dsh-std/presentation'
import type { CapabilityHandlerContext } from '@dsh-std/connection'

const DEFAULT_LIFETIME_MS = 5 * 60_000
const MAX_REQUEST_TARGET = 16 * 1024
const MAX_PARAMETERS = 64
const COMPLETION_PAGE = '<!doctype html><meta charset="utf-8"><title>DSH</title><p>You may close this window.</p>'

interface PendingRedirect {
  finish(result: PresentationResult<ExternalRedirectValue>): void
}

/** Receives one-shot loopback redirects, sharing a random listener unless an exact URI is required. */
export class TuiExternalRedirectReceiver implements ExternalRedirectHandler {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private readonly pending = new Map<string, PendingRedirect>()
  private readonly allPending = new Set<PendingRedirect>()
  private readonly exactServers = new Set<Server>()

  async receive(
    request: ExternalRedirectRequest,
    context: CapabilityHandlerContext<ExternalRedirectReady>,
  ): Promise<PresentationResult<ExternalRedirectValue>> {
    const expiresAtMs = Math.min(
      request.deadline === undefined ? Number.POSITIVE_INFINITY : Date.parse(request.deadline),
      Date.now() + DEFAULT_LIFETIME_MS,
    )
    if (expiresAtMs <= Date.now()) return { status: 'expired' }

    const exactRedirectUri = Reflect.get(request, 'exactRedirectUri') as unknown
    if (exactRedirectUri !== undefined && typeof exactRedirectUri !== 'string') {
      throw new TypeError('ExternalRedirect exactRedirectUri must be a string')
    }
    if (exactRedirectUri !== undefined) return await this.receiveExact(exactRedirectUri, expiresAtMs, context)

    const port = await this.listen()
    const path = `/dsh/callback/${randomBytes(24).toString('base64url')}`
    return await this.waitForRedirect(
      `http://127.0.0.1:${String(port)}${path}`,
      expiresAtMs,
      context,
      pending => this.pending.set(path, pending),
      () => this.pending.delete(path),
    )
  }

  async dispose(): Promise<void> {
    for (const redirect of [...this.allPending]) {
      redirect.finish({ status: 'unavailable', reason: 'presentation endpoint closed' })
    }
    this.pending.clear()
    const servers = [...this.exactServers]
    this.exactServers.clear()
    if (this.server !== undefined) servers.push(this.server)
    this.server = undefined
    this.starting = undefined
    await Promise.all(servers.map(closeServer))
  }

  private async receiveExact(
    redirectUri: string,
    expiresAtMs: number,
    context: CapabilityHandlerContext<ExternalRedirectReady>,
  ): Promise<PresentationResult<ExternalRedirectValue>> {
    const uri = new URL(redirectUri)
    const port = explicitPort(uri, redirectUri)
    const hostname = uri.hostname === '[::1]' ? '::1' : uri.hostname
    let pending: PendingRedirect | undefined
    const server = createServer((incoming, response) => {
      this.respond(incoming, response, path => path === uri.pathname ? pending : undefined)
    })
    try {
      await listen(server, port, hostname)
    } catch (error) {
      return unavailableForListenError(error)
    }
    this.exactServers.add(server)
    return await this.waitForRedirect(
      redirectUri,
      expiresAtMs,
      context,
      value => { pending = value },
      () => {
        pending = undefined
        this.exactServers.delete(server)
        void closeServer(server)
      },
    )
  }

  private async waitForRedirect(
    redirectUri: string,
    expiresAtMs: number,
    context: CapabilityHandlerContext<ExternalRedirectReady>,
    register: (pending: PendingRedirect) => void,
    unregister: () => void,
  ): Promise<PresentationResult<ExternalRedirectValue>> {
    return await new Promise<PresentationResult<ExternalRedirectValue>>(resolve => {
      let settled = false
      const finish = (result: PresentationResult<ExternalRedirectValue>): void => {
        if (settled) return
        settled = true
        unregister()
        this.allPending.delete(pending)
        clearTimeout(timer)
        context.signal.removeEventListener('abort', abort)
        resolve(result)
      }
      const pending: PendingRedirect = { finish }
      const abort = (): void => finish({ status: 'cancelled' })
      const timer = setTimeout(() => finish({ status: 'expired' }), expiresAtMs - Date.now())
      timer.unref()
      this.allPending.add(pending)
      register(pending)
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) abort()
      if (settled) return
      context.progress(Object.freeze({
        type: 'ready',
        redirectUri,
        expiresAt: new Date(expiresAtMs).toISOString(),
      }))
    })
  }

  private listen(): Promise<number> {
    if (this.server?.listening === true) return Promise.resolve(portOf(this.server))
    if (this.starting !== undefined) return this.starting
    const server = createServer((incoming, response) => {
      this.respond(incoming, response, path => this.pending.get(path))
    })
    this.server = server
    this.starting = listen(server, 0, '127.0.0.1').then(() => portOf(server), error => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private respond(
    incoming: IncomingMessage,
    response: ServerResponse,
    lookup: (path: string) => PendingRedirect | undefined,
  ): void {
    const target = incoming.url ?? ''
    if (incoming.method !== 'GET' || target.length > MAX_REQUEST_TARGET) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Invalid callback request.')
      return
    }
    const url = new URL(target, 'http://127.0.0.1')
    const pending = lookup(url.pathname)
    if (pending === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Callback is unavailable.')
      return
    }
    const query: Record<string, string[]> = {}
    let count = 0
    for (const [name, value] of url.searchParams) {
      count += 1
      if (count > MAX_PARAMETERS) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Too many callback parameters.')
        pending.finish({ status: 'unavailable', reason: 'callback contains too many parameters' })
        return
      }
      ;(query[name] ??= []).push(value)
    }
    pending.finish({ status: 'submitted', value: { query } })
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'none'; script-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }).end(COMPLETION_PAGE)
  }
}

function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      server.removeListener('listening', ready)
      reject(error)
    }
    const ready = (): void => {
      server.removeListener('error', fail)
      resolve()
    }
    server.once('error', fail)
    server.once('listening', ready)
    server.listen({ port, host: hostname, exclusive: true })
  })
}

function unavailableForListenError(error: unknown): PresentationResult<ExternalRedirectValue> {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined
  if (code === 'EADDRINUSE') return { status: 'unavailable', reason: 'redirect-address-in-use' }
  if (code === 'EACCES') return { status: 'unavailable', reason: 'redirect-uri-rejected' }
  return { status: 'unavailable', reason: 'redirect-uri-unavailable' }
}

function explicitPort(uri: URL, source: string): number {
  const authority = source.slice(source.indexOf('//') + 2).split(/[/?#]/u, 1)[0]!
  const match = /^(?:127\.0\.0\.1|localhost):(\d+)$|^\[::1\]:(\d+)$/iu.exec(authority)
  const port = Number(match?.[1] ?? match?.[2])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError('ExternalRedirect exactRedirectUri must contain an explicit TCP port')
  if (uri.hostname !== '127.0.0.1' && uri.hostname !== 'localhost' && uri.hostname !== '[::1]') {
    throw new TypeError('ExternalRedirect exactRedirectUri must target a loopback host')
  }
  return port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('ExternalRedirect listener has no TCP port')
  return address.port
}
