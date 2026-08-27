import type { ChatMessage } from '@/lib/llm/client';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { VoucherDiff } from '@/lib/schemas/scoring';
import type { Voucher } from '@/lib/schemas/voucher';
import { RULEBOOK_TEXT } from '@/lib/llm/grounding/rulebook';

const ADJUDICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sequence: { type: 'integer' },
          field: {
            type: 'string',
            enum: ['account', 'dr_cr', 'amount', 'voucher_type', 'gst', 'tds', 'bill_reference', 'narration'],
          },
          verdict: { type: 'string', enum: ['uphold', 'dismiss'] },
          reason: { type: 'string' },
        },
        required: ['sequence', 'field', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
} as const;

// The judge's brief: senior reviewer deciding whether a mechanical checker's
// findings are real errors or acceptable practice variations. This runs
// entirely server-side inside the scoring job — the expected postings shown
// here never reach any client-facing output (same boundary as hint
// generation's answer-key grounding).
const SYSTEM_PROMPT = `You are a senior accountant adjudicating findings from a mechanical bookkeeping
checker. A trainee posted a month of transactions in Tally; the checker diffed
their vouchers against the expected postings and flagged discrepancies. Your
job: for EACH flagged finding, decide "uphold" (a genuine accounting error the
trainee should be coached on) or "dismiss" (an acceptable variation the checker
was too rigid about).

UPHOLD real errors:
- Wrong GST regime (IGST vs CGST/SGST) or wrong GST side (Output GST reversed
  through Input, or vice versa)
- TDS deducted when it shouldn't be, not deducted when it should, or computed
  on the wrong base (e.g. on the GST-inclusive total instead of the taxable base)
- Amounts that don't match the source documents
- A credit sale routed through cash, a fixed asset expensed, a wrong voucher type
- Missing bill-by-bill references where the house standard requires them
- Parking an unidentified receipt in a sloppily-named ledger instead of Suspense

DISMISS acceptable variations:
- Ledger NAMING differences where the classification is right (the expected
  "Purchases" posted as "Trading goods", "Sales" split into "Cash Sales A/c"
  and "Credit Sales A/c", a vendor name with a suffix, a typo in a ledger name)
- Legitimate structural alternatives (a return netted into the main ledger
  instead of a separate Returns ledger; one split payment vs. per-bill
  payments; prepaid apportioned in a separate JV)
- Reference-format differences where the reference clearly identifies the same
  bill
- Rounding differences of less than one rupee

Judge against the House Practices Rulebook below. Be strict about substance,
tolerant about form. When genuinely unsure, uphold — a false "all clear"
teaches the trainee the wrong thing, while an upheld finding just gets a
closer look in coaching.

Return a verdict for EVERY finding listed — never skip one.

Reference — Karbon VA House Practices Rulebook v0.2:
${RULEBOOK_TEXT}

Respond only with JSON matching the provided schema.`;

export type FlaggedTransaction = {
  sequence: number;
  expectedLegs: AnswerKeyEntry[];
  actualVoucher: Voucher | null;
  findings: VoucherDiff[];
};

function describeExpected(legs: AnswerKeyEntry[]): string {
  const meta = legs[0];
  const parts = [
    `voucher type ${meta.voucher_type}`,
    ...legs.map((leg) => `${leg.dr_cr} ${leg.correct_account} ${leg.amount}`),
  ];
  if (meta.gst_head) {
    parts.push(`GST ${meta.gst_head} @${meta.gst_rate}%`);
  }
  if (meta.tds_section) {
    parts.push(`TDS ${meta.tds_section} @${meta.tds_rate}% on base ${meta.tds_base}`);
  }
  if (meta.bill_reference) {
    parts.push(`bill ref ${meta.bill_reference}`);
  }
  return parts.join('; ');
}

function describeActual(voucher: Voucher | null): string {
  if (!voucher) {
    return 'NO MATCHING VOUCHER FOUND in the submission';
  }
  const legs = voucher.ledgerEntries.map((entry) => {
    const refs = entry.billAllocations.map((allocation) => allocation.name).join(', ');
    return `${entry.drOrCr} ${entry.ledgerName} ${entry.amount}${refs ? ` [refs: ${refs}]` : ''}`;
  });
  return `voucher type ${voucher.voucherType}, date ${voucher.date}; ${legs.join('; ')}; narration: "${voucher.narration}"`;
}

export function buildAdjudicationPrompt(flagged: FlaggedTransaction[]): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const blocks = flagged.map((transaction) => {
    const findings = transaction.findings
      .map((finding) => `- field "${finding.field}"${finding.error_code ? ` (${finding.error_code})` : ''}`)
      .join('\n');
    return `Transaction #${transaction.sequence}
Expected: ${describeExpected(transaction.expectedLegs)}
Trainee posted: ${describeActual(transaction.actualVoucher)}
Flagged findings:
${findings}`;
  });

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: blocks.join('\n\n') },
    ],
    jsonSchema: { name: 'adjudication', schema: ADJUDICATION_JSON_SCHEMA },
  };
}

export function buildAdjudicationRetryPrompt(
  flagged: FlaggedTransaction[],
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildAdjudicationPrompt(flagged);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'user',
        content: `Your previous response failed schema validation with this error: ${validationError}. Respond again with corrected JSON matching the schema exactly.`,
      },
    ],
  };
}
