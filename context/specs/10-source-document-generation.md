# Unit 10: Source Document Generation

## Goal

Exercises can now come with generated source documents — vendor invoices/bills and mock bank statements — as PDFs the learner works from, instead of a plain-text transaction description. This is the first unit introducing PDF generation. Same architectural pattern as scoring (Unit 06): the LLM produces structured document data, and code deterministically renders that data into the actual PDF — the LLM never generates a PDF or its layout directly.

## Design

Reference `context/ui-context.md`.

- A source document attaches to an exercise's delivery message as a document card: file icon, document name (e.g. "Invoice — Parekh Integrated Services.pdf"), `bg-surface`, `radius-md`, with a view/download action. Not an inline PDF preview — a card, consistent with how a real chat product handles file attachments.
- Card sits below the scenario text in the same assistant message, not as a separate message.

## Implementation

### Structured document schema
- `/lib/schemas/source-document.ts`: Zod schema for document *content*, not layout — e.g. for a vendor invoice: `vendorName`, `vendorGSTIN`, `invoiceNumber`, `invoiceDate`, `lineItems` (array of `{ description, quantity, rate, amount }`), `taxBreakup` (raw stated figures — CGST/SGST/IGST amounts as they'd appear printed on the document), `totalAmount`. For a bank statement: `accountHolderName`, `period`, `transactions` (array of `{ date, narration, debit, credit, balance }`).
- **Important content boundary:** the document contains only what a real physical document would show — raw commercial facts and figures. It never states the accounting classification the learner is supposed to derive (e.g. an invoice shows the GST amount charged, but never labels it "this should be posted as IGST Payable" — that's the judgment the exercise is testing). Keep this boundary explicit in the generation prompt, not just assumed.

### Generation
- `/lib/documents/generate-source-document.ts`: new LLM call type (`source-document-generation`). Input: the relevant slice of the exercise's `answer_key` (the specific transaction this document represents), so the document's figures are internally consistent with what a correct posting would require. Output validated against `source-document.ts`, retried on failure — same bounded-retry pattern as every other LLM call so far.
- Extend `generate-exercise.ts` (Units 04/09): exercises can now be flagged as requiring one or more source documents (driven by module/difficulty configuration — some exercises stay direct-entry, some require documents, per the product's rising-realism progression). When flagged, call `generate-source-document.ts` for each required document as part of exercise generation, before delivery.

### PDF rendering (deterministic, code-based — not LLM-generated)
- `/lib/documents/templates/vendor-invoice.tsx` and `/lib/documents/templates/bank-statement.tsx`, built with `@react-pdf/renderer`. Each template takes the validated structured data and renders a consistent, realistic-looking layout — same input always produces the same visual document, no LLM involvement in this step at all.
- Render to a PDF buffer, upload to Storage under a learner/exercise-scoped path (e.g. `exercise-documents/{learner_id}/{exercise_id}/{doc_id}.pdf`), with the same access-scoping discipline as every other Storage path so far — confirmed by direct test, not assumed.

### Data model
- `exercise_source_documents` table: `id`, `exercise_id`, `doc_type` (`'vendor_invoice' | 'bank_statement'`), `storage_path`, `structured_data` (jsonb — this is learner-facing content, safe to store plainly, unlike `answer_key`), `created_at`.
- RLS: learner can `select` only documents belonging to their own exercises (join through `exercises.learner_id`).

### Delivery
- When an exercise with source documents is delivered to chat (via the existing Unit 04/09 delivery path), attach the document card(s) to that same message, linking to the Storage URL.

## Dependencies

- `@react-pdf/renderer` — introduced here, first point it's actually needed.

## Verify when done

- [ ] An exercise flagged as requiring a source document generates one, validated against the schema, with bounded retry on malformed LLM output
- [ ] The rendered PDF's figures match the structured data exactly — spot-check the invoice total against the underlying transaction it represents
- [ ] The document contains only raw commercial facts — manually confirm no line item or label states the accounting classification the learner is meant to derive
- [ ] PDF rendering is confirmed deterministic: regenerating a PDF from the same structured data produces the same layout (code-based, not LLM-based) — check by inspecting the render call, not just output
- [ ] Document Storage access is learner-scoped, confirmed by direct test (attempt cross-learner access)
- [ ] Document card renders correctly in the chat message, using only `ui-context.md` tokens, and the view/download action works
- [ ] Both `vendor_invoice` and `bank_statement` document types generate and render correctly with at least one real example each
- [ ] `exercise_source_documents` RLS confirmed by direct test
- [ ] `answer_key`'s raw object is never returned in any client-facing response related to document generation — only the composed, learner-appropriate `structured_data`
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No qualitative scoring, multi-part submission, or anomaly-seeding logic exists yet — those are Unit 11
