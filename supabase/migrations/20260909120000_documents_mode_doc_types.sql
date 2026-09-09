-- Documents mode (2026-09-09): two more source-document types. sales_invoice
-- is the company's own outgoing invoice / cash memo; month_end_note is the
-- owner's month-end instructions sheet for journals that have no
-- third-party document. Must be applied BEFORE the code that generates them
-- is deployed, or document inserts for documents-mode batches fail.

alter table exercise_source_documents
  drop constraint exercise_source_documents_doc_type_check;

alter table exercise_source_documents
  add constraint exercise_source_documents_doc_type_check
  check (doc_type in ('vendor_invoice', 'bank_statement', 'sales_invoice', 'month_end_note'));
