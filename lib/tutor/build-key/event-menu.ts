import type { ConceptTag, ExerciseDifficultyLevel } from '@/lib/schemas/exercise';

// What a batch at a level may contain (2026-09-22, rebuild Stage 3). The
// menu is stated to the model AND enforced on the plan, so difficulty is
// never the model's choice.

export type EventMenu = {
  allowedTypes: readonly ('sale' | 'purchase' | 'receipt' | 'payment' | 'contra' | 'depreciation')[];
  allowAdvances: boolean;
  allowTds: boolean;
  allowOnAccount: boolean;
  allowMultiBill: boolean;
  allowAssets: boolean;
  minEvents: number;
  maxEvents: number;
  maxLinesPerDocument: number;
};

// Concepts v1 of the builder can express. The rest (reverse charge, TDS
// withheld by a customer, credit and debit notes) send the batch to the
// legacy generator until Stage 6.
const SUPPORTED_CONCEPTS: readonly ConceptTag[] = [
  'sales_voucher_basics',
  'purchase_voucher_basics',
  'payment_voucher_basics',
  'receipt_voucher_basics',
  'contra_voucher_basics',
  'journal_voucher_basics',
  'gst_classification',
  'tds_classification',
  'bill_by_bill_referencing',
  'narration_discipline',
  'trial_balance_tie_out',
  'customer_advance',
  'supplier_advance',
  'on_account_reference',
  'multi_bill_settlement',
  'gst_set_off',
  'gst_payment',
  'fixed_assets_depreciation',
];

export function supportsConcepts(concepts: readonly ConceptTag[]): boolean {
  return concepts.every((concept) => SUPPORTED_CONCEPTS.includes(concept));
}

export function eventMenuFor(level: ExerciseDifficultyLevel, concepts: readonly ConceptTag[], escalation: boolean): EventMenu {
  const has = (tag: ConceptTag) => concepts.includes(tag);
  const rank = ['L0', 'L1', 'L2', 'L3', 'L4'].indexOf(level);
  return {
    allowedTypes: rank === 0 ? ['sale', 'purchase', 'receipt', 'payment', 'contra'] : ['sale', 'purchase', 'receipt', 'payment', 'contra', 'depreciation'],
    allowAdvances: rank >= 2 || has('customer_advance') || has('supplier_advance'),
    allowTds: rank >= 1 || has('tds_classification'),
    allowOnAccount: rank >= 2 || has('on_account_reference'),
    allowMultiBill: rank >= 1 || has('multi_bill_settlement'),
    allowAssets: rank >= 2 || has('fixed_assets_depreciation'),
    // Escalation batches are narrow, not small (2026-09-10 meeting).
    minEvents: escalation ? 8 : 10,
    maxEvents: 12,
    maxLinesPerDocument: rank >= 3 ? 3 : 2,
  };
}

export function describeMenu(menu: EventMenu): string {
  const lines = [
    `- Event types allowed: ${menu.allowedTypes.join(', ')}.`,
    `- ${menu.minEvents} to ${menu.maxEvents} events, at most ${menu.maxLinesPerDocument} line items per invoice or bill.`,
    menu.allowAdvances ? '- Advances allowed: a receipt/payment with settlement mode "advance", and a later sale/purchase of the same party with settlement "adjust_advance" naming that advance.' : '- No advances at this level.',
    menu.allowTds ? '- Service and expense purchases may attract TDS; the system computes it.' : '- Keep purchases to goods at this level (no TDS).',
    menu.allowOnAccount ? '- An "on_account" settlement is allowed when no bill can be identified.' : '- No on-account settlements at this level.',
    menu.allowMultiBill ? '- A "full" settlement may name several bills of one party.' : '- Settle one bill per receipt or payment at this level.',
    menu.allowAssets ? '- A purchase of nature "asset" and a depreciation event are allowed.' : '- No asset purchases or depreciation at this level.',
  ];
  return lines.join('\n');
}
