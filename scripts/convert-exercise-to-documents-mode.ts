// Converts an already-generated, unsubmitted batch to documents mode in
// place (2026-09-09): the three interns had crossed the mastery threshold
// before documents mode shipped, and their open March batches were still in
// the old text format. Runs the same applyDocumentsMode the generator uses,
// so the answer key's figures never change — only the brief lines become
// pointers, every leg is flagged document-backed, and the documents that
// did not exist yet (sales invoices / cash memos, the month-end notes sheet)
// are rendered and attached. Vendor invoices and the bank statement already
// exist and are left alone.
//
//   npx tsx scripts/convert-exercise-to-documents-mode.ts --exercise <uuid>[,<uuid>...]
//
// Refuses an exercise that already has a scored submission or that is
// already in documents mode. Reads .env.local; never prints secrets.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { GeneratedExerciseSchema } from '@/lib/schemas/exercise';
import { renderSourceDocument } from '@/lib/documents/render-source-document';
import { applyDocumentsMode } from '@/lib/tutor/documents-mode';
import { extractTransactionDate } from '@/lib/llm/prompts/source-document';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULT_COMPANY = 'Blossom Retail Pvt Ltd';

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
  const exerciseIds = (arg('exercise') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (exerciseIds.length === 0) throw new Error('Pass --exercise <uuid>[,<uuid>...]');

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const exerciseId of exerciseIds) {
    const { data: exercise, error } = await supabase
      .from('exercises')
      .select('id, learner_id, kind, scenario, answer_key')
      .eq('id', exerciseId)
      .single();
    if (error) throw error;

    const { data: scored, error: subError } = await supabase
      .from('submissions')
      .select('id')
      .eq('exercise_id', exerciseId)
      .eq('status', 'scored');
    if (subError) throw subError;
    if ((scored ?? []).length > 0) {
      console.log(`${exerciseId.slice(0, 8)}: already scored, skipped`);
      continue;
    }

    const generated = GeneratedExerciseSchema.parse({ ...(exercise.scenario as object), answer_key: exercise.answer_key });
    if (generated.scenario.includes('Documents mode:')) {
      console.log(`${exerciseId.slice(0, 8)}: already in documents mode, skipped`);
      continue;
    }

    const firstDate = extractTransactionDate(generated.transactions[0]?.description ?? '');
    const monthLabel = firstDate ? `${MONTH_NAMES[firstDate.monthIndex]} ${firstDate.year}` : 'this month';
    const plan = applyDocumentsMode(generated, { companyName: DEFAULT_COMPANY, monthLabel });

    // Keep the new PDFs in the batch's existing storage folder.
    const { data: existingDocs, error: docsError } = await supabase
      .from('exercise_source_documents')
      .select('storage_path, doc_type')
      .eq('exercise_id', exerciseId);
    if (docsError) throw docsError;
    const folder = existingDocs?.[0]?.storage_path.split('/').slice(0, 2).join('/') ?? `${exercise.learner_id}/${crypto.randomUUID()}`;

    const toRender = [
      ...plan.salesInvoices.map(({ sequence, content }) => ({ document: { doc_type: 'sales_invoice' as const, content }, seed: `sales:${sequence}` })),
      ...(plan.monthEndNotes ? [{ document: { doc_type: 'month_end_note' as const, content: plan.monthEndNotes }, seed: 'month-end-notes' }] : []),
      ...(plan.salesRegister ? [{ document: { doc_type: 'sales_register' as const, content: plan.salesRegister }, seed: 'sales-register' }] : []),
    ];
    for (const { document, seed } of toRender) {
      const rendered = await renderSourceDocument(document, `${folder}:${seed}`);
      const storagePath = `${folder}/${crypto.randomUUID()}.${rendered.extension}`;
      const { error: uploadError } = await supabase.storage
        .from('exercise-documents')
        .upload(storagePath, rendered.bytes, { contentType: rendered.contentType });
      if (uploadError) throw uploadError;
      const { error: insertError } = await supabase
        .from('exercise_source_documents')
        .insert({ exercise_id: exerciseId, doc_type: document.doc_type, storage_path: storagePath, structured_data: document.content });
      if (insertError) throw insertError;
    }

    const { scenario, transactions, difficulty_level, variant, answer_key } = plan.generated;
    const { error: updateError } = await supabase
      .from('exercises')
      .update({ scenario: { ...(exercise.scenario as object), scenario, transactions, difficulty_level, variant }, answer_key })
      .eq('id', exerciseId);
    if (updateError) throw updateError;

    const amountsBefore = generated.answer_key.entries.map((e) => e.amount).join(',');
    const amountsAfter = answer_key.entries.map((e) => e.amount).join(',');
    console.log(
      `${exerciseId.slice(0, 8)} (${exercise.kind}, ${monthLabel}): ${transactions.length} lines rewritten, ` +
        `${plan.salesInvoices.length} sales document(s) + ${plan.monthEndNotes ? 1 : 0} notes sheet added to ${(existingDocs ?? []).length} existing, ` +
        `key amounts unchanged: ${amountsBefore === amountsAfter}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
