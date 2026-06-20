import Anthropic from '@anthropic-ai/sdk';
import type { AnalyzeResult } from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Enrich detected recurring charges with merchant identification and a
// keep/review/cancel recommendation. Mutates result.recurring in place.
// This is the only place an LLM is used; everything else is deterministic.
export async function enrichWithLLM(result: AnalyzeResult, apiKey: string): Promise<void> {
  if (result.recurring.length === 0) return;
  const client = new Anthropic({ apiKey });
  const model = process.env.ANALYZER_MODEL ?? DEFAULT_MODEL;

  // Cap to the highest-value recurring merchants so the structured response
  // fits comfortably under the token limit. They're already sorted by total,
  // so slice indices line up with positions in result.recurring.
  const toEnrich = result.recurring.slice(0, 40);
  const list = toEnrich.map((r, i) =>
    `${i}. "${r.merchant}" — ${r.count}x, $${r.total.toFixed(2)} total over ${result.months.toFixed(1)} months, ` +
    `charge amounts: ${r.amounts.slice(0, 8).map(a => a.toFixed(2)).join(', ')}`,
  ).join('\n');

  const prompt =
    `You are a personal-finance assistant reviewing recurring charges from a US bank/credit-card export. ` +
    `For each item, identify what the merchant most likely is, whether it is a subscription/membership ` +
    `(vs. a merchant the person just frequents, like a grocery store or gas station), whether the spending is ` +
    `discretionary (a "want" that could be cancelled) vs. essential (a "need" like utilities or trash service), ` +
    `and a short, direct recommendation. Be concrete; if a name is cryptic (e.g. "BOING US HOLDCO"), give your ` +
    `best guess at the underlying service and tell them to verify it.\n\n` +
    `Recurring charges:\n${list}`;

  const msg = await client.messages.create({
    model,
    max_tokens: 8192,
    tools: [{
      name: 'report',
      description: 'Return one annotation per recurring charge, matched by index.',
      input_schema: {
        type: 'object' as const,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number', description: 'The index from the input list' },
                whatItIs: { type: 'string', description: 'Best guess at the merchant/service in a few words' },
                isSubscription: { type: 'boolean' },
                discretionary: { type: 'boolean', description: 'true = want/cancellable, false = essential need' },
                recommendation: { type: 'string', description: 'One short sentence: keep / review / cancel and why' },
              },
              required: ['index', 'whatItIs', 'isSubscription', 'discretionary', 'recommendation'],
            },
          },
        },
        required: ['items'],
      },
    }],
    tool_choice: { type: 'tool' as const, name: 'report' },
    messages: [{ role: 'user', content: prompt }],
  });

  if (process.env.ANALYZER_DEBUG) {
    console.error(`[debug] model=${model} stop=${msg.stop_reason} blocks=${msg.content.map(b => b.type).join(',')}`);
  }
  const toolUse = msg.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return;
  const items = (toolUse.input as { items?: Array<Record<string, unknown>> }).items ?? [];

  for (const a of items) {
    const idx = a.index as number;
    const r = result.recurring[idx];
    if (!r) continue;
    r.whatItIs = a.whatItIs as string;
    r.isSubscription = a.isSubscription as boolean;
    r.discretionary = a.discretionary as boolean;
    r.recommendation = a.recommendation as string;
  }
}
