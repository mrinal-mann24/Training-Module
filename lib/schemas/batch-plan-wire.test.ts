import { describe, expect, it } from 'vitest';
import { BATCH_PLAN_JSON_SCHEMA } from '@/lib/llm/prompts/batch-plan-json-schema';
import { batchPlanFromWire } from './batch-plan-wire';

// The first dry run against a learner's real books (2026-09-22) showed that
// the provider's strict JSON mode refuses the plan schema as a union
// ("compiled grammar is too large") and refuses an enum on a nullable type,
// so every planned generation would have thrown in production. The model
// now answers in one flat event shape; these tests pin both halves: the
// schema never regains the refused constructs, and the flat answer becomes
// exactly the typed plan, with nothing guessed.

const blank = {
  party: null,
  new_party: false,
  lines: [],
  gst_rate: null,
  doc_number: null,
  settlement: null,
  adjust_advance_ref: null,
  nature: null,
  ledger: null,
  instrument: null,
  settlement_mode: null,
  bills: [],
  amount: null,
  why: null,
  tds_withheld: null,
  direction: null,
  months: null,
  annual_rate_percent: null,
};

const line = { description: 'Cotton sheets', quantity: 10, rate: 500 };

describe('the model-facing schema stays inside what the provider compiles', () => {
  const walk = (node: unknown, visit: (object: Record<string, unknown>) => void): void => {
    if (Array.isArray(node)) node.forEach((item) => walk(item, visit));
    else if (node && typeof node === 'object') {
      visit(node as Record<string, unknown>);
      Object.values(node).forEach((value) => walk(value, visit));
    }
  };

  it('has no anyOf, oneOf or allOf anywhere', () => {
    const unions: string[] = [];
    walk(BATCH_PLAN_JSON_SCHEMA, (object) => {
      for (const word of ['anyOf', 'oneOf', 'allOf']) if (word in object) unions.push(word);
    });
    expect(unions).toEqual([]);
  });

  it('never puts an enum on a nullable type', () => {
    const offenders: unknown[] = [];
    walk(BATCH_PLAN_JSON_SCHEMA, (object) => {
      if (Array.isArray(object.type) && object.type.includes('null') && 'enum' in object) offenders.push(object);
    });
    expect(offenders).toEqual([]);
  });

  it('requires every event property, so the model always writes the whole flat shape', () => {
    const event = BATCH_PLAN_JSON_SCHEMA.properties.events.items;
    expect([...event.required].sort()).toEqual(Object.keys(event.properties).sort());
    expect(event.additionalProperties).toBe(false);
  });
});

describe('batchPlanFromWire', () => {
  const wire = (events: Record<string, unknown>[]) => ({ scenario: 'A steady month of trading for the company.', difficulty_level: 'L3', events });

  it('turns each flat event into its typed form and drops the fields of other types', () => {
    const result = batchPlanFromWire(
      wire([
        { ...blank, type: 'sale', seq: 1, day: 2, party: 'Karnataka Emporium', nature: 'service', lines: [line], gst_rate: 18, settlement: 'credit', doc_number: 'INV-3010', amount: 999 },
        { ...blank, type: 'sale', seq: 2, day: 3, party: 'Cash', lines: [line], gst_rate: 5, settlement: 'cash', doc_number: 'CM-07' },
        { ...blank, type: 'purchase', seq: 3, day: 4, party: 'Deccan Traders', nature: 'goods', lines: [line], gst_rate: 18, settlement: 'credit', doc_number: 'DT/901' },
        { ...blank, type: 'receipt', seq: 4, day: 5, party: 'Karnataka Emporium', instrument: 'bank', settlement_mode: 'full', bills: ['INV-3010'], tds_withheld: '194J' },
        { ...blank, type: 'payment', seq: 5, day: 6, party: 'Deccan Traders', instrument: 'bank', settlement_mode: 'part', bills: ['DT/901'], amount: 1000 },
        { ...blank, type: 'payment', seq: 6, day: 7, ledger: 'Electricity Charges', amount: 6500, instrument: 'bank' },
        { ...blank, type: 'contra', seq: 7, day: 8, direction: 'cash_to_bank', amount: 5000 },
        { ...blank, type: 'depreciation', seq: 8, day: 30, ledger: 'Office Equipment', months: 1, annual_rate_percent: 15 },
        { ...blank, type: 'credit_note', seq: 9, day: 9, party: 'Karnataka Emporium', bills: ['INV-3010'], lines: [line], gst_rate: 18, doc_number: 'CN-01' },
      ]),
    );
    if (!result.ok) throw new Error(result.violations.join('\n'));
    const [service, cash, purchase, receipt, part, direct, contra, depreciation, note] = result.plan.events;
    expect(service).toMatchObject({ type: 'sale', nature: 'service', customer: { name: 'Karnataka Emporium', new_party: false }, settlement: 'credit', doc_number: 'INV-3010' });
    expect(service).not.toHaveProperty('amount');
    // A sale that names no nature is goods, which is what a trading company sells.
    expect(cash).toMatchObject({ type: 'sale', nature: 'goods', settlement: 'cash' });
    expect(purchase).toMatchObject({ type: 'purchase', vendor: { name: 'Deccan Traders', new_party: false }, nature: 'goods', ledger: null });
    expect(receipt).toMatchObject({ type: 'receipt', settlement: { mode: 'full', bills: ['INV-3010'] }, tds_withheld: '194J' });
    expect(part).toMatchObject({ type: 'payment', payee: { name: 'Deccan Traders', new_party: false }, settlement: { mode: 'part', bill: 'DT/901', amount: 1000 }, expense_ledger: null });
    expect(direct).toMatchObject({ type: 'payment', payee: null, settlement: null, expense_ledger: 'Electricity Charges', amount: 6500 });
    expect(contra).toMatchObject({ type: 'contra', direction: 'cash_to_bank', amount: 5000 });
    expect(depreciation).toMatchObject({ type: 'depreciation', asset_ledger: 'Office Equipment', months: 1, annual_rate_percent: 15 });
    expect(note).toMatchObject({ type: 'credit_note', against_bill: 'INV-3010', note_number: 'CN-01' });
  });

  it('reports a field the event type needs under the flat name the model writes, and never fills it in', () => {
    const result = batchPlanFromWire(
      wire([
        { ...blank, type: 'contra', seq: 1, day: 3, amount: 5000 },
        { ...blank, type: 'receipt', seq: 2, day: 4, party: 'Karnataka Emporium', instrument: 'bank' },
        { ...blank, type: 'credit_note', seq: 3, day: 5, party: 'Karnataka Emporium', lines: [line], gst_rate: 18, doc_number: 'CN-02' },
        { ...blank, type: 'payment', seq: 4, day: 6, instrument: 'bank', settlement_mode: 'nonsense' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toContain('event seq 1 (contra): "direction"');
    expect(result.violations.some((violation) => violation.includes('event seq 2 (receipt): "settlement_mode"'))).toBe(true);
    expect(result.violations.some((violation) => violation.includes('event seq 3 (credit_note): "bills (the one bill the note is against)"'))).toBe(true);
  });

  it('rejects an answer that is not the flat shape at all', () => {
    const result = batchPlanFromWire({ scenario: 'x', difficulty_level: 'L3', events: [{ type: 'sale' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]).toContain('did not match the schema');
  });
});
