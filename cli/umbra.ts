#!/usr/bin/env node

/**
 * umbra.ts — Umbra-powered interactive CLI
 *
 * Launches the Wallet Agent OS operator terminal with the Umbra privacy layer wired in.
 * All asset transfers are routed through Umbra's confidential ETA (Encrypted Token Account)
 * path — amounts are hidden on-chain via Arcium MPC computation.
 *
 * Usage:
 *   bun cli/umbra.ts
 *   bun cli/umbra.ts --persist
 *
 * Environment:
 *   UMBRA_SECRET_KEY_BASE64  64-byte Solana keypair (base64). If unset, a fresh
 *                             ephemeral signer is generated (devnet testing only).
 *   SOLANA_RPC_URL           Solana RPC endpoint (defaults to api.devnet.solana.com)
 *   SOLANA_WS_URL            Solana WebSocket endpoint (defaults to wss://api.devnet.solana.com)
 *   OPENAI_API_KEY           Primary AI provider for intent routing
 *   GROQ_API_KEY             Fallback AI provider (Groq, openai-compatible)
 */

import React from 'react'
import { render } from 'ink'
import { bootstrapUmbra } from './umbra-bootstrap.js'
import { OperatorCliApp } from './app/OperatorCliApp.js'

async function main() {
  const args = process.argv.slice(2)
  const persist = args.includes('--persist')
  const network = (process.env['SOLANA_CLUSTER'] as 'mainnet' | 'devnet' | 'localnet') ?? 'devnet'

  const result = await bootstrapUmbra({
    network,
    rpcUrl: process.env['SOLANA_RPC_URL'],
    rpcSubscriptionsUrl: process.env['SOLANA_WS_URL'],
    secretKeyBase64: process.env['UMBRA_SECRET_KEY_BASE64'],
    persist,
    // Defer master-seed wallet-sign until first operation
    deferMasterSeedSignature: true,
  } as Parameters<typeof bootstrapUmbra>[0])

  const client = await result.umbraProvider.getClient()

  const app = render(
    React.createElement(OperatorCliApp, {
      kernel: result.kernel,
      session: result.session,
      persist: result.persist,
      runsDir: result.runsDir,
      persistence: result.persistence,
      runRegistry: result.runRegistry,
      walletRegistry: result.walletRegistry,
      solanaMeta: {
        cluster: `solana-${network}`,
        walletAddress: String(client.signer.address),
        keypairSource: process.env['UMBRA_SECRET_KEY_BASE64'] ? 'env:UMBRA_SECRET_KEY_BASE64' : 'ephemeral',
      },
    }),
  )

  await app.waitUntilExit()
}

main().catch((error) => {
  console.error('\nFatal error:', error)
  process.exit(1)
})
