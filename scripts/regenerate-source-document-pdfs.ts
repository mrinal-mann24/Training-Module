// Re-renders the PDF for every source document of the given learners'
// OPEN exercises (no scored submission yet) from the structured data stored
// in exercise_source_documents, and overwrites the file at the same
// storage_path. Used after Downloads/patch-timeline-shift-2024.sql moved the
// dates in structured_data: the stored PDFs still showed 2026/2027 dates.
// Rendering is deterministic code (renderSourceDocumentPdf), no LLM call.
//
//   npx tsx scripts/regenerate-source-document-pdfs.ts --learners <id>,<id>,...
//   npx tsx scripts/regenerate-source-document-pdfs.ts --learners <id> --all   (scored exercises too)
//
// Reads SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL from .env.local;
// never prints secrets.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { renderSourceDocumentPdf } from '@/lib/documents/render-source-document';
import { GeneratedSourceDocumentSchema } from '@/lib/schemas/source-document';

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

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local');
  const learners = (arg('learners') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (learners.length === 0) throw new Error('Pass --learners <uuid>,<uuid>');
  const includeScored = process.argv.includes('--all');

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: exercises, error: exError } = await supabase
    .from('exercises')
    .select('id, learner_id, kind, created_at')
    .in('learner_id', learners)
    .order('created_at', { ascending: true });
  if (exError) throw exError;

  const { data: scored, error: subError } = await supabase
    .from('submissions')
    .select('exercise_id')
    .in('learner_id', learners)
    .eq('status', 'scored');
  if (subError) throw subError;
  const scoredExercises = new Set((scored ?? []).map((row) => row.exercise_id as string));

  const targets = (exercises ?? []).filter((exercise) => includeScored || !scoredExercises.has(exercise.id as string));
  console.log(`Exercises to refresh: ${targets.length} (${includeScored ? 'all' : 'open only'})`);

  let rendered = 0;
  for (const exercise of targets) {
    const { data: docs, error: docError } = await supabase
      .from('exercise_source_documents')
      .select('id, doc_type, storage_path, structured_data')
      .eq('exercise_id', exercise.id);
    if (docError) throw docError;

    for (const doc of docs ?? []) {
      const generated = GeneratedSourceDocumentSchema.parse({ doc_type: doc.doc_type, content: doc.structured_data });
      // The seed only picks the visual template; keep it stable per document.
      const pdf = await renderSourceDocumentPdf(generated, `${exercise.id}:${doc.id}`);
      const { error: uploadError } = await supabase.storage
        .from('exercise-documents')
        .upload(doc.storage_path as string, pdf, { contentType: 'application/pdf', upsert: true });
      if (uploadError) throw uploadError;
      rendered += 1;
      const label = doc.doc_type === 'bank_statement'
        ? `bank statement ${(doc.structured_data as { period?: string }).period ?? ''}`
        : `invoice ${(doc.structured_data as { invoiceNumber?: string; invoiceDate?: string }).invoiceNumber ?? ''} ${(doc.structured_data as { invoiceDate?: string }).invoiceDate ?? ''}`;
      console.log(`  ${(exercise.learner_id as string).slice(0, 8)} ${(exercise.id as string).slice(0, 8)} ${exercise.kind}: ${label}`);
    }
  }
  console.log(`Re-rendered ${rendered} PDF(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
