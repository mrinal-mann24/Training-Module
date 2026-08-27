# Unit 05: Submission Upload + XML Parsing + Validity Gate

## Goal

From inside the chat shell, a learner can upload their Detailed Day Book XML and Trial Balance XML for the current exercise. The files are stored, parsed into a normalized voucher structure, and run through a pre-scoring validity gate. The learner sees either "files received, ready for scoring" or a specific, actionable rejection message telling them exactly what to fix. Actual scoring (comparing against the answer key) is **not** built in this unit — that's Unit 06. This unit only proves the submission can get from "file on the learner's computer" to "clean, validated, normalized data the scoring engine will later consume."

## Design

Reference `context/ui-context.md` — no new tokens.

- Composer gains a file-attach control (paperclip icon or "Attach files" button) alongside the existing text input from Unit 04. Accepts `.xml` only — reject other extensions at the file picker level.
- Attached files render as small chip/pill elements above the composer before sending (filename + remove button), `radius-sm`, `bg-surface`, so the learner can see what they're about to submit before it goes.
- Once sent, the submission appears as a learner message bubble showing both filenames as attachments (not the raw XML content — never render raw XML in the chat thread).
- The tutor's response to a valid submission is a short assistant message, `bg-surface` bubble: acknowledgment that files were received and are valid, no score yet.
- The tutor's response to an invalid submission uses the `status-error` token for a small inline flag next to the specific issue, followed by plain-language instructions on what to fix and resubmit. Do not use a full-bleed red panel — this should read as corrective, not alarming, consistent with the "friendly" design direction.

## Implementation

### Storage
- Create a private Supabase Storage bucket (e.g. `submissions`) with a path convention `submissions/{learner_id}/{submission_id}/daybook.xml` and `.../trialbalance.xml`.
- Storage policy scoped so a learner can only read/write objects under their own `{learner_id}` prefix — test this directly (attempt cross-learner access), not just written and assumed correct, per the same discipline as every RLS policy so far.

### Database
- `submissions` table: `id`, `learner_id`, `exercise_id` (references the current `exercises` row from Unit 04), `daybook_path`, `trialbalance_path`, `status` (`'validating' | 'valid' | 'invalid' | 'awaiting_scoring'`), `validity_errors` (jsonb, populated only when invalid), `created_at`.
- RLS: learner can `select`/`insert` only their own rows.

### Upload flow
- File-attach control in the composer, client-side extension check (`.xml` only) before allowing send — this is a cheap first filter, not the real validation.
- On send, a Server Action: authenticates, uploads both files to Storage, creates a `submissions` row with `status: 'validating'`, then runs parsing + the validity gate synchronously for this unit (no background job yet — that's Unit 07; if this unit's parse+validate is fast, doing it inline is fine for now and gets replaced, not layered on top, when Unit 07 lands).

### XML parsing
- `/lib/parsing/daybook.ts` and `/lib/parsing/trialbalance.ts`, using `fast-xml-parser`.
- **Encoding:** the real sample files we inspected are UTF-16LE, not UTF-8. Detect and decode this before handing the buffer to the parser — do not assume UTF-8 and silently mis-parse.
- **Sign convention:** each ledger entry carries `AMOUNT` and `ISDEEMEDPOSITIVE`. Per the sample data: `ISDEEMEDPOSITIVE=Yes` + negative amount = Debit; `ISDEEMEDPOSITIVE=No` + positive amount = Credit. Normalize every entry to an explicit `{ ledgerName, amount, drOrCr }` shape so nothing downstream has to re-derive this from the raw flags.
- Output a normalized structure per voucher: `{ voucherType, date, ledgerEntries: [{ ledgerName, amount, drOrCr, billAllocations }] }`. Bill allocations may be empty — that's valid, not an error, since the sample data shows this can genuinely be empty on some vouchers.
- **Known open risk, don't paper over it:** the sample `DayBook.xml` we inspected had `REPORTNAME: "All Masters"`, not a Day Book report export. Build the parser to key off structural content (presence of `<VOUCHER>` and `<LEDGERENTRIES.LIST>` elements) rather than a strict `REPORTNAME` string match, since we don't yet have a confirmed sample of the actual Day Book screen's export format. Flag this in code with a comment, and treat the envelope-format check in the validity gate below as provisional until verified against a real learner-path export.

### Pre-scoring validity gate
- `/lib/tutor/submission-gate.ts`. Runs after parsing succeeds. Checks, each producing a specific error message on failure (never a generic "invalid file"):
  1. Both files parsed without error (malformed/corrupted XML → specific "file couldn't be read" message).
  2. Trial Balance has ledger-level entries, not just group-level summaries — reject a TB that looks like the sparse 2-group sample we inspected, since that's not enough data to score against.
  3. Voucher dates in the Day Book fall within the exercise's expected period (derived from the exercise's scenario data — the *count* and *period* can be checked structurally without touching `answer_key`).
  4. Voucher count roughly matches the expected transaction count from the exercise scenario (structural check only — comparing counts, not comparing content against the answer key, which stays untouched in this unit since scoring doesn't exist yet).
- On any failure: set `status: 'invalid'`, store the specific reasons in `validity_errors`, render the corrective assistant message, allow resubmission (new upload replaces/creates a new `submissions` row tied to the same exercise).
- On success: set `status: 'awaiting_scoring'`, render the acknowledgment message. No scoring call happens in this unit — the submission simply sits at `awaiting_scoring` until Unit 06 exists to pick it up.

## Dependencies

- `fast-xml-parser`
- No background job runtime yet (Unit 07) — this unit's processing is synchronous within the Server Action.
- No scoring/LLM call for grading yet (Unit 06) — Unit 04's LLM plumbing is not extended in this unit.

## Verify when done

- [ ] Learner can attach both XML files from the composer and see them as chips before sending
- [ ] A non-`.xml` file is rejected at the picker level with a clear message
- [ ] Sent files appear in the chat thread as attachment references, never as raw XML text
- [ ] Files are stored under the correct learner-scoped Storage path
- [ ] Storage access is confirmed learner-scoped by direct test (attempt to access another learner's file and confirm it's blocked), not assumed
- [ ] The real sample `DayBook.xml` and `TrialBal.xml` (UTF-16LE) parse correctly end-to-end through this pipeline
- [ ] Dr/Cr normalization is verified correct against the sample's known values (e.g. `Material purchase` → Debit, `Parekh Integrated Services Pvt Ltd` → Credit)
- [ ] A deliberately malformed XML file produces a specific, readable rejection message, not a crash or generic error
- [ ] A Trial Balance with only group-level summaries (like the sparse sample) is rejected with a specific message, not silently accepted
- [ ] A valid, complete pair of files results in `status: 'awaiting_scoring'` and the acknowledgment message — no fake or placeholder score is shown
- [ ] Resubmission after rejection works — a corrected upload replaces/creates a submission tied to the same exercise
- [ ] `submissions` table RLS confirmed by direct test
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No scoring logic, answer key comparison, or background job exists in this unit