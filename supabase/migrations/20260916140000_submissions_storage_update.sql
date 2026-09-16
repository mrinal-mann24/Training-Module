-- Re-sending a submission's files needs UPDATE on storage.objects (2026-09-16).
--
-- 20260812150000 created the 'submissions' bucket with exactly two policies:
-- select-own and insert-own. That was enough while a file could only ever be
-- written once. It stopped being enough when uploadSubmissionXmlFiles started
-- passing upsert: true.
--
-- Supabase Storage implements upsert as an INSERT ... ON CONFLICT DO UPDATE on
-- storage.objects, so overwriting an existing object is checked against the
-- UPDATE policy, not the INSERT one. Without this policy the upsert is refused
-- by RLS, and the learner sees the very message the upsert was added to
-- remove: "Something went wrong on my side while saving your Day Book file."
--
-- Why the overwrite is needed at all: submitFiles rejoins an open submission
-- rather than starting a new one (getOpenSubmissionForExercise matches
-- 'validating' and 'scoring'), and the Storage path is derived from the
-- submission id, so a second send of the same exercise lands on the objects
-- the first send already wrote. A half-finished first attempt (files and rows
-- written, then the Inngest send fails) therefore blocked every later attempt
-- permanently, with advice to "send both files again" that could never work.
--
-- Same predicate as the insert policy: the first path segment must be the
-- caller's own user id, so a learner can only ever overwrite their own files.
-- UPDATE takes both USING (which rows may be updated) and WITH CHECK (what
-- they may become); both are scoped identically, so a learner cannot move an
-- object into another learner's folder.

create policy "submissions_storage_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
