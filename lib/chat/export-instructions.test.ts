import { describe, expect, it } from 'vitest';
import {
  DAY_BOOK_EXPORT_STEPS,
  EXPORT_NOTE,
  TRIAL_BALANCE_EXPORT_STEPS,
  exportSteps,
  exportStepsFor,
  formatRejection,
  guidanceFor,
} from './export-instructions';

describe('export steps', () => {
  it('numbers the steps under a title', () => {
    const text = exportSteps('trialbalance');
    expect(text.split('\n')[0]).toBe('How to export the Trial Balance:');
    expect(text.split('\n')).toHaveLength(TRIAL_BALANCE_EXPORT_STEPS.length + 1);
    expect(text).toContain('3. Press F5 so the report is Ledger-wise.');
    expect(text).toContain('4. Press F12 and set Show Opening Balance to Yes.');
  });

  it('asks for the Detailed Day Book and the month of the exercise', () => {
    const text = exportSteps('daybook');
    expect(text).toContain('Alt+F2');
    expect(text).toContain('Alt+F5 so the report is Detailed');
    expect(text.split('\n')).toHaveLength(DAY_BOOK_EXPORT_STEPS.length + 1);
  });

  it('always lists the Day Book before the Trial Balance, each once', () => {
    const text = exportStepsFor(['trialbalance', 'daybook', 'trialbalance']);
    expect(text.indexOf('How to export the Day Book')).toBeLessThan(text.indexOf('How to export the Trial Balance'));
    expect(text.match(/How to export the Trial Balance/g)).toHaveLength(1);
  });

  it('uses no em dash and no hint about the answers', () => {
    const everything = [EXPORT_NOTE, exportStepsFor(['daybook', 'trialbalance'])].join('\n');
    expect(everything).not.toMatch(/[–—]/);
    expect(everything).not.toMatch(/ledger name|amount of|GST rate/i);
  });
});

describe('guidanceFor', () => {
  it('gives the steps of the file that was exported wrongly', () => {
    expect(guidanceFor('trial_balance_too_sparse')).toEqual(['trialbalance']);
    expect(guidanceFor('day_book_not_detailed')).toEqual(['daybook']);
  });

  it('gives both files when the vouchers themselves need fixing', () => {
    for (const code of ['voucher_count_mismatch', 'voucher_dates_out_of_period', 'blank_vouchers', 'parse_failed']) {
      expect(guidanceFor(code)).toEqual(['daybook', 'trialbalance']);
    }
  });

  it('gives no steps for a failure on our side, and both for a code it does not know', () => {
    expect(guidanceFor('processing_failed')).toEqual([]);
    expect(guidanceFor('no_parts_received')).toEqual([]);
    expect(guidanceFor('something_new')).toEqual(['daybook', 'trialbalance']);
  });
});

describe('formatRejection', () => {
  it('states the problem, then the steps for that file, then what to do', () => {
    const text = formatRejection([{ code: 'trial_balance_too_sparse', message: 'This Trial Balance shows groups, not ledgers.' }]);
    expect(text).toBe(
      [
        'This upload could not be scored yet. One thing needs fixing:',
        '• This Trial Balance shows groups, not ledgers.',
        exportSteps('trialbalance'),
        'Then attach both files here again.',
      ].join('\n\n'),
    );
    expect(text).not.toContain('How to export the Day Book');
  });

  it('lists every problem and the steps of every file involved, once', () => {
    const text = formatRejection([
      { code: 'trial_balance_too_sparse', message: 'Groups only.' },
      { code: 'blank_vouchers', message: 'One blank voucher.' },
    ]);
    expect(text).toContain('These things need fixing:');
    expect(text).toContain('• Groups only.\n• One blank voucher.');
    expect(text.match(/How to export the Day Book/g)).toHaveLength(1);
    expect(text.match(/How to export the Trial Balance/g)).toHaveLength(1);
  });

  it('does not tell the learner to fix anything when the failure was ours', () => {
    const text = formatRejection([{ code: 'processing_failed', message: 'Something went wrong on my side while checking this. Nothing you did wrong. Please send your files again.' }]);
    expect(text).toBe('• Something went wrong on my side while checking this. Nothing you did wrong. Please send your files again.');
    expect(text).not.toMatch(/fix|How to export/i);
  });

  it('still reads sensibly with no stored reason', () => {
    expect(formatRejection(null)).toContain('This upload could not be scored yet.');
    expect(formatRejection([])).toContain('How to export the Day Book');
  });
});
