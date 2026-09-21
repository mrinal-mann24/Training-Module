import { CONCEPT_TAGS, type ConceptTag, type ExerciseDifficultyLevel } from '@/lib/schemas/exercise';

// What a batch at a level may contain (2026-09-22, rebuild Stage 3). The
// menu is stated to the model AND enforced on the plan, so difficulty is
// never the model's choice.

export type EventType = 'sale' | 'purchase' | 'receipt' | 'payment' | 'contra' | 'depreciation' | 'credit_note' | 'debit_note';

export type EventMenu = {
  allowedTypes: readonly EventType[];
  allowAdvances: boolean;
  allowTds: boolean;
  allowOnAccount: boolean;
  allowMultiBill: boolean;
  allowAssets: boolean;
  // Stage 6: returns (credit and debit notes) and a customer withholding
  // TDS on a receipt. Reverse charge is never a choice: the builder
  // applies it wherever the rulebook makes it mandatory.
  allowNotes: boolean;
  allowTdsOnReceipt: boolean;
  minEvents: number;
  maxEvents: number;
  maxLinesPerDocument: number;
};

// Every concept the builder can express. Since Stage 6 that is the whole
// vocabulary; supportsConcepts stays as the one switch the generator asks,
// so a concept added to CONCEPT_TAGS without builder support falls back
// to the legacy generator instead of producing a batch that cannot drill it.
const SUPPORTED_CONCEPTS: readonly ConceptTag[] = [...CONCEPT_TAGS];

export function supportsConcepts(concepts: readonly ConceptTag[]): boolean {
  return concepts.every((concept) => SUPPORTED_CONCEPTS.includes(concept));
}

export function eventMenuFor(level: ExerciseDifficultyLevel, concepts: readonly ConceptTag[], escalation: boolean): EventMenu {
  const has = (tag: ConceptTag) => concepts.includes(tag);
  const rank = ['L0', 'L1', 'L2', 'L3', 'L4'].indexOf(level);
  const allowNotes = rank >= 1;
  return {
    allowedTypes: [
      'sale',
      'purchase',
      'receipt',
      'payment',
      'contra',
      ...(rank >= 1 ? (['depreciation'] as const) : []),
      ...(allowNotes ? (['credit_note', 'debit_note'] as const) : []),
    ],
    allowAdvances: rank >= 2 || has('customer_advance') || has('supplier_advance'),
    allowTds: rank >= 1 || has('tds_classification'),
    allowOnAccount: rank >= 2 || has('on_account_reference'),
    allowMultiBill: rank >= 1 || has('multi_bill_settlement'),
    allowAssets: rank >= 2 || has('fixed_assets_depreciation'),
    allowNotes,
    allowTdsOnReceipt: rank >= 2 || has('tds_on_receipt'),
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
    menu.allowAdvances ? '- Advances allowed: a receipt/payment with settlement_mode "advance", and a later sale/purchase of the same party with settlement "adjust_advance" naming that advance.' : '- No advances at this level.',
    menu.allowTds ? '- Service and expense purchases may attract TDS; the system computes it.' : '- Keep purchases to goods at this level (no TDS).',
    menu.allowOnAccount ? '- settlement_mode "on_account" is allowed when no bill can be identified.' : '- No on-account settlements at this level.',
    menu.allowMultiBill ? '- settlement_mode "full" may list several bills of one party in "bills".' : '- Settle one bill per receipt or payment at this level.',
    menu.allowAssets ? '- A purchase of nature "asset" and a depreciation event are allowed.' : '- No asset purchases or depreciation at this level.',
    menu.allowNotes
      ? '- Returns allowed: a "credit_note" (our credit note to a customer against ONE open invoice of theirs) or a "debit_note" (our debit note to a vendor against ONE open bill), with lines at the original slab and a new note_number; the note total must stay within the bill\'s open balance.'
      : '- No credit or debit notes at this level.',
    menu.allowTdsOnReceipt
      ? '- A receipt may carry "tds_withheld" ("194J" for professional fees, "194C" for contract work) when the customer paid net of TDS on the invoices it settles; otherwise null.'
      : '- "tds_withheld" must be null at this level.',
    '- Reverse charge is decided by the system, never by you: a legal bill from an advocate or law firm, or a goods transport agency, is booked with no vendor GST and the company\'s own RCM journal; still give such a purchase its GST slab in "gst_rate".',
  ];
  return lines.join('\n');
}
