import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDayBookXml } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';

const DIR = 'D:/Mrinal.Manna/OneDrive - KOREFI BUSINESS SOLUTIONS PRIVATE LIMITED/Downloads/Praveen';

describe('praveen july upload', () => {
  it('parses both files', () => {
    const db = parseDayBookXml(readFileSync(`${DIR}/daybookjuly.xml`));
    console.log('DAYBOOK vouchers:', db.vouchers.length);
    console.log(JSON.stringify(db, null, 2));

    const tb = parseTrialBalanceXml(readFileSync(`${DIR}/TrialBal july.xml`));
    console.log('TB keys:', Object.keys(tb));
    console.log(JSON.stringify(tb).slice(0, 3000));
  });
});
