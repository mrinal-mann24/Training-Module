import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDayBookXml } from '@/lib/parsing/daybook';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { ParsedTrialBalance } from '@/lib/schemas/voucher';
import { collectErrorCodes, scoreSubmission } from './score-submission';

const sampleDayBookPath = path.resolve(__dirname, '../../xmls/DayBook.xml');

// Worked example built from the real DayBook.xml sample (confirmed by hex/text
// inspection): one Purchase voucher, "Material purchase" Dr 423000, "IGST
// Payable" Dr 21150 (5% of 423000), "Parekh Integrated Services Pvt Ltd" Cr
// 444150. This is the correct posting the answer key below represents.
function correctAnswerKey(): AnswerKey {
  return {
    entries: [
      {
        sequence: 1,
        correct_account: 'Material purchase',
        dr_cr: 'Dr',
        amount: 423000,
        voucher_type: 'Purchase',
        gst_head: 'IGST',
        gst_rate: 5,
        tds_section: null,
        tds_rate: null,
        tds_base: null,
        bill_reference: null,
        narration: 'Received Material in good condition. All terms accepted.',
        concept_tags: ['gst_classification'],
        requires_source_document: false,
        source_document_type: null,
      },
    ],
  };
}

function trialBalanceMatchingAnswerKey(): ParsedTrialBalance {
  return {
    ledgers: [
      { ledgerName: 'Material purchase', closingDebit: 423000, closingCredit: 0 },
      { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
    ],
  };
}

describe('scoreSubmission', () => {
  it('scores the real sample as a clean pass when the answer key matches the posting', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    // Hand-verified: account correct, dr_cr correct, amount correct, voucher_type
    // correct, gst correct (IGST Payable ledger present), tds correct (none
    // expected, none present), bill_reference correct (none expected), and
    // narration present (the sample's NARRATION tag is extracted since the
    // 2026-08-19 parser fix — previously this always reported missing).
    const narrationDiff = result.per_voucher_diffs.find((d) => d.field === 'narration');
    expect(narrationDiff?.is_correct).toBe(true);

    expect(result.per_voucher_diffs.every((d) => d.is_correct)).toBe(true);

    expect(result.tb_tie_out).toBe(true);

    // Weighted score by hand: weights are account=1, dr_cr=1, amount=1,
    // voucher_type=1, gst=2, tds=2, bill_reference=1, narration=1 => total 10.
    // Everything correct => 10/10 = 1.0, a genuinely clean pass.
    expect(result.weighted_score).toBeCloseTo(1.0, 5);
    expect(result.overall_result).toBe('pass');
  });

  it('marks TDS vacuously correct when none is expected and none was posted', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    // correctAnswerKey has tds_section: null and the sample posts no TDS ledger.
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    const tdsDiff = result.per_voucher_diffs.find((d) => d.field === 'tds');
    expect(tdsDiff?.is_correct).toBe(true);
    expect(tdsDiff?.vacuously_correct).toBe(true);
  });

  it('does not mark a genuinely-demonstrated field as vacuously correct', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    // correctAnswerKey expects IGST and the sample actually posts an IGST
    // ledger — real GST handling, so this is an achievement, not a vacuous pass.
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    const gstDiff = result.per_voucher_diffs.find((d) => d.field === 'gst');
    expect(gstDiff?.is_correct).toBe(true);
    expect(gstDiff?.vacuously_correct).toBeFalsy();
  });

  it('still counts a vacuously-correct field toward the weighted score', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    // TDS (weight 2) is vacuously correct here. The clean-pass 1.0 above
    // already includes it — a learner must never be penalized for a field the
    // exercise didn't test.
    expect(result.weighted_score).toBeCloseTo(1.0, 5);
  });

  it('flags DR_CR_REVERSED when the answer key expects the opposite direction', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    answerKey.entries[0].dr_cr = 'Cr';

    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);

    const drCrDiff = result.per_voucher_diffs.find((d) => d.field === 'dr_cr');
    expect(drCrDiff?.is_correct).toBe(false);
    expect(drCrDiff?.error_code).toBe('DR_CR_REVERSED');
  });

  it('flags GST_HEAD_WRONG when the expected head does not match the posted ledger', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    answerKey.entries[0].gst_head = 'CGST';

    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);

    const gstDiff = result.per_voucher_diffs.find((d) => d.field === 'gst');
    expect(gstDiff?.is_correct).toBe(false);
    expect(gstDiff?.error_code).toBe('GST_HEAD_WRONG');
  });

  it('flags ACCOUNT_WRONG when no ledger entry matches the expected account', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    answerKey.entries[0].correct_account = 'Office Supplies';

    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);

    const accountDiff = result.per_voucher_diffs.find((d) => d.field === 'account');
    expect(accountDiff?.is_correct).toBe(false);
    expect(accountDiff?.error_code).toBe('ACCOUNT_WRONG');
  });

  it('flags VOUCHER_MISSING when the answer key expects more vouchers than were submitted', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    answerKey.entries.push({
      sequence: 2,
      correct_account: 'Bank Account',
      dr_cr: 'Cr',
      amount: 10000,
      voucher_type: 'Payment',
      gst_head: null,
      gst_rate: null,
      tds_section: null,
      tds_rate: null,
      tds_base: null,
      bill_reference: null,
      narration: null,
      concept_tags: ['payment_voucher_basics'],
      requires_source_document: false,
      source_document_type: null,
    });

    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);

    const missingVoucherDiff = result.per_voucher_diffs.find((d) => d.voucherRef === 2);
    expect(missingVoucherDiff?.error_code).toBe('VOUCHER_MISSING');
  });

  it('fails Trial Balance tie-out when the parsed TB does not match the correct posting', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const wrongTrialBalance: ParsedTrialBalance = {
      ledgers: [
        { ledgerName: 'Material purchase', closingDebit: 400000, closingCredit: 0 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
      ],
    };

    const result = scoreSubmission(dayBook, wrongTrialBalance, correctAnswerKey());

    expect(result.tb_tie_out).toBe(false);
  });

  // GST/TDS error codes must weight 2x a standard field — verified against a
  // clean baseline: a GST regime error (expected intra-state CGST/SGST,
  // posted IGST — still wrong under the intra-state equivalence rule) costs
  // its double weight, 2/10.
  it('weights a GST error at double weight', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));

    const cleanResult = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    const gstErrorAnswerKey = correctAnswerKey();
    gstErrorAnswerKey.entries[0].gst_head = 'CGST';
    const gstErrorResult = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), gstErrorAnswerKey);

    expect(cleanResult.weighted_score).toBeCloseTo(1.0, 5);
    // GST (weight 2) wrong out of total weight 10 => earned 8/10 = 0.8.
    expect(gstErrorResult.weighted_score).toBeCloseTo(0.8, 5);
    expect(gstErrorResult.weighted_score).toBeLessThan(cleanResult.weighted_score);
  });

  // Unit 09: concept_results rolls per-voucher diffs up to a per-concept
  // pass/fail, the input concept_attempts logging (mastery.ts) reads.
  it('reports concept_results as pass when the transaction is entirely correct', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    // Every scored field on the sample transaction is correct (narration is
    // extracted since the 2026-08-19 parser fix), so the concept passes.
    expect(result.concept_results).toEqual([{ concept_tag: 'gst_classification', result: 'pass' }]);
  });

  it('reports concept_results as fail when any scored field on the transaction is wrong', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    answerKey.entries[0].gst_head = 'CGST';

    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);

    expect(result.concept_results).toEqual([{ concept_tag: 'gst_classification', result: 'fail' }]);
  });

  it('a concept tagged on multiple transactions fails overall if any occurrence fails', () => {
    const dayBook = { vouchers: [
      {
        voucherType: 'Sales',
        date: '20260401',
        narration: 'Being test narration',
        ledgerEntries: [
          { ledgerName: 'Cash', amount: 10000, drOrCr: 'Dr' as const, billAllocations: [] },
          { ledgerName: 'Sales', amount: 10000, drOrCr: 'Cr' as const, billAllocations: [] },
        ],
      },
      {
        voucherType: 'Sales',
        date: '20260402',
        narration: 'Being test narration',
        ledgerEntries: [
          { ledgerName: 'Cash', amount: 5000, drOrCr: 'Dr' as const, billAllocations: [] },
          { ledgerName: 'Wrong Ledger', amount: 5000, drOrCr: 'Cr' as const, billAllocations: [] },
        ],
      },
    ] };

    const answerKey = {
      entries: [
        {
          sequence: 1,
          correct_account: 'Cash',
          dr_cr: 'Dr' as const,
          amount: 10000,
          voucher_type: 'Sales',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: null,
          narration: null,
          concept_tags: ['sales_voucher_basics' as const],
          requires_source_document: false,
          source_document_type: null,
        },
        {
          sequence: 1,
          correct_account: 'Sales',
          dr_cr: 'Cr' as const,
          amount: 10000,
          voucher_type: 'Sales',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: null,
          narration: null,
          concept_tags: ['sales_voucher_basics' as const],
          requires_source_document: false,
          source_document_type: null,
        },
        {
          sequence: 2,
          correct_account: 'Cash',
          dr_cr: 'Dr' as const,
          amount: 5000,
          voucher_type: 'Sales',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: null,
          narration: null,
          concept_tags: ['sales_voucher_basics' as const],
          requires_source_document: false,
          source_document_type: null,
        },
        {
          sequence: 2,
          correct_account: 'Sales',
          dr_cr: 'Cr' as const,
          amount: 5000,
          voucher_type: 'Sales',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: null,
          narration: null,
          concept_tags: ['sales_voucher_basics' as const],
          requires_source_document: false,
          source_document_type: null,
        },
      ],
    };

    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);

    expect(result.concept_results).toEqual([{ concept_tag: 'sales_voucher_basics', result: 'fail' }]);
  });


  // 2026-08-19 engine fixes -------------------------------------------------

  it('accepts SGST-first intra-state postings when the key expects CGST', () => {
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Sales',
          date: '20260405',
          narration: 'Being intra-state sale',
          ledgerEntries: [
            { ledgerName: 'Customer KA', amount: 118000, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'Output SGST', amount: 9000, drOrCr: 'Cr' as const, billAllocations: [] },
            { ledgerName: 'Output CGST', amount: 9000, drOrCr: 'Cr' as const, billAllocations: [] },
            { ledgerName: 'Sales', amount: 100000, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const answerKey = {
      entries: [
        {
          sequence: 1, correct_account: 'Customer KA', dr_cr: 'Dr' as const, amount: 118000,
          voucher_type: 'Sales', gst_head: 'CGST' as const, gst_rate: 18,
          tds_section: null, tds_rate: null, tds_base: null, bill_reference: null,
          narration: 'x', concept_tags: ['gst_classification' as const],
          requires_source_document: false, source_document_type: null,
        },
      ],
    };
    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);
    const gstDiff = result.per_voucher_diffs.find((d) => d.field === 'gst');
    // The SGST ledger precedes CGST, so inference returns SGST — which is the
    // same intra-state regime the key expects. Must NOT be GST_HEAD_WRONG.
    expect(gstDiff?.is_correct).toBe(true);
  });

  it('flags a half-posted intra-state pair (same head twice, other head absent) as GST_MISSING', () => {
    // Real pilot submission HR-118 (2026-08-31): CGST posted twice, SGST
    // never posted. First-match head inference plus CGST~SGST equivalence
    // passed it silently; the split-missed half is Appendix A E05.
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Purchase',
          date: '20260426',
          narration: 'Warehouse rent April',
          ledgerEntries: [
            { ledgerName: 'Hero Rentals', amount: 47200, drOrCr: 'Cr' as const, billAllocations: [] },
            { ledgerName: 'Purchase', amount: 40000, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'CGST', amount: 3600, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'CGST', amount: 3600, drOrCr: 'Dr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const answerKey = {
      entries: [
        {
          sequence: 1, correct_account: 'Hero Rentals', dr_cr: 'Cr' as const, amount: 47200,
          voucher_type: 'Purchase', gst_head: 'CGST' as const, gst_rate: 18,
          tds_section: null, tds_rate: null, tds_base: null, bill_reference: null,
          narration: null, concept_tags: ['gst_classification' as const],
          requires_source_document: false, source_document_type: null,
        },
      ],
    };
    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);
    const gstDiff = result.per_voucher_diffs.find((d) => d.field === 'gst');
    expect(gstDiff?.is_correct).toBe(false);
    expect(gstDiff?.error_code).toBe('GST_MISSING');
  });

  it('does not let a missing transaction steal an unrelated voucher via a generic ledger leg', () => {
    // Pilot 2026-08-31: the AI-201 purchase was never posted, but its answer
    // key group matched an unrelated purchase voucher on the generic
    // "Purchases" leg alone, then flagged that innocent voucher's GST/fields
    // against the wrong key. Generic-leg-only similarity must not pair, and
    // with more vouchers than key transactions there is no positional
    // fallback — the transaction reports VOUCHER_MISSING.
    const unrelatedPurchase = {
      voucherType: 'Purchase',
      date: '20260410',
      narration: 'Some other purchase',
      ledgerEntries: [
        { ledgerName: 'Zeta Suppliers', amount: 59000, drOrCr: 'Cr' as const, billAllocations: [] },
        { ledgerName: 'Purchase', amount: 50000, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'CGST', amount: 4500, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'SGST', amount: 4500, drOrCr: 'Dr' as const, billAllocations: [] },
      ],
    };
    const paymentVoucher = {
      voucherType: 'Payment',
      date: '20260411',
      narration: 'NEFT payment',
      ledgerEntries: [
        { ledgerName: 'Zeta Suppliers', amount: 59000, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'HDFC Bank', amount: 59000, drOrCr: 'Cr' as const, billAllocations: [] },
      ],
    };
    const leg = (sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string, gst: 'IGST' | null = null) => ({
      sequence, correct_account: account, dr_cr: drCr, amount, voucher_type: voucherType,
      gst_head: gst, gst_rate: gst ? 18 : null, tds_section: null, tds_rate: null, tds_base: null,
      bill_reference: null, narration: null, concept_tags: ['purchase_voucher_basics' as const],
      requires_source_document: false, source_document_type: null,
    });
    // One key transaction the learner never posted: Purchases Dr / Ahmedabad
    // Import Cr with IGST. Two submitted vouchers, neither of which is it.
    const answerKey = {
      entries: [
        leg(1, 'Purchases', 'Dr', 90000, 'Purchase', 'IGST'),
        leg(1, 'Ahmedabad Import', 'Cr', 106200, 'Purchase', 'IGST'),
      ],
    };
    const result = scoreSubmission(
      { vouchers: [unrelatedPurchase, paymentVoucher] },
      { ledgers: [] },
      answerKey,
    );
    const missingDiff = result.per_voucher_diffs.find((d) => d.voucherRef === 1);
    expect(missingDiff?.error_code).toBe('VOUCHER_MISSING');
    // Exactly one diff for the missing transaction — no GST/direction/amount
    // flags fabricated against the stolen voucher.
    expect(result.per_voucher_diffs).toHaveLength(1);
  });

  it('matches out-of-order same-day vouchers to the right transactions', () => {
    // Two same-day vouchers posted in the OPPOSITE order from the key.
    const paymentVoucher = {
      voucherType: 'Payment',
      date: '20260405',
      narration: 'Being payment',
      ledgerEntries: [
        { ledgerName: 'Vendor B', amount: 5000, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'Bank', amount: 5000, drOrCr: 'Cr' as const, billAllocations: [] },
      ],
    };
    const receiptVoucher = {
      voucherType: 'Receipt',
      date: '20260405',
      narration: 'Being receipt',
      ledgerEntries: [
        { ledgerName: 'Bank', amount: 8000, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'Customer A', amount: 8000, drOrCr: 'Cr' as const, billAllocations: [] },
      ],
    };
    const leg = (sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string) => ({
      sequence, correct_account: account, dr_cr: drCr, amount, voucher_type: voucherType,
      gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
      bill_reference: null, narration: 'x', concept_tags: ['receipt_voucher_basics' as const],
      requires_source_document: false, source_document_type: null,
    });
    const answerKey = {
      entries: [
        leg(1, 'Bank', 'Dr', 8000, 'Receipt'), leg(1, 'Customer A', 'Cr', 8000, 'Receipt'),
        leg(2, 'Vendor B', 'Dr', 5000, 'Payment'), leg(2, 'Bank', 'Cr', 5000, 'Payment'),
      ],
    };
    // Positional matching would score both vouchers against the wrong key.
    const result = scoreSubmission({ vouchers: [paymentVoucher, receiptVoucher] }, { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.filter((d) => d.field === 'account').every((d) => d.is_correct)).toBe(true);
    expect(result.per_voucher_diffs.filter((d) => d.field === 'voucher_type').every((d) => d.is_correct)).toBe(true);
  });

  it('includes opening balances in the Trial Balance tie-out', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = { ...correctAnswerKey(), opening_balances: [
      { account: 'Material purchase', dr_cr: 'Dr' as const, amount: 50000 },
    ] };
    // Closing must now be opening 50,000 + movement 4,23,000 = 4,73,000 — the
    // movements-only TB from the base fixture no longer ties out...
    expect(scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey).tb_tie_out).toBe(false);
    // ...and a TB carrying the opening-inclusive closing does.
    const openingAwareTb = {
      ledgers: [
        { ledgerName: 'Material purchase', closingDebit: 473000, closingCredit: 0 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
      ],
    };
    expect(scoreSubmission(dayBook, openingAwareTb, answerKey).tb_tie_out).toBe(true);
  });

  it('exempts GST/TDS-named accounts from tie-out and tolerates settled zero-balance accounts', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    // A GST-named leg whose balance the learner's TB will never carry this
    // way (head-wise ledgers), plus a fully-settled account absent from TB.
    answerKey.entries.push(
      { ...answerKey.entries[0], sequence: 1, correct_account: 'Output GST', dr_cr: 'Dr', amount: 999999 },
      { ...answerKey.entries[0], sequence: 1, correct_account: 'Settled Vendor', dr_cr: 'Dr', amount: 1000 },
      { ...answerKey.entries[0], sequence: 1, correct_account: 'Settled Vendor', dr_cr: 'Cr', amount: 1000 },
    );
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);
    expect(result.tb_tie_out).toBe(true);
  });

  it('accepts alias, containment, and typo ledger names (pilot calibration)', () => {
    const voucher = (ledgerName: string) => ({
      vouchers: [
        {
          voucherType: 'Purchase',
          date: '20260405',
          narration: 'x',
          ledgerEntries: [
            { ledgerName, amount: 100, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'Some Vendor', amount: 100, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    });
    const key = (aliases: string[]) => ({
      entries: [
        {
          sequence: 1, correct_account: 'Purchases', account_aliases: aliases, dr_cr: 'Dr' as const,
          amount: 100, voucher_type: 'Purchase', gst_head: null, gst_rate: null,
          tds_section: null, tds_rate: null, tds_base: null, bill_reference: null,
          narration: null, concept_tags: ['purchase_voucher_basics' as const],
          requires_source_document: false, source_document_type: null,
        },
        {
          sequence: 1, correct_account: 'Some Vendor', dr_cr: 'Cr' as const,
          amount: 100, voucher_type: 'Purchase', gst_head: null, gst_rate: null,
          tds_section: null, tds_rate: null, tds_base: null, bill_reference: null,
          narration: null, concept_tags: ['purchase_voucher_basics' as const],
          requires_source_document: false, source_document_type: null,
        },
      ],
    });
    const accountOk = (dayBook: Parameters<typeof scoreSubmission>[0], answerKey: AnswerKey) =>
      scoreSubmission(dayBook, { ledgers: [] }, answerKey)
        .per_voucher_diffs.filter((d) => d.field === 'account')
        .every((d) => d.is_correct);

    // Alias: register-nature naming accepted via account_aliases.
    expect(accountOk(voucher('Trading goods'), key(['Trading goods']))).toBe(true);
    // Containment: "Purchase A/c" embeds "purchase"-stem naming.
    expect(accountOk(voucher('Purchases A/c'), key([]))).toBe(true);
    // Typo tolerance: a real ledger name from the pilot submission.
    expect(accountOk(voucher('Purchsaes'), key([]))).toBe(true);
    // A genuinely different account still fails.
    expect(accountOk(voucher('Office Equipment'), key([]))).toBe(false);
  });

  it('collectErrorCodes extracts only the non-null error codes', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));

    // Clean pass (narration extracted since the 2026-08-19 parser fix): no
    // error codes at all.
    const cleanResult = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());
    expect(collectErrorCodes(cleanResult)).toEqual([]);

    // A genuine error still comes through as its code alone.
    const gstErrorAnswerKey = correctAnswerKey();
    gstErrorAnswerKey.entries[0].gst_head = 'CGST';
    const gstErrorResult = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), gstErrorAnswerKey);
    expect(collectErrorCodes(gstErrorResult)).toEqual(['GST_HEAD_WRONG']);
  });

  // Real generated answer keys are full double-entry: two entries sharing the
  // same sequence (a Dr leg + a Cr leg), not one entry per voucher. Confirmed
  // against a live-generated diagnostic exercise's actual answer_key shape.
  // This must diff BOTH legs against the matching voucher's two ledger
  // entries, not just the first leg that happens to match.
  describe('double-entry answer keys (two legs per sequence)', () => {
    function twoLegAnswerKey(): AnswerKey {
      return {
        entries: [
          {
            sequence: 1,
            correct_account: 'Cash',
            dr_cr: 'Dr',
            amount: 10000,
            voucher_type: 'Sales',
            gst_head: null,
            gst_rate: null,
            tds_section: null,
            tds_rate: null,
            tds_base: null,
            bill_reference: null,
            narration: null,
            concept_tags: ['sales_voucher_basics'],
            requires_source_document: false,
            source_document_type: null,
          },
          {
            sequence: 1,
            correct_account: 'Sales',
            dr_cr: 'Cr',
            amount: 10000,
            voucher_type: 'Sales',
            gst_head: null,
            gst_rate: null,
            tds_section: null,
            tds_rate: null,
            tds_base: null,
            bill_reference: null,
            narration: null,
            concept_tags: ['sales_voucher_basics'],
            requires_source_document: false,
            source_document_type: null,
          },
        ],
      };
    }

    function dayBookMatchingBothLegs() {
      return {
        vouchers: [
          {
            voucherType: 'Sales',
            date: '20260401',
            narration: 'Being test narration',
            ledgerEntries: [
              { ledgerName: 'Cash', amount: 10000, drOrCr: 'Dr' as const, billAllocations: [] },
              { ledgerName: 'Sales', amount: 10000, drOrCr: 'Cr' as const, billAllocations: [] },
            ],
          },
        ],
      };
    }

    it('scores both legs correct when the voucher posts both ledger lines correctly', () => {
      const result = scoreSubmission(dayBookMatchingBothLegs(), { ledgers: [] }, twoLegAnswerKey());

      const accountDiffs = result.per_voucher_diffs.filter((d) => d.field === 'account');
      expect(accountDiffs).toHaveLength(2);
      expect(accountDiffs.every((d) => d.is_correct)).toBe(true);
    });

    it('flags only the wrong leg when one of the two legs is posted to the wrong account', () => {
      const dayBook = dayBookMatchingBothLegs();
      dayBook.vouchers[0].ledgerEntries[1].ledgerName = 'Miscellaneous Income';

      const result = scoreSubmission(dayBook, { ledgers: [] }, twoLegAnswerKey());

      const accountDiffs = result.per_voucher_diffs.filter((d) => d.field === 'account');
      expect(accountDiffs).toHaveLength(2);
      expect(accountDiffs.filter((d) => d.is_correct)).toHaveLength(1);
      expect(accountDiffs.filter((d) => !d.is_correct)).toHaveLength(1);
    });

    it('does not let one correct leg mask the other leg being wrong (the original bug)', () => {
      // Before the fix, only the FIRST matching ledger entry was ever checked
      // per voucher, so a correct Cash leg would mask an entirely wrong second
      // leg. Here the Cash leg is correct but Sales was mis-posted as Discount
      // Given with the wrong Dr/Cr direction — this must be caught.
      const dayBook = dayBookMatchingBothLegs();
      dayBook.vouchers[0].ledgerEntries[1] = {
        ledgerName: 'Discount Given',
        amount: 10000,
        drOrCr: 'Dr',
        billAllocations: [],
      };

      const result = scoreSubmission(dayBook, { ledgers: [] }, twoLegAnswerKey());

      const accountDiffs = result.per_voucher_diffs.filter((d) => d.field === 'account');
      const wrongLegDiffs = accountDiffs.filter((d) => !d.is_correct);
      expect(wrongLegDiffs).toHaveLength(1);
      expect(wrongLegDiffs[0].error_code).toBe('ACCOUNT_WRONG');
    });

    it('maps a second transaction to the second voucher, not an out-of-range index', () => {
      // 2 transactions x 2 legs = 4 answer key entries, but only 2 vouchers.
      // Grouping by sequence must produce exactly 2 transaction groups.
      const answerKey = twoLegAnswerKey();
      answerKey.entries.push(
        {
          sequence: 2,
          correct_account: 'Office Supplies',
          dr_cr: 'Dr',
          amount: 2000,
          voucher_type: 'Purchase',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: null,
          narration: null,
          concept_tags: ['purchase_voucher_basics'],
          requires_source_document: false,
          source_document_type: null,
        },
        {
          sequence: 2,
          correct_account: 'Creditors (Supplier B)',
          dr_cr: 'Cr',
          amount: 2000,
          voucher_type: 'Purchase',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: null,
          narration: null,
          concept_tags: ['purchase_voucher_basics'],
          requires_source_document: false,
          source_document_type: null,
        },
      );

      const dayBook = dayBookMatchingBothLegs();
      dayBook.vouchers.push({
        voucherType: 'Purchase',
        date: '20260402',
        narration: 'Being test narration',
        ledgerEntries: [
          { ledgerName: 'Office Supplies', amount: 2000, drOrCr: 'Dr' as const, billAllocations: [] },
          { ledgerName: 'Creditors (Supplier B)', amount: 2000, drOrCr: 'Cr' as const, billAllocations: [] },
        ],
      });

      const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);

      const voucherRefs = [...new Set(result.per_voucher_diffs.map((d) => d.voucherRef))];
      expect(voucherRefs.sort()).toEqual([1, 2]);

      const missingDiffs = result.per_voucher_diffs.filter((d) => d.error_code === 'VOUCHER_MISSING');
      expect(missingDiffs).toHaveLength(0);

      const accountDiffs = result.per_voucher_diffs.filter((d) => d.field === 'account');
      expect(accountDiffs.every((d) => d.is_correct)).toBe(true);
    });
  });
});

describe('voucher-type-aware narration (Phase 3, spec 15)', () => {
  const makeDayBook = (voucherType: string, narration: string, partyLedger = 'Parekh Integrated Services Pvt Ltd') => ({
    vouchers: [
      {
        voucherType,
        date: '20260405',
        narration,
        ledgerEntries: [
          { ledgerName: partyLedger, amount: 5000, drOrCr: 'Dr' as const, billAllocations: [] },
          { ledgerName: 'HDFC Bank', amount: 5000, drOrCr: 'Cr' as const, billAllocations: [] },
        ],
      },
    ],
  });
  const makeKey = (voucherType: string, partyLedger = 'Parekh Integrated Services Pvt Ltd') => ({
    entries: [
      {
        sequence: 1, correct_account: partyLedger, dr_cr: 'Dr' as const, amount: 5000,
        voucher_type: voucherType, gst_head: null, gst_rate: null, tds_section: null,
        tds_rate: null, tds_base: null, bill_reference: null, narration: 'required',
        concept_tags: ['payment_voucher_basics' as const],
        requires_source_document: false, source_document_type: null,
      },
      {
        sequence: 1, correct_account: 'HDFC Bank', dr_cr: 'Cr' as const, amount: 5000,
        voucher_type: voucherType, gst_head: null, gst_rate: null, tds_section: null,
        tds_rate: null, tds_base: null, bill_reference: null, narration: null,
        concept_tags: ['payment_voucher_basics' as const],
        requires_source_document: false, source_document_type: null,
      },
    ],
  });
  const narrationDiff = (voucherType: string, narration: string, partyLedger?: string) =>
    scoreSubmission(makeDayBook(voucherType, narration, partyLedger), { ledgers: [] }, makeKey(voucherType, partyLedger))
      .per_voucher_diffs.find((d) => d.field === 'narration');

  it('passes a payment narration carrying reference and party', () => {
    const diff = narrationDiff('Payment', 'NEFT UTR 123456789 paid to Parekh against INV-012');
    expect(diff?.is_correct).toBe(true);
    expect(diff?.error_code).toBe(null);
  });

  it('flags a payment narration with a reference but no party as NARRATION_WEAK', () => {
    const diff = narrationDiff('Payment', 'Being payment made, ref 123456');
    expect(diff?.is_correct).toBe(false);
    expect(diff?.error_code).toBe('NARRATION_WEAK');
  });

  it('flags a receipt narration with a party but no reference-like token', () => {
    const diff = narrationDiff('Receipt', 'Amount received from Parekh in full settlement');
    expect(diff?.is_correct).toBe(false);
    expect(diff?.error_code).toBe('NARRATION_WEAK');
  });

  it('does not demand a party when the voucher has no party-like ledger', () => {
    // A bank-charge payment: Bank Charges + HDFC Bank. Nothing to name, so
    // the reference alone satisfies the standard.
    const diff = narrationDiff('Payment', 'Bank charges for May, ref 445566', 'Bank Charges');
    expect(diff?.is_correct).toBe(true);
  });

  it('keeps sales narration presence-only', () => {
    const diff = narrationDiff('Sales', 'Being goods sold');
    expect(diff?.is_correct).toBe(true);
  });

  it('flags a trivial journal narration and passes a real why', () => {
    expect(narrationDiff('Journal', 'ok done')?.error_code).toBe('NARRATION_WEAK');
    expect(narrationDiff('Journal', 'Being provision for audit fees for FY 2026-27')?.is_correct).toBe(true);
  });

  it('accepts the party as a bank-style abbreviation inside the reference (pilot calibration)', () => {
    // Real pilot narration shape: "UPI/26040301/KAREMP/MARCH-INV" for a
    // receipt from Karnataka Emporium. The reviewer accepted these.
    const diff = narrationDiff('Receipt', 'UPI/26040301/KAREMP/MARCH-INV', 'Karnataka Emporium');
    expect(diff?.is_correct).toBe(true);
  });

  it('does not demand a bank reference on a cash payment', () => {
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Payment',
          date: '20260405',
          narration: 'Cash purchase packaging material, KRISHNA PACKERS',
          ledgerEntries: [
            { ledgerName: 'Krishna Packers', amount: 500, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'Cash', amount: 500, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const diff = scoreSubmission(dayBook, { ledgers: [] }, makeKey('Payment', 'Krishna Packers'))
      .per_voucher_diffs.find((d) => d.field === 'narration');
    expect(diff?.is_correct).toBe(true);
  });

  it('still reports a wholly absent narration as NARRATION_MISSING', () => {
    const diff = narrationDiff('Payment', '   ');
    expect(diff?.error_code).toBe('NARRATION_MISSING');
  });
});

describe('Trial Balance tie-out account matching (2026-09-02)', () => {
  const leg = (
    sequence: number,
    account: string,
    drCr: 'Dr' | 'Cr',
    amount: number,
  ) => ({
    sequence, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Sales',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: null, narration: null, concept_tags: ['sales_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
  });

  it('does not let a short account name swallow a longer, different one', () => {
    // "Sales" matched BOTH "Sales" and "Sales Returns" through containment,
    // so each account was compared against the sum of the two and tie-out
    // could never succeed for any submission using a returns ledger.
    const answerKey = {
      entries: [
        leg(1, 'Customer A', 'Dr', 85000),
        leg(1, 'Sales', 'Cr', 100000),
        leg(1, 'Sales Returns', 'Dr', 15000),
      ],
    };
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Sales', date: '20260504', narration: 'Being the sale',
          ledgerEntries: [
            { ledgerName: 'Customer A', amount: 85000, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'Sales', amount: 100000, drOrCr: 'Cr' as const, billAllocations: [] },
            { ledgerName: 'Sales Returns', amount: 15000, drOrCr: 'Dr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const trialBalance = {
      ledgers: [
        { ledgerName: 'Customer A', closingDebit: 85000, closingCredit: 0 },
        { ledgerName: 'Sales', closingDebit: 0, closingCredit: 100000 },
        { ledgerName: 'Sales Returns', closingDebit: 15000, closingCredit: 0 },
      ],
    };

    expect(scoreSubmission(dayBook, trialBalance, answerKey).tb_tie_out).toBe(true);
  });

  it('still sums a genuinely split account when no exact row exists', () => {
    // The behaviour the containment rule exists for: the learner split one
    // logical "Sales" across two ledgers of their own naming.
    const answerKey = {
      entries: [leg(1, 'Customer A', 'Dr', 100000), leg(1, 'Sales', 'Cr', 100000)],
    };
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Sales', date: '20260504', narration: 'Being the sale',
          ledgerEntries: [
            { ledgerName: 'Customer A', amount: 100000, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'Sales', amount: 100000, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const trialBalance = {
      ledgers: [
        { ledgerName: 'Customer A', closingDebit: 100000, closingCredit: 0 },
        { ledgerName: 'Credit Sales A/c', closingDebit: 0, closingCredit: 60000 },
        { ledgerName: 'Cash Sales A/c', closingDebit: 0, closingCredit: 40000 },
      ],
    };

    expect(scoreSubmission(dayBook, trialBalance, answerKey).tb_tie_out).toBe(true);
  });
});

describe('scorer fairness fixes from Garima Level 2 (2026-09-02)', () => {
  const leg = (
    sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number,
    extra: Partial<AnswerKey['entries'][number]> = {},
  ): AnswerKey['entries'][number] => ({
    sequence, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Sales',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: null, narration: null, concept_tags: ['gst_classification' as const],
    requires_source_document: false, source_document_type: null, ...extra,
  });

  it('reads the GST expectation from whichever leg carries it, not just the first leg', () => {
    // Generated keys put gst_head on the tax leg only; the party leg says
    // null. Reading legs[0] declared "no GST expected" and flagged a correct
    // IGST posting as GST_UNEXPECTED.
    const answerKey = {
      entries: [
        leg(1, 'Rajasthan Home Decor', 'Dr', 94400),
        leg(1, 'Sales', 'Cr', 80000),
        leg(1, 'Output IGST', 'Cr', 14400, { gst_head: 'IGST', gst_rate: 18 }),
      ],
    };
    const dayBook = { vouchers: [{
      voucherType: 'Sales', date: '20260505', narration: 'Sold goods',
      ledgerEntries: [
        { ledgerName: 'Rajasthan Home Decor', amount: 94400, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'Sales', amount: 80000, drOrCr: 'Cr' as const, billAllocations: [] },
        { ledgerName: 'IGST', amount: 14400, drOrCr: 'Cr' as const, billAllocations: [] },
      ],
    }] };
    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);
    const gst = result.per_voucher_diffs.find((d) => d.field === 'gst');
    expect(gst?.is_correct).toBe(true);
    expect(gst?.error_code).toBeNull();
    // ...and the plain "IGST" ledger satisfies the "Output IGST" tax leg.
    expect(result.per_voucher_diffs.filter((d) => d.field === 'account').every((d) => d.is_correct)).toBe(true);
  });

  it('matches a bill reference regardless of "(New Ref)" / "Against ... (Partial)" annotations', () => {
    const answerKey = {
      entries: [
        leg(1, 'Rajasthan Home Decor', 'Dr', 60000, { voucher_type: 'Receipt', bill_reference: 'Against BR-205 (Partial)' }),
        leg(1, 'HDFC Bank — 1234', 'Cr', 60000, { voucher_type: 'Receipt', bill_reference: 'Against BR-205 (Partial)' }),
      ],
    };
    const dayBook = { vouchers: [{
      voucherType: 'Receipt', date: '20260514', narration: 'UPI/26051401/RAJHOME/PMT received from Rajasthan Home Decor',
      ledgerEntries: [
        { ledgerName: 'Rajasthan Home Decor', amount: 60000, drOrCr: 'Dr' as const, billAllocations: [{ name: 'BR-205', amount: 60000 }] },
        { ledgerName: 'HDFC Bank — 1234', amount: 60000, drOrCr: 'Cr' as const, billAllocations: [] },
      ],
    }] };
    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.find((d) => d.field === 'bill_reference')?.is_correct).toBe(true);
  });

  it('still rejects a genuinely wrong bill reference', () => {
    const answerKey = {
      entries: [leg(1, 'Deccan Traders', 'Dr', 40000, { voucher_type: 'Payment', bill_reference: 'Against DT-114 (Partial)' })],
    };
    const dayBook = { vouchers: [{
      voucherType: 'Payment', date: '20260518', narration: 'NEFT/N26051801/DECCAN/PMT to Deccan Traders',
      ledgerEntries: [{ ledgerName: 'Deccan Traders', amount: 40000, drOrCr: 'Dr' as const, billAllocations: [{ name: 'DT-115', amount: 40000 }] }],
    }] };
    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.find((d) => d.field === 'bill_reference')?.error_code).toBe('BILL_REFERENCE_WRONG');
  });
});

describe('multi-rate invoices: consolidated vs split GST lines (Garima Level 3 Tx 7, 2026-09-02)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, gst: 'CGST' | 'SGST' | null = null, rate: number | null = null): AnswerKey['entries'][number] => ({
    sequence: 1, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Sales',
    gst_head: gst, gst_rate: rate, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: 'MD-142', narration: null, concept_tags: ['gst_classification' as const],
    requires_source_document: false, source_document_type: null,
  });
  // Furniture 30,000 @ 9%+9% and packing 10,000 @ 6%+6% on one invoice: the
  // key carries two CGST legs and two SGST legs.
  const answerKey = { entries: [
    leg('Mysore Decor', 'Dr', 46600), leg('Sales', 'Cr', 40000),
    leg('Output CGST', 'Cr', 2700, 'CGST', 18), leg('Output SGST', 'Cr', 2700, 'SGST', 18),
    leg('Output CGST', 'Cr', 600, 'CGST', 12), leg('Output SGST', 'Cr', 600, 'SGST', 12),
  ] };
  const voucher = (lines: [string, number][]) => ({ vouchers: [{
    voucherType: 'Sales', date: '20260612', narration: 'Sold furniture and packing to Mysore Decor, Invoice MD-142',
    ledgerEntries: lines.map(([name, amount]) => ({
      ledgerName: name, amount, drOrCr: (name === 'Mysore Decor' ? 'Dr' : 'Cr') as 'Dr' | 'Cr',
      billAllocations: name === 'Mysore Decor' ? [{ name: 'MD-142', amount }] : [],
    })),
  }] });

  it('accepts the way Tally shows it: one combined CGST line and one SGST line', () => {
    const result = scoreSubmission(voucher([['Mysore Decor', 46600], ['Sales', 40000], ['CGST', 3300], ['SGST', 3300]]), { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
    expect(result.weighted_score).toBeCloseTo(1.0, 5);
  });

  it('equally accepts the split posting with a line per rate', () => {
    const result = scoreSubmission(voucher([['Mysore Decor', 46600], ['Sales', 40000], ['CGST', 2700], ['SGST', 2700], ['CGST', 600], ['SGST', 600]]), { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
  });

  it('still catches a missing SGST when CGST was posted twice', () => {
    const result = scoreSubmission(voucher([['Mysore Decor', 46600], ['Sales', 40000], ['CGST', 3300], ['CGST', 3300]]), { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.some((d) => d.error_code === 'GST_MISSING' || d.error_code === 'ACCOUNT_WRONG')).toBe(true);
  });
});

describe('bill reference with a comma inside the annotation (Praveen Level 2 key format)', () => {
  it('matches KE/2026/018 when the key says "KE/2026/018 (part payment, Rs 30,000 balance outstanding)"', () => {
    const answerKey = {
      entries: [
        {
          sequence: 1,
          correct_account: 'Karnataka Emporium',
          dr_cr: 'Cr' as const,
          amount: 45000,
          voucher_type: 'Receipt',
          gst_head: null,
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: 'KE/2026/018 (part payment, ₹30,000 balance outstanding)',
          narration: null,
          concept_tags: ['bill_by_bill_referencing' as const],
          requires_source_document: true,
          source_document_type: 'bank_statement' as const,
        },
      ],
    };
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Receipt',
          date: '20260514',
          narration: 'NEFT/N26050114/KARNATAKA EMPORIUM/KE/2026/018 - Karnataka Emporium',
          ledgerEntries: [
            { ledgerName: 'Karnataka Emporium', amount: 45000, drOrCr: 'Cr' as const, billAllocations: [{ name: 'KE/2026/018', amount: 45000 }] },
          ],
        },
      ],
    };
    const result = scoreSubmission(dayBook, { ledgers: [] }, answerKey);
    expect(result.per_voucher_diffs.find((d) => d.field === 'bill_reference')?.is_correct).toBe(true);
  });
});
