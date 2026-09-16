-- One-off, OPTIONAL, NOT a migration. Run by hand only after
-- scripts/upload-educational-pack.mjs has uploaded packs/variant-a-edu/*.
--
-- 2026-09-16: new educational learners get the re-dated Educational Mode pack
-- files at assignment (assignPackDiagnostic -> resolvePackFilesForLicense).
-- Learners assigned the pack BEFORE that keep scenario.pack_files pointing at
-- variant-a/, whose dates Tally Educational Mode refuses. This repoints their
-- pack exercises that have not reached scoring yet, so the chat's download
-- cards (signed from scenario.pack_files on every page load and click) serve
-- the re-dated copies. Only storage_path changes; labels, the answer key,
-- expected_voucher_count and every other scenario field stay as they are.
--
-- Skipped on purpose:
--   * exercises with a submission in 'scoring' or 'scored' (their feedback
--     was written against the files they downloaded);
--   * exercises whose paths are already "-edu";
--   * any exercise whose re-dated objects are not ALL present in Storage.
--
-- Step 1: preview (read-only).
with candidates as (
  select e.id, e.learner_id, e.scenario -> 'pack_files' as pack_files
  from exercises e
  join learner_profile lp on lp.id = e.learner_id
  where lp.license_mode = 'educational'
    and e.kind = 'diagnostic'
    and jsonb_typeof(e.scenario -> 'pack_files') = 'array'
    and jsonb_array_length(e.scenario -> 'pack_files') > 0
    and not exists (
      select 1 from jsonb_array_elements(e.scenario -> 'pack_files') f
      where split_part(f ->> 'storage_path', '/', 1) like '%-edu'
    )
    and not exists (
      select 1 from submissions s
      where s.exercise_id = e.id and s.status in ('scoring', 'scored')
    )
)
select c.id, c.learner_id,
  (select jsonb_agg(regexp_replace(f ->> 'storage_path', '^([^/]+)/', '\1-edu/') order by ord)
     from jsonb_array_elements(c.pack_files) with ordinality t(f, ord)) as new_paths,
  not exists (
    select 1 from jsonb_array_elements(c.pack_files) f
    where not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'packs'
        and o.name = regexp_replace(f ->> 'storage_path', '^([^/]+)/', '\1-edu/')
    )
  ) as all_copies_uploaded
from candidates c;

-- Step 2: repoint (review step 1 first; rows with all_copies_uploaded = false
-- are left alone by the same guard).
begin;

update exercises e
set scenario = jsonb_set(
  e.scenario,
  '{pack_files}',
  (
    select jsonb_agg(
      jsonb_set(f, '{storage_path}', to_jsonb(regexp_replace(f ->> 'storage_path', '^([^/]+)/', '\1-edu/')))
      order by ord
    )
    from jsonb_array_elements(e.scenario -> 'pack_files') with ordinality t(f, ord)
  )
)
from learner_profile lp
where lp.id = e.learner_id
  and lp.license_mode = 'educational'
  and e.kind = 'diagnostic'
  and jsonb_typeof(e.scenario -> 'pack_files') = 'array'
  and jsonb_array_length(e.scenario -> 'pack_files') > 0
  and not exists (
    select 1 from jsonb_array_elements(e.scenario -> 'pack_files') f
    where split_part(f ->> 'storage_path', '/', 1) like '%-edu'
  )
  and not exists (
    select 1 from submissions s
    where s.exercise_id = e.id and s.status in ('scoring', 'scored')
  )
  and not exists (
    select 1 from jsonb_array_elements(e.scenario -> 'pack_files') f
    where not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'packs'
        and o.name = regexp_replace(f ->> 'storage_path', '^([^/]+)/', '\1-edu/')
    )
  )
returning e.id, e.learner_id, e.scenario -> 'pack_files' as pack_files;

-- Defaults to rollback so pasting the whole file changes nothing. After
-- checking the returned rows, run step 2 again ending in commit instead.
rollback;
-- commit;
