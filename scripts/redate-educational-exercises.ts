// Backfill (2026-09-17 audit): Educational Mode redating (educational-dates.ts)
// only runs for batches generated after 2026-09-16, and the identifier fix
// of 2026-09-17 after that. Open exercises of educational learners generated
// earlier can still carry dates Tally Educational Mode will not save (the
// 15th, the 30th) in their transaction lines, scenario, key narrations and
// the documents built from them. This script applies enforceEducationalDates
// to those exercises and rebuilds the derived documents with the same
// builders the generator uses:
//   - bank_statement: buildBankStatementContent from the redated key, the
//     opening balance recovered from the stored statement's first row, and
//     applyBankReferences so the key's narrations carry the new references;
//   - sales_invoice / month_end_note / sales_register: applyDocumentsMode on
//     the redated batch (its documents only; the stored text is kept);
//   - vendor_invoice (model-written content): every date string in the
//     structured data is redated with the same mapping.
//
//   npx tsx scripts/redate-educational-exercises.ts                    dry run, all educational learners
//   npx tsx scripts/redate-educational-exercises.ts --learners <id>,<id>
//   npx tsx scripts/redate-educational-exercises.ts --confirm          write the changes
//
// Dry run by default: it lists what would change and writes nothing. It
// never touches an exercise with a scored submission, and never changes an
// answer-key amount, ledger, sequence or bill reference (only narrations).
//
// PDFs: this script updates exercises.scenario / answer_key and
// exercise_source_documents.structured_data only. The stored PDF/CSV files
// still show the old dates until they are re-rendered from structured_data:
//   npx tsx scripts/regenerate-source-document-pdfs.ts --learners <id>,<id>
// which overwrites each file at its storage_path (open exercises only).
//
// Reads SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL from .env.local;
// never prints secrets.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { applyBankReferences, buildBankStatementContent } from '@/lib/documents/build-bank-statement';
import { extractTransactionDate } from '@/lib/llm/prompts/source-document';
import { GeneratedExerciseSchema, type AnswerKey, type GeneratedExercise } from '@/lib/schemas/exercise';
import { applyDocumentsMode } from '@/lib/tutor/documents-mode';
import { enforceEducationalDates, redateDescription, type CalendarMonth } from '@/lib/tutor/educational-dates';

const DEFAULT_COMPANY = 'Blossom Retail Pvt Ltd';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Structured-data fields that are identifiers, never dates.
const IDENTIFIER_FIELDS = new Set(['invoiceNumber', 'gstin', 'vendorGSTIN', 'buyerGSTIN', 'narration', 'pan']);

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

// The month most of the batch's transaction dates fall in; tokens of other
// months (a bill "dated 12-Apr-2024" named in a May batch) are left alone.
function batchMonthOf(generated: GeneratedExercise): CalendarMonth | null {
  const counts = new Map<string, { month: CalendarMonth; count: number }>();
  for (const transaction of generated.transactions) {
    const date = extractTransactionDate(transaction.description);
    if (!date) continue;
    const id = `${date.year}-${date.monthIndex}`;
    const slot = counts.get(id) ?? { month: { monthIndex: date.monthIndex, year: date.year }, count: 0 };
    slot.count += 1;
    counts.set(id, slot);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.month ?? null;
}

function redateStructured(value: unknown, month: CalendarMonth | null, field: string | null = null): unknown {
  if (typeof value === 'string') return field !== null && IDENTIFIER_FIELDS.has(field) ? value : redateDescription(value, month);
  if (Array.isArray(value)) return value.map((item) => redateStructured(item, month, field));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redateStructured(item, month, key)]));
  }
  return value;
}

type StoredDocument = { id: string; doc_type: string; structured_data: Record<string, unknown> };

function openingFromStatement(data: Record<string, unknown>): number | null {
  const rows = data.transactions;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0] as { balance?: number; debit?: number | null; credit?: number | null };
  if (typeof first.balance !== 'number') return null;
  return first.balance + (first.debit ?? 0) - (first.credit ?? 0);
}

function changedLines(before: string[], after: string[]): string[] {
  return before.flatMap((line, index) => (line === after[index] ? [] : [`      - ${line}\n      + ${after[index]}`]));
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local');
  const confirm = process.argv.includes('--confirm');
  const onlyLearners = (arg('learners') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  let profileQuery = supabase.from('learner_profile').select('id').eq('license_mode', 'educational');
  if (onlyLearners.length > 0) profileQuery = profileQuery.in('id', onlyLearners);
  const { data: profiles, error: profileError } = await profileQuery;
  if (profileError) throw profileError;
  const learners = (profiles ?? []).map((row) => row.id as string);
  console.log(`${confirm ? 'WRITING' : 'DRY RUN'}: ${learners.length} educational learner(s)`);
  if (learners.length === 0) return;

  const { data: scored, error: scoredError } = await supabase.from('submissions').select('exercise_id').in('learner_id', learners).eq('status', 'scored');
  if (scoredError) throw scoredError;
  const scoredExercises = new Set((scored ?? []).map((row) => row.exercise_id as string));

  const { data: exercises, error: exerciseError } = await supabase
    .from('exercises')
    .select('id, learner_id, kind, scenario, answer_key, created_at')
    .in('learner_id', learners)
    .order('created_at', { ascending: true });
  if (exerciseError) throw exerciseError;

  let changed = 0;
  const priorKeysByLearner = new Map<string, AnswerKey[]>();
  for (const exercise of exercises ?? []) {
    const learnerId = exercise.learner_id as string;
    const priorKeys = priorKeysByLearner.get(learnerId) ?? [];
    priorKeysByLearner.set(learnerId, [...priorKeys, exercise.answer_key as AnswerKey]);
    const label = `${learnerId.slice(0, 8)} ${(exercise.id as string).slice(0, 8)} ${exercise.kind}`;
    if (scoredExercises.has(exercise.id as string)) continue;
    if (exercise.kind === 'review') continue;

    const parsed = GeneratedExerciseSchema.safeParse({ ...(exercise.scenario as object), answer_key: exercise.answer_key });
    if (!parsed.success) {
      console.log(`  ${label}: skipped, stored exercise does not parse (${parsed.error.issues[0]?.message ?? 'invalid'})`);
      continue;
    }
    const original = parsed.data;
    const month = batchMonthOf(original);
    let redated: GeneratedExercise;
    try {
      redated = enforceEducationalDates(original, month);
    } catch (error) {
      console.log(`  ${label}: NOT FIXABLE automatically: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const { data: docs, error: docError } = await supabase
      .from('exercise_source_documents')
      .select('id, doc_type, structured_data')
      .eq('exercise_id', exercise.id);
    if (docError) throw docError;
    const stored = (docs ?? []) as StoredDocument[];

    const documentUpdates: { id: string; docType: string; data: unknown }[] = [];
    let final = redated;
    try {
      const statementDoc = stored.find((doc) => doc.doc_type === 'bank_statement');
      if (statementDoc) {
        const opening = openingFromStatement(statementDoc.structured_data) ?? 0;
        const statement = buildBankStatementContent({ companyName: DEFAULT_COMPANY, openingBankBalance: opening, generated: redated });
        if (statement) {
          final = applyBankReferences(redated, statement.referenceBySequence);
          documentUpdates.push({ id: statementDoc.id, docType: 'bank_statement', data: { ...statementDoc.structured_data, ...statement.content } });
        }
      }
      const codeBuilt = stored.filter((doc) => ['sales_invoice', 'month_end_note', 'sales_register'].includes(doc.doc_type));
      if (codeBuilt.length > 0) {
        const plan = applyDocumentsMode(final, {
          companyName: DEFAULT_COMPANY,
          monthLabel: month ? `${MONTH_NAMES[month.monthIndex]} ${month.year}` : 'this month',
          priorKeys,
        });
        const salesDocs = codeBuilt.filter((doc) => doc.doc_type === 'sales_invoice');
        salesDocs.forEach((doc, index) => {
          const byNumber = plan.salesInvoices.find((sale) => sale.content.invoiceNumber === doc.structured_data.invoiceNumber);
          const rebuilt = byNumber ?? plan.salesInvoices[index];
          if (rebuilt) documentUpdates.push({ id: doc.id, docType: 'sales_invoice', data: rebuilt.content });
        });
        for (const doc of codeBuilt) {
          if (doc.doc_type === 'month_end_note' && plan.monthEndNotes) documentUpdates.push({ id: doc.id, docType: doc.doc_type, data: plan.monthEndNotes });
          if (doc.doc_type === 'sales_register' && plan.salesRegister) documentUpdates.push({ id: doc.id, docType: doc.doc_type, data: plan.salesRegister });
        }
      }
      for (const doc of stored.filter((item) => item.doc_type === 'vendor_invoice')) {
        documentUpdates.push({ id: doc.id, docType: doc.doc_type, data: redateStructured(doc.structured_data, month) });
      }
    } catch (error) {
      console.log(`  ${label}: NOT FIXABLE automatically (documents): ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const textChanges = [
      ...changedLines([original.scenario], [final.scenario]),
      ...changedLines(
        original.transactions.map((t) => t.description),
        final.transactions.map((t) => t.description),
      ),
      ...changedLines(
        original.answer_key.entries.map((e) => e.narration ?? ''),
        final.answer_key.entries.map((e) => e.narration ?? ''),
      ),
    ];
    const docChanges = documentUpdates.filter((update) => {
      const before = stored.find((doc) => doc.id === update.id)?.structured_data;
      return JSON.stringify(before) !== JSON.stringify(update.data);
    });
    if (textChanges.length === 0 && docChanges.length === 0) continue;
    changed += 1;
    console.log(`  ${label}: ${textChanges.length} text change(s), ${docChanges.length} document(s) to rebuild (${docChanges.map((d) => d.docType).join(', ') || 'none'})`);
    for (const line of textChanges) console.log(line);

    // Nothing but dates and the references derived from them may change.
    const keyShape = (generated: GeneratedExercise) =>
      JSON.stringify(generated.answer_key.entries.map((e) => [e.sequence, e.correct_account, e.dr_cr, e.amount, e.bill_reference]));
    if (keyShape(original) !== keyShape(final)) {
      console.log(`  ${label}: ABORTED, the answer key's legs would change`);
      continue;
    }

    if (!confirm) continue;
    const { scenario, transactions, difficulty_level, variant, answer_key } = final;
    const { error: updateError } = await supabase
      .from('exercises')
      .update({ scenario: { ...(exercise.scenario as object), scenario, transactions, difficulty_level, variant }, answer_key })
      .eq('id', exercise.id);
    if (updateError) throw updateError;
    for (const update of docChanges) {
      const { error: documentError } = await supabase.from('exercise_source_documents').update({ structured_data: update.data }).eq('id', update.id);
      if (documentError) throw documentError;
    }
  }
  console.log(`${confirm ? 'Updated' : 'Would update'} ${changed} exercise(s).`);
  if (changed > 0) {
    console.log('Next: re-render the stored files, e.g. npx tsx scripts/regenerate-source-document-pdfs.ts --learners <id>,<id>');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
