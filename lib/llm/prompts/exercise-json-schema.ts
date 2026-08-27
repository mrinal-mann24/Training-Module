import { CONCEPT_TAGS } from '@/lib/schemas/exercise';
import { SOURCE_DOCUMENT_TYPES } from '@/lib/schemas/source-document';

// Shared JSON Schema for GeneratedExerciseSchema (lib/schemas/exercise.ts),
// used by both the diagnostic prompt (Unit 04) and the adaptive prompt
// (Unit 09) so the two never drift out of sync with each other or with the
// Zod schema they're both validated against afterward.
export const EXERCISE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenario: { type: 'string' },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sequence: { type: 'integer' },
          description: { type: 'string' },
        },
        required: ['sequence', 'description'],
      },
    },
    difficulty_level: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
    variant: { type: 'string', enum: ['A', 'B'] },
    answer_key: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sequence: { type: 'integer' },
              correct_account: { type: 'string' },
              dr_cr: { type: 'string', enum: ['Dr', 'Cr'] },
              amount: { type: 'number' },
              voucher_type: { type: 'string' },
              gst_head: { type: ['string', 'null'], enum: ['CGST', 'SGST', 'IGST', null] },
              gst_rate: { type: ['number', 'null'] },
              tds_section: { type: ['string', 'null'] },
              tds_rate: { type: ['number', 'null'] },
              tds_base: { type: ['number', 'null'] },
              bill_reference: { type: ['string', 'null'] },
              narration: { type: ['string', 'null'] },
              concept_tags: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', enum: [...CONCEPT_TAGS] },
              },
              requires_source_document: { type: 'boolean' },
              source_document_type: { type: ['string', 'null'], enum: [...SOURCE_DOCUMENT_TYPES, null] },
            },
            required: [
              'sequence',
              'correct_account',
              'dr_cr',
              'amount',
              'voucher_type',
              'gst_head',
              'gst_rate',
              'tds_section',
              'tds_rate',
              'tds_base',
              'bill_reference',
              'narration',
              'concept_tags',
              'requires_source_document',
              'source_document_type',
            ],
          },
        },
      },
      required: ['entries'],
    },
  },
  required: ['scenario', 'transactions', 'difficulty_level', 'variant', 'answer_key'],
} as const;
