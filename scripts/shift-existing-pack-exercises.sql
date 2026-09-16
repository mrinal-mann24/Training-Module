-- One-off, OPTIONAL, NOT a migration. Run by hand only after
-- scripts/apply-pack-year-shift.mjs --confirm has moved the pack to 2024.
--
-- 2026-09-16: assignPackDiagnostic copies exercise_packs.day1_message into
-- exercises.scenario.scenario and the pack key into exercises.answer_key at
-- assignment. Learners assigned the pack before the shift keep "Books Begin
-- Date as 1-Apr-2026" / "Trial Balance as on 30-Apr-2026" and narrations such
-- as "NEFT/N26040201/DECCAN/MARCHPMT", while their download cards (signed from
-- scenario.pack_files, which still point at variant-a/ or variant-a-edu/)
-- now serve the 2024 files. This moves those copies to 2024 with the same
-- rules as the 2026-09-09 timeline patch: "DD-Mon-2026", "D-Month-2026",
-- "Month 2026", and bank references "/N26MMDDnn/" or "/26MMDDnn/" (month
-- 01-12, day 01-31). Bill numbers that contain 26 (CA26-101) are untouched.
--
-- Skipped on purpose: exercises with a submission in 'scoring' or 'scored'.
-- Their Day Book was posted in 2026 against the 2026 message and files, and
-- the stored diffs and coaching quote that material; rewriting their copy
-- would make the record disagree with what the learner actually did and
-- submitted. Scoring never reads these dates (the gate checks voucher dates
-- against learner_profile.books_begin_date and today; diffBankReference only
-- checks narrations that carry "Ref <bank ref>", which pack narrations do
-- not), so leaving them changes no score.
-- As of 2026-09-16 all three pack exercises are scored, so step 2 is
-- expected to update 0 rows; it is kept for anyone assigned before the upload.
--
-- Step 1: preview (read-only).
with candidates as (
  select e.id, e.learner_id, e.scenario, e.answer_key
  from exercises e
  where e.kind = 'diagnostic'
    and jsonb_typeof(e.scenario -> 'pack_files') = 'array'
    and jsonb_array_length(e.scenario -> 'pack_files') > 0
    and not exists (
      select 1 from submissions s
      where s.exercise_id = e.id and s.status in ('scoring', 'scored')
    )
),
shifted as (
  select c.id, c.learner_id,
    c.scenario ->> 'scenario' as old_message,
    regexp_replace(
      regexp_replace(
        regexp_replace(
          c.scenario ->> 'scenario',
          '(\m\d{1,2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-)2026\M', '\12024', 'gi'),
        '(\m\d{1,2}-(January|February|March|April|May|June|July|August|September|October|November|December)-)2026\M', '\12024', 'gi'),
      '(\m(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+)2026\M', '\12024', 'gi'
    ) as new_message,
    (
      select count(*)
      from jsonb_array_elements(c.answer_key -> 'entries') leg
      where leg ->> 'narration' ~ '/(N|CD|CW)?26(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{2}/'
    ) as narrations_to_shift
  from candidates c
)
select id, learner_id,
  old_message <> new_message as message_changes,
  (select array_agg(m[1]) from regexp_matches(old_message, '([^\n]{0,30}2026[^\n]{0,10})', 'g') m) as message_2026_before,
  (select array_agg(m[1]) from regexp_matches(new_message, '([^\n]{0,30}2024[^\n]{0,10})', 'g') m) as message_2024_after,
  narrations_to_shift
from shifted
where old_message <> new_message or narrations_to_shift > 0;

-- Step 2: shift (review step 1 first).
begin;

with candidates as (
  select e.id
  from exercises e
  where e.kind = 'diagnostic'
    and jsonb_typeof(e.scenario -> 'pack_files') = 'array'
    and jsonb_array_length(e.scenario -> 'pack_files') > 0
    and not exists (
      select 1 from submissions s
      where s.exercise_id = e.id and s.status in ('scoring', 'scored')
    )
),
shifted as (
  select e.id,
    jsonb_set(
      e.scenario,
      '{scenario}',
      to_jsonb(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              e.scenario ->> 'scenario',
              '(\m\d{1,2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-)2026\M', '\12024', 'gi'),
            '(\m\d{1,2}-(January|February|March|April|May|June|July|August|September|October|November|December)-)2026\M', '\12024', 'gi'),
          '(\m(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+)2026\M', '\12024', 'gi'
        )
      )
    ) as new_scenario,
    jsonb_set(
      e.answer_key,
      '{entries}',
      (
        select jsonb_agg(
          case
            when jsonb_typeof(leg -> 'narration') = 'string' then
              jsonb_set(leg, '{narration}', to_jsonb(regexp_replace(
                leg ->> 'narration',
                '/(N|CD|CW)?26((0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{2})/', '/\124\2/', 'g')))
            else leg
          end
          order by ord
        )
        from jsonb_array_elements(e.answer_key -> 'entries') with ordinality t(leg, ord)
      )
    ) as new_answer_key
  from exercises e
  join candidates c on c.id = e.id
  where jsonb_typeof(e.scenario -> 'scenario') = 'string'
    and jsonb_typeof(e.answer_key -> 'entries') = 'array'
    and jsonb_array_length(e.answer_key -> 'entries') > 0
)
update exercises e
set scenario = s.new_scenario,
    answer_key = s.new_answer_key
from shifted s
where s.id = e.id
  and (e.scenario is distinct from s.new_scenario or e.answer_key is distinct from s.new_answer_key)
returning e.id, e.learner_id,
  (select array_agg(m[1]) from regexp_matches(e.scenario ->> 'scenario', '([^\n]{0,30}202[46][^\n]{0,10})', 'g') m) as message_dates_after;

-- Defaults to rollback so pasting the whole file changes nothing. After
-- checking the returned rows, run step 2 again ending in commit instead.
-- Idempotent: a second run finds no 2026 token and updates 0 rows.
rollback;
-- commit;
