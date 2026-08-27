// Calibration harness: runs the deterministic scoring engine against the
// PILOT trainee's real diagnostic submission (xmls/pilot-submission/) and the
// derived Variant A answer key, so the engine's verdict can be compared with
// the pilot reviewer's known-good review (173/200 = 86.5%, specific findings
// in the group chat). Run with:  npx tsx scripts/calibrate-pilot.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDayBookXml } from '../lib/parsing/daybook.ts';
import { parseTrialBalanceXml } from '../lib/parsing/trialbalance.ts';
import { scoreSubmission } from '../lib/tutor/score-submission.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const dayBook = parseDayBookXml(readFileSync(path.join(root, 'xmls', 'pilot-submission', 'elina-daybook.xml')));
const trialBalance = parseTrialBalanceXml(readFileSync(path.join(root, 'xmls', 'pilot-submission', 'elina-trialbal.xml')));
const answerKey = JSON.parse(readFileSync(path.join(root, 'seed', 'blossom-variant-a', 'answer_key.json'), 'utf-8'));

console.log(`Submission: ${dayBook.vouchers.length} vouchers, TB rows: ${trialBalance.ledgers.length}`);
console.log(`Answer key: ${new Set(answerKey.entries.map((e) => e.sequence)).size} transactions, ${answerKey.entries.length} legs, ${answerKey.opening_balances?.length ?? 0} openings`);

const result = scoreSubmission(dayBook, trialBalance, answerKey);

console.log(`\nTB tie-out: ${result.tb_tie_out}`);
console.log(`Weighted score: ${(result.weighted_score * 100).toFixed(1)}%  (pilot reviewer: 86.5%)`);
console.log(`Overall: ${result.overall_result}`);

const byField = {};
for (const d of result.per_voucher_diffs) {
  if (!d.is_correct) {
    byField[d.field] = (byField[d.field] ?? 0) + 1;
  }
}
console.log('\nIncorrect diffs by field:', byField);

const errorCodes = {};
for (const d of result.per_voucher_diffs) {
  if (d.error_code) errorCodes[d.error_code] = (errorCodes[d.error_code] ?? 0) + 1;
}
console.log('Error codes:', errorCodes);

console.log('\nConcept results:');
for (const c of result.concept_results) console.log(` ${c.result === 'pass' ? 'PASS' : 'fail'}  ${c.concept_tag}`);

// Which expected transactions have errors — with the expected accounts, to
// spot systematic ledger-NAME mismatches (my key's names vs her real names).
const bySeq = new Map();
for (const e of answerKey.entries) {
  if (!bySeq.has(e.sequence)) bySeq.set(e.sequence, []);
  bySeq.get(e.sequence).push(e);
}
const badSeqs = [...new Set(result.per_voucher_diffs.filter((d) => !d.is_correct).map((d) => d.voucherRef))];
console.log(`\nTransactions with >=1 error: ${badSeqs.length} of ${bySeq.size}`);
for (const seq of badSeqs) {
  const legs = bySeq.get(seq) ?? [];
  const fields = result.per_voucher_diffs.filter((d) => d.voucherRef === seq && !d.is_correct).map((d) => `${d.field}${d.error_code ? `(${d.error_code})` : ''}`);
  console.log(` #${seq} [${legs.map((l) => `${l.dr_cr} ${l.correct_account} ${l.amount}`).join(' | ')}] -> ${fields.join(', ')}`);
}
if (badSeqs.length > 25) console.log(` ... and ${badSeqs.length - 25} more`);

// TB reconciliation: which accounts fail closing-balance comparison.
function norm(n) { return n.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function nmatch(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  const s2 = x.length <= y.length ? x : y, l = x.length <= y.length ? y : x;
  return s2.length >= 5 && l.includes(s2);
}
const bal = new Map();
for (const o of answerKey.opening_balances ?? []) {
  const k = o.account; bal.set(k, (bal.get(k) ?? 0) + (o.dr_cr === 'Dr' ? o.amount : -o.amount));
}
for (const e of answerKey.entries) {
  const k = [...bal.keys()].find((x) => norm(x) === norm(e.correct_account)) ?? e.correct_account;
  bal.set(k, (bal.get(k) ?? 0) + (e.dr_cr === 'Dr' ? e.amount : -e.amount));
}
console.log('\nTB mismatches (expected vs her TB, GST/TDS exempt):');
for (const [account, expected] of bal) {
  if (/gst|tds/i.test(account)) continue;
  const rows = trialBalance.ledgers.filter((l) => nmatch(l.ledgerName, account));
  const actual = rows.reduce((sum, r) => sum + (r.closingDebit - r.closingCredit), 0);
  if (rows.length === 0 && Math.abs(expected) < 0.005) continue;
  if (Math.abs(actual - expected) > 0.005) {
    console.log(` ${account}: expected ${expected.toFixed(2)}, her TB ${rows.length ? actual.toFixed(2) : 'NO ROW'} (${rows.map((r) => r.ledgerName).join('+') || '-'})`);
  }
}

// Her ledger-name universe, to reconcile naming.
const names = new Set();
for (const v of dayBook.vouchers) for (const e of v.ledgerEntries) names.add(e.ledgerName);
console.log(`\nHer distinct ledger names (${names.size}):`);
console.log([...names].sort().join(' | '));
