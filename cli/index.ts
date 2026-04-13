#!/usr/bin/env node

import React from 'react'
import { render } from 'ink'
import { bootstrap } from './bootstrap.js'
import { bootstrapSolana } from './solana-bootstrap.js'
import { OperatorCliApp } from './app/OperatorCliApp.js'

async function main() {
  const args = process.argv.slice(2)
  const persist = args.includes('--persist')
  const useSolana = args.includes('--solana')

  if (useSolana) {
    const bootstrapResult = await bootstrapSolana()
    const app = render(React.createElement(OperatorCliApp, {
      kernel: bootstrapResult.kernel,
      session: bootstrapResult.session,
      persist: bootstrapResult.persist,
      runsDir: bootstrapResult.runsDir,
      persistence: bootstrapResult.persistence,
      runRegistry: bootstrapResult.runRegistry,
      walletRegistry: bootstrapResult.walletRegistry,
      solanaMeta: {
        cluster: bootstrapResult.cluster,
        walletAddress: bootstrapResult.walletAddress,
        keypairSource: bootstrapResult.keypairSource,
      },
      solanaRpcUrl: bootstrapResult.rpcUrl,
    }))

    await app.waitUntilExit()
    return
  }

  const bootstrapResult = await bootstrap({ persist })
  const app = render(React.createElement(OperatorCliApp, {
    kernel: bootstrapResult.kernel,
    session: bootstrapResult.session,
    persist: bootstrapResult.persist,
    runsDir: bootstrapResult.runsDir,
    persistence: bootstrapResult.persistence,
    runRegistry: bootstrapResult.runRegistry,
    walletRegistry: bootstrapResult.walletRegistry,
  }))
  await app.waitUntilExit()
}

main().catch((error) => {
  // Ink may not be mounted yet on bootstrap failures.
  console.error('\nFatal error:', error)
  process.exit(1)
})
