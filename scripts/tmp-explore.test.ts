import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { parseDayBookXml } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';
it('explore', () => {
  const db = parseDayBookXml(readFileSync('xmls/pilot-submission/elina-daybook.xml'));
  const tb = parseTrialBalanceXml(readFileSync('xmls/pilot-submission/elina-trialbal.xml'));
  const names = new Map<string, number>();
  for (const v of db.vouchers) for (const e of v.ledgerEntries) names.set(e.ledgerName, (names.get(e.ledgerName) ?? 0) + 1);
  const lines: string[] = [];
  lines.push('LEDGERS: ' + [...names.entries()].map(([n, c]) => `${n}(${c})`).join(' | '));
  db.vouchers.forEach((v, i) => {
    lines.push(`${i + 1} ${v.date} ${v.voucherType} :: ${v.ledgerEntries.map((e) => `${e.drOrCr} ${e.ledgerName} ${e.amount}${e.billAllocations.length ? ' [' + e.billAllocations.map((b) => b.name + (b.billType ? '/' + b.billType : '')).join(',') + ']' : ''}`).join(' ; ')} :: ${v.narration.slice(0, 90)}`);
  });
  lines.push('TB:');
  for (const r of tb.ledgers) lines.push(`${r.ledgerName} | open ${r.openingDebit ?? '-'} / ${r.openingCredit ?? '-'} | close ${r.closingDebit} / ${r.closingCredit}`);
  writeFileSync(process.env.OUT!, lines.join('\n'));
});
