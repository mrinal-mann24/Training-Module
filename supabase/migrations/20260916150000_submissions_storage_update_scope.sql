  -- Narrow the submissions bucket's UPDATE policy to unscored submissions
  -- (2026-09-16).
  --
  -- 20260916140000 added submissions_storage_update_own so that a re-sent
  -- export could overwrite a half-finished submission's files. Its predicate was
  -- only "the object is in your own folder", which allowed a learner to
  -- overwrite ANY of their submission files, including ones already scored.
  -- That broke two things:
  --
  -- 1. architecture.md's storage model states uploaded Day Book and Trial
  --    Balance XMLs are "immutable once submitted".
  -- 2. It opened a real tampering path. The movement-based tie-out takes the
  --    most recent SCORED Trial Balance as next month's baseline
  --    (getPreviousScoredTrialBalancePath, downloaded in
  --    lib/jobs/advance-learner.ts). A learner could rewrite that old file
  --    directly through the Storage API and change what the next batch's
  --    tie-out, and the trial_balance_tie_out concept's mastery, is measured
  --    against.
  --
  -- The overwrite exists for exactly one case: a submission stranded at
  -- 'validating' because the first attempt uploaded its files and wrote its rows
  -- but then failed before the scoring job was sent. So that is the only case
  -- this policy now allows. A submission that is 'scoring' or 'scored' keeps its
  -- files immutable; an attempt to overwrite one is refused and the learner sees
  -- the ordinary "could not save" message, which for a 'scoring' submission is
  -- also correct: files must not be swapped under a running scorer.
  --
  -- Unaffected by design:
  -- - A first upload is an INSERT, checked by submissions_storage_insert_own.
  --   It has to be: submitFiles uploads before the submissions row exists, so
  --   no status-based predicate could ever apply to it.
  -- - A correction round gets a new submission id and therefore new paths, so
  --   it is an INSERT too.
  -- - A re-send after a gate rejection ('invalid') starts a new submission for
  --   the same reason, since getOpenSubmissionForExercise never matches it.
  --
  -- Path layout is {learner_id}/{submission_id}/{file}, so foldername()[1] is
  -- the learner and [2] the submission. The id is compared as text rather than
  -- cast to uuid: a learner can create an object at a malformed path inside
  -- their own folder (the insert policy checks only [1]), and a uuid cast would
  -- raise an error on that row instead of simply denying. This runs once per
  -- single-object upload, so the lost index on submissions.id costs nothing
  -- measurable. auth.uid() is wrapped in a select so it is evaluated once.
  --
  -- UPDATE takes both USING (which existing rows may be updated) and WITH CHECK
  -- (what they may become). Both carry the full predicate, so a learner can
  -- neither overwrite a scored file nor move an object into one.

  drop policy if exists "submissions_storage_update_own" on storage.objects;

  create policy "submissions_storage_update_own"
    on storage.objects for update
    to authenticated
    using (
      bucket_id = 'submissions'
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and exists (
        select 1
        from public.submissions s
        where s.id::text = (storage.foldername(name))[2]
          and s.learner_id = (select auth.uid())
          and s.status = 'validating'
      )
    )
    with check (
      bucket_id = 'submissions'
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and exists (
        select 1
        from public.submissions s
        where s.id::text = (storage.foldername(name))[2]
          and s.learner_id = (select auth.uid())
          and s.status = 'validating'
      )
    );
