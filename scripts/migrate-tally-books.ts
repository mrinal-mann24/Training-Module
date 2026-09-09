// One-off migration for the 2026-09 timeline shift: takes a learner's Tally
// "Export Masters" and "All Vouchers" XML (Data Interchange format), moves
// every date back N years, optionally merges/renames ledgers, replaces the
// opening balances with a supplied set, drops named vouchers, and writes two
// files ready to import into a fresh Tally company whose books begin on the
// shifted date. Also prints a before/after check sheet (voucher count and
// per-ledger closing balance) so the import can be verified in Tally.
//
// Usage (see context/progress-tracker.md, 2026-09-07):
//   npx tsx scripts/migrate-tally-books.ts \
//     --masters in/masters.xml --vouchers in/vouchers.xml --out out/ \
//     --years 2 --company "Blossom Retail Pvt Ltd" \
//     [--config learner-config.json]
//
// learner-config.json (all keys optional):
// {
//   "rename": { "AHMDELITE": "Ahmedabad Elite", "PRIYAS": { "to": "Salaries", "parent": "Indirect Expenses" } },
//   "openings": [ { "account": "HDFC BANK", "dr_cr": "Dr", "amount": 800000,
//                   "bills": [ { "name": "MS-M1", "date": "20260322", "amount": 120000 } ] } ],
//   "dropVouchers": [ { "date": "20260401", "narration": "OPENING BALANCE B/F" } ]
// }
// When "openings" is given, EVERY ledger's opening balance and opening bill
// list in the masters is replaced (ledgers not listed open at zero). Without
// it the exported opening balances are kept as they are.
//
// Tally sign convention in these files: a NEGATIVE amount is a debit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type RenameTarget = string | { to: string; parent: string };
type OpeningBill = { name: string; date: string; amount: number };
type Opening = { account: string; dr_cr: 'Dr' | 'Cr'; amount: number; bills?: OpeningBill[] };
type DropRule = { date?: string; narration?: string; narrationStartsWith?: string; voucherType?: string };
// relabel: rename a ledger inside ONE voucher only (a junk ledger that was
// used for two different parties). Matched by date + narration fragment.
type RelabelRule = { date: string; narrationContains: string; from: string; to: string };
type Config = {
  rename?: Record<string, RenameTarget>;
  openings?: Opening[];
  dropVouchers?: DropRule[];
  relabel?: RelabelRule[];
  // ledger -> parent group, for ledgers exported under the wrong group
  parentOverride?: Record<string, string>;
};

const DATE_TAGS = [
  'DATE', 'VCHSTATUSDATE', 'EFFECTIVEDATE', 'INSTRUMENTDATE', 'REFERENCEDATE', 'BILLOFLADINGDATE',
  'VATPARTYTRANSRETURNDATE', 'BILLDATE', 'APPLICABLEFROM', 'STARTINGFROM', 'BASICSHIPPINGDATE',
  'BASICORDERDATE', 'BASICDUEDATEOFPYMT', 'CHEQUEDATE', 'PAYMENTDATE',
];
const PARTY_NAME_TAGS = [
  'LEDGERNAME', 'PARTYLEDGERNAME', 'PARTYNAME', 'BASICBUYERNAME', 'BASICBASEPARTYNAME',
  'PARTYMAILINGNAME', 'CONSIGNEEMAILINGNAME', 'BANKALLOCATIONS.LIST/NAME', 'PAYMENTFAVOURING', 'BANKPARTYNAME',
];

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing --${name}`);
  }
  return process.argv[index + 1];
}

function readTallyXml(file: string): string {
  const buffer = readFileSync(file);
  const utf16 = buffer[0] === 0xff && buffer[1] === 0xfe;
  return utf16 ? buffer.toString('utf16le').replace(/^﻿/, '') : buffer.toString('utf8').replace(/^﻿/, '');
}

function writeTallyXml(file: string, xml: string): void {
  // Tally exported UTF-16LE with a BOM; write the same so import behaves the same.
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s: string): string => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function shiftDate(yyyymmdd: string, years: number): string {
  const year = Number(yyyymmdd.slice(0, 4)) - years;
  let monthDay = yyyymmdd.slice(4);
  if (monthDay === '0229' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) monthDay = '0228';
  return `${year}${monthDay}`;
}

function shiftAllDates(xml: string, years: number): string {
  const tagPattern = new RegExp(`<(${DATE_TAGS.join('|')})>(\\d{8})</\\1>`, 'g');
  return xml.replace(tagPattern, (_m, tag: string, date: string) => `<${tag}>${shiftDate(date, years)}</${tag}>`);
}

// Textual dates inside bill names ("MS-M1 dt 22-Mar-26") and narrations are
// left alone on purpose: Tally does not parse them, and rewriting free text
// risks corrupting references the scorer matches on.

function stripIdentity(xml: string): string {
  // GUID/ALTERID/REMOTEID/VCHKEY belong to the old company. A fresh company
  // must mint its own, otherwise a second import of the same file collides.
  return xml
    .replace(/ REMOTEID="[^"]*"/g, '')
    .replace(/ VCHKEY="[^"]*"/g, '')
    .replace(/<GUID>[^<]*<\/GUID>\s*/g, '')
    .replace(/<ALTERID>[^<]*<\/ALTERID>\s*/g, '')
    .replace(/<MASTERID>[^<]*<\/MASTERID>\s*/g, '')
    .replace(/<UPDATEDDATETIME>[^<]*<\/UPDATEDDATETIME>\s*/g, '');
}

function renameMap(config: Config): Map<string, { to: string; parent?: string }> {
  const map = new Map<string, { to: string; parent?: string }>();
  for (const [from, target] of Object.entries(config.rename ?? {})) {
    map.set(from, typeof target === 'string' ? { to: target } : { to: target.to, parent: target.parent });
  }
  return map;
}

function applyRenames(xml: string, renames: Map<string, { to: string; parent?: string }>): string {
  let out = xml;
  for (const [from, { to }] of renames) {
    const escapedFrom = xmlEscape(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedTo = xmlEscape(to);
    for (const tag of PARTY_NAME_TAGS) {
      const simpleTag = tag.split('/').pop() as string;
      out = out.replace(new RegExp(`<${simpleTag}>${escapedFrom}</${simpleTag}>`, 'g'), `<${simpleTag}>${escapedTo}</${simpleTag}>`);
    }
    out = out.replace(new RegExp(`<LEDGER NAME="${escapedFrom}"`, 'g'), `<LEDGER NAME="${escapedTo}"`);
    out = out.replace(new RegExp(`<NAME>${escapedFrom}</NAME>`, 'g'), `<NAME>${escapedTo}</NAME>`);
  }
  return out;
}

type LedgerBlock = { name: string; parent: string; block: string };

function splitLedgerMessages(masters: string): { ledgers: LedgerBlock[]; others: string[]; head: string; tail: string } {
  const bodyStart = masters.indexOf('<TALLYMESSAGE');
  const bodyEnd = masters.lastIndexOf('</TALLYMESSAGE>') + '</TALLYMESSAGE>'.length;
  const head = masters.slice(0, bodyStart);
  const tail = masters.slice(bodyEnd);
  // Tally can put several master objects in ONE <TALLYMESSAGE> (Garima's
  // export had the "Cash-in-Hand" group and the "Cash" ledger together), so
  // split on the objects themselves, not on the message wrapper. Each object
  // is re-wrapped in its own message on output.
  const objects = masters.slice(bodyStart, bodyEnd).match(/<(GROUP|LEDGER|CURRENCY|UNIT|STOCKITEM|VOUCHERTYPE|COSTCENTRE|GODOWN|STOCKGROUP)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  const ledgers: LedgerBlock[] = [];
  const others: string[] = [];
  for (const object of objects) {
    const nameMatch = object.match(/^<LEDGER NAME="([^"]*)"/);
    if (!nameMatch) {
      others.push(wrapMessage(object));
      continue;
    }
    const parent = xmlUnescape((object.match(/<PARENT>([^<]*)<\/PARENT>/) ?? [])[1] ?? '');
    ledgers.push({ name: xmlUnescape(nameMatch[1]), parent, block: wrapMessage(object) });
  }
  return { ledgers, others, head, tail };
}

function wrapMessage(object: string): string {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">${object}</TALLYMESSAGE>`;
}

function tallyAmount(drCr: 'Dr' | 'Cr', amount: number): string {
  const value = amount.toFixed(2);
  return drCr === 'Dr' ? `-${value}` : value;
}

function replaceOpening(block: string, opening: Opening | undefined, years: number): string {
  let out = block
    .replace(/<OPENINGBALANCE>[^<]*<\/OPENINGBALANCE>\s*/g, '')
    .replace(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>\s*/g, '');
  if (!opening) {
    return out;
  }
  const bills = (opening.bills ?? [])
    .map((bill) => `<BILLALLOCATIONS.LIST><NAME>${xmlEscape(bill.name)}</NAME><BILLDATE>${shiftDate(bill.date, years)}</BILLDATE><BILLCREDITPERIOD>0 Days</BILLCREDITPERIOD><ISADVANCE>No</ISADVANCE><OPENINGBALANCE>${tallyAmount(opening.dr_cr, bill.amount)}</OPENINGBALANCE></BILLALLOCATIONS.LIST>`)
    .join('');
  const insertion = `<OPENINGBALANCE>${tallyAmount(opening.dr_cr, opening.amount)}</OPENINGBALANCE>${bills}`;
  // Place it right after <PARENT>, which every ledger block has.
  out = out.replace(/(<PARENT>[^<]*<\/PARENT>)/, `$1${insertion}`);
  return out;
}

function newLedgerBlock(name: string, parent: string, billwise: boolean): string {
  return wrapMessage(`<LEDGER NAME="${xmlEscape(name)}" RESERVEDNAME=""><PARENT>${xmlEscape(parent)}</PARENT><ISBILLWISEON>${billwise ? 'Yes' : 'No'}</ISBILLWISEON><AFFECTSSTOCK>No</AFFECTSSTOCK><LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${xmlEscape(name)}</NAME></NAME.LIST><LANGUAGEID>1033</LANGUAGEID></LANGUAGENAME.LIST></LEDGER>`);
}

type VoucherSummary = { date: string; type: string; narration: string; legs: { ledger: string; amount: number }[] };

function summarizeVouchers(xml: string): VoucherSummary[] {
  const vouchers = xml.match(/<VOUCHER [\s\S]*?<\/VOUCHER>/g) ?? [];
  return vouchers.map((voucher) => {
    const get = (tag: string) => xmlUnescape((voucher.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) ?? [])[1] ?? '');
    // Item invoices carry the purchase/sales leg inside the stock item's
    // ACCOUNTINGALLOCATIONS.LIST, not in a ledger-entries list.
    const legs = [...voucher.matchAll(/<(?:ALLLEDGERENTRIES|LEDGERENTRIES|ACCOUNTINGALLOCATIONS)\.LIST>[\s\S]*?<LEDGERNAME>([^<]*)<\/LEDGERNAME>[\s\S]*?<AMOUNT>([^<]*)<\/AMOUNT>/g)]
      .map((m) => ({ ledger: xmlUnescape(m[1]), amount: Number(m[2]) }));
    return { date: get('DATE'), type: get('VOUCHERTYPENAME'), narration: get('NARRATION'), legs };
  });
}

function closingBalances(openings: Map<string, number>, vouchers: VoucherSummary[]): Map<string, number> {
  const balances = new Map<string, number>(openings);
  for (const voucher of vouchers) {
    for (const leg of voucher.legs) {
      balances.set(leg.ledger, (balances.get(leg.ledger) ?? 0) + leg.amount);
    }
  }
  return balances;
}

function main(): void {
  const mastersPath = arg('masters');
  const vouchersPath = arg('vouchers');
  const outDir = arg('out');
  const years = Number(arg('years', '2'));
  const company = arg('company');
  const configPath = arg('config', '');
  const config: Config = configPath ? (JSON.parse(readFileSync(configPath, 'utf8')) as Config) : {};
  const renames = renameMap(config);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // ---- Vouchers -----------------------------------------------------------
  let vouchersXml = readTallyXml(vouchersPath);
  const before = summarizeVouchers(vouchersXml);
  const dropRules = config.dropVouchers ?? [];
  let dropped = 0;
  const relabelRules = config.relabel ?? [];
  let relabelled = 0;
  vouchersXml = vouchersXml.replace(/<TALLYMESSAGE[^>]*>\s*<VOUCHER [\s\S]*?<\/VOUCHER>\s*<\/TALLYMESSAGE>/g, (message) => {
    const summary = summarizeVouchers(message)[0];
    const narration = summary.narration.trim().toUpperCase();
    const matches = dropRules.some(
      (rule) =>
        (rule.date === undefined || rule.date === summary.date) &&
        (rule.voucherType === undefined || rule.voucherType === summary.type) &&
        (rule.narration === undefined || narration === rule.narration.trim().toUpperCase()) &&
        (rule.narrationStartsWith === undefined || narration.startsWith(rule.narrationStartsWith.trim().toUpperCase())),
    );
    if (matches) {
      dropped += 1;
      return '';
    }
    let out = message;
    for (const rule of relabelRules) {
      if (rule.date !== summary.date || !narration.includes(rule.narrationContains.toUpperCase())) continue;
      const from = xmlEscape(rule.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const to = xmlEscape(rule.to);
      const next = out.replace(new RegExp(`<LEDGERNAME>${from}</LEDGERNAME>`, 'g'), `<LEDGERNAME>${to}</LEDGERNAME>`);
      if (next !== out) relabelled += 1;
      out = next;
    }
    return out;
  });
  vouchersXml = applyRenames(stripIdentity(shiftAllDates(vouchersXml, years)), renames);
  vouchersXml = vouchersXml.replace(/<SVCURRENTCOMPANY>[^<]*<\/SVCURRENTCOMPANY>/g, `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>`);
  const after = summarizeVouchers(vouchersXml);

  // ---- Masters ------------------------------------------------------------
  const mastersXml = readTallyXml(mastersPath);
  const { ledgers, others, head, tail } = splitLedgerMessages(stripIdentity(mastersXml));
  const openingsByAccount = new Map<string, Opening>();
  for (const opening of config.openings ?? []) openingsByAccount.set(opening.account, opening);
  const replaceOpenings = config.openings !== undefined;

  const keptLedgers: string[] = [];
  const existingNames = new Set<string>();
  for (const ledger of ledgers) {
    if (renames.has(ledger.name)) continue; // merged away
    let block = shiftAllDates(ledger.block, years);
    const parentOverride = config.parentOverride?.[ledger.name];
    if (parentOverride) block = block.replace(/<PARENT>[^<]*<\/PARENT>/, `<PARENT>${xmlEscape(parentOverride)}</PARENT>`);
    if (replaceOpenings) block = replaceOpening(block, openingsByAccount.get(ledger.name), years);
    keptLedgers.push(applyRenames(block, renames));
    existingNames.add(ledger.name);
  }
  // Rename targets that do not exist yet need a master of their own.
  for (const [, target] of renames) {
    if (existingNames.has(target.to)) continue;
    if (!target.parent) throw new Error(`Rename target "${target.to}" does not exist in the masters; give it a "parent" group so it can be created.`);
    const billwise = /Sundry (Debtors|Creditors)/i.test(target.parent);
    let block = newLedgerBlock(target.to, target.parent, billwise);
    if (replaceOpenings) block = replaceOpening(block, openingsByAccount.get(target.to), years);
    keptLedgers.push(block);
    existingNames.add(target.to);
  }
  for (const opening of config.openings ?? []) {
    if (!existingNames.has(opening.account)) throw new Error(`Opening balance given for "${opening.account}" but no such ledger exists after renames.`);
    const written = keptLedgers.find((block) => block.includes(`<LEDGER NAME="${xmlEscape(opening.account)}"`));
    if (!written || !written.includes(`<OPENINGBALANCE>${tallyAmount(opening.dr_cr, opening.amount)}</OPENINGBALANCE>`)) {
      throw new Error(`Opening balance for "${opening.account}" was not written into its ledger block.`);
    }
  }
  let outMasters = head + others.map((m) => shiftAllDates(m, years)).join('') + keptLedgers.join('') + tail;
  outMasters = outMasters.replace(/<SVCURRENTCOMPANY>[^<]*<\/SVCURRENTCOMPANY>/g, `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>`);

  const base = path.basename(vouchersPath, path.extname(vouchersPath));
  writeTallyXml(path.join(outDir, `${base}-shifted-masters.xml`), outMasters);
  writeTallyXml(path.join(outDir, `${base}-shifted-vouchers.xml`), vouchersXml);

  // ---- Check sheet --------------------------------------------------------
  const exportedOpenings = new Map<string, number>();
  for (const ledger of ledgers) {
    const ob = Number((ledger.block.match(/<OPENINGBALANCE>([^<]*)<\/OPENINGBALANCE>/) ?? [])[1] ?? '0');
    const name = renames.get(ledger.name)?.to ?? ledger.name;
    exportedOpenings.set(name, (exportedOpenings.get(name) ?? 0) + ob);
  }
  const newOpenings = new Map<string, number>();
  if (replaceOpenings) {
    for (const opening of config.openings ?? []) newOpenings.set(opening.account, Number(tallyAmount(opening.dr_cr, opening.amount)));
  }
  const beforeBalances = closingBalances(new Map(), before);
  const afterBalances = closingBalances(replaceOpenings ? newOpenings : exportedOpenings, after);
  const lines: string[] = [];
  lines.push(`Company: ${company} | shift: -${years} years | vouchers: ${before.length} in, ${after.length} out (${dropped} dropped, ${relabelled} relabelled)`);
  lines.push(`Dates: ${before.map((v) => v.date).sort()[0]}..${before.map((v) => v.date).sort().at(-1)} -> ${after.map((v) => v.date).sort()[0]}..${after.map((v) => v.date).sort().at(-1)}`);
  lines.push(`Ledgers: ${ledgers.length} exported, ${keptLedgers.length} written (${renames.size} renamed/merged)`);
  lines.push('');
  lines.push('Closing balance per ledger AFTER migration (Tally sign: negative = Dr). Movement column = vouchers only, so it can be compared with the old company.');
  const names = [...new Set([...afterBalances.keys(), ...newOpenings.keys()])].sort((a, b) => a.localeCompare(b));
  let totalDr = 0;
  let totalCr = 0;
  for (const name of names) {
    const closing = afterBalances.get(name) ?? 0;
    if (Math.abs(closing) < 0.005) continue;
    if (closing < 0) totalDr += -closing; else totalCr += closing;
    const movement = closingBalances(new Map(), after).get(name) ?? 0;
    lines.push(`  ${name.padEnd(36)} closing ${closing.toFixed(2).padStart(14)}   movement ${movement.toFixed(2).padStart(14)}`);
  }
  lines.push('');
  lines.push(`Trial balance after migration: Dr ${totalDr.toFixed(2)}  Cr ${totalCr.toFixed(2)}  difference ${(totalDr - totalCr).toFixed(2)}`);
  const beforeNames = [...beforeBalances.keys()].filter((n) => renames.has(n));
  if (beforeNames.length) lines.push(`Merged ledgers (old -> new): ${beforeNames.map((n) => `${n} -> ${renames.get(n)?.to}`).join('; ')}`);
  const report = lines.join('\n');
  writeFileSync(path.join(outDir, `${base}-check-sheet.txt`), report);
  console.log(report);
}

main();
