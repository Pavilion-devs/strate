# Wallet Agent OS Plan

This file is the active design and build plan for `wallet-agent-os`.

It is intentionally concrete.

The goal is to avoid drifting into "cool crypto agent ideas" without locking down the runtime foundation first.

## Product Thesis

Wallet Agent OS is a runtime for high-stakes financial actions.

It should help agents:

- interpret human requests
- convert them into structured intent
- enforce wallet and treasury policy
- simulate before execution
- verify approval requirements
- request protected signatures
- broadcast safely
- preserve a durable execution ledger

## What We Are Actually Building

Not:

- a meme AI wallet
- freeform autonomous money movement
- a bot with raw key access

Yes:

- an execution OS for wallet, treasury, identity, and trust workflows

## Core Runtime Primitives

Everything else should build on these four primitives:

### 1. Intent Object

Source of truth for what the human or system is trying to do.

### 2. Policy Profile

Source of truth for what is allowed.

### 3. Signing Boundary

Source of truth for how protected execution happens.

### 4. Execution Ledger

Source of truth for what actually happened.

## First End-To-End Flows

These are the first flows worth building.

### Flow A: Safe Transfer

Operator request:

- send funds to a recipient safely

Runtime outcome:

- interpret request
- create intent
- verify recipient and amount
- simulate
- request approval if required
- request signature through protected signer
- broadcast
- reconcile

### Flow B: Wallet Creation Plus Identity Linking

Operator request:

- create a wallet for a new person, team, or business and start compliance setup

Runtime outcome:

- create wallet
- bind wallet to org/user identity
- start KYC or KYB workflow
- apply initial policy
- set trust baseline

### Flow C: Treasury Rebalance Proposal

Operator request:

- rebalance treasury under policy

Runtime outcome:

- inspect balances
- plan rebalance
- check limits and counterparties
- simulate expected deltas
- request approval
- execute through protected signing path

## Build Sequence

### Phase 0: Design Foundation

Status:

- complete

Deliverables:

- `runtime-modules.md`
- `AGENTS.md`
- `plan.md`
- `storyboards/startup-treasury-week.md`
- `intent-object.md`
- `policy-profile.md`
- `signing-boundary.md`

### Phase 1: Runtime Contracts

Goal:

- lock down the first real interfaces

Deliverables:

- typed intent schema ✓
- typed policy profile schema ✓
- policy resolution contract ✓
- signer gateway contract ✓
- signer adapter contract ✓
- tool interface contract ✓
- execution ledger event types ✓
- runtime phase model ✓
- session kernel contract ✓

Status:

- complete

### Phase 2: Safe Transfer MVP

Goal:

- complete one operator-safe money movement path

Status:

- complete — running on Solana devnet

Deliverables:

- transfer intent builder ✓
- transfer policy checks ✓
- transaction simulation contract ✓
- approval engine contract ✓ (see note below)
- approval UI contract ✓ (CLI natural language approval)
- signer request contract ✓
- final execution report ✓

Note on approval engine:
- DeterministicApprovalEngine is built and wired
- approval-engine.md contract is partially followed — material hash binding,
  role-aware records, expiry checks, and simulation-staleness invalidation are implemented
- break-glass callback path is implemented
- gap: reusable external multi-party approval delivery client is still being hardened
- these are Phase 3/4 concerns, not blockers for MVP

### Phase 3: Wallet And Identity MVP

Goal:

- complete one wallet lifecycle path

Status:

- in progress — `wallet.create` is now routed through AI parsing and provisions a real
  Solana keypair via `SolanaWalletProvider.provisionWallet()` when running in Solana mode.
  Identity-link, compliance-kickoff, policy-attachment, and trust-baseline artifacts/events
  are written in the wallet-create run path.
- remaining gap: compliance provider integration is still a runtime artifact stub
  (no external KYC/KYB provider callback loop yet), and lifecycle restrictions are not yet
  enforced end-to-end across all action paths.

Deliverables:

- wallet creation flow (partial ✓ — real Solana provisioning path + deterministic fallback)
- wallet state lifecycle contract ✓ (defined in wallet-state-lifecycle.md)
- identity link flow (partial ✓ — runtime artifact + ledger event)
- KYC status orchestration (partial — kickoff recorded, provider-driven status updates pending)
- policy assignment at wallet creation time (partial — recorded and resolved, per-wallet
  policy lifecycle still needs hardening)

Open question: wallet creation uses OWS (@open-wallet-standard/core) or Solana Keypair?
See section below.

### Phase 4: Treasury MVP

Goal:

- support recurring operator workflows

Status:

- in progress — `treasury.rebalance` and `treasury.payment_batch` now run end-to-end:
  intent parse/build/validate, policy resolution, treasury planning,
  simulation, approval, signing, broadcast, reconciliation, and report creation
  are implemented.
- remaining gap: treasury-specific limit hardening (obligation-aware balance policy)
  and recurring approval policy enforcement depth.

Deliverables:

- payment batch planning and execution ✓
- treasury rebalance flow ✓
- rebalance planning (partial ✓ — TreasuryBalanceInspector MVP wired)
- treasury balance policy (partial ✓ — inspector models spendable/buffer logic; needs
  richer obligation-aware policy integration)
- treasury limits (partial — resolved policy is used; treasury-specific limits need hardening)
- recurring approval rules (in progress)

### Phase 5: Trust And Risk Layer

Goal:

- add deterministic trust and risk systems on top of the safe core

Deliverables:

- trust signal map
- trust scoring posture
- trust engine contract
- trust score engine
- risk explanation outputs
- counterparty and protocol scoring support

## Design Boundaries

### Model Responsibilities

The model may:

- interpret requests
- draft intent
- summarize risk
- propose plans
- explain execution

The model may not be the source of truth for:

- whether signing is allowed
- whether policy passed
- whether trust score changed
- whether KYC is complete
- what transaction was actually signed

### Runtime Responsibilities

The runtime must own:

- policy resolution
- deterministic validation
- simulation requirements
- approval state
- signer handoff
- execution logging

## Current Strongest Real-World Wedge

The best first market-shaped workflow is:

- stablecoin treasury operations for startups and internet businesses

Why:

- repeated workflows
- painful manual ops
- real approval chains
- real compliance requirements
- real cost for mistakes

This gives us a strong initial target:

- payroll
- vendor payments
- treasury transfers
- rebalances
- wallet onboarding

## What To Avoid Early

- uncontrolled DeFi strategy execution
- broad protocol support before policy exists
- autonomous large-value transfers
- trust scores built from model intuition

## Wallet Creation: OWS vs Solana Keypair

OWS (@open-wallet-standard/core) is a standard interface for connecting to
existing user wallets (browser wallets like Phantom, Backpack, etc). It is the
right choice for user-facing wallets where the user already holds keys.

For treasury/ops/vendor wallets we are provisioning on behalf of an org, OWS
is not the right tool. Those wallets need a fresh Keypair, stored securely
(KMS, MPC, or a custodial vault), with a signer profile attached.

Decision:
- user wallets (connecting to Phantom/Backpack): use OWS adapters
- treasury/ops/vendor wallets (provisioned by the system): use Solana Keypair
  generation + signer gateway delegation (same path as the transfer flow)
- KYC/identity binding: orchestrated by the runtime, sourced from an external
  KYC provider — not part of wallet key provisioning itself

## Design Doc Compliance Tracker

These design docs were written intentionally. We must build against them, not
drift from them. Status of each:

| Doc | Status |
|-----|--------|
| intent-object.md | ✓ fully implemented in contracts/intent.ts |
| policy-profile.md | ✓ fully implemented in contracts/policy.ts |
| policy-resolution.md | ✓ RestrictivePolicyResolver follows the spec |
| signing-boundary.md | ✓ SignerGateway contract followed |
| signer-gateway-adapters.md | ✓ DeterministicSignerGateway + SolanaSignerGateway |
| approval-engine.md | partial — role-aware approvals, expiry checks, stale-simulation invalidation, break-glass callback path, and external approval evidence refs are enforced; reusable external delivery orchestration is still pending |
| approval-ui-contract.md | partial — runtime now emits canonical approval review package artifacts, retrieval commands, a typed external approval client adapter, an audited approval API service, and an authenticated local HTTP transport; production delivery hardening still needs work |
| safe-transfer-flow.md | ✓ full E2E working on devnet |
| wallet-create-flow.md | partial — AI parsing + real Solana provisioning + identity/compliance/trust artifacts; compliance kickoff, provider callback lifecycle progression, operator/status inspection, reusable compliance provider boundary, and deterministic wallet trust baseline/refresh are wired for wallet onboarding, but broader lifecycle/trust enforcement still needs hardening |
| wallet-state-lifecycle.md | partial — states defined, transitions not all enforced |
| treasury-rebalance-flow.md | ✓ end-to-end flow implemented through signing, broadcast, reconciliation, and closeout reporting |
| trust-signal-map.md | partial — deterministic wallet-trust signals now implemented for compliance, provenance, signer control, and org linkage; non-wallet objects and richer signal families still pending |
| trust-engine-contract.md | partial — deterministic trust engine modules now assess wallet trust, persist trust artifacts, and refresh on compliance callbacks; refresh/query surfaces and broader policy integration still pending |
| execution-ledger.md | ✓ FileExecutionLedger implements the contract |
| ledger-storage-layout.md | ✓ fileLayout.ts follows the spec |
| runtime-phases.md | ✓ phaseGuards.ts implements all 11 phases |
| session-kernel.md | ✓ DefaultSessionKernel implements the contract |
| tool-contract.md | partial — StatusQueryEngine tool-calling loop exists; broader tool registry/permission model still to wire |
| runtime-modules.md | ✓ all modules present |

## Current Implementation Snapshot (April 9, 2026)

Runtime and infrastructure:

- file-backed run/session/artifact persistence is live
- phase guards are live
- AI-first kernel routing is live (regex remains fallback)
- status queries use model-directed tool calling against runtime registries
- typed external approval client adapter now consumes runtime review packages and submits structured decisions with outcome codes
- smoke coverage now includes external approval client role-split, stale-state rejection, and break-glass flows
- stable approval API service now emits `approval.request_rendered` and `approval.submission_received` ledger events for external review flows
- approval review and decision submission are now exposed over an authenticated local HTTP transport for external system integration and smoke-tested through the shared HTTP route handler
- wallet onboarding now persists compliance workflow ids and applies provider callback-driven lifecycle progression for vendor and ops wallets
- operator/status surfaces now expose pending compliance workflows and per-wallet compliance state without reading raw artifacts
- operator CLI now runs on an Ink-based persistent component tree instead of readline/raw-mode overlays, with shared prompt state, inline slash filtering, modal wallet inspection, and cleaner session presentation for manual testing
- compliance kickoff and callback reconciliation now flow through a reusable provider adapter boundary instead of kernel-hardcoded provider logic
- wallet records now preserve wallet-provider provenance separately from compliance-provider provenance
- deterministic trust engine modules now compute wallet trust baselines from explicit signals and refresh trust after compliance callbacks
- trust assessments now persist as durable artifacts and drive wallet `trustStatus` updates instead of leaving new wallets permanently `unassessed`

Completed vertical slice:

- safe transfer flow (Solana devnet path) from intent to closeout report

In-progress vertical slices:

- wallet create + identity/compliance/trust baseline (core path implemented, reusable compliance provider boundary wired, deterministic wallet trust baseline active, broader lifecycle enforcement still pending)

Immediate code milestone:

- productionize approval delivery beyond the local authenticated transport
- extend compliance adapters beyond wallet onboarding into richer provider/workflow coverage
- extend trust assessments beyond wallet onboarding into query surfaces and non-wallet object coverage
- extend the new Ink-based operator CLI with `/runs`, wallet sub-actions, and richer inline status surfaces now that the render architecture is fixed

## Immediate Next Docs

1. `ledger-query-contract.md`
2. `run-state-contract.md`
3. `notification-contract.md`
4. `callback-event-contract.md`
5. `provider-adapter-contract.md`
