import { describe, expect, it } from 'vitest';
import { accountNamesMatch, tdsSectionOf } from './account-names';

describe('tdsSectionOf', () => {
  it('reads a known section from the ledger name in any of the learners\' spellings', () => {
    expect(tdsSectionOf('TDS Payable — u/s 194J')).toBe('194j');
    expect(tdsSectionOf('TDS U/S 194 I')).toBe('194i');
    expect(tdsSectionOf('TDS Payable - 194c')).toBe('194c');
    expect(tdsSectionOf('TDS Receivable — u/s 194J')).toBe('194j');
  });

  it('ignores names without a section and unrecognised section letters', () => {
    expect(tdsSectionOf('TDS Payable')).toBeNull();
    expect(tdsSectionOf('TDS Payable - 194Ci')).toBeNull();
    expect(tdsSectionOf('Rent')).toBeNull();
  });
});

describe('accountNamesMatch with TDS sections', () => {
  it('rejects a deduction booked under a different section (rulebook 12, E06)', () => {
    expect(accountNamesMatch('TDS Payable — u/s 194C', 'TDS Payable — u/s 194J')).toBe(false);
    expect(accountNamesMatch('TDS Payable u/s 194I', 'TDS Payable — u/s 194C')).toBe(false);
  });

  it('still accepts the same section in another spelling', () => {
    expect(accountNamesMatch('TDS Payable - 194c', 'TDS Payable — u/s 194C')).toBe(true);
    expect(accountNamesMatch('TDS Payable u/s 194J', 'TDS Payable — u/s 194J')).toBe(true);
  });

  it('lets a typo that is not a known section fall through to the ordinary rules', () => {
    // Praveen's rent-TDS ledger.
    expect(accountNamesMatch('TDS Payable - 194Ci', 'TDS Payable — u/s 194I')).toBe(true);
  });

  it('keeps TDS Receivable distinct from TDS Payable of the same section', () => {
    expect(accountNamesMatch('TDS Payable — u/s 194J', 'TDS Receivable — u/s 194J')).toBe(false);
  });
});
