# Blossom Retail Variant A — Answer Key (REVIEW DRAFT)

99 vouchers / 203 ledger legs, derived by `scripts/derive-blossom-answer-key.py`.

**Review every line marked with a note — those are the authored judgment calls.**

Known engine limitations (accepted for v1, from the existing scorer): (1) vouchers match by date-order position, so a learner's same-day ordering must match register order; (2) intra-state GST is keyed as CGST (single-head check); (3) narration content isn't extracted by the parser — narration scoring reports presence only.

## Review notes — 2026-09-17 (accuracy audit, round 2)

Amounts, accounts and GST treatment are unchanged. Only concept tags and the set-off's GST heads were corrected, so each tag names what its voucher actually drills (checked by `checkConceptTagsMatchContent` and `checkGstHeadMetadata` in `lib/tutor/generation-checks.ts`, both now clean on this key). The live `exercise_packs` row is updated separately by `scripts/fix-pack-answer-key-tags.mjs`; learner exercises already assigned keep their copy.

- **#2** tagged `journal_voucher_basics` on a Purchase voucher: tag removed (`purchase_voucher_basics` stays).
- **#44** and **#58** tagged `tds_classification` with no TDS on the voucher: tag removed. The negative-TDS traps remain in the notes, but a voucher with no deduction cannot fail a TDS check, so the tag only inflated mastery.
- **#99** set-off legs carried `gst_head` null: each Output/Input leg now carries its head; GST Payable (all heads) stays null.

Assumptions the key relies on (stated so the reviewer can confirm them against the pack documents):

- **A1. Sharma Legal (#44, #67) is a legal consultancy firm, not an individual advocate or a firm of advocates.** Legal services by an advocate or a firm of advocates to a business entity are under reverse charge (Notification 13/2017-Central Tax (Rate), entry 2); a consultancy that is not an advocate charges GST forward, so the bill's CGST/SGST @18% is correct as keyed. No TDS: the fee of 30,000 does not EXCEED the FY 2024-25 s. 194J threshold of 30,000 (the 50,000 threshold applies only from 1-Apr-2025, Finance Act 2025).
- **A2. Delivery Direct (#71, #82) is a transporter owning not more than ten goods carriages that furnished its PAN and the s. 194C(6) declaration.** Under s. 194C(6) no TDS is deducted on payments to such a contractor in the business of plying, hiring or leasing goods carriages, so 40,000 above the 30,000 single-bill limit carries no TDS. The GST treatment (CGST/SGST @18% as billed) is kept exactly as the pack states and was not re-examined; open for the reviewer: a goods transport agency paying forward charge in FY 2024-25 charges 5% or 12% (Notification 11/2017-Central Tax (Rate), item 9(iii)), and road transport by a non-GTA transporter is exempt (Notification 12/2017-Central Tax (Rate), entry 18), so 18% needs the supplier to be something other than either.

| # | Date | Voucher | Legs | GST | TDS | Ref | Note |
|---|---|---|---|---|---|---|---|
| 1 | 2024-04-02 | Sales | Dr Ludhiana Woodworks 112,100.00; Cr Sales 95,000.00 | IGST @18% |  | INV-010 |  |
| 2 | 2024-04-02 | Purchase | Dr Office Equipment 80,000.00; Cr Deccan Traders 94,400.00 | CGST @18% |  | DT-115 | TRAP: computers are a FIXED ASSET (Office Equipment), not trading purchases. |
| 3 | 2024-04-02 | Payment | Dr Deccan Traders 50,000.00; Cr HDFC Bank — 1234 50,000.00 |  |  | DT-99 | Opening-balance settlement (March bill), Against Ref |
| 4 | 2024-04-03 | Purchase | Dr Purchases 250,000.00; Cr Mumbai Suppliers 295,000.00 | IGST @18% |  | MS-B1 |  |
| 5 | 2024-04-03 | Purchase | Dr Purchases 80,000.00; Cr Mumbai Suppliers 94,400.00 | IGST @18% |  | MS-B3 |  |
| 6 | 2024-04-03 | Receipt | Dr HDFC Bank — 1234 75,000.00; Cr Karnataka Emporium 75,000.00 |  |  | INV-M-101 | Opening-balance receipt (March invoice), Against Ref |
| 7 | 2024-04-04 | Sales | Dr Rajasthan Home Decor 129,800.00; Cr Sales 110,000.00 | IGST @18% |  | INV-011 |  |
| 8 | 2024-04-04 | Purchase | Dr Purchases 120,000.00; Cr Mumbai Suppliers 141,600.00 | IGST @18% |  | MS-B2 |  |
| 9 | 2024-04-05 | Sales | Dr Cash 17,700.00; Cr Sales 15,000.00 | CGST @18% |  |  |  |
| 10 | 2024-04-05 | Purchase | Dr Purchases 55,000.00; Cr Coimbatore Wholesale 64,900.00 | IGST @18% |  | CW-101 |  |
| 11 | 2024-04-05 | Payment | Dr Mumbai Suppliers 120,000.00; Cr HDFC Bank — 1234 120,000.00 |  |  | MS-M1 | Opening-balance settlement, Against Ref |
| 12 | 2024-04-05 | Payment | Dr Coimbatore Wholesale 64,900.00; Cr HDFC Bank — 1234 64,900.00 |  |  | CW-101 |  |
| 13 | 2024-04-06 | Sales | Dr Coimbatore Interiors 76,700.00; Cr Sales 65,000.00 | IGST @18% |  | INV-012 | TRAP (pilot: Elina's one GST slip): Coimbatore Interiors is TAMIL NADU — IGST, not CGST/SGST. |
| 14 | 2024-04-06 | Receipt | Dr HDFC Bank — 1234 112,100.00; Cr Ludhiana Woodworks 112,100.00 |  |  | INV-010 |  |
| 15 | 2024-04-07 | Sales | Dr Ahmedabad Elite 212,400.00; Cr Sales 180,000.00 | IGST @18% |  | INV-013 |  |
| 16 | 2024-04-07 | Purchase | Dr Purchases 90,000.00; Cr Chennai Suppliers 106,200.00 | IGST @18% |  | CS-092 |  |
| 17 | 2024-04-07 | Payment | Dr TDS Payable — u/s 194J 5,000.00; Cr HDFC Bank — 1234 5,000.00 |  |  |  | TRAP: clears the opening TDS LIABILITY — not an expense. |
| 18 | 2024-04-07 | Receipt | Dr HDFC Bank — 1234 90,000.00; Cr Delhi Bazaar 90,000.00 |  |  | INV-M-102 | Opening-balance receipt, Against Ref |
| 19 | 2024-04-08 | Sales | Dr Karnataka Emporium 212,400.00; Cr Sales 180,000.00 | CGST @18% |  | INV-001 |  |
| 20 | 2024-04-08 | Purchase | Dr Purchases 120,000.00; Cr Kolkata Traders 141,600.00 | IGST @18% |  | KT-055 |  |
| 21 | 2024-04-08 | Payment | Dr Ahmedabad Import 106,200.00; Cr HDFC Bank — 1234 106,200.00 |  |  | AI-201 |  |
| 22 | 2024-04-09 | Sales | Dr Kochi Modern 103,840.00; Cr Sales 88,000.00 | IGST @18% |  | INV-014 |  |
| 23 | 2024-04-09 | Purchase | Dr Purchases 90,000.00; Cr Ahmedabad Import 106,200.00 | IGST @18% |  | AI-201 |  |
| 24 | 2024-04-09 | Payment | Dr Chennai Suppliers 106,200.00; Cr HDFC Bank — 1234 106,200.00 |  |  | CS-092 |  |
| 25 | 2024-04-10 | Sales | Dr Kerala Handicrafts 259,600.00; Cr Sales 220,000.00 | IGST @18% |  | INV-002 |  |
| 26 | 2024-04-10 | Receipt | Dr HDFC Bank — 1234 129,800.00; Cr Rajasthan Home Decor 129,800.00 |  |  | INV-011 |  |
| 27 | 2024-04-11 | Sales | Dr Vizag Furnishings 84,960.00; Cr Sales 72,000.00 | IGST @18% |  | INV-015 |  |
| 28 | 2024-04-11 | Receipt | Dr HDFC Bank — 1234 76,700.00; Cr Coimbatore Interiors 76,700.00 |  |  | INV-012 |  |
| 29 | 2024-04-12 | Sales | Dr Karnataka Emporium 35,400.00; Cr Sales 30,000.00 | CGST @18% |  | INV-016 |  |
| 30 | 2024-04-12 | Purchase | Dr Purchases 45,000.00; Cr Chennai Suppliers 53,100.00 | IGST @18% |  | CS-093 |  |
| 31 | 2024-04-12 | Receipt | Dr HDFC Bank — 1234 150,000.00; Cr Kerala Handicrafts 150,000.00 |  |  | ADV-01 | ADVANCE received (Advance ref ADV-01) — not against an invoice; later applied to INV-009. |
| 32 | 2024-04-13 | Sales | Dr Gujarat Retail 141,600.00; Cr Sales 120,000.00 | IGST @18% |  | INV-006 |  |
| 33 | 2024-04-13 | Receipt | Dr HDFC Bank — 1234 100,000.00; Cr Ahmedabad Elite 100,000.00 |  |  | INV-013 | PARTIAL: 1,00,000 of 2,12,400 — Against Ref INV-013, balance stays outstanding. |
| 34 | 2024-04-14 | Sales | Dr Bengaluru Local Store 64,900.00; Cr Sales 55,000.00 | CGST @18% |  | INV-017 |  |
| 35 | 2024-04-14 | Purchase | Dr Purchases 60,000.00; Cr Trichy Textiles 70,800.00 | IGST @18% |  | TT-234 |  |
| 36 | 2024-04-15 | Sales | Dr Delhi Bazaar 177,000.00; Cr Sales 150,000.00 | IGST @18% |  | INV-003 |  |
| 37 | 2024-04-15 | Purchase | Dr Purchases 65,000.00; Cr Vizag Vendors 76,700.00 | IGST @18% |  | VV-042 |  |
| 38 | 2024-04-15 | Payment | Dr Deccan Traders 94,400.00; Cr HDFC Bank — 1234 94,400.00 |  |  | DT-115 |  |
| 39 | 2024-04-15 | Receipt | Dr HDFC Bank — 1234 84,960.00; Cr Vizag Furnishings 84,960.00 |  |  | INV-015 |  |
| 40 | 2024-04-16 | Sales | Dr Mysore Decor 49,560.00; Cr Sales 42,000.00 | CGST @18% |  | INV-018 |  |
| 41 | 2024-04-16 | Payment | Dr Mumbai Suppliers 450,000.00; Cr HDFC Bank — 1234 450,000.00 |  |  | MS-B1, MS-B2, MS-B3 (part) | SPLIT 4,50,000 across three bills: B1 2,95,000 + B2 1,41,600 + B3 13,400 partial. |
| 42 | 2024-04-16 | Payment | Dr Trichy Textiles 70,800.00; Cr HDFC Bank — 1234 70,800.00 |  |  | TT-234 |  |
| 43 | 2024-04-17 | Credit Note | Dr Sales Returns 15,000.00; Cr Karnataka Emporium 17,700.00 | CGST @18% |  | INV-001 | Trap: must reverse OUTPUT GST (not Input) and use a Credit Note voucher. |
| 44 | 2024-04-17 | Purchase | Dr Legal & Professional Charges 30,000.00; Cr Sharma Legal 35,400.00 | CGST @18% |  | SL-018 | NEGATIVE TDS TRAP: 30,000 does not exceed the FY 2024-25 194J threshold of 30,000 — NO TDS. Forward-charge GST: see assumption A1. |
| 45 | 2024-04-17 | Receipt | Dr HDFC Bank — 1234 64,900.00; Cr Bengaluru Local Store 64,900.00 |  |  | INV-017 |  |
| 46 | 2024-04-17 | Payment | Dr Bank Charges 350.00; Cr HDFC Bank — 1234 350.00 |  |  |  | Plain bank charge, no GST component on this line. |
| 47 | 2024-04-18 | Purchase | Dr Legal & Professional Charges 75,000.00; Cr Mehta & Associates 81,000.00 | CGST @18% | 194J @10.0% on 75,000 | CA26-101 |  |
| 48 | 2024-04-18 | Receipt | Dr HDFC Bank — 1234 150,000.00; Cr Karnataka Emporium 150,000.00 |  |  | INV-001 | PARTIAL: 1,50,000 against INV-001 (1,94,700 net of CN-001). |
| 49 | 2024-04-18 | Payment | Dr Kolkata Traders 141,600.00; Cr HDFC Bank — 1234 141,600.00 |  |  | KT-055 |  |
| 50 | 2024-04-19 | Sales | Dr Karnataka Emporium 53,100.00; Cr Sales 45,000.00 | CGST @18% |  | INV-007 |  |
| 51 | 2024-04-19 | Debit Note | Dr Mumbai Suppliers 29,500.00; Cr Purchase Returns 25,000.00 | IGST @18% |  | DN-M1 |  |
| 52 | 2024-04-19 | Receipt | Dr HDFC Bank — 1234 103,840.00; Cr Kochi Modern 103,840.00 |  |  | INV-014 |  |
| 53 | 2024-04-20 | Sales | Dr Kerala Handicrafts 165,200.00; Cr Sales 140,000.00 | IGST @18% |  | INV-019 |  |
| 54 | 2024-04-20 | Purchase | Dr Repairs & Maintenance 150,000.00; Cr Balaji Interiors 174,000.00 | CGST @18% | 194C @2.0% on 150,000 | BI-047 |  |
| 55 | 2024-04-20 | Payment | Dr Mehta & Associates 81,000.00; Cr HDFC Bank — 1234 81,000.00 |  |  | CA26-101 | Net of 194J TDS: 88,500 − 7,500 = 81,000. |
| 56 | 2024-04-20 | Payment | Dr Chennai Suppliers 53,100.00; Cr HDFC Bank — 1234 53,100.00 |  |  | CS-093 |  |
| 57 | 2024-04-21 | Sales | Dr Nagpur Retail 92,040.00; Cr Sales 78,000.00 | IGST @18% |  | INV-020 |  |
| 58 | 2024-04-21 | Purchase | Dr Office Maintenance 25,000.00; Cr Bangalore Cleaning 29,500.00 | CGST @18% |  | BC-078 | NEGATIVE TDS TRAP: 25k below the 30k single-bill 194C limit — NO TDS. |
| 59 | 2024-04-21 | Receipt | Dr HDFC Bank — 1234 141,600.00; Cr Gujarat Retail 141,600.00 |  |  | INV-006 |  |
| 60 | 2024-04-21 | Receipt | Dr HDFC Bank — 1234 49,560.00; Cr Mysore Decor 49,560.00 |  |  | INV-018 |  |
| 61 | 2024-04-22 | Sales | Dr Chennai Home Store 106,200.00; Cr Sales 90,000.00 | IGST @18% |  | INV-004 |  |
| 62 | 2024-04-22 | Payment | Dr Balaji Interiors 174,000.00; Cr HDFC Bank — 1234 174,000.00 |  |  | BI-047 | Net of 194C TDS: 1,77,000 − 3,000 = 1,74,000. |
| 63 | 2024-04-22 | Payment | Dr Bangalore Cleaning 29,500.00; Cr HDFC Bank — 1234 29,500.00 |  |  | BC-078 |  |
| 64 | 2024-04-23 | Sales | Dr Kolkata Emporium 147,500.00; Cr Sales 125,000.00 | IGST @18% |  | INV-021 |  |
| 65 | 2024-04-23 | Purchase | Dr Advertisement & Marketing 60,000.00; Cr Signage Advertising 69,600.00 | CGST @18% | 194C @2.0% on 60,000 | SA-101 |  |
| 66 | 2024-04-23 | Receipt | Dr HDFC Bank — 1234 100,000.00; Cr Delhi Bazaar 100,000.00 |  |  | INV-003 | PARTIAL: 1,00,000 of 1,77,000 against INV-003. |
| 67 | 2024-04-23 | Payment | Dr Sharma Legal 35,400.00; Cr HDFC Bank — 1234 35,400.00 |  |  | SL-018 | Full 35,400 — no TDS was deducted (below threshold). |
| 68 | 2024-04-24 | Payment | Dr Bharat Machinery 50,000.00; Cr HDFC Bank — 1234 50,000.00 |  |  | ADV-02 | ADVANCE paid to a creditor (Advance ref ADV-02) — no bill yet. |
| 69 | 2024-04-24 | Payment | Dr Vizag Vendors 76,700.00; Cr HDFC Bank — 1234 76,700.00 |  |  | VV-042 |  |
| 70 | 2024-04-25 | Sales | Dr Hyderabad Interiors 100,300.00; Cr Sales 85,000.00 | IGST @18% |  | INV-008 | TRAP: 30d terms — a CREDIT sale to Hyderabad Interiors, must NOT go to Cash Sales. |
| 71 | 2024-04-25 | Purchase | Dr Freight & Delivery Charges 40,000.00; Cr Delivery Direct 47,200.00 | CGST @18% |  | DD-455 | No TDS under s. 194C(6), forward-charge GST: see assumption A2. |
| 72 | 2024-04-25 | Payment | Dr Electricity Charges 4,500.00; Cr HDFC Bank — 1234 4,500.00 |  |  |  |  |
| 73 | 2024-04-25 | Payment | Dr Signage Advertising 69,384.00; Cr HDFC Bank — 1234 69,384.00 |  |  | SA-101 | TRAP: net payable is 69,600 (70,800 − 1,200 TDS) but bank shows 69,384 — a 216 residual stays on the vendor. Post as per bank. |
| 74 | 2024-04-26 | Sales | Dr Delhi Bazaar 112,100.00; Cr Sales 95,000.00 | IGST @18% |  | INV-022 |  |
| 75 | 2024-04-26 | Purchase | Dr Rent 40,000.00; Cr Hero Rentals 43,200.00 | CGST @18% | 194I @10.0% on 40,000 | HR-118 |  |
| 76 | 2024-04-26 | Receipt | Dr HDFC Bank — 1234 92,040.00; Cr Nagpur Retail 92,040.00 |  |  | INV-020 |  |
| 77 | 2024-04-26 | Payment | Dr Hero Rentals 43,200.00; Cr HDFC Bank — 1234 43,200.00 |  |  | HR-118 | Net of 194I TDS: 47,200 − 4,000 = 43,200. |
| 78 | 2024-04-26 | Payment | Dr Bank Charges 720.34; Cr HDFC Bank — 1234 850.00 | CGST @18% |  |  | TRAP: 850 is GROSS incl. GST — split 720.34 charge + 129.66 Input CGST/SGST (do not book gross). |
| 79 | 2024-04-27 | Sales | Dr Karnataka Emporium 70,800.00; Cr Sales 60,000.00 | CGST @18% |  | INV-005 |  |
| 80 | 2024-04-27 | Purchase | Dr Software Subscription 25,000.00; Cr Software Cloud LLC 29,500.00 | CGST @18% |  | SC-909 |  |
| 81 | 2024-04-27 | Receipt | Dr HDFC Bank — 1234 106,200.00; Cr Chennai Home Store 106,200.00 |  |  | INV-004 |  |
| 82 | 2024-04-27 | Payment | Dr Delivery Direct 47,200.00; Cr HDFC Bank — 1234 47,200.00 |  |  | DD-455 |  |
| 83 | 2024-04-28 | Sales | Dr Chennai Home Store 80,240.00; Cr Sales 68,000.00 | IGST @18% |  | INV-023 |  |
| 84 | 2024-04-28 | Payment | Dr Salaries 40,000.00; Cr HDFC Bank — 1234 40,000.00 |  |  |  | April salary — Priya S. |
| 85 | 2024-04-28 | Receipt | Dr HDFC Bank — 1234 100,300.00; Cr Hyderabad Interiors 100,300.00 |  |  | INV-008 |  |
| 86 | 2024-04-28 | Payment | Dr Packing Materials 2,800.00; Cr Cash 2,800.00 |  |  |  | Cash Memo: cash-only, not in bank statement. Small KA vendor, no GST breakup given. |
| 87 | 2024-04-29 | Sales | Dr Kerala Handicrafts 212,400.00; Cr Sales 180,000.00 | IGST @18% |  | INV-009 | Advance ADV-01 (received 12-Apr, 1,50,000) is applied against this invoice; balance 62,400 as New Ref. |
| 88 | 2024-04-29 | Receipt | Dr HDFC Bank — 1234 45,000.00; Cr Karnataka Emporium 45,000.00 |  |  | INV-001 (bal), INV-016 (part) | ALLOCATION: 44,700 clears INV-001's balance, 300 against INV-016. |
| 89 | 2024-04-29 | Receipt | Dr HDFC Bank — 1234 147,500.00; Cr Kolkata Emporium 147,500.00 |  |  | INV-021 |  |
| 90 | 2024-04-29 | Payment | Dr Software Cloud LLC 29,500.00; Cr HDFC Bank — 1234 29,500.00 |  |  | SC-909 |  |
| 91 | 2024-04-30 | Sales | Dr Bengaluru Boutique 47,200.00; Cr Sales 40,000.00 | CGST @18% |  | INV-024 |  |
| 92 | 2024-04-30 | Payment | Dr Software Subscription 18,000.00; Cr HDFC Bank — 1234 18,000.00 |  |  |  | Month-end note 2: 18,000 covers Apr–Sep. Dr Software Subscription 3,000 (April) + Dr Prepaid Software 15,000. |
| 93 | 2024-04-30 | Receipt | Dr HDFC Bank — 1234 1,200.00; Cr Interest Income 1,200.00 |  |  |  |  |
| 94 | 2024-04-30 | Receipt | Dr HDFC Bank — 1234 5,000.00; Cr Suspense 5,000.00 |  |  |  | TRAP: unidentifiable sender — a proper Suspense ledger, NOT a ledger named UNKNOWN. |
| 95 | 2024-04-30 | Receipt | Dr HDFC Bank — 1234 55,000.00; Cr Delhi Bazaar 55,000.00 |  |  | INV-003 (bal) | ALLOCATION: 55,000 against INV-003's remaining 77,000; 22,000 stays outstanding. |
| 96 | 2024-04-30 | Receipt | Dr HDFC Bank — 1234 47,200.00; Cr Bengaluru Boutique 47,200.00 |  |  | INV-024 |  |
| 97 | 2024-04-30 | Journal | Dr Prepaid Software 15,000.00; Cr Software Subscription 15,000.00 |  |  |  | Month-end note 2. |
| 98 | 2024-04-30 | Journal | Dr Rent 35,000.00; Cr Outstanding Expenses 35,000.00 |  |  |  | Month-end note 1. |
| 99 | 2024-04-30 | Journal | Dr Output CGST 40,680.00; Dr Output SGST 40,680.00; Dr Output IGST 352,980.00; Cr Input CGST 52,314.83; Cr Input SGST 52,314.83; Cr Input IGST 171,000.00; Cr GST Payable 158,710.34 |  |  |  | Month-end note 3, head-wise. Output 434,340.00 vs Input 275,629.66 → net payable 158,710.34. All GST-named ledgers are tie-out-exempt in the engine, so head naming variants do not fail the TB check. Since 2026-09-17 the scorer judges this journal against the learner's own GST ledger balances (least cash under Rule 88A, CGST credit never against SGST), and head-wise payables (IGST/CGST/SGST Payable) are accepted for GST Payable. |
