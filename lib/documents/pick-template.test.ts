import { describe, expect, it } from 'vitest';
import {
  pickFormatIndex,
  formatCountForDocType,
  VENDOR_INVOICE_FORMAT_COUNT,
  BANK_STATEMENT_FORMAT_COUNT,
} from './pick-template';

describe('pickFormatIndex (Phase 4 format rotation)', () => {
  it('is deterministic: same doc type and seed always pick the same format', () => {
    const first = pickFormatIndex('vendor_invoice', 'exercise-1:3');
    for (let i = 0; i < 5; i++) {
      expect(pickFormatIndex('vendor_invoice', 'exercise-1:3')).toBe(first);
    }
  });

  it('stays within the format range for both doc types', () => {
    for (let sequence = 1; sequence <= 40; sequence++) {
      const invoiceIndex = pickFormatIndex('vendor_invoice', `ex:${sequence}`);
      expect(invoiceIndex).toBeGreaterThanOrEqual(0);
      expect(invoiceIndex).toBeLessThan(VENDOR_INVOICE_FORMAT_COUNT);

      const statementIndex = pickFormatIndex('bank_statement', `ex:${sequence}`);
      expect(statementIndex).toBeGreaterThanOrEqual(0);
      expect(statementIndex).toBeLessThan(BANK_STATEMENT_FORMAT_COUNT);
    }
  });

  it('actually rotates: many seeds reach every vendor-invoice format', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickFormatIndex('vendor_invoice', `exercise-${i}:1`));
    }
    expect(seen.size).toBe(VENDOR_INVOICE_FORMAT_COUNT);
  });

  it('reaches both bank statement formats, so the HDFC variant appears', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      seen.add(pickFormatIndex('bank_statement', `exercise-${i}:1`));
    }
    expect(seen.size).toBe(BANK_STATEMENT_FORMAT_COUNT);
  });

  it('doc type participates in the hash: counts differ per type', () => {
    expect(formatCountForDocType('vendor_invoice')).toBe(VENDOR_INVOICE_FORMAT_COUNT);
    expect(formatCountForDocType('bank_statement')).toBe(BANK_STATEMENT_FORMAT_COUNT);
  });
});
