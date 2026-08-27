-- Unit 10: exercise_source_documents table + private Storage bucket for
-- generated PDF source documents (vendor invoices/bills, mock bank statements).

create table exercise_source_documents (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid not null references exercises (id) on delete cascade,
  doc_type text not null check (doc_type in ('vendor_invoice', 'bank_statement')),
  storage_path text not null,
  -- Learner-facing content (what the rendered document actually shows) —
  -- safe to store plainly, unlike exercises.answer_key, since this is exactly
  -- what the learner already sees in the PDF.
  structured_data jsonb not null,
  created_at timestamptz not null default now()
);

alter table exercise_source_documents enable row level security;

-- Learner can select only documents belonging to their own exercises, joined
-- through exercises.learner_id (this table has no learner_id column of its
-- own). No insert/update policy for authenticated — generation always writes
-- via the service-role client, same pattern as exercises.answer_key.
create policy "exercise_source_documents_select_own"
  on exercise_source_documents for select
  to authenticated
  using (
    exists (
      select 1 from exercises
      where exercises.id = exercise_source_documents.exercise_id
        and exercises.learner_id = auth.uid()
    )
  );

-- Private bucket. Path convention: exercise-documents/{learner_id}/{exercise_id}/{doc_id}.pdf
-- — enforced by the policies below via storage.foldername, same discipline as
-- the submissions bucket (Unit 5).
insert into storage.buckets (id, name, public)
values ('exercise-documents', 'exercise-documents', false);

create policy "exercise_documents_storage_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'exercise-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
