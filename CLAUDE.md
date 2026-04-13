# CLAUDE.md — Wallet Agent OS

Working agreement and orientation for any AI agent contributing to this codebase.

---

## What This Is

A deterministic execution runtime for high-stakes wallet, treasury, and signing workflows — built as a hackathon submission for the Umbra Side Track ($10k, deadline May 12 2026).

This is not a generic crypto chatbot. It is:
- An agent runtime with typed tools
- Explicit policy resolution + restrictive merge
- Approval and signing boundaries enforced by the runtime, not the model
- Durable session/run state with append-only ledger
- Simulation before execution
- Audit-grade artifacts per run

The model interprets and drafts. The runtime enforces.

---

## Before Making Changes

Read these files in order:

1. `plan.md` — active build plan and current priority
2. `docs/runtime-modules.md` — high-level module map
3. `docs/intent-object.md` — core intent contract
4. `docs/policy-profile.md` — policy shape
5. `docs/policy-resolution.md` — restrictive merge logic
6. `docs/signing-boundary.md` — signing handoff contract
7. `docs/safe-transfer-flow.md` — end-to-end transfer path
8. `docs/execution-ledger.md` — audit artifact model
9. `docs/runtime-phases.md` — 11-phase state machine
10. `docs/session-kernel.md` — session kernel contract
11. `docs/umbra-integration-spec.md` — Umbra integration design

For Umbra hackathon context: `docs/umbraspec.md`

---

## Codebase State (as of April 2026)

### What's done
- All 11 runtime phases implemented end-to-end
- SessionKernel refactored: 5,396 → 1,221 lines, phase logic extracted to `src/runtime/phases/`
- AIKernelRouter with OpenAI primary + Groq fallback (`src/runtime/AIKernelRouter.ts`)
- Vitest test suite: 54 tests covering approval, simulation, and policy engines (`tests/`)
- DeterministicBroadcaster + SolanaBroadcaster
- DeterministicApprovalEngine, DeterministicSimulationEngine, RestrictivePolicyResolver
- WalletRegistry, RunRegistry, FileKernelPersistence
- TrustEngine, ComplianceProvider (deterministic/mock)
- Full smoke tests: `cli/smoke-test-*.ts`

### What's next (in priority order)
1. **Umbra integration** — `UmbraWalletProvider`, `UmbraBroadcaster`, `ViewingKeyLedgerExtension`, `PrivacyPolicy` fields
2. **Umbra bootstrap** — wire up `cli/umbra.ts` entrypoint
3. **Shielded payroll demo** — `treasury.private_payment_batch` end-to-end
4. **CLI UI polish** — shielded transfer badge, `/disclose` command, viewing key indicator
5. **Devnet deploy** — real shielded transactions on Solana devnet
6. **Submission** — README architecture section, demo video

---

## Non-Negotiable Design Rules

1. The model never directly controls private keys.
2. No financial action executes without a structured `IntentObject`.
3. Policy resolution stays in the execution path, not the prompt.
4. Simulation happens before signing for all financial actions.
5. Approval is a runtime state transition, not an informal chat reply.
6. KYC and identity data must be reference-based and redacted in normal session state.
7. Trust scores are deterministic-first and explainable.
8. Every sign, deny, approve, simulate, and broadcast event becomes a durable ledger artifact.

---

## Architecture Quick Reference

```
src/
  contracts/         — TypeScript type contracts for every concept
  runtime/           — SessionKernel (orchestrator), AIKernelRouter, registries
  runtime/phases/    — Phase handler classes extracted from SessionKernel
  policy/            — RestrictivePolicyResolver
  approval/          — DeterministicApprovalEngine
  simulation/        — DeterministicSimulationEngine
  signing/           — SignerGateway adapters + signature request builders
  broadcast/         — DeterministicBroadcaster, SolanaBroadcaster
  reconciliation/    — DeterministicReconciler
  wallets/           — WalletProvider adapters, WalletRegistry
  transfers/         — Intent parsing, building, validation, material hash
  treasury/          — Rebalance + payment batch workflows
  trust/             — TrustEngine + signal collection
  compliance/        — ComplianceProvider (mock)
  ledger/            — (ViewingKeyLedgerExtension goes here — Umbra)

cli/
  index.ts           — Main entrypoint (in-memory or --persist)
  bootstrap.ts       — Dependency wiring (in-memory + file-backed)
  solana-bootstrap.ts — Real Solana wiring
  umbra.ts           — (to be created) Umbra-powered entrypoint
  app/OperatorCliApp.tsx — Ink-based TUI
  smoke-test-*.ts    — End-to-end integration tests

tests/
  approval.test.ts   — DeterministicApprovalEngine (vitest)
  simulation.test.ts — DeterministicSimulationEngine (vitest)
  policy.test.ts     — RestrictivePolicyResolver (vitest)
```

---

## Provider Adapter Pattern

All external dependencies are behind interfaces with deterministic (mock) and real implementations. Never let vendor-specific logic leak into the runtime core.

Key interfaces: `WalletProvider`, `Broadcaster`, `SignerGateway`, `ComplianceProvider`, `Reconciler`

For Umbra: implement `UmbraWalletProvider` and `UmbraBroadcaster` behind these same interfaces. The runtime should not know it is doing a shielded transfer — that is the broadcaster's concern.

---

## Working Rules

- Prefer small composable modules over one large orchestration file.
- Prefer operator-safe workflows over autonomy theater.
- Prefer deterministic enforcement over model judgment for policy, signing, and trust.
- Prefer bounded provider adapters instead of leaking vendor-specific logic.
- Build one end-to-end flow completely before generalizing.
- Run `bun tsc --noEmit` and `bun test` after any meaningful change.

---

## Environment

```
OPENAI_API_KEY=...   — primary AI provider
GROQ_API_KEY=...     — fallback AI provider (Groq, openai-compatible)
GROQ_MODEL=openai/gpt-oss-20b
SOLANA_RPC_URL=...   — Solana RPC for real broadcast
SOLANA_CLUSTER=devnet
SOLANA_KEYPAIR_PATH=./id.json
```

---

## Commands

```bash
bun test                          # run unit tests (vitest)
bun run check                     # TypeScript type check
bun cli/index.ts                  # interactive CLI (in-memory)
bun cli/index.ts --persist        # file-backed
bun cli/index.ts --persist --solana  # real Solana
bun cli/smoke-test-payment-batch.ts  # smoke tests
```
