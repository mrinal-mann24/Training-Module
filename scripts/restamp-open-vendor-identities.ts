// One-time restamp (2026-09-10) of vendor invoices on OPEN exercises (no
// scored submission yet) with the party directory's fixed GSTIN and address.
// Invoices generated before the directory carried a model-invented GSTIN
// whose state code changed from one invoice to the next, so AI Accountant
// could never match the vendor master. Rewrites structured_data.vendorGSTIN
// and vendorAddress, then re-renders the PDF at the same storage path.
// Figures, dates and invoice numbers are untouched.
//
//   npx tsx scripts/restamp-open-vendor-identities.ts --learners <id>,<id>          (dry run)
//   npx tsx scripts/restamp-open-vendor-identities.ts --learners <id>,<id> --apply
//
// Reads SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL from .env.local;
// never prints secrets.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { partyDetailsFor } from '@/lib/documents/party-directory';
import { renderSourceDocument } from '@/lib/documents/render-source-document';
import { GeneratedSourceDocumentSchema, type VendorInvoiceContent } from '@/lib/schemas/source-document';

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

// IGST on the invoice → inter-state vendor; CGST/SGST → home state; no tax → unknown.
function interStateOf(content: VendorInvoiceContent): boolean | null {
  const { cgst_amount, sgst_amount, igst_amount } = content.taxBreakup;
  if (igst_amount) return true;
  if (cgst_amount || sgst_amount) return false;
  return null;
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

  const { data: exercises, error: exError } = await supabase
    .from('exercises')
    .select('id, learner_id, created_at')
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

  let changed = 0;
  for (const exercise of (exercises ?? []).filter((e) => !scoredExercises.has(e.id as string))) {
    const { data: docs, error: docError } = await supabase
      .from('exercise_source_documents')
      .select('id, doc_type, storage_path, structured_data')
      .eq('exercise_id', exercise.id)
      .eq('doc_type', 'vendor_invoice');
    if (docError) throw docError;

    for (const doc of docs ?? []) {
      const content = doc.structured_data as VendorInvoiceContent;
      const party = partyDetailsFor(content.vendorName, interStateOf(content));
      const same = content.vendorGSTIN === party.gstin && content.vendorAddress === party.address;
      console.log(
        `  ${(exercise.learner_id as string).slice(0, 8)} ${(exercise.id as string).slice(0, 8)} ${content.invoiceNumber.padEnd(12)} ${content.vendorName.padEnd(20)} ${content.vendorGSTIN} -> ${party.gstin}${same ? '  (already stamped)' : ''}`,
      );
      if (same || !apply) continue;
      const updated: VendorInvoiceContent = { ...content, vendorGSTIN: party.gstin, vendorAddress: party.address };
      const generated = GeneratedSourceDocumentSchema.parse({ doc_type: 'vendor_invoice', content: updated });
      const rendered = await renderSourceDocument(generated, `${exercise.id}:${doc.id}`);
      const { error: uploadError } = await supabase.storage
        .from('exercise-documents')
        .upload(doc.storage_path as string, rendered.bytes, { contentType: rendered.contentType, upsert: true });
      if (uploadError) throw uploadError;
      const { error: updateError } = await supabase
        .from('exercise_source_documents')
        .update({ structured_data: updated })
        .eq('id', doc.id);
      if (updateError) throw updateError;
      changed += 1;
    }
  }
  console.log(apply ? `Restamped ${changed} invoice(s).` : 'Dry run complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
