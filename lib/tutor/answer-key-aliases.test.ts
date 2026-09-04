import { describe, expect, it } from 'vitest';
import type { AnswerKey } from '@/lib/schemas/exercise';
import { inheritAccountAliases } from './answer-key-aliases';
import { scoreSubmission } from './score-submission';

const leg = (
  sequence: number,
  account: string,
  drCr: 'Dr' | 'Cr',
  amount: number,
  aliases?: string[],
): AnswerKey['entries'][number] => ({
  sequence,
  correct_account: account,
  dr_cr: drCr,
  amount,
  voucher_type: 'Purchase',
  gst_head: null,
  gst_rate: null,
  tds_section: null,
  tds_rate: null,
  tds_base: null,
  bill_reference: null,
  narration: null,
  concept_tags: ['purchase_voucher_basics' as const],
  requires_source_document: false,
  source_document_type: null,
  ...(aliases ? { account_aliases: aliases } : {}),
});

describe('inheritAccountAliases (Praveen MA/205 + SL/118, 2026-09-04)', () => {
  const aprilPack: AnswerKey = {
    entries: [
      leg(44, 'Legal & Professional Charges', 'Dr', 30000, ['Legal services', 'Professional services']),
      leg(44, 'Sharma Legal', 'Cr', 35400),
    ],
  };
  const september: AnswerKey = {
    entries: [leg(5, 'Legal & Professional Charges', 'Dr', 30000), leg(5, 'Sharma Legal', 'Cr', 30000)],
  };

  it('copies the pack aliases onto a generated key for the same canonical account', () => {
    const merged = inheritAccountAliases(september, [aprilPack, september]);
    expect(merged.entries[0].account_aliases).toEqual(['Legal services', 'Professional services']);
    expect(merged.entries[1].account_aliases).toBeUndefined();
  });

  it('a ledger name April accepted is still accepted in September', () => {
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Purchase',
          date: '20260910',
          narration: 'SL/118 legal services availed',
          ledgerEntries: [
            { ledgerName: 'Legal Services AC', amount: 30000, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'Sharma Legal (individual)', amount: 30000, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const before = scoreSubmission(dayBook, { ledgers: [] }, september);
    expect(before.per_voucher_diffs.some((d) => d.error_code === 'ACCOUNT_WRONG')).toBe(true);
    const after = scoreSubmission(dayBook, { ledgers: [] }, inheritAccountAliases(september, [aprilPack]));
    expect(after.per_voucher_diffs.some((d) => d.error_code === 'ACCOUNT_WRONG')).toBe(false);
  });

  it('returns the key untouched when no learner key carries aliases', () => {
    expect(inheritAccountAliases(september, [september])).toBe(september);
  });
});
