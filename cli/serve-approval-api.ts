/**
 * serve-approval-api.ts
 * Starts a local HTTP transport for approval review and decision endpoints.
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { RuntimeApprovalClient } from '../src/approval/RuntimeApprovalClient.js'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { RuntimeApprovalApiService } from '../src/runtime/ApprovalApiService.js'
import { ApprovalApiHttpServer } from '../src/runtime/ApprovalApiHttpServer.js'
import { FileKernelPersistence } from '../src/runtime/kernelPersistence.js'
import { FileRunRegistry } from '../src/runtime/runRegistry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const runsDir = join(__dirname, '..', 'runs')

async function main() {
  const persistence = new FileKernelPersistence(runsDir)
  const runs = new FileRunRegistry(runsDir)
  const kernel = new DefaultSessionKernel({
    persistence,
    runs,
  })
  const client = new RuntimeApprovalClient({
    kernel,
    runs,
  })
  const service = new RuntimeApprovalApiService({
    client,
    ledger: persistence.ledger,
  })

  const bearerToken = process.env['APPROVAL_API_BEARER_TOKEN']
  const bearerActorId = process.env['APPROVAL_API_BEARER_ACTOR_ID']
  const bearerRoleId = process.env['APPROVAL_API_BEARER_ROLE_ID']
  const webhookKeyId = process.env['APPROVAL_API_WEBHOOK_KEY_ID']
  const webhookSecret = process.env['APPROVAL_API_WEBHOOK_SECRET']
  const webhookActorId = process.env['APPROVAL_API_WEBHOOK_ACTOR_ID']
  const webhookRoleId = process.env['APPROVAL_API_WEBHOOK_ROLE_ID']
  const server = new ApprovalApiHttpServer({
    service,
    bearerCredentials:
      bearerToken != null
        ? [
            {
              token: bearerToken,
              permissions: ['review', 'decision'],
              actorId: bearerActorId,
              roleId: bearerRoleId,
            },
          ]
        : [],
    webhookCredentials:
      webhookKeyId != null && webhookSecret != null
        ? [
            {
              keyId: webhookKeyId,
              secret: webhookSecret,
              permissions: ['decision'],
              actorId: webhookActorId,
              roleId: webhookRoleId,
            },
          ]
        : [],
  })

  const started = await server.start({
    host: process.env['APPROVAL_API_HOST'] ?? '127.0.0.1',
    port: process.env['APPROVAL_API_PORT']
      ? Number(process.env['APPROVAL_API_PORT'])
      : 8787,
  })

  console.log(`Approval API listening on ${started.baseUrl}`)
  console.log('Routes:')
  console.log('  GET  /health')
  console.log('  GET  /sessions/:sessionId/approval-reviews?limit=25')
  console.log('  GET  /runs/:runId/approval-review?viewerActorId=...&viewerRole=...')
  console.log('  POST /runs/:runId/approval-decisions')
  console.log('Auth:')
  console.log('  Bearer: Authorization: Bearer <token>')
  console.log('  Webhook: x-waos-key-id, x-waos-timestamp, x-waos-signature')

  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
