/** Minimal Node HTTP/WebSocket carrier for the dsh-TUI standard endpoint. */

import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { sameProtocol, type ApiReference, type ProtocolCatalog } from '@dsh-std/core'
import {
  ConnectionInvocationError,
  resolveConnection,
  validateEndpointOffer,
  type CapabilityBinding,
  type CapabilityCall,
  type CapabilityClient,
  type ConnectionEndpoint,
  type ConnectionPlan,
  type EndpointOffer,
  type StandardConnection,
} from '@dsh-std/connection'
import {
  TUI_CHANNEL_HTTP_DESCRIPTOR_PATH,
  TUI_CHANNEL_HTTP_HEALTH_PATH,
  TUI_CHANNEL_HTTP_WEBSOCKET_PATH,
  createTuiChannelEndpointDescriptor,
  validateTuiChannelEndpointDescriptor,
} from 'dsh-ecosystem-spec/tui-channel-http'

export interface TuiChannelHttpServerOptions {
  readonly host?: string
  readonly port?: number
  readonly onConnection?: (connection: StandardConnection) => void | (() => void)
}

export interface TuiChannelHttpServer {
  readonly origin: string
  close(): Promise<void>
}

export interface StandardWireError {
  readonly code: 'connection-closed' | 'capability-unbound' | 'handler-missing' | 'cancelled' | 'handler-failed'
  readonly message: string
}

export type StandardConnectionFrame =
  | { readonly type: 'connection/open'; readonly offer: EndpointOffer }
  | { readonly type: 'connection/opened'; readonly offer: EndpointOffer; readonly plan: ConnectionPlan }
  | { readonly type: 'connection/offer'; readonly offer: EndpointOffer }
  | { readonly type: 'connection/plan'; readonly offer: EndpointOffer; readonly plan: ConnectionPlan }
  | { readonly type: 'capability/invoke'; readonly invocationId: string; readonly planRevision: number; readonly bindingId: string; readonly operation: string; readonly input: unknown }
  | { readonly type: 'capability/progress'; readonly invocationId: string; readonly value: unknown }
  | { readonly type: 'capability/result'; readonly invocationId: string; readonly ok: true; readonly value: unknown }
  | { readonly type: 'capability/result'; readonly invocationId: string; readonly ok: false; readonly error: StandardWireError }
  | { readonly type: 'capability/cancel'; readonly invocationId: string; readonly reason?: string }
  | { readonly type: 'connection/close'; readonly reason?: string }

/** Start the standalone endpoint used by `dsh --profile tui --server`. */
export async function listenTuiChannelHttp(
  endpoint: ConnectionEndpoint,
  protocols: ProtocolCatalog,
  options: TuiChannelHttpServerOptions = {},
): Promise<TuiChannelHttpServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 10721
  const sockets = new Set<WebSocket>()
  const connections = new Set<WireStandardConnection>()
  const connectionDisposers = new Map<WireStandardConnection, () => void>()
  let origin = ''
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'method-not-allowed' }))
      return
    }
    const path = request.url === undefined ? '' : new URL(request.url, origin || `http://${host}:${String(port)}`).pathname
    if (path === TUI_CHANNEL_HTTP_HEALTH_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (path === TUI_CHANNEL_HTTP_DESCRIPTOR_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(createTuiChannelEndpointDescriptor(origin)))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not-found' }))
  })
  const websocket = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const path = request.url === undefined ? '' : new URL(request.url, origin || `http://${host}:${String(port)}`).pathname
    if (path !== TUI_CHANNEL_HTTP_WEBSOCKET_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    websocket.handleUpgrade(request, socket, head, accepted => websocket.emit('connection', accepted, request))
  })
  websocket.on('connection', socket => {
    sockets.add(socket)
    const connection = new WireStandardConnection('server', endpoint, protocols, frame => send(socket, frame), randomUUID())
    connections.add(connection)
    const disposeConnection = options.onConnection?.(connection)
    if (disposeConnection !== undefined) connectionDisposers.set(connection, disposeConnection)
    bindSocket(socket, frame => connection.accept(frame), reason => {
      sockets.delete(socket)
      connections.delete(connection)
      connectionDisposers.get(connection)?.()
      connectionDisposers.delete(connection)
      connection.transportClosed(reason)
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
    const ready = (): void => { server.off('error', failed); resolveListen() }
    server.once('error', failed)
    server.once('listening', ready)
    server.listen(port, host)
  })
  const address = server.address() as AddressInfo
  origin = `http://${formatHost(address.address)}:${String(address.port)}`
  return Object.freeze({
    origin,
    close: async () => {
      for (const dispose of connectionDisposers.values()) dispose()
      connectionDisposers.clear()
      for (const connection of connections) connection.close('TUI Channel HTTP server stopped')
      for (const socket of sockets) socket.close()
      websocket.close()
      await closeHttp(server)
    },
  })
}

/** Discover and connect to a standalone dsh-TUI endpoint. */
export async function connectTuiChannelHttp(
  address: string,
  endpoint: ConnectionEndpoint,
  protocols: ProtocolCatalog,
  signal?: AbortSignal,
): Promise<StandardConnection> {
  signal?.throwIfAborted()
  const origin = normalizeOrigin(address)
  const descriptorResponse = await fetch(new URL(TUI_CHANNEL_HTTP_DESCRIPTOR_PATH, origin), { signal })
  if (!descriptorResponse.ok) throw new Error(`dsh-tui endpoint discovery failed with HTTP ${String(descriptorResponse.status)}`)
  const descriptor = validateTuiChannelEndpointDescriptor(await descriptorResponse.json())
  const socketUrl = new URL(descriptor.connection, descriptor.origin)
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(socketUrl)
  await waitForSocket(socket, signal)
  const connection = new WireStandardConnection('client', endpoint, protocols, frame => send(socket, frame), randomUUID(), () => socket.close())
  bindSocket(socket, frame => connection.accept(frame), reason => connection.transportClosed(reason))
  await connection.open(signal)
  return connection
}

interface PendingOutbound {
  readonly progress: AsyncQueue<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

class WireStandardConnection implements StandardConnection {
  private remoteOffer: EndpointOffer | undefined
  private currentPlan: ConnectionPlan | undefined
  private planRevision = 0
  private invocationSequence = 0
  private closed = false
  private readonly planListeners = new Set<(plan: ConnectionPlan) => void>()
  private readonly outbound = new Map<string, PendingOutbound>()
  private readonly inbound = new Map<string, AbortController>()
  private readonly releaseOfferListener: () => void
  private openedResolve: (() => void) | undefined
  private openedReject: ((reason: unknown) => void) | undefined

  constructor(
    private readonly role: 'client' | 'server',
    private readonly endpoint: ConnectionEndpoint,
    private readonly protocols: ProtocolCatalog,
    private readonly sendFrame: (frame: StandardConnectionFrame) => void,
    readonly id: string,
    private readonly closeTransport?: () => void,
  ) {
    this.releaseOfferListener = endpoint.onOfferChange(offer => {
      if (this.closed || this.remoteOffer === undefined) return
      if (this.role === 'client') this.sendFrame({ type: 'connection/offer', offer })
      else this.renegotiate(true)
    })
  }

  get local() { return this.endpoint.offer.endpoint }
  get remote() {
    if (this.remoteOffer === undefined) throw new ConnectionInvocationError('connection-closed', 'connection handshake is incomplete')
    return this.remoteOffer.endpoint
  }
  get plan(): ConnectionPlan {
    if (this.currentPlan === undefined) throw new ConnectionInvocationError('connection-closed', 'connection handshake is incomplete')
    return this.currentPlan
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.role !== 'client') throw new Error('only the connecting endpoint opens a standard connection')
    if (this.closed) throw new ConnectionInvocationError('connection-closed', 'connection is closed')
    const opened = new Promise<void>((resolve, reject) => { this.openedResolve = resolve; this.openedReject = reject })
    const abort = (): void => this.close(abortMessage(signal as AbortSignal))
    signal?.addEventListener('abort', abort, { once: true })
    this.sendFrame({ type: 'connection/open', offer: this.endpoint.offer })
    try { await opened } finally { signal?.removeEventListener('abort', abort) }
  }

  accept(frame: StandardConnectionFrame): void {
    if (this.closed) return
    try {
      switch (frame.type) {
        case 'connection/open':
          if (this.role !== 'server' || this.remoteOffer !== undefined) throw new Error('connection/open is invalid in the current role or state')
          validateEndpointOffer(frame.offer)
          this.remoteOffer = frame.offer
          this.renegotiate(false)
          this.sendFrame({ type: 'connection/opened', offer: this.endpoint.offer, plan: this.plan })
          return
        case 'connection/opened':
          if (this.role !== 'client' || this.remoteOffer !== undefined) throw new Error('connection/opened is invalid in the current role or state')
          this.acceptRemotePlan(frame.offer, frame.plan, false)
          this.openedResolve?.()
          this.openedResolve = undefined
          this.openedReject = undefined
          return
        case 'connection/offer':
          if (this.role !== 'server') throw new Error('connection/offer is server-owned input')
          this.acceptRemoteOffer(frame.offer)
          return
        case 'connection/plan':
          if (this.role !== 'client') throw new Error('connection/plan is client-owned input')
          this.acceptRemotePlan(frame.offer, frame.plan, true)
          return
        case 'capability/invoke': this.acceptInvocation(frame); return
        case 'capability/progress': this.outbound.get(frame.invocationId)?.progress.push(frame.value); return
        case 'capability/result': this.acceptResult(frame); return
        case 'capability/cancel':
          this.inbound.get(frame.invocationId)?.abort(new ConnectionInvocationError('cancelled', frame.reason ?? 'peer cancelled capability invocation'))
          return
        case 'connection/close': this.finishClose(frame.reason ?? 'peer closed the connection'); return
      }
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error))
    }
  }

  client(participantId: string): CapabilityClient {
    nonEmpty(participantId, 'participantId')
    return Object.freeze({
      participantId,
      binding: (reference: ApiReference) => this.binding(participantId, reference),
      invoke: <TInput = unknown, TOutput = unknown, TProgress = unknown>(reference: ApiReference, operation: string, input: TInput, options?: { readonly signal?: AbortSignal }): CapabilityCall<TOutput, TProgress> =>
        this.invoke(participantId, reference, operation, input, options?.signal),
    })
  }

  onPlanChange(listener: (plan: ConnectionPlan) => void): () => void {
    this.planListeners.add(listener)
    return () => { this.planListeners.delete(listener) }
  }

  close(reason = 'connection closed'): void {
    if (this.closed) return
    try { this.sendFrame({ type: 'connection/close', reason }) } catch {}
    this.finishClose(reason)
    this.closeTransport?.()
  }

  transportClosed(reason: string): void { this.finishClose(reason) }

  private acceptRemoteOffer(offer: EndpointOffer): void {
    validateEndpointOffer(offer)
    if (this.remoteOffer === undefined || offer.endpoint.instanceId !== this.remoteOffer.endpoint.instanceId || offer.revision <= this.remoteOffer.revision) {
      throw new Error('peer offer identity or revision is invalid')
    }
    this.remoteOffer = offer
    this.renegotiate(true)
  }

  private acceptRemotePlan(offer: EndpointOffer, plan: ConnectionPlan, update: boolean): void {
    validateEndpointOffer(offer)
    if (update) {
      if (this.remoteOffer === undefined || offer.endpoint.instanceId !== this.remoteOffer.endpoint.instanceId || offer.revision < this.remoteOffer.revision) {
        throw new Error('peer offer identity or revision regressed')
      }
      if (plan.revision <= (this.currentPlan?.revision ?? 0)) throw new Error('connection plan revision did not increase')
    }
    // The accepting endpoint is the plan author and places its offer first.
    // Preserve that order when recomputing the digest on the connector.
    const expected = resolveConnection(offer, this.endpoint.offer, {
      connectionId: plan.connectionId,
      revision: plan.revision,
      protocols: this.protocols,
    })
    if (expected.digest !== plan.digest) throw new Error('peer connection plan does not match the endpoint offers')
    this.remoteOffer = offer
    this.currentPlan = plan
    for (const listener of this.planListeners) listener(plan)
  }

  private renegotiate(notify: boolean): void {
    if (this.remoteOffer === undefined) return
    this.currentPlan = resolveConnection(this.endpoint.offer, this.remoteOffer, {
      connectionId: this.id,
      revision: ++this.planRevision,
      protocols: this.protocols,
    })
    for (const listener of this.planListeners) listener(this.currentPlan)
    if (notify) this.sendFrame({ type: 'connection/plan', offer: this.endpoint.offer, plan: this.currentPlan })
  }

  private binding(participantId: string, reference: ApiReference): CapabilityBinding | undefined {
    return this.currentPlan?.bindings.find(binding =>
      binding.consumer.endpoint.instanceId === this.endpoint.offer.endpoint.instanceId
      && binding.consumer.participantId === participantId
      && sameProtocol(binding.requirement, reference))
  }

  private invoke<TInput, TOutput, TProgress>(participantId: string, reference: ApiReference, operation: string, input: TInput, signal?: AbortSignal): CapabilityCall<TOutput, TProgress> {
    if (this.closed) throw new ConnectionInvocationError('connection-closed', 'connection is closed')
    signal?.throwIfAborted()
    const binding = this.binding(participantId, reference)
    if (binding === undefined || binding.provider.endpoint.instanceId !== this.remoteOffer?.endpoint.instanceId) {
      throw new ConnectionInvocationError('capability-unbound', `participant ${JSON.stringify(participantId)} has no remote binding for ${reference.apiVersion} ${reference.kind}`)
    }
    nonEmpty(operation, 'operation')
    const invocationId = `${this.endpoint.offer.endpoint.instanceId}:${String(++this.invocationSequence)}`
    const progress = new AsyncQueue<unknown>()
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const result = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail })
    this.outbound.set(invocationId, { progress, resolve, reject })
    const cancel = (reason = 'capability invocation cancelled'): void => {
      const pending = this.outbound.get(invocationId)
      if (pending === undefined) return
      this.outbound.delete(invocationId)
      pending.progress.close()
      pending.reject(new ConnectionInvocationError('cancelled', reason))
      this.sendFrame({ type: 'capability/cancel', invocationId, reason })
    }
    signal?.addEventListener('abort', () => cancel(abortMessage(signal)), { once: true })
    this.sendFrame({ type: 'capability/invoke', invocationId, planRevision: binding.planRevision, bindingId: binding.bindingId, operation, input })
    return Object.freeze({ invocationId, result: result as Promise<TOutput>, progress: progress as AsyncIterable<TProgress>, cancel })
  }

  private acceptInvocation(frame: Extract<StandardConnectionFrame, { type: 'capability/invoke' }>): void {
    const binding = this.currentPlan?.bindings.find(candidate =>
      candidate.bindingId === frame.bindingId && candidate.planRevision === frame.planRevision
      && candidate.provider.endpoint.instanceId === this.endpoint.offer.endpoint.instanceId
      && candidate.consumer.endpoint.instanceId === this.remoteOffer?.endpoint.instanceId)
    if (binding === undefined || this.inbound.has(frame.invocationId) || this.outbound.has(frame.invocationId)) {
      this.sendFrame({ type: 'capability/result', invocationId: frame.invocationId, ok: false, error: { code: 'capability-unbound', message: 'invocation does not match an active binding' } })
      return
    }
    const controller = new AbortController()
    this.inbound.set(frame.invocationId, controller)
    void this.endpoint.dispatch({
      connectionId: this.id, planRevision: frame.planRevision, invocationId: frame.invocationId,
      binding, operation: frame.operation, input: frame.input, signal: controller.signal,
      progress: value => this.sendFrame({ type: 'capability/progress', invocationId: frame.invocationId, value }),
    }).then(value => {
      if (this.inbound.delete(frame.invocationId)) this.sendFrame({ type: 'capability/result', invocationId: frame.invocationId, ok: true, value })
    }, error => {
      if (this.inbound.delete(frame.invocationId)) this.sendFrame({ type: 'capability/result', invocationId: frame.invocationId, ok: false, error: wireError(error) })
    })
  }

  private acceptResult(frame: Extract<StandardConnectionFrame, { type: 'capability/result' }>): void {
    const pending = this.outbound.get(frame.invocationId)
    if (pending === undefined) return
    this.outbound.delete(frame.invocationId)
    pending.progress.close()
    if (frame.ok) pending.resolve(frame.value)
    else pending.reject(new ConnectionInvocationError(frame.error.code, frame.error.message))
  }

  private finishClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.releaseOfferListener()
    this.openedReject?.(new ConnectionInvocationError('connection-closed', reason))
    this.openedResolve = undefined
    this.openedReject = undefined
    for (const pending of this.outbound.values()) {
      pending.progress.close()
      pending.reject(new ConnectionInvocationError('connection-closed', reason))
    }
    this.outbound.clear()
    for (const controller of this.inbound.values()) controller.abort(new ConnectionInvocationError('connection-closed', reason))
    this.inbound.clear()
    this.planListeners.clear()
  }
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private done = false
  push(value: T): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter({ done: false, value })
  }
  close(): void {
    if (this.done) return
    this.done = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift() as T })
    if (this.done) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => this.waiters.push(resolve))
  }
  return(): Promise<IteratorResult<T>> { this.close(); return Promise.resolve({ done: true, value: undefined }) }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this }
}

function bindSocket(socket: WebSocket, accept: (frame: StandardConnectionFrame) => void, closed: (reason: string) => void): void {
  socket.on('message', (data: RawData, binary: boolean) => {
    if (binary) { socket.close(1003, 'text frames required'); return }
    try { accept(JSON.parse(rawText(data)) as StandardConnectionFrame) } catch (error) {
      socket.close(1002, error instanceof Error ? error.message.slice(0, 120) : 'invalid frame')
    }
  })
  socket.once('close', (_code, reason) => closed(reason.toString() || 'WebSocket closed'))
  socket.once('error', error => closed(error.message))
}

function send(socket: WebSocket, frame: StandardConnectionFrame): void {
  if (socket.readyState !== WebSocket.OPEN) throw new ConnectionInvocationError('connection-closed', 'WebSocket is not open')
  socket.send(JSON.stringify(frame))
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data as ArrayBuffer).toString('utf8')
}

function waitForSocket(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('open', opened); socket.off('error', failed); signal?.removeEventListener('abort', aborted)
    }
    const opened = (): void => { cleanup(); resolve() }
    const failed = (error: Error): void => { cleanup(); reject(error) }
    const aborted = (): void => { cleanup(); socket.close(); reject(signal?.reason ?? new Error('connection cancelled')) }
    socket.once('open', opened)
    socket.once('error', failed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted === true) aborted()
  })
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
}

function normalizeOrigin(address: string): URL {
  const trimmed = address.trim()
  if (trimmed === '') throw new TypeError('/connect requires an address')
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('/connect address must use http or https')
  if (url.port === '') url.port = '10721'
  url.pathname = '/'; url.search = ''; url.hash = ''
  return url
}

function formatHost(host: string): string {
  if (host === '::' || host === '0.0.0.0') return host
  return host.includes(':') ? `[${host}]` : host
}

function wireError(error: unknown): StandardWireError {
  return error instanceof ConnectionInvocationError
    ? { code: error.code, message: error.message }
    : { code: 'handler-failed', message: error instanceof Error ? error.message : String(error) }
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : typeof signal.reason === 'string' ? signal.reason : 'connection cancelled'
}

function nonEmpty(value: string, label: string): void {
  if (value.trim() === '') throw new TypeError(`${label} must be non-empty`)
}
