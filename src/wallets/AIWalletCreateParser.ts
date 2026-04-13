/**
 * AIWalletCreateParser
 *
 * AI-first parser for wallet creation requests.
 * No regex. Extracts structured WalletCreateIntentPayload from any natural language.
 *
 * Uses OpenAI with a structured JSON system prompt.
 * Falls back to an error result if the model cannot extract required fields.
 */

import OpenAI from 'openai'
import type { WalletCreateIntentPayload } from '../contracts/intent.js'
import type { RuntimeEnvironment } from '../contracts/common.js'

export type ParseWalletCreateResult =
  | { ok: true; payload: WalletCreateIntentPayload }
  | { ok: false; error: string }

const SYSTEM_PROMPT = {
  role: 'system' as const,
  content: JSON.stringify({
    task: 'Parse a wallet creation request into structured JSON.',
    output_schema: {
      subjectType: {
        type: 'string',
        enum: ['individual', 'team', 'business'],
        description: 'Type of entity the wallet is for. Infer from context: contractor/person → individual, team/department → team, company/vendor/corp/llc/business → business.',
      },
      subjectId: {
        type: 'string',
        description: 'Identifier or name of the subject. Use slugified form if a name is given: "Acme Corp" → "acme_corp", "John Smith" → "john_smith". Must be present.',
      },
      walletType: {
        type: 'string',
        enum: ['treasury', 'ops', 'user', 'vendor'],
        description: 'treasury = org treasury, ops = operational/internal, user = individual user wallet, vendor = external vendor/contractor payout.',
      },
      environment: {
        type: 'string',
        enum: ['development', 'staging', 'production'],
        description: 'Default to development unless explicitly stated.',
      },
      signerProfileId: {
        type: ['string', 'null'],
        description: 'Explicit signer profile if mentioned, otherwise null.',
      },
      initialPolicyProfileId: {
        type: ['string', 'null'],
        description: 'Explicit policy profile if mentioned, otherwise null.',
      },
    },
    rules: [
      'subjectId is REQUIRED. Infer from context: "for me" or "for myself" → "operator"; "for us" or "for our team" → "team"; if truly unidentifiable return {"missing": ["subjectId"]}.',
      'walletType is REQUIRED. Infer from context: "payout wallet", "vendor wallet" → vendor; "treasury" → treasury; "ops" or "operational" → ops; "user", "personal", "for me" → user. If unidentifiable return {"missing": ["walletType"]}.',
      'If both are missing return {"missing": ["subjectId", "walletType"]}.',
      'Do not include fields not in the schema.',
      'Return ONLY valid JSON — no markdown, no explanation.',
      'If the request is completely unrelated to wallet creation, return {"error": "not a wallet creation request"}.',
    ],
    examples: [
      {
        input: 'Create a payout wallet for our new contractor Javier',
        output: { subjectType: 'individual', subjectId: 'javier', walletType: 'vendor', environment: 'development', signerProfileId: null, initialPolicyProfileId: null },
      },
      {
        input: 'create a wallet for me please',
        output: { subjectType: 'individual', subjectId: 'operator', walletType: 'user', environment: 'development', signerProfileId: null, initialPolicyProfileId: null },
      },
      {
        input: 'Set up a vendor wallet for Acme Corp, they are a business',
        output: { subjectType: 'business', subjectId: 'acme_corp', walletType: 'vendor', environment: 'development', signerProfileId: null, initialPolicyProfileId: null },
      },
      {
        input: 'Create a treasury wallet for the payments team',
        output: { subjectType: 'team', subjectId: 'payments_team', walletType: 'treasury', environment: 'development', signerProfileId: null, initialPolicyProfileId: null },
      },
      {
        input: 'Onboard a new ops wallet for infrastructure team in production',
        output: { subjectType: 'team', subjectId: 'infrastructure_team', walletType: 'ops', environment: 'production', signerProfileId: null, initialPolicyProfileId: null },
      },
    ],
  }),
}

export class AIWalletCreateParser {
  private readonly client: OpenAI
  private readonly model: string

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'],
    })
    this.model = options.model ?? 'gpt-4o-mini'
  }

  async parse(text: string): Promise<ParseWalletCreateResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 300,
        messages: [
          SYSTEM_PROMPT,
          { role: 'user', content: text },
        ],
      })

      const raw = response.choices[0]?.message?.content?.trim() ?? ''

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, error: `AI returned non-JSON: ${raw}` }
      }

      if (parsed['error']) {
        return { ok: false, error: String(parsed['error']) }
      }

      // Model flagged missing fields — return a clarifying prompt
      if (parsed['missing']) {
        const missing = parsed['missing'] as string[]
        const prompts: string[] = []
        if (missing.includes('subjectId')) prompts.push('who is this wallet for?')
        if (missing.includes('walletType')) prompts.push('what type of wallet? (treasury / ops / user / vendor)')
        return {
          ok: false,
          error: `To create the wallet I need a bit more info — ${prompts.join(' and ')}`,
        }
      }

      const subjectId = parsed['subjectId']
      const walletType = parsed['walletType']
      const subjectType = parsed['subjectType']

      if (!subjectId || !walletType || !subjectType) {
        return {
          ok: false,
          error: 'Could not extract wallet creation fields. Try: "create a vendor wallet for Acme Corp".',
        }
      }

      return {
        ok: true,
        payload: {
          subjectType: String(subjectType) as WalletCreateIntentPayload['subjectType'],
          subjectId: String(subjectId),
          walletType: String(walletType) as WalletCreateIntentPayload['walletType'],
          environment: (String(parsed['environment'] ?? 'development')) as RuntimeEnvironment,
          signerProfileId: (parsed['signerProfileId'] as string | null) ?? undefined,
          initialPolicyProfileId: (parsed['initialPolicyProfileId'] as string | null) ?? undefined,
        },
      }
    } catch (err) {
      return {
        ok: false,
        error: `AI wallet create parser failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}
