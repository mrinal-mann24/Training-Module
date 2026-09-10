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
    // Narration is not scored (2026-09-10): no narration diff at all.
    expect(result.per_voucher_diffs.some((d) => d.field === 'narration')).toBe(false);

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
    // GST (weight 2) wrong out of total weight 9 (narration no longer
    // scored, 2026-09-10) => earned 7/9.
    expect(gstErrorResult.weighted_score).toBeCloseTo(7 / 9, 5);
    expect(gstErrorResult.weighted_score).toBeLessThan(cleanResult.weighted_score);
  });

  // Unit 09: concept_results rolls per-voucher diffs up to a per-concept
  // pass/fail, the input concept_attempts logging (mastery.ts) reads.
  it('reports concept_results as pass when the transaction is entirely correct', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), correctAnswerKey());

    // Every scored field on the sample transaction is correct (narration is
    // extracted since the 2026-08-19 parser fix), so the concept passes.
    expect(result.concept_results).toEqual([
      { concept_tag: 'gst_classification', result: 'pass' },
      { concept_tag: 'trial_balance_tie_out', result: 'pass' },
    ]);
  });

  it('reports concept_results as fail when any scored field on the transaction is wrong', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const answerKey = correctAnswerKey();
    answerKey.entries[0].gst_head = 'CGST';

    const result = scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), answerKey);

    expect(result.concept_results).toEqual([
      { concept_tag: 'gst_classification', result: 'fail' },
      { concept_tag: 'trial_balance_tie_out', result: 'pass' },
    ]);
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

    expect(result.concept_results).toEqual([
      { concept_tag: 'sales_voucher_basics', result: 'fail' },
      // An empty Trial Balance export never ties out.
      { concept_tag: 'trial_balance_tie_out', result: 'fail' },
    ]);
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

describe('ledger names: same head, different wording (Praveen Level 4, 2026-09-03)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number): AnswerKey['entries'][number] => ({
    sequence: 1, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Payment',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: null, narration: null, concept_tags: ['payment_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
  });
  const score = (posted: string, expected: string) => {
    const result = scoreSubmission(
      { vouchers: [{ voucherType: 'Payment', date: '20260709', narration: 'NEFT UTR HDFC0N330421', ledgerEntries: [
        { ledgerName: posted, amount: 28000, drOrCr: 'Dr' as const, billAllocations: [] },
        { ledgerName: 'HDFC Bank - 1234', amount: 28000, drOrCr: 'Cr' as const, billAllocations: [] },
      ] }] },
      { ledgers: [] },
      { entries: [leg(expected, 'Dr', 28000), leg('HDFC Bank — 1234', 'Cr', 28000)] },
    );
    return result.per_voucher_diffs.filter((d) => d.field === 'account').every((d) => d.is_correct);
  };

  it('accepts the learner\'s wording for the same expense head', () => {
    expect(score('Office Rent', 'Rent')).toBe(true);
    expect(score('Electricity Bill', 'Electricity Charges')).toBe(true);
    expect(score('SALARY AC', 'Salaries')).toBe(true);
    expect(score('Rent A/c', 'Rent')).toBe(true);
  });

  it('still rejects a genuinely different ledger', () => {
    expect(score('Petty Cash', 'Cash')).toBe(false);
    expect(score('Warehouse Rent AC', 'Office Rent')).toBe(false);
    expect(score('Sales Returns', 'Sales')).toBe(false);
    expect(score('Kolkata Emporium', 'Karnataka Emporium')).toBe(false);
  });
});

describe('ledger name typo tolerance on long names (Praveen Level 3 "Office Maintanece", 2026-09-03)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number): AnswerKey['entries'][number] => ({
    sequence: 1, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Payment',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: null, narration: null, concept_tags: ['payment_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
  });
  const accountOk = (posted: string, expected: string) => scoreSubmission(
    { vouchers: [{ voucherType: 'Payment', date: '20260613', narration: 'paid in cash', ledgerEntries: [
      { ledgerName: posted, amount: 3500, drOrCr: 'Dr' as const, billAllocations: [] },
      { ledgerName: 'Cash', amount: 3500, drOrCr: 'Cr' as const, billAllocations: [] },
    ] }] },
    { ledgers: [] },
    { entries: [leg(expected, 'Dr', 3500), leg('Cash', 'Cr', 3500)] },
  ).per_voucher_diffs.filter((d) => d.field === 'account').every((d) => d.is_correct);

  it('accepts a three-edit misspelling of a long ledger name', () => {
    expect(accountOk('Office Maintanece', 'Office Maintenance')).toBe(true);
  });

  it('still rejects a different long party name', () => {
    expect(accountOk('Kolkata Emporium', 'Karnataka Emporium')).toBe(false);
    expect(accountOk('Chennai Home Store', 'Chennai Suppliers')).toBe(false);
  });
});

describe('bill reference carried on the party leg only (Praveen Level 6, 2026-09-03)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, ref: string | null): AnswerKey['entries'][number] => ({
    sequence: 1, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Purchase',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: ref, narration: null, concept_tags: ['purchase_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
  });
  const key = { entries: [leg('Purchases', 'Dr', 40000, null), leg('Mumbai Suppliers', 'Cr', 40000, 'MS/812')] };
  const voucher = (billName: string) => ({ vouchers: [{ voucherType: 'Purchase', date: '20260902', narration: 'Purchase from Mumbai Suppliers',
    ledgerEntries: [
      { ledgerName: 'Purchases', amount: 40000, drOrCr: 'Dr' as const, billAllocations: [] },
      { ledgerName: 'Mumbai Suppliers', amount: 40000, drOrCr: 'Cr' as const, billAllocations: [{ name: billName, amount: 40000 }] },
    ] }] });
  it('checks the allocation even though the first leg has no reference', () => {
    expect(scoreSubmission(voucher('MS/812'), { ledgers: [] }, key).per_voucher_diffs.find((d) => d.field === 'bill_reference')?.is_correct).toBe(true);
    expect(scoreSubmission(voucher('MS/999'), { ledgers: [] }, key).per_voucher_diffs.find((d) => d.field === 'bill_reference')?.error_code).toBe('BILL_REFERENCE_WRONG');
  });
});

describe('matcher: one missing voucher must not cascade (Garima Level 4, 2026-09-03)', () => {
  const leg = (sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string): AnswerKey['entries'][number] => ({
    sequence, correct_account: account, dr_cr: drCr, amount, voucher_type: voucherType,
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: null, narration: null, concept_tags: ['payment_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
  });
  const key = { entries: [
    leg(1, 'Mumbai Suppliers', 'Dr', 50000, 'Payment'), leg(1, 'HDFC Bank — 1234', 'Cr', 50000, 'Payment'),
    leg(2, 'HDFC Bank — 1234', 'Dr', 35100, 'Receipt'), leg(2, 'Karnataka Emporium', 'Cr', 35100, 'Receipt'),
    leg(3, 'Chennai Suppliers', 'Dr', 20000, 'Payment'), leg(3, 'HDFC Bank — 1234', 'Cr', 20000, 'Payment'),
  ] };
  const voucher = (type: string, entries: [string, number, 'Dr' | 'Cr'][]) => ({ voucherType: type, date: '20260714', narration: 'ok', ledgerEntries: entries.map(([n, a, d]) => ({ ledgerName: n, amount: a, drOrCr: d, billAllocations: [] })) });
  // Transaction 1 (Mumbai payment) was never posted.
  const dayBook = { vouchers: [
    voucher('Receipt', [['HDFC BANK', 35100, 'Dr'], ['Karnataka Emporium', 35100, 'Cr']]),
    voucher('Payment', [['Chennai Suppliers', 20000, 'Dr'], ['HDFC BANK', 20000, 'Cr']]),
  ] };
  it('reports only the missing voucher; the others still match on evidence', () => {
    const result = scoreSubmission(dayBook, { ledgers: [] }, key);
    const wrong = result.per_voucher_diffs.filter((d) => !d.is_correct && d.error_code).map((d) => `${d.voucherRef}:${d.error_code}`);
    expect(wrong).toEqual(['1:VOUCHER_MISSING']);
  });
});


describe('concept rollup judges each concept on its own fields (Yeshas June, 2026-09-04)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number): AnswerKey['entries'][number] => ({
    sequence: 9, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Payment',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: 'MS-B3', narration: 'Payment to Mumbai Suppliers against MS-B3 by NEFT',
    concept_tags: ['payment_voucher_basics' as const, 'bill_by_bill_referencing' as const, 'narration_discipline' as const],
    requires_source_document: false, source_document_type: null,
  });
  const key: AnswerKey = { entries: [leg('Mumbai Suppliers', 'Dr', 51500), leg('HDFC Bank — 1234', 'Cr', 51500)] };
  const dayBook = { vouchers: [{ voucherType: 'Payment', date: '20260611', narration: 'paid', ledgerEntries: [
    { ledgerName: 'Mumbai Suppliers', amount: 51500, drOrCr: 'Dr' as const, billAllocations: [{ name: 'MS-B3', amount: 51500 }] },
    { ledgerName: 'HDFC Bank 1234', amount: 51500, drOrCr: 'Cr' as const, billAllocations: [] },
  ] }] };

  it('a thin narration costs nothing and the retired narration concept is never reported (2026-09-10)', () => {
    const result = scoreSubmission(dayBook, { ledgers: [] }, key);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
    expect(result.concept_results).toEqual([
      { concept_tag: 'payment_voucher_basics', result: 'pass' },
      { concept_tag: 'bill_by_bill_referencing', result: 'pass' },
      { concept_tag: 'trial_balance_tie_out', result: 'fail' },
    ]);
  });

  it('a missing voucher still fails the voucher-basics concept', () => {
    const result = scoreSubmission({ vouchers: [] }, { ledgers: [] }, key);
    expect(result.concept_results.find((c) => c.concept_tag === 'payment_voucher_basics')?.result).toBe('fail');
  });
});

// Movement-based tie-out (2026-09-09): with a previous scored Trial Balance,
// each ledger's change over the month is compared to the batch's correct
// postings, so earlier months' drift no longer fails every submission.
describe('Trial Balance tie-out by movement (2026-09-09)', () => {
  const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
  // The sample month: Material purchase Dr 4,23,000; Parekh Cr 4,44,150.
  const key = correctAnswerKey();
  // Enough unrelated ledgers to read as a real per-ledger export (a
  // collapsed group-level file is ignored as a baseline, tested below).
  const filler: ParsedTrialBalance['ledgers'] = Array.from({ length: 10 }, (_, i) => ({
    ledgerName: `Other Ledger ${i + 1}`,
    closingDebit: 1000 * (i + 1),
    closingCredit: 0,
  }));
  const previous: ParsedTrialBalance = {
    ledgers: [
      // Drifted books: an old mistake left Material purchase 10,000 high and
      // Parekh 10,000 high, and an unrelated ledger sits at any balance.
      { ledgerName: 'Material purchase', closingDebit: 210000, closingCredit: 0 },
      { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 310000 },
      { ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 },
      ...filler,
    ],
  };

  it('ties out when every ledger moved by exactly the correct postings, whatever it started at', () => {
    const current: ParsedTrialBalance = {
      ledgers: [
        { ledgerName: 'Material purchase', closingDebit: 633000, closingCredit: 0 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 754150 },
        { ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 },
      ],
    };
    const result = scoreSubmission(dayBook, current, key, { previousTrialBalance: previous });
    expect(result.tb_tie_out).toBe(true);
    expect(result.tb_tie_out_mismatches).toEqual([]);
    expect(result.overall_result).toBe('pass');
    expect(result.concept_results.find((c) => c.concept_tag === 'trial_balance_tie_out')?.result).toBe('pass');
    // The same closing balances fail the old closing comparison, which is
    // exactly the trap the movement comparison removes.
    expect(scoreSubmission(dayBook, current, key).tb_tie_out).toBe(false);
  });

  it('names the ledger and the size of the gap when a movement is off, without the expected figure', () => {
    const current: ParsedTrialBalance = {
      ledgers: [
        // Moved 4,08,000 instead of 4,23,000: 15,000 short.
        { ledgerName: 'Material purchase', closingDebit: 618000, closingCredit: 0 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 754150 },
        { ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 },
      ],
    };
    const result = scoreSubmission(dayBook, current, key, { previousTrialBalance: previous });
    expect(result.tb_tie_out).toBe(false);
    expect(result.tb_tie_out_mismatches).toEqual([{ account: 'material purchase', status: 'off', difference: -15000 }]);
    expect(result.overall_result).toBe('partial');
    expect(result.concept_results.find((c) => c.concept_tag === 'trial_balance_tie_out')?.result).toBe('fail');
  });

  it('ignores sub-rupee rounding between two exports', () => {
    const current: ParsedTrialBalance = {
      ledgers: [
        { ledgerName: 'Material purchase', closingDebit: 633000.4, closingCredit: 0 },
        { ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 },
      ],
    };
    expect(scoreSubmission(dayBook, current, key, { previousTrialBalance: previous }).tb_tie_out).toBe(true);
  });

  it('reports a ledger that is in neither export as missing, with the movement it should have shown', () => {
    const current: ParsedTrialBalance = { ledgers: [{ ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 }] };
    const withoutMaterial: ParsedTrialBalance = { ledgers: previous.ledgers.filter((l) => !/Material/.test(l.ledgerName)) };
    const result = scoreSubmission(dayBook, current, key, { previousTrialBalance: withoutMaterial });
    expect(result.tb_tie_out).toBe(false);
    expect(result.tb_tie_out_mismatches).toEqual([{ account: 'material purchase', status: 'missing', difference: -423000 }]);
  });

  it('sums a party split across two ledgers, exact plus unclaimed fuzzy rows (Deccan Traders + Deccan Traders Debtor)', () => {
    const split = correctAnswerKey();
    split.entries.push({ ...split.entries[0], correct_account: 'Deccan Traders', dr_cr: 'Dr', amount: 70800, gst_head: null, gst_rate: null });
    const before: ParsedTrialBalance = {
      ledgers: [
        ...previous.ledgers,
        { ledgerName: 'Deccan Traders', closingDebit: 0, closingCredit: 244600 },
        { ledgerName: 'Deccan Traders Debtor', closingDebit: 212400, closingCredit: 0 },
      ],
    };
    const after: ParsedTrialBalance = {
      ledgers: [
        { ledgerName: 'Material purchase', closingDebit: 633000, closingCredit: 0 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 754150 },
        { ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 },
        { ledgerName: 'Deccan Traders', closingDebit: 0, closingCredit: 244600 },
        // The sale of 70,800 landed on the debtor ledger.
        { ledgerName: 'Deccan Traders Debtor', closingDebit: 283200, closingCredit: 0 },
      ],
    };
    expect(scoreSubmission(dayBook, after, split, { previousTrialBalance: before }).tb_tie_out).toBe(true);
  });

  it('ignores a collapsed group-level previous export as a baseline and falls back to the closing comparison', () => {
    const groupLevel: ParsedTrialBalance = { ledgers: [{ ledgerName: 'Purchase Accounts', closingDebit: 210000, closingCredit: 0 }] };
    // Closing comparison: 4,23,000 movement only, no openings → the plain
    // movements-only fixture ties out, the drifted one does not.
    expect(scoreSubmission(dayBook, trialBalanceMatchingAnswerKey(), key, { previousTrialBalance: groupLevel }).tb_tie_out).toBe(true);
    const drifted: ParsedTrialBalance = { ledgers: [{ ledgerName: 'Material purchase', closingDebit: 633000, closingCredit: 0 }, ...trialBalanceMatchingAnswerKey().ledgers.slice(1)] };
    expect(scoreSubmission(dayBook, drifted, key, { previousTrialBalance: groupLevel }).tb_tie_out).toBe(false);
  });

  it('a ledger dropped from this export is measured as having moved to zero', () => {
    // Material purchase stood at 2,10,000 last month and is absent now:
    // movement −2,10,000 against an expected +4,23,000 → off by 6,33,000.
    const current: ParsedTrialBalance = { ledgers: [{ ledgerName: 'Cash', closingDebit: 777840, closingCredit: 0 }] };
    const result = scoreSubmission(dayBook, current, key, { previousTrialBalance: previous });
    expect(result.tb_tie_out_mismatches).toEqual([{ account: 'material purchase', status: 'off', difference: -633000 }]);
  });
});

// GST amounts (2026-09-10): the right heads with the wrong tax figure used to
// pass silently. On a sales/purchase-side voucher the posted total per head
// must equal the key's GST legs per head.
describe('GST amount check (GST_RATE_WRONG, 2026-09-10)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, gstHead: 'CGST' | 'SGST' | 'IGST' | null = null): AnswerKey['entries'][number] => ({
    sequence: 1, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Sales',
    gst_head: gstHead, gst_rate: gstHead ? 9 : null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: 'INV-070', narration: null, concept_tags: ['sales_voucher_basics' as const, 'gst_classification' as const],
    requires_source_document: false, source_document_type: null,
  });
  const key: AnswerKey = { entries: [
    leg('Karnataka Emporium', 'Dr', 47200),
    leg('Sales', 'Cr', 40000),
    leg('Output CGST', 'Cr', 3600, 'CGST'),
    leg('Output SGST', 'Cr', 3600, 'SGST'),
  ] };
  const entry = (ledgerName: string, amount: number, drOrCr: 'Dr' | 'Cr') => ({ ledgerName, amount, drOrCr, billAllocations: ledgerName === 'Karnataka Emporium' ? [{ name: 'INV-070', amount }] : [] });
  const voucher = (cgst: number, sgst: number) => ({ vouchers: [{ voucherType: 'Sales', date: '20250402', narration: 'INV-070', ledgerEntries: [
    entry('Karnataka Emporium', 40000 + cgst + sgst, 'Dr'), entry('Sales', 40000, 'Cr'), entry('Output CGST', cgst, 'Cr'), entry('Output SGST', sgst, 'Cr'),
  ] }] });
  const gstDiff = (cgst: number, sgst: number) => scoreSubmission(voucher(cgst, sgst), { ledgers: [] }, key).per_voucher_diffs.find((d) => d.field === 'gst');

  it('passes the exact figures', () => {
    expect(gstDiff(3600, 3600)?.is_correct).toBe(true);
  });

  it('flags the right heads with the wrong figure as GST_RATE_WRONG, not GST_HEAD_WRONG', () => {
    // 12% charged instead of 18%: heads and side are right, the figure is not.
    const diff = gstDiff(2400, 2400);
    expect(diff?.is_correct).toBe(false);
    expect(diff?.error_code).toBe('GST_RATE_WRONG');
  });

  it('still reports a wrong regime as GST_HEAD_WRONG ahead of any amount difference', () => {
    const igstVoucher = { vouchers: [{ voucherType: 'Sales', date: '20250402', narration: 'INV-070', ledgerEntries: [
      entry('Karnataka Emporium', 47200, 'Dr'), entry('Sales', 40000, 'Cr'), entry('Output IGST', 7200, 'Cr'),
    ] }] };
    expect(scoreSubmission(igstVoucher, { ledgers: [] }, key).per_voucher_diffs.find((d) => d.field === 'gst')?.error_code).toBe('GST_HEAD_WRONG');
  });
});


describe('leg pairing: account names claim entries before aliases do (Yeshas SA-105, 2026-09-04)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, aliases?: string[], gstHead: 'CGST' | 'SGST' | null = null): AnswerKey['entries'][number] => ({
    sequence: 10, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Purchase',
    gst_head: gstHead, gst_rate: gstHead ? 9 : null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: 'SA-105', narration: null, concept_tags: ['purchase_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
    ...(aliases ? { account_aliases: aliases } : {}),
  });
  const key: AnswerKey = { entries: [
    leg('Advertisement & Marketing', 'Dr', 12000, ['Marketing collaterals', 'Advertising', 'Marketing Expenses']),
    leg('Input CGST', 'Dr', 1080, undefined, 'CGST'),
    leg('Input SGST', 'Dr', 1080, undefined, 'SGST'),
    leg('Signage Advertising', 'Cr', 14160),
  ] };
  const dayBook = { vouchers: [{ voucherType: 'Purchase', date: '20260714', narration: 'Purchased signage from Signage Advertising SA-105', ledgerEntries: [
    { ledgerName: 'Signage Advertising', amount: 14160, drOrCr: 'Cr' as const, billAllocations: [{ name: 'SA-105', amount: 14160 }] },
    { ledgerName: 'Purchase A/C', amount: 12000, drOrCr: 'Dr' as const, billAllocations: [] },
    { ledgerName: 'OUTPUT SGST', amount: 1080, drOrCr: 'Dr' as const, billAllocations: [] },
    { ledgerName: 'OUTPUT CGST', amount: 1080, drOrCr: 'Dr' as const, billAllocations: [] },
  ] }] };

  it('the party entry stays with the party leg; only the real slips are flagged', () => {
    const result = scoreSubmission(dayBook, { ledgers: [] }, key);
    const codes = result.per_voucher_diffs.filter((d) => !d.is_correct && d.error_code).map((d) => d.error_code).sort();
    expect(codes).toEqual(['ACCOUNT_WRONG', 'GST_HEAD_WRONG']);
  });
});

describe('GST set-off journal: input and output legs of the same head must not cross (Praveen February, 2026-09-07)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, gstHead: 'CGST' | 'SGST' | 'IGST' | null): AnswerKey['entries'][number] => ({
    sequence: 9, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Journal',
    gst_head: gstHead, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: null, narration: null, concept_tags: ['journal_voucher_basics' as const, 'gst_classification' as const],
    requires_source_document: false, source_document_type: null,
  });
  const key: AnswerKey = { entries: [
    leg('Output CGST 6%', 'Dr', 1920, 'CGST'),
    leg('Output CGST 9%', 'Dr', 42390, 'CGST'),
    leg('Output SGST 6%', 'Dr', 1920, 'SGST'),
    leg('Output SGST 9%', 'Dr', 42390, 'SGST'),
    leg('Output IGST 18%', 'Dr', 148680, 'IGST'),
    leg('Input CGST 9%', 'Cr', 50644.83, 'CGST'),
    leg('Input SGST 9%', 'Cr', 50644.83, 'SGST'),
    leg('Input IGST 18%', 'Cr', 76140, 'IGST'),
    leg('GST Payable', 'Cr', 59870.34, null),
  ] };
  // Posted in Praveen's own order and casing, 9% legs before 6% legs.
  const entry = (ledgerName: string, amount: number, drOrCr: 'Dr' | 'Cr') => ({ ledgerName, amount, drOrCr, billAllocations: [] });
  const dayBook = { vouchers: [{ voucherType: 'Journal', date: '20270215', narration: 'GST utilisation for FEB', ledgerEntries: [
    entry('Output CGST 9%', 42390, 'Dr'), entry('Output SGST 9%', 42390, 'Dr'), entry('OUTPUT IGST 18%', 148680, 'Dr'),
    entry('INPUT CGST 9%', 50644.83, 'Cr'), entry('INPUT SGST 9 %', 50644.83, 'Cr'), entry('INPUT IGST 18%', 76140, 'Cr'),
    entry('Output CGST 6%', 1920, 'Dr'), entry('Output SGST 6%', 1920, 'Dr'), entry('GST Payable', 59870.34, 'Cr'),
  ] }] };

  it('scores a correctly posted nine-leg set-off with no flags', () => {
    const result = scoreSubmission(dayBook, { ledgers: [] }, key);
    const codes = result.per_voucher_diffs.filter((d) => !d.is_correct && d.error_code).map((d) => d.error_code);
    expect(codes).toEqual([]);
  });

  it('still flags a set-off that leaves a whole head out', () => {
    const noIgst = { vouchers: [{ ...dayBook.vouchers[0], ledgerEntries: dayBook.vouchers[0].ledgerEntries.filter((e) => !/IGST/i.test(e.ledgerName)) }] };
    const result = scoreSubmission(noIgst, { ledgers: [] }, key);
    const codes = result.per_voucher_diffs.filter((d) => !d.is_correct && d.error_code).map((d) => d.error_code);
    expect(codes).toContain('GST_HEAD_WRONG');
    expect(codes).toContain('ACCOUNT_WRONG');
  });
});

describe('bill reference that names only a type, no number (Praveen February #12, 2026-09-07)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', ref: string | null): AnswerKey['entries'][number] => ({
    sequence: 12, correct_account: account, dr_cr: drCr, amount: 5000, voucher_type: 'Journal',
    gst_head: null, gst_rate: null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: ref, narration: null, concept_tags: ['journal_voucher_basics' as const],
    requires_source_document: false, source_document_type: null,
  });
  const key: AnswerKey = { entries: [leg('Suspense', 'Dr', 'New Ref (advance)'), leg('Bengaluru Boutique', 'Cr', 'New Ref (advance)')] };
  const voucher = (allocations: { name: string; amount: number }[]) => ({ vouchers: [{ voucherType: 'Journal', date: '20270224', narration: 'Suspense reclassified as advance', ledgerEntries: [
    { ledgerName: 'Suspense A/c', amount: 5000, drOrCr: 'Dr' as const, billAllocations: [] },
    { ledgerName: 'Bengaluru Boutique', amount: 5000, drOrCr: 'Cr' as const, billAllocations: allocations },
  ] }] });

  it("accepts whatever allocation the learner created (Tally's own running number)", () => {
    const result = scoreSubmission(voucher([{ name: '9', amount: 5000 }]), { ledgers: [] }, key);
    expect(result.per_voucher_diffs.filter((d) => d.field === 'bill_reference').every((d) => d.is_correct)).toBe(true);
  });

  it('still requires an allocation to exist', () => {
    const result = scoreSubmission(voucher([]), { ledgers: [] }, key);
    expect(result.per_voucher_diffs.some((d) => d.error_code === 'BILL_REFERENCE_MISSING')).toBe(true);
  });
});
