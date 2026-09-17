import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { parseDayBookXml } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';
import type { AnswerKey } from '@/lib/schemas/exercise';
import { inheritAccountAliases } from '@/lib/tutor/answer-key-aliases';
import { scoreSubmission } from '@/lib/tutor/score-submission';

// Temporary replay (2026-09-17): delete after use.
it('replays the Elina pilot', () => {
  const out = process.env.REPLAY_OUT ?? 'replay.json';
  const key = JSON.parse(readFileSync('seed/blossom-variant-a/answer_key.json', 'utf8')) as AnswerKey;
  const scoredKey = inheritAccountAliases(key, [key]);
  const dayBook = parseDayBookXml(readFileSync('xmls/pilot-submission/elina-daybook.xml'));
  const trialBalance = parseTrialBalanceXml(readFileSync('xmls/pilot-submission/elina-trialbal.xml'));
  const result = scoreSubmission(dayBook, trialBalance, scoredKey);
  const flagged: Record<string, string[]> = {};
  for (const diff of result.per_voucher_diffs) {
    if (diff.is_correct) continue;
    const id = String(diff.voucherRef);
    flagged[id] = [...(flagged[id] ?? []), `${diff.field}${diff.leg !== undefined ? `#${diff.leg}` : ''}:${diff.error_code}`];
  }
  writeFileSync(
    out,
    JSON.stringify(
      {
        weighted: result.weighted_score,
        overall: result.overall_result,
        tieOut: result.tb_tie_out,
        mismatches: result.tb_tie_out_mismatches,
        flagged,
        unmatched: result.unmatched_vouchers?.length,
        findings: result.ledger_findings,
        composites: result.composite_matches,
      },
      null,
      2,
    ),
  );
});
