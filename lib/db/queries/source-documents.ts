import type { SupabaseClient } from '@supabase/supabase-js';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

// Client-facing shape for a document card — url is a signed URL resolved by
// the caller (getSignedSourceDocumentUrls below), storage_path itself is
// never sent to the client.
export type SourceDocumentForLearner = {
  id: string;
  exerciseId: string;
  docType: SourceDocumentType;
  storagePath: string;
  documentName: string;
  createdAt: string;
};

const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Resolves a signed URL for each document's storage_path, using the
// authenticated (not service-role) client — the exercise-documents bucket's
// select policy is scoped via storage.foldername to auth.uid(), so this call
// naturally enforces the same learner-scoping as every other Storage read in
// this codebase, rather than adding a separate application-level check.
export async function getSignedSourceDocumentUrls(
  supabase: SupabaseClient,
  documents: SourceDocumentForLearner[],
): Promise<{ id: string; docType: SourceDocumentType; documentName: string; url: string }[]> {
  const resolved = await Promise.all(
    documents.map(async (doc) => {
      const { data, error } = await supabase.storage
        .from('exercise-documents')
        .createSignedUrl(doc.storagePath, SIGNED_URL_TTL_SECONDS);

      if (error || !data) {
        throw error ?? new Error(`Could not create a signed URL for document ${doc.id}.`);
      }

      return { id: doc.id, docType: doc.docType, documentName: doc.documentName, url: data.signedUrl };
    }),
  );

  return resolved;
}

export async function insertSourceDocument(
  supabase: SupabaseClient,
  exerciseId: string,
  docType: SourceDocumentType,
  storagePath: string,
  structuredData: unknown,
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('exercise_source_documents')
    .insert({
      exercise_id: exerciseId,
      doc_type: docType,
      storage_path: storagePath,
      structured_data: structuredData,
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

const DOC_TYPE_LABEL: Record<SourceDocumentType, string> = {
  vendor_invoice: 'Invoice',
  bank_statement: 'Bank Statement',
};

function deriveDocumentName(docType: SourceDocumentType, structuredData: unknown): string {
  if (docType === 'vendor_invoice') {
    const vendorName = (structuredData as { vendorName?: string }).vendorName;
    return vendorName ? `${DOC_TYPE_LABEL.vendor_invoice} — ${vendorName}.pdf` : `${DOC_TYPE_LABEL.vendor_invoice}.pdf`;
  }
  const accountHolderName = (structuredData as { accountHolderName?: string }).accountHolderName;
  return accountHolderName
    ? `${DOC_TYPE_LABEL.bank_statement} — ${accountHolderName}.pdf`
    : `${DOC_TYPE_LABEL.bank_statement}.pdf`;
}

// Fetches every source document attached to an exercise, for delivery
// alongside its scenario message (Unit 10's design: card sits below the
// scenario text in the same assistant message, not a separate message).
export async function getSourceDocumentsForExercise(
  supabase: SupabaseClient,
  exerciseId: string,
): Promise<SourceDocumentForLearner[]> {
  const { data, error } = await supabase
    .from('exercise_source_documents')
    .select('id, exercise_id, doc_type, storage_path, structured_data, created_at')
    .eq('exercise_id', exerciseId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    exerciseId: row.exercise_id,
    docType: row.doc_type as SourceDocumentType,
    storagePath: row.storage_path,
    documentName: deriveDocumentName(row.doc_type as SourceDocumentType, row.structured_data),
    createdAt: row.created_at,
  }));
}
