-- Sales register (2026-09-09): AI Accountant's sales screen accepts CSV/XLS
-- only, so a documents-mode batch with any sale also ships one CSV of the
-- month's sales invoices. New doc_type 'sales_register' (the only non-PDF
-- document). Must be applied BEFORE the code that generates it is deployed,
-- or the document insert for the next documents-mode batch fails.

alter table exercise_source_documents
  drop constraint exercise_source_documents_doc_type_check;

alter table exercise_source_documents
  add constraint exercise_source_documents_doc_type_check
  check (doc_type in ('vendor_invoice', 'bank_statement', 'sales_invoice', 'month_end_note', 'sales_register'));
