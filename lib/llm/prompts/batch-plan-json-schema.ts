import { EXERCISE_DIFFICULTY_LEVELS } from '@/lib/schemas/exercise';

// JSON Schema for BatchPlanSchema (lib/schemas/batch-plan.ts), stated by
// hand the way exercise-json-schema.ts is, with additionalProperties false
// everywhere: a model that wants to write a ledger leg, a GST head or a
// bill_reference gets a parse failure, not a wrong key.

const party = {
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string' }, new_party: { type: 'boolean' } },
  required: ['name', 'new_party'],
} as const;

const lines = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { description: { type: 'string' }, quantity: { type: 'number' }, rate: { type: 'number' } },
    required: ['description', 'quantity', 'rate'],
  },
} as const;

const settlement = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['full'] }, bills: { type: 'array', minItems: 1, items: { type: 'string' } } },
      required: ['mode', 'bills'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['part'] }, bill: { type: 'string' }, amount: { type: 'number' } },
      required: ['mode', 'bill', 'amount'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['advance'] }, amount: { type: 'number' } },
      required: ['mode', 'amount'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['on_account'] }, amount: { type: 'number' }, why: { type: 'string' } },
      required: ['mode', 'amount', 'why'],
    },
  ],
} as const;

const seqDay = { seq: { type: 'integer' }, day: { type: 'integer', minimum: 1, maximum: 31 } } as const;

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
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['sale'] },
              ...seqDay,
              customer: party,
              lines,
              gst_rate: { type: 'number' },
              settlement: { type: 'string', enum: ['credit', 'cash', 'adjust_advance'] },
              adjust_advance_ref: { type: ['string', 'null'] },
              doc_number: { type: 'string' },
            },
            required: ['type', 'seq', 'day', 'customer', 'lines', 'gst_rate', 'settlement', 'adjust_advance_ref', 'doc_number'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['purchase'] },
              ...seqDay,
              vendor: party,
              nature: { type: 'string', enum: ['goods', 'service', 'expense', 'asset'] },
              ledger: { type: ['string', 'null'] },
              lines,
              gst_rate: { type: ['number', 'null'] },
              settlement: { type: 'string', enum: ['credit', 'adjust_advance'] },
              adjust_advance_ref: { type: ['string', 'null'] },
              doc_number: { type: 'string' },
            },
            required: ['type', 'seq', 'day', 'vendor', 'nature', 'ledger', 'lines', 'gst_rate', 'settlement', 'adjust_advance_ref', 'doc_number'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['receipt'] },
              ...seqDay,
              customer: party,
              instrument: { type: 'string', enum: ['bank', 'cash'] },
              settlement,
            },
            required: ['type', 'seq', 'day', 'customer', 'instrument', 'settlement'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['payment'] },
              ...seqDay,
              payee: { anyOf: [party, { type: 'null' }] },
              settlement: { anyOf: [settlement, { type: 'null' }] },
              expense_ledger: { type: ['string', 'null'] },
              amount: { type: ['number', 'null'] },
              instrument: { type: 'string', enum: ['bank', 'cash'] },
            },
            required: ['type', 'seq', 'day', 'payee', 'settlement', 'expense_ledger', 'amount', 'instrument'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['contra'] },
              ...seqDay,
              direction: { type: 'string', enum: ['cash_to_bank', 'bank_to_cash'] },
              amount: { type: 'number' },
            },
            required: ['type', 'seq', 'day', 'direction', 'amount'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['depreciation'] },
              ...seqDay,
              asset_ledger: { type: 'string' },
              months: { type: 'integer', minimum: 1, maximum: 12 },
              annual_rate_percent: { type: 'number' },
            },
            required: ['type', 'seq', 'day', 'asset_ledger', 'months', 'annual_rate_percent'],
          },
        ],
      },
    },
  },
  required: ['scenario', 'difficulty_level', 'events'],
} as const;
