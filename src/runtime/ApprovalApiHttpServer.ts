import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import type { ApprovalApiService } from '../contracts/approvalApi.js'
import type { SubmitApprovalDecisionRequest } from '../contracts/approvalApi.js'

type ApprovalTransportPermission = 'review' | 'decision'
type BearerCredential = {
  token: string
  permissions: ApprovalTransportPermission[]
  actorId?: string
  roleId?: string
}
type WebhookCredential = {
  keyId: string
  secret: string
  permissions: ApprovalTransportPermission[]
  actorId?: string
  roleId?: string
  maxSkewSeconds?: number
}

type ApprovalApiHttpServerDependencies = {
  service: ApprovalApiService
  bearerCredentials?: BearerCredential[]
  webhookCredentials?: WebhookCredential[]
  now?: () => string
}

type StartApprovalApiHttpServerInput = {
  port?: number
  host?: string
}

type JsonObject = Record<string, unknown>
type HttpDispatchInput = {
  method: string
  url: string
  body?: JsonObject
  rawBody?: string
  headers?: Record<string, string | undefined>
}
type HttpDispatchResult = {
  statusCode: number
  body: JsonObject
}

class HttpDispatchError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000)
}

function json(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: JsonObject,
) {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Uint8Array[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) {
    return {}
  }

  const parsed = JSON.parse(body) as unknown
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object body.')
  }

  return parsed as JsonObject
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function getSingleQueryValue(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)
  return value == null || value.length === 0 ? undefined : value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`)
  }

  return value
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`)
  }

  return value as Record<string, unknown>
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
  return `{${entries.join(',')}}`
}

function toHeaderMap(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value == null) {
      continue
    }
    normalized[key.toLowerCase()] = value
  }
  return normalized
}

function toEpochMillis(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

export class ApprovalApiHttpServer {
  private readonly service: ApprovalApiService
  private readonly bearerCredentials: BearerCredential[]
  private readonly webhookCredentials: WebhookCredential[]
  private readonly now: () => string
  private server?: Server

  constructor(dependencies: ApprovalApiHttpServerDependencies) {
    this.service = dependencies.service
    this.bearerCredentials = dependencies.bearerCredentials ?? []
    this.webhookCredentials = dependencies.webhookCredentials ?? []
    this.now = dependencies.now ?? (() => new Date().toISOString())
  }

  async start(
    input: StartApprovalApiHttpServerInput = {},
  ): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.server) {
      throw new Error('Approval API HTTP server is already running.')
    }

    const host = input.host ?? '127.0.0.1'
    const attempts = input.port != null && input.port !== 0 ? [input.port] : Array.from(
      { length: 10 },
      () => randomPort(),
    )

    for (const port of attempts) {
      const candidate = createServer((request, response) => {
        void this.handleRequest(request, response)
      })

      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject)
          candidate.listen(port, host, () => {
            candidate.off('error', reject)
            resolve()
          })
        })

        this.server = candidate
        const address = candidate.address()
        if (!address || typeof address === 'string') {
          throw new Error('Approval API HTTP server failed to bind an address.')
        }

        return {
          host,
          port: address.port,
          baseUrl: `http://${host}:${address.port}`,
        }
      } catch (error) {
        candidate.removeAllListeners()
        candidate.close()
        const code =
          error instanceof Error && 'code' in error
            ? String((error as Error & { code?: string }).code)
            : undefined
        if (code === 'EADDRINUSE') {
          continue
        }
        throw error
      }
    }

    throw new Error('Approval API HTTP server could not bind an available port.')
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    const server = this.server
    this.server = undefined

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  async dispatch(input: HttpDispatchInput): Promise<HttpDispatchResult> {
    try {
      const method = input.method
      const url = new URL(input.url, 'http://127.0.0.1')
      const path = url.pathname
      const headers = toHeaderMap(input.headers)

      if (method === 'GET' && path === '/health') {
        return {
          statusCode: 200,
          body: { ok: true },
        }
      }

      const pendingReviewsMatch = path.match(/^\/sessions\/([^/]+)\/approval-reviews$/)
      if (method === 'GET' && pendingReviewsMatch) {
        this.authenticateRequest({
          permission: 'review',
          method,
          url: url.pathname + url.search,
          headers,
          rawBody: input.rawBody,
          body: input.body,
        })
        const sessionId = decodeURIComponent(pendingReviewsMatch[1] ?? '')
        const limitValue = getSingleQueryValue(url.searchParams, 'limit')
        const limit = limitValue ? Number(limitValue) : undefined
        const result = await this.service.listPendingReviews({
          sessionId,
          limit: Number.isFinite(limit) ? limit : undefined,
        })
        return {
          statusCode: 200,
          body: result as JsonObject,
        }
      }

      const reviewMatch = path.match(/^\/runs\/([^/]+)\/approval-review$/)
      if (method === 'GET' && reviewMatch) {
        const runId = decodeURIComponent(reviewMatch[1] ?? '')
        const actorId = getSingleQueryValue(url.searchParams, 'viewerActorId')
        if (!actorId) {
          return {
            statusCode: 400,
            body: { error: 'viewerActorId is required.' },
          }
        }
        const auth = this.authenticateRequest({
          permission: 'review',
          method,
          url: url.pathname + url.search,
          headers,
          rawBody: input.rawBody,
          body: input.body,
        })
        this.assertActorBinding(
          auth,
          actorId,
          getSingleQueryValue(url.searchParams, 'viewerRole'),
          'review rendering',
        )

        const result = await this.service.getApprovalReview({
          runId,
          viewer: {
            actorType:
              (getSingleQueryValue(url.searchParams, 'viewerActorType') as
                | 'human'
                | 'agent'
                | 'system'
                | 'signer_backend'
                | undefined) ?? 'human',
            actorId,
            role: getSingleQueryValue(url.searchParams, 'viewerRole'),
          },
          surface:
            (getSingleQueryValue(url.searchParams, 'surface') as
              | 'external_api'
              | 'dashboard'
              | 'automation'
              | 'backoffice'
              | undefined) ?? 'external_api',
          requestedAt: getSingleQueryValue(url.searchParams, 'requestedAt'),
        })
        return {
          statusCode: 200,
          body: result as JsonObject,
        }
      }

      const decisionMatch = path.match(/^\/runs\/([^/]+)\/approval-decisions$/)
      if (method === 'POST' && decisionMatch) {
        const runId = decodeURIComponent(decisionMatch[1] ?? '')
        const body = input.body ?? {}
        const actor = requireObject(body['actor'], 'actor')
        const normalizedRequest: SubmitApprovalDecisionRequest = {
          runId,
          actor: {
            actorId: requireString(actor['actorId'], 'actor.actorId'),
            roleId: requireString(actor['roleId'], 'actor.roleId'),
          },
          decision: requireString(body['decision'], 'decision') as
            | 'approved'
            | 'rejected',
          approvalStateId:
            typeof body['approvalStateId'] === 'string'
              ? body['approvalStateId']
              : undefined,
          requirementId:
            typeof body['requirementId'] === 'string'
              ? body['requirementId']
              : undefined,
          comment: typeof body['comment'] === 'string' ? body['comment'] : undefined,
          viewedMaterialHash:
            typeof body['viewedMaterialHash'] === 'string'
              ? body['viewedMaterialHash']
              : undefined,
          viewedAt: typeof body['viewedAt'] === 'string' ? body['viewedAt'] : undefined,
          decidedAt:
            typeof body['decidedAt'] === 'string' ? body['decidedAt'] : undefined,
          breakGlassReason:
            typeof body['breakGlassReason'] === 'string'
              ? body['breakGlassReason']
              : undefined,
          externalEvidenceRef:
            typeof body['externalEvidenceRef'] === 'string'
              ? body['externalEvidenceRef']
              : undefined,
          surface:
            typeof body['surface'] === 'string'
              ? (body['surface'] as
                  | 'external_api'
                  | 'dashboard'
                  | 'automation'
                  | 'backoffice')
              : undefined,
          receivedAt:
            typeof body['receivedAt'] === 'string' ? body['receivedAt'] : undefined,
        }
        const auth = this.authenticateRequest({
          permission: 'decision',
          method,
          url: url.pathname + url.search,
          headers,
          rawBody: input.rawBody,
          body,
        })
        this.assertDecisionActorBinding(
          auth,
          normalizedRequest.actor.actorId,
          normalizedRequest.actor.roleId,
        )
        const result = await this.service.submitApprovalDecision(normalizedRequest)
        return {
          statusCode: result.outcome === 'accepted' ? 200 : 409,
          body: result as JsonObject,
        }
      }

      return {
        statusCode: 404,
        body: { error: 'Not found.' },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        statusCode:
          error instanceof HttpDispatchError ? error.statusCode : 400,
        body: { error: message },
      }
    }
  }

  private authenticateRequest(input: {
    permission: ApprovalTransportPermission
    method: string
    url: string
    headers: Record<string, string>
    rawBody?: string
    body?: JsonObject
  }): {
    actorId?: string
    roleId?: string
    authenticationType: 'bearer' | 'webhook'
  } {
    const authorization = input.headers['authorization']
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length).trim()
      const credential = this.bearerCredentials.find(
        (candidate) => candidate.token === token,
      )
      if (!credential) {
        throw new HttpDispatchError(401, 'Invalid bearer token.')
      }
      if (!credential.permissions.includes(input.permission)) {
        throw new HttpDispatchError(403, `Bearer token lacks ${input.permission} permission.`)
      }
      return {
        actorId: credential.actorId,
        roleId: credential.roleId,
        authenticationType: 'bearer',
      }
    }

    const keyId = input.headers['x-waos-key-id']
    const timestamp = input.headers['x-waos-timestamp']
    const signature = input.headers['x-waos-signature']
    if (keyId || timestamp || signature) {
      if (!keyId || !timestamp || !signature) {
        throw new HttpDispatchError(401, 'Webhook authentication headers are incomplete.')
      }
      const credential = this.webhookCredentials.find(
        (candidate) => candidate.keyId === keyId,
      )
      if (!credential) {
        throw new HttpDispatchError(401, 'Unknown webhook key id.')
      }
      if (!credential.permissions.includes(input.permission)) {
        throw new HttpDispatchError(403, `Webhook credential lacks ${input.permission} permission.`)
      }

      const nowMillis = toEpochMillis(this.now())
      const timestampMillis = toEpochMillis(timestamp)
      if (nowMillis == null || timestampMillis == null) {
        throw new HttpDispatchError(401, 'Webhook timestamp is invalid.')
      }
      const maxSkewMillis = (credential.maxSkewSeconds ?? 300) * 1000
      if (Math.abs(nowMillis - timestampMillis) > maxSkewMillis) {
        throw new HttpDispatchError(401, 'Webhook timestamp is outside the allowed skew window.')
      }

      const payload = input.rawBody ?? stableStringify(input.body ?? {})
      const expected = createHmac('sha256', credential.secret)
        .update(`${timestamp}.${input.method.toUpperCase()}.${input.url}.${payload}`)
        .digest('hex')
      if (!safeCompare(expected, signature)) {
        throw new HttpDispatchError(401, 'Webhook signature verification failed.')
      }

      return {
        actorId: credential.actorId,
        roleId: credential.roleId,
        authenticationType: 'webhook',
      }
    }

    throw new HttpDispatchError(401, 'Approval transport authentication is required.')
  }

  private assertActorBinding(
    auth: {
      actorId?: string
      roleId?: string
      authenticationType: 'bearer' | 'webhook'
    },
    actorId: string,
    roleId: string | undefined,
    action: string,
  ) {
    if (auth.actorId && auth.actorId !== actorId) {
      throw new HttpDispatchError(
        403,
        `Authenticated actor does not match requested actor for ${action}.`,
      )
    }
    if (auth.roleId && roleId && auth.roleId !== roleId) {
      throw new HttpDispatchError(
        403,
        `Authenticated role does not match requested role for ${action}.`,
      )
    }
  }

  private assertDecisionActorBinding(
    auth: {
      actorId?: string
      roleId?: string
      authenticationType: 'bearer' | 'webhook'
    },
    actorId: string,
    roleId: string,
  ) {
    if (!auth.actorId) {
      throw new HttpDispatchError(
        403,
        `Authenticated ${auth.authenticationType} credential is missing actor binding for decision submission.`,
      )
    }
    this.assertActorBinding(auth, actorId, roleId, 'decision submission')
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    const rawBody = request.method === 'POST' ? await readRawBody(request) : undefined
    const body =
      request.method === 'POST' && rawBody != null && rawBody.trim().length > 0
        ? (() => {
            const parsed = JSON.parse(rawBody) as unknown
            if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new HttpDispatchError(400, 'Expected JSON object body.')
            }
            return parsed as JsonObject
          })()
        : undefined
    const result = await this.dispatch({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      body,
      rawBody,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : value,
        ]),
      ),
    })
    json(response, result.statusCode, result.body)
  }
}
