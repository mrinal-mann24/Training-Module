// One-time backfill for the movement-based Trial Balance tie-out
// (2026-09-09). Every scored submission so far was evaluated with the old
// closing-balance comparison, which failed forever after a learner's first
// slip: all three interns were capped at 'partial' for the whole programme
// and the trial_balance_tie_out concept never logged a pass.
//
// For each learner, walks the scored submissions in order, re-evaluates the
// tie-out with evaluateTrialBalanceTieOut (previous scored Trial Balance as
// the baseline, exactly as the jobs do now), and rewrites ONLY:
//   - scoring_results.tb_tie_out and overall_result (re-combined with the
//     stored explanation score, so a fail on the write-up stays a fail);
//   - the trial_balance_tie_out row in concept_attempts for that exercise
//     (updated in place, or inserted dated at the original scoring time when
//     the exercise logged none), then concept_mastery/module_progress are
//     recomputed from the corrected history.
// Per-voucher scores, error codes and feedback text are never touched.
//
//   npx tsx scripts/backfill-tie-out.ts --learners <id>,<id>            (dry run: prints changes)
//   npx tsx scripts/backfill-tie-out.ts --learners <id>,<id> --apply    (writes)
//
// Reads SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL from .env.local;
// never prints secrets.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';
import { getExerciseAnswerKeyForScoring } from '@/lib/db/queries/exercises';
import { getHintDepthForExercise } from '@/lib/db/queries/hint-requests';
import { recomputeMasteryAndModuleProgress } from '@/lib/jobs/advance-learner';
import { computeOverallResult, evaluateTrialBalanceTieOut } from '@/lib/tutor/score-submission';
import { combineOverallResult } from '@/lib/tutor/score-qualitative';
import type { ParsedTrialBalance } from '@/lib/schemas/voucher';
import type { QualitativeScoring } from '@/lib/schemas/qualitative-scoring';

function loadEnv(): void {
  const file = path.resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^"|"$/g, '');
    }
  }
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? '');
}

async function trialBalancePathFor(supabase: SupabaseClient, submission: { id: string; trialbalance_path: string | null }): Promise<string | null> {
  if (submission.trialbalance_path) return submission.trialbalance_path;
  const { data, error } = await supabase
    .from('submission_parts')
    .select('content')
    .eq('submission_id', submission.id)
    .eq('part_type', 'trialbalance_xml')
    .maybeSingle();
  if (error) throw error;
  return (data?.content as { storage_path?: string } | null)?.storage_path ?? null;
}

async function downloadTrialBalance(supabase: SupabaseClient, storagePath: string): Promise<ParsedTrialBalance | null> {
  const download = await supabase.storage.from('submissions').download(storagePath);
  if (download.error || !download.data) return null;
  try {
    return parseTrialBalanceXml(Buffer.from(await download.data.arrayBuffer()));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  const learners = (arg('learners') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (learners.length === 0) throw new Error('Pass --learners <uuid>,<uuid>');
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'APPLY mode: writing changes.' : 'DRY RUN: no writes. Add --apply to write.');

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const learnerId of learners) {
    const { data: submissions, error: subError } = await supabase
      .from('submissions')
      .select('id, exercise_id, created_at, trialbalance_path')
      .eq('learner_id', learnerId)
      .eq('status', 'scored')
      .order('created_at', { ascending: true });
    if (subError) throw subError;

    console.log(`\n== learner ${learnerId.slice(0, 8)}: ${submissions?.length ?? 0} scored submission(s)`);
    let previous: ParsedTrialBalance | null = null;
    let changed = 0;

    for (const submission of submissions ?? []) {
      const storagePath = await trialBalancePathFor(supabase, submission);
      const trialBalance = storagePath ? await downloadTrialBalance(supabase, storagePath) : null;
      if (!trialBalance) {
        console.log(`  ${submission.created_at.slice(0, 10)} ${submission.id.slice(0, 8)}: no Trial Balance file, skipped`);
        continue;
      }
      const answerKey = await getExerciseAnswerKeyForScoring(supabase, submission.exercise_id, learnerId);
      if (!answerKey) {
        console.log(`  ${submission.created_at.slice(0, 10)} ${submission.id.slice(0, 8)}: no answer key, skipped`);
        previous = trialBalance;
        continue;
      }
      const { data: result, error: resultError } = await supabase
        .from('scoring_results')
        .select('id, weighted_score, tb_tie_out, overall_result, qualitative_score, created_at')
        .eq('submission_id', submission.id)
        .maybeSingle();
      if (resultError) throw resultError;
      if (!result) {
        console.log(`  ${submission.created_at.slice(0, 10)} ${submission.id.slice(0, 8)}: no scoring result, skipped`);
        previous = trialBalance;
        continue;
      }

      const tieOut = evaluateTrialBalanceTieOut(trialBalance, answerKey, previous);
      const quantitative = computeOverallResult(Number(result.weighted_score), tieOut.tieOut);
      const overall = combineOverallResult(quantitative, (result.qualitative_score as QualitativeScoring | null) ?? null);

      const { data: attempt, error: attemptError } = await supabase
        .from('concept_attempts')
        .select('id, result')
        .eq('learner_id', learnerId)
        .eq('exercise_id', submission.exercise_id)
        .eq('concept_tag', 'trial_balance_tie_out')
        .maybeSingle();
      if (attemptError) throw attemptError;
      // New rule: the concept passes only when the export ties out AND the
      // tagged transactions (the old, structure-only judgement) were clean.
      const attemptResult: 'pass' | 'fail' = tieOut.tieOut ? (attempt ? (attempt.result as 'pass' | 'fail') : 'pass') : 'fail';

      const mismatchText = tieOut.mismatches
        .slice(0, 4)
        .map((m) => `${m.account} ${m.status === 'missing' ? 'missing' : (m.difference > 0 ? '+' : '') + Math.round(m.difference)}`)
        .join(', ');
      const delta = `tie-out ${result.tb_tie_out} -> ${tieOut.tieOut}; overall ${result.overall_result} -> ${overall}; concept ${attempt?.result ?? 'none'} -> ${attemptResult}`;
      const unchanged = result.tb_tie_out === tieOut.tieOut && result.overall_result === overall && (attempt?.result ?? null) === attemptResult;
      console.log(`  ${submission.created_at.slice(0, 10)} ${submission.id.slice(0, 8)} ${previous ? 'movement' : 'closing '} ${unchanged ? 'same    ' : 'CHANGE  '} ${delta}${mismatchText ? ` [${mismatchText}${tieOut.mismatches.length > 4 ? ', …' : ''}]` : ''}`);

      if (apply && !unchanged) {
        const { error: updateError } = await supabase
          .from('scoring_results')
          .update({ tb_tie_out: tieOut.tieOut, overall_result: overall })
          .eq('id', result.id);
        if (updateError) throw updateError;
        if (attempt) {
          if (attempt.result !== attemptResult) {
            const { error } = await supabase.from('concept_attempts').update({ result: attemptResult }).eq('id', attempt.id);
            if (error) throw error;
          }
        } else {
          const hintRungsUsed = await getHintDepthForExercise(supabase, learnerId, submission.exercise_id);
          const { error } = await supabase.from('concept_attempts').insert({
            learner_id: learnerId,
            exercise_id: submission.exercise_id,
            concept_tag: 'trial_balance_tie_out',
            result: attemptResult,
            hint_rungs_used: hintRungsUsed,
            created_at: result.created_at,
          });
          if (error) throw error;
        }
        changed += 1;
      }
      previous = trialBalance;
    }

    if (apply) {
      await recomputeMasteryAndModuleProgress(supabase, learnerId);
      console.log(`  ${changed} submission(s) updated; mastery and module progress recomputed.`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
