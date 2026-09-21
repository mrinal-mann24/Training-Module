import { EXERCISE_DIFFICULTY_LEVELS } from '@/lib/schemas/exercise';

// The wire format of a batch plan: ONE flat event object with nullable
// fields, converted to the typed union of lib/schemas/batch-plan.ts by
// batchPlanFromWire (lib/schemas/batch-plan-wire.ts).
//
// It was a JSON Schema `anyOf` of eight event variants with two nested
// settlement unions until the first dry run against a learner's real books
// (2026-09-22): the provider's strict structured-output compiler refused
// it ("The compiled grammar is too large"), so every planned generation
// would have thrown in production. The legacy exercise schema, which the
// same provider accepts, uses no `anyOf` at all; this one follows it: plain
// objects, `type: [x, 'null']` and enums on non-nullable fields only (the
// provider rejects an enum on a nullable type, so the nullable choice
// fields are plain strings whose values the prompt lists and
// BatchPlanSchema enforces). additionalProperties stays
// false, so a model that wants to write a ledger leg, a GST head or a
// bill_reference still gets a parse failure, not a wrong key.

const nullableString = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;

export const BATCH_PLAN_EVENT_TYPES = ['sale', 'purchase', 'receipt', 'payment', 'contra', 'depreciation', 'credit_note', 'debit_note'] as const;

export const BATCH_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenario: { type: 'string' },
    difficulty_level: { type: 'string', enum: [...EXERCISE_DIFFICULTY_LEVELS] },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: 14,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...BATCH_PLAN_EVENT_TYPES] },
          seq: { type: 'integer' },
          day: { type: 'integer', minimum: 1, maximum: 31 },
          // The customer, vendor or payee; null for a contra, a depreciation
          // and a direct expense payment.
          party: nullableString,
          new_party: { type: 'boolean' },
          // Sale, purchase, credit_note, debit_note; empty otherwise.
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { description: { type: 'string' }, quantity: { type: 'number' }, rate: { type: 'number' } },
              required: ['description', 'quantity', 'rate'],
            },
          },
          gst_rate: nullableNumber,
          // Our invoice number, the vendor's bill number, or the note number.
          doc_number: nullableString,
          // Sale: credit | cash | adjust_advance. Purchase: credit | adjust_advance.
          settlement: nullableString,
          adjust_advance_ref: nullableString,
          // Purchase only.
          nature: nullableString,
          // Purchase: the expense or asset ledger (null for goods). Payment
          // with no party: the expense ledger. Depreciation: the asset ledger.
          ledger: nullableString,
          // Receipt and payment.
          instrument: nullableString,
          settlement_mode: nullableString,
          // Mode full: every bill settled. Mode part: the one bill. Credit
          // and debit notes: the one bill the note is against. Empty otherwise.
          bills: { type: 'array', items: { type: 'string' } },
          // Mode part, advance, on_account; a direct expense payment; a contra.
          amount: nullableNumber,
          // Mode on_account: why no bill can be identified.
          why: nullableString,
          // Receipt: the section under which the customer withheld TDS.
          tds_withheld: nullableString,
          // Contra.
          direction: nullableString,
          // Depreciation.
          months: { type: ['integer', 'null'] },
          annual_rate_percent: nullableNumber,
        },
        required: [
          'type',
          'seq',
          'day',
          'party',
          'new_party',
          'lines',
          'gst_rate',
          'doc_number',
          'settlement',
          'adjust_advance_ref',
          'nature',
          'ledger',
          'instrument',
          'settlement_mode',
          'bills',
          'amount',
          'why',
          'tds_withheld',
          'direction',
          'months',
          'annual_rate_percent',
        ],
      },
    },
  },
  required: ['scenario', 'difficulty_level', 'events'],
} as const;
