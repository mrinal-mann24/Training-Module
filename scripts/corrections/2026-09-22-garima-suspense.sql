-- Carried rectification for Garima (70d15c95), 2026-09-22.
--
-- Defect (confirmed from the stored keys, scripts/audit-answer-keys.ts):
-- her May 2025 batch (exercise 30a8e1ac..., month-end note 1) told her to
-- clear Rs 39,900 from Suspense as the receipt from Kolkata Emporium
-- against KE-305. Suspense only ever held Rs 5,000 (the pack's unidentified
-- receipt), so her books now carry Suspense Dr 34,900 and Kolkata Emporium
-- at nil although KE-305 (Rs 64,900 less the Rs 25,000 received in June
-- 2024) still has Rs 34,900 outstanding.
--
-- Treatment: the May key stays as scored. Her next generated batch carries
-- this journal, which puts Suspense back to nil and reopens KE-305 for the
-- Rs 34,900 still due. Run once; the generator consumes the row.
--
-- Rollback (only while carried_in_exercise_id is still null):
--   delete from carried_rectifications where learner_id = '70d15c95-cc55-47d8-b662-73acd216ded1' and carried_in_exercise_id is null;

insert into carried_rectifications (learner_id, source_exercise_id, reason, learner_text, legs)
select
  '70d15c95-cc55-47d8-b662-73acd216ded1',
  (select id from exercises where learner_id = '70d15c95-cc55-47d8-b662-73acd216ded1' and id::text like '30a8e1ac%'),
  'May 2025 month-end note 1 cleared 39,900 from Suspense against KE-305; Suspense held only 5,000. Books show Suspense Dr 34,900 and KE-305 closed though 34,900 is still due.',
  'On review of last month''s Suspense clearing, only the unidentified receipt already lying in Suspense belonged to Kolkata Emporium; the balance of Rs 34,900 was never received. Reverse the excess: debit Kolkata Emporium Rs 34,900 as a New Ref against bill KE-305 (the bill is reopened for the amount still due) and credit Suspense Rs 34,900, which brings Suspense to nil.',
  '[
    {"account": "Kolkata Emporium", "dr_cr": "Dr", "amount": 34900, "bill_reference": "KE-305 (New Ref)", "narration": "Being excess Suspense clearing of May reversed; KE-305 reopened for the Rs 34,900 still receivable from Kolkata Emporium."},
    {"account": "Suspense", "dr_cr": "Cr", "amount": 34900, "bill_reference": null, "narration": "Being excess Suspense clearing of May reversed; KE-305 reopened for the Rs 34,900 still receivable from Kolkata Emporium."}
  ]'::jsonb
where not exists (
  select 1 from carried_rectifications
  where learner_id = '70d15c95-cc55-47d8-b662-73acd216ded1' and carried_in_exercise_id is null
);

-- Expect: 1 row. Check:
--   select id, created_at, carried_in_exercise_id from carried_rectifications where learner_id = '70d15c95-cc55-47d8-b662-73acd216ded1';
