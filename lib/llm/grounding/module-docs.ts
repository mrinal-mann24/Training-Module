// VA Training Module reference docs — extracted from the source .docx set
// (Reference Material/Training Modules) on 2026-08-19. These are the real
// reference material the spec previously modeled as 'video slots': hint
// rung 2 points learners at the module covering their concept, and Q&A can
// ground answers in them. Regenerate via the extraction script on doc
// updates; do not hand-edit the strings.
import type { ConceptTag } from '@/lib/schemas/exercise';

export const MODULE_DOCS: Record<string, string> = {
  '1.Sales_Module': `Sales Module
Cash Sales vs Credit Sales — Entries and Effect on P&L / Balance Sheet
Every sale is either settled immediately (Cash Sale) or settled later (Credit Sale). The accounting entry, and which Balance Sheet account gets affected, differs between the two — but the effect on the P&L is identical.
Worked examples below assume an intra-state sale of ₹10,000 with 18% GST (9% CGST + 9% SGST), making the total invoice value ₹11,800. For an inter-state sale, the two 9% GST lines would instead be a single 18% IGST line.
1. Cash Sales (Ideally not in Business Practice)
Payment is received at the same time as the sale — money moves straight into Cash or Bank.
Entry (at the time of sale)
Account
Dr / Cr
Cash / Bank A/c (₹11,800)
Dr
Sales A/c (₹10,000)
Cr
Output CGST A/c @9% (₹900)
Cr
Output SGST A/c @9% (₹900)
Cr
Illustrative TallyPrime screen — Cash Sale entry (recreated to match your interface)
Effect on P&L:  Sales A/c is Direct Income — it increases revenue and Gross Profit immediately, in full.
Effect on Balance Sheet:  Cash/Bank (Asset) increases by the full invoice value. Output GST (Current Liability) increases by the tax amount, until it is paid to the government.
2. Credit Sales (Usually business Practices)
The customer takes the goods now and pays later — the sale is recorded immediately, but cash arrives on a future date.
Entry 1 — at the time of sale
Account
Dr / Cr
Sundry Debtor (Customer) A/c (₹11,800)
Dr
Sales A/c (₹10,000)
Cr
Output CGST A/c @9% (₹900)
Cr
Output SGST A/c @9% (₹900)
Cr
Illustrative TallyPrime screen — Credit Sale entry (recreated to match your interface)
Entry 2 — when the customer eventually pays
Account
Dr / Cr
Cash / Bank A/c (₹11,800)
Dr
Sundry Debtor (Customer) A/c (₹11,800)
Cr
Illustrative TallyPrime screen — Receipt entry against the credit sale (recreated to match your interface)
Effect on P&L:  Identical to a cash sale — Sales A/c increases revenue and Gross Profit immediately at the time of sale (accounting is on accrual basis, not on when cash is received).
Effect on Balance Sheet:  At the time of sale: Sundry Debtors (Asset) increases, and Output GST (Current Liability) increases. When payment is received: Sundry Debtors decreases and Cash/Bank (Asset) increases by the same amount — the Balance Sheet total doesn't change, just which asset holds the value.
Quick comparison
Cash Sales
Credit Sales
When is Sales A/c credited?
Immediately
Immediately (same as cash)
What is debited?
Cash / Bank
Sundry Debtors
P&L impact
Full amount, same day
Full amount, same day
Balance Sheet impact
Cash/Bank rises right away
Debtors rises first, then converts to Cash/Bank on receipt
Risk
None — money already in hand
Credit/collection risk until customer pays
Bottom line: the P&L doesn't care whether a sale was for cash or on credit — revenue is booked the moment the sale happens either way. The only difference shows up on the Balance Sheet, in whether the value first lands in Debtors (credit sale) or straight into Cash/Bank (cash sale).`,
  '2.Purchase_Module': `Purchase Module
Cash Purchase vs Credit Purchase — Entries and Effect on P&L / Balance Sheet
Every purchase is either paid for immediately (Cash Purchase) or paid for later (Credit Purchase). The accounting entry, and which Balance Sheet account gets affected, differs between the two — but the effect on the P&L is identical.
Worked examples below assume an intra-state purchase of ₹10,000 with 18% GST (9% CGST + 9% SGST), making the total invoice value ₹11,800. For an inter-state purchase, the two 9% GST lines would instead be a single 18% IGST line.
1. Cash Purchase (Usually business don’t follow this)
Payment is made at the same time as the purchase — money moves straight out of Cash or Bank.
Entry (at the time of purchase)
Account
Dr / Cr
Purchase A/c (₹10,000)
Dr
Input CGST A/c @9% (₹900)
Dr
Input SGST A/c @9% (₹900)
Dr
Cash / Bank A/c (₹11,800)
Cr
Illustrative TallyPrime screen — Cash Purchase entry (recreated to match your interface)
Effect on P&L:  Purchase A/c is a Direct Expense — it increases the Cost of Goods and reduces Gross Profit immediately, in full. Input GST never touches the P&L — it isn't a cost, it's a tax credit you'll claim back.
Effect on Balance Sheet:  Cash/Bank (Asset) decreases by the full invoice value. Input GST (Current Asset) increases by the tax amount — it's a receivable from the government (Input Tax Credit) until it's adjusted against your Output GST liability.
2. Credit Purchase (Usually business follow this)
You receive the goods now and pay the supplier later — the purchase is recorded immediately, but cash goes out on a future date.
Entry 1 — at the time of purchase
Account
Dr / Cr
Purchase A/c (₹10,000)
Dr
Input CGST A/c @9% (₹900)
Dr
Input SGST A/c @9% (₹900)
Dr
Sundry Creditor (Supplier) A/c (₹11,800)
Cr
Illustrative TallyPrime screen — Credit Purchase entry (recreated to match your interface)
Entry 2 — when you eventually pay the supplier
Account
Dr / Cr
Sundry Creditor (Supplier) A/c (₹11,800)
Dr
Cash / Bank A/c (₹11,800)
Cr
Illustrative TallyPrime screen — Payment entry against the credit purchase (recreated to match your interface)
Effect on P&L:  Identical to a cash purchase — Purchase A/c increases the Cost of Goods and reduces Gross Profit immediately at the time of purchase (accounting is on accrual basis, not on when cash is paid).
Effect on Balance Sheet:  At the time of purchase: Sundry Creditors (Liability) increases, and Input GST (Current Asset) increases. When you pay: Sundry Creditors decreases and Cash/Bank (Asset) decreases by the same amount — the Balance Sheet total doesn't change, just which side settles.
Quick comparison
Cash Purchase
Credit Purchase
When is Purchase A/c debited?
Immediately
Immediately (same as cash)
What is credited?
Cash / Bank
Sundry Creditors
P&L impact
Full amount, same day
Full amount, same day
Balance Sheet impact
Cash/Bank falls right away
Creditors rises first, then converts to a Cash/Bank outflow on payment
Risk
None — no future obligation
You owe the supplier until payment is made
Bottom line: the P&L doesn't care whether a purchase was for cash or on credit — the expense is booked the moment the purchase happens either way. The only difference shows up on the Balance Sheet, in whether the value first sits in Creditors (credit purchase) or leaves Cash/Bank immediately (cash purchase). Either way, Input GST becomes a Current Asset you can set off against your Output GST liability.`,
  '3.Bank_Module': `Bank Module
Deposit vs Withdrawal — Entries and Effect on P&L / Balance Sheet
The Bank Module covers two kinds of movement: transfers between your own Cash and Bank accounts (Deposit / Withdrawal, via Contra vouchers), and settlements with outside parties that happen to go through the bank (paying a vendor, or receiving from a customer, via Payment / Receipt vouchers).
None of these four entries touch the P&L. Deposits and Withdrawals move money between two of your own asset accounts; paying a vendor or receiving from a customer just settles a balance that was already recognised as an expense or income back when the original Purchase or Sale happened.
1. Deposit (Cash into Bank)
Cash sitting in the office is deposited into the company's bank account.
Entry
Account
Dr / Cr
Bank A/c (₹50,000)
Dr
Cash A/c (₹50,000)
Cr
Illustrative TallyPrime screen — Deposit entry via Contra voucher (recreated to match your interface)
Effect on P&L:  None. A Contra entry is a pure transfer between two Asset accounts (Cash and Bank) — it never appears on the Trading Account or P&L.
Effect on Balance Sheet:  Cash-in-Hand (Asset) decreases by ₹50,000, and Bank (Asset) increases by the same ₹50,000. Total assets are unchanged — only the mix between the two shifts.
2. Withdrawal (Bank into Cash)
Money is withdrawn from the bank account to fund day-to-day cash expenses in the office.
Entry
Account
Dr / Cr
Cash A/c (₹20,000)
Dr
Bank A/c (₹20,000)
Cr
Illustrative TallyPrime screen — Withdrawal entry via Contra voucher (recreated to match your interface)
Effect on P&L:  None, for the same reason as a Deposit — it's a transfer between two Asset accounts, not income or expense.
Effect on Balance Sheet:  Bank (Asset) decreases by ₹20,000, and Cash-in-Hand (Asset) increases by the same ₹20,000. Again, total assets are unchanged.
3. Payment to Vendor (via Bank)
You settle an outstanding supplier bill by transferring money from the bank — this clears the liability created earlier when the credit purchase was recorded.
Entry
Account
Dr / Cr
Sundry Creditor (Vendor) A/c (₹35,000)
Dr
Bank A/c (₹35,000)
Cr
Illustrative TallyPrime screen — Payment to Vendor via bank (recreated to match your interface)
Effect on P&L:  None — the expense was already booked when the Purchase entry was made. This payment simply clears the amount owed.
Effect on Balance Sheet:  Sundry Creditors (Liability) decreases by ₹35,000, and Bank (Asset) decreases by the same ₹35,000.
4. Received from Customer (via Bank)
A customer clears their outstanding invoice by transferring money into the bank — this clears the receivable created earlier when the credit sale was recorded.
Entry
Account
Dr / Cr
Bank A/c (₹22,000)
Dr
Sundry Debtor (Customer) A/c (₹22,000)
Cr
Illustrative TallyPrime screen — Receipt from Customer via bank (recreated to match your interface)
Effect on P&L:  None — the income was already booked when the Sales entry was made. This receipt simply converts a receivable into cash.
Effect on Balance Sheet:  Sundry Debtors (Asset) decreases by ₹22,000, and Bank (Asset) increases by the same ₹22,000.
Quick comparison
Deposit
Withdrawal
Payment to Vendor
Receipt from Customer
Voucher type
Contra (F4)
Contra (F4)
Payment (F5)
Receipt (F6)
What is debited?
Bank
Cash
Sundry Creditor
Bank
What is credited?
Cash
Bank
Bank
Sundry Debtor
P&L impact
None
None
None
None
Balance Sheet impact
Cash to Bank
Bank to Cash
Creditors and Bank both fall
Debtors falls, Bank rises
Bonus: Bank Reconciliation Statement (BRS)
Your book balance for a bank ledger and the bank's own statement balance rarely match exactly on a given day — cheques you've issued may not be presented yet, or the bank may have deducted charges you haven't recorded. A BRS lists these timing differences side by side to prove the two balances will match once everything clears.
In TallyPrime: open the Bank ledger, press F5 (Bank Reconciliation), and mark off each entry against the date it actually appears on your bank statement. This is a reconciliation process, not a voucher — it doesn't create any new accounting entries, it simply confirms your Bank ledger is accurate.
Bottom line: none of the four Bank Module entries above ever touch profit. Deposits and Withdrawals just reshuffle assets between Cash and Bank; paying a vendor or collecting from a customer just clears a balance that was already booked to the P&L back when the original Purchase or Sale happened. Compare that to Sales and Purchase entries themselves, where the P&L moves every time. Reconciling the bank regularly is what keeps all of these Balance Sheet figures trustworthy.`,
  '4.1 Taxation Module_1_TDS': `TDS Module
Section 194J (Professional Fees) & Section 194C (Contractors)
TDS (Tax Deducted at Source) applies when you pay certain categories of expenses above a threshold — you hold back a percentage as tax and deposit it with the government on the payee's behalf; they get credit for it against their own tax liability. This module covers two of the most common sections: 194J (professional fees) and 194C (payments to contractors).
Note: from FY 2026-27, TDS provisions are consolidated under Section 393 of the Income Tax Act, 2025 — but the familiar section numbers (194J, 194C) are still universally used in practice, in software like TallyPrime, and in this guide, since they map directly to the old, well-known rates and rules.
A. TDS under Section 194J — Professional Fees
Applies to fees for professional services (legal, accounting, consultancy, etc.). Threshold: ₹50,000 in aggregate per payee per financial year. Rate: 10% for professional services [194J(b)] — technical services, royalty, and call-centre payments are taxed separately at 2% under 194J(a).
Menu Path:  Gateway of Tally → Create → Journal   (booking the expense with TDS deducted)
Entry 1 — booking the expense
You engage CA Rakesh & Co for professional services billed at ₹60,000 (above the ₹50,000 threshold).
Account
Dr / Cr
Professional Fees A/c (₹60,000)
Dr
CA Rakesh & Co A/c (₹54,000)
Cr
TDS Payable @10% u/s 194J A/c (₹6,000)
Cr
Illustrative TallyPrime screen — Booking professional fees with TDS u/s 194J (recreated to match your interface)
Effect on P&L:  Professional Fees A/c is an Indirect Expense — it reduces profit by the full ₹60,000, the moment the expense is booked (not when it's paid).
Effect on Balance Sheet:  CA Rakesh & Co (Sundry Creditor, Liability) increases by ₹54,000 — the net amount still owed. TDS Payable (Liability) increases by ₹6,000 — tax held back, due to the government.
Entry 2 — depositing the TDS with the government
TDS deducted in a month must be deposited by the 7th of the following month (30th April for March deductions).
Account
Dr / Cr
TDS Payable @10% u/s 194J A/c (₹6,000)
Dr
Bank A/c (₹6,000)
Cr
Illustrative TallyPrime screen — TDS Payment u/s 194J (recreated to match your interface)
Effect on P&L:  None — the expense was already booked in Entry 1. This is just settling the amount held back.
Effect on Balance Sheet:  TDS Payable (Liability) goes to ₹0. Bank (Asset) decreases by ₹6,000. Separately, paying CA Rakesh & Co the net ₹54,000 is a standard Payment voucher, exactly like the Payables Module.
B. TDS under Section 194C — Payments to Contractors
Applies to payments to contractors or sub-contractors for work carried out. Threshold: ₹30,000 for a single payment, or ₹1,00,000 in aggregate during the financial year. Rate: 1% if the contractor is an individual or HUF, 2% for all other contractors (companies, firms, etc.).
Entry 1 — booking the expense
Balaji Construction (a firm) completes contract work billed at ₹2,00,000.
Account
Dr / Cr
Contract Charges A/c (₹2,00,000)
Dr
Balaji Construction A/c (₹1,96,000)
Cr
TDS Payable @2% u/s 194C A/c (₹4,000)
Cr
Illustrative TallyPrime screen — Booking contract charges with TDS u/s 194C (recreated to match your interface)
Effect on P&L:  Contract Charges A/c is a Direct/Indirect Expense (depending on the nature of the work) — it reduces profit by the full ₹2,00,000 the moment it's booked.
Effect on Balance Sheet:  Balaji Construction (Sundry Creditor, Liability) increases by ₹1,96,000. TDS Payable (Liability) increases by ₹4,000.
Entry 2 — depositing the TDS with the government
Account
Dr / Cr
TDS Payable @2% u/s 194C A/c (₹4,000)
Dr
Bank A/c (₹4,000)
Cr
Illustrative TallyPrime screen — TDS Payment u/s 194C (recreated to match your interface)
Effect on P&L:  None — the expense was already booked in Entry 1.
Effect on Balance Sheet:  TDS Payable (Liability) goes to ₹0. Bank (Asset) decreases by ₹4,000.
Quick comparison: 194J vs 194C
194J — Professional Fees
194C — Contractors
Applies to
Legal, accounting, consultancy, technical & professional services
Work contracts, sub-contracts, labour/construction charges
Threshold
₹50,000 in aggregate per FY
₹30,000 single payment, or ₹1,00,000 aggregate per FY
Rate
10% (professional) / 2% (technical, 194J(a))
1% (individual/HUF) / 2% (others)
Deposit due date
7th of the following month
7th of the following month
P&L impact
Full expense booked immediately
Full expense booked immediately
Bottom line: TDS never creates an expense or income by itself — the real P&L impact happens when the underlying professional fee or contract charge is first booked. Deducting and depositing TDS is just the mechanics of settling up with the tax authorities afterwards.`,
  '4.2 Taxation Module_2_GST': `GST Module
Sale Entry, Purchase Entry (CGST/SGST/IGST) & Utilisation
GST splits into three components depending on where the buyer and seller are located: CGST + SGST for a sale or purchase within the same state, and IGST for a sale or purchase across state lines. This module walks through both cases for Sales and Purchase, then shows how the tax collected and paid gets netted off and settled with the government.
Worked examples use 18% GST throughout (9% CGST + 9% SGST for intra-state, 18% IGST for inter-state) — the same total tax either way, just split differently.
1. Sale Entry
1a. Intra-state sale — CGST + SGST
A credit sale of ₹10,000 to Metro Retailers, also in Karnataka.
Account
Dr / Cr
Sundry Debtor — Metro Retailers A/c (₹11,800)
Dr
Sales A/c (₹10,000)
Cr
Output CGST A/c @9% (₹900)
Cr
Output SGST A/c @9% (₹900)
Cr
Illustrative TallyPrime screen — Intra-state Sale with CGST + SGST (recreated to match your interface)
1b. Inter-state sale — IGST
A credit sale of ₹20,000 to Global Traders in Maharashtra (a different state).
Account
Dr / Cr
Sundry Debtor — Global Traders A/c (₹23,600)
Dr
Sales A/c (₹20,000)
Cr
Output IGST A/c @18% (₹3,600)
Cr
Illustrative TallyPrime screen — Inter-state Sale with IGST (recreated to match your interface)
Effect on P&L (both cases):  Sales A/c is Direct Income — it increases revenue and Gross Profit by ₹10,000 / ₹20,000 respectively, regardless of whether the tax charged was CGST+SGST or IGST.
Effect on Balance Sheet:  The Sundry Debtor (Metro Retailers or Global Traders) increases by the full invoice value — an asset representing money owed to you. Output CGST, SGST, and IGST are all Current Liabilities — money collected on the government's behalf, not your income.
2. Purchase Entry
2a. Intra-state purchase — CGST + SGST
A credit purchase of ₹10,000 from Sunrise Traders, also in Karnataka.
Account
Dr / Cr
Purchase A/c (₹10,000)
Dr
Input CGST A/c @9% (₹900)
Dr
Input SGST A/c @9% (₹900)
Dr
Sundry Creditor — Sunrise Traders A/c (₹11,800)
Cr
Illustrative TallyPrime screen — Intra-state Purchase with CGST + SGST (recreated to match your interface)
2b. Inter-state purchase — IGST
A credit purchase of ₹20,000 from Prime Vendors in Tamil Nadu (a different state).
Account
Dr / Cr
Purchase A/c (₹20,000)
Dr
Input IGST A/c @18% (₹3,600)
Dr
Sundry Creditor — Prime Vendors A/c (₹23,600)
Cr
Illustrative TallyPrime screen — Inter-state Purchase with IGST (recreated to match your interface)
Effect on P&L (both cases):  Purchase A/c is a Direct Expense — it reduces Gross Profit by ₹10,000 / ₹20,000 respectively. Input GST never touches the P&L in either case.
Effect on Balance Sheet:  The Sundry Creditor (Sunrise Traders or Prime Vendors) increases by the full invoice value — a liability representing money you owe. Input CGST, SGST, and IGST are all Current Assets — Input Tax Credit (ITC) you can claim back.
3. Utilisation of GST (Input Tax Credit Set-off)
At month-end, every Output GST ledger is adjusted against the matching Input GST (ITC), and whatever liability remains becomes the amount actually paid to the government. The order in which credit can be used is fixed by GST law, not by choice:
IGST credit is used first against IGST liability; anything left over can spill into CGST, then SGST liability.
CGST credit is used against CGST liability first, then any leftover can spill into IGST liability (never SGST).
SGST credit is used against SGST liability first, then any leftover can spill into IGST liability (never CGST).
CGST and SGST credit can never be used against each other directly.
Worked example, combining the entries above plus other transactions during the month: Output IGST ₹8,000, Output CGST ₹5,000, Output SGST ₹5,000, against Input IGST ₹6,000, Input CGST ₹3,000, Input SGST ₹3,000. Since each Input amount is smaller than its matching Output amount here, no cross-utilisation is actually needed — but the entry below still follows the correct head-by-head order.
Menu Path:  Gateway of Tally → Create → Journal   (or Alt+G [Go To] → Create Voucher → F7: Journal)
Entry
Account
Dr / Cr
Output IGST A/c (₹8,000)
Dr
Output CGST A/c (₹5,000)
Dr
Output SGST A/c (₹5,000)
Dr
Input IGST A/c (₹6,000)
Cr
Input CGST A/c (₹3,000)
Cr
Input SGST A/c (₹3,000)
Cr
GST Payable A/c (₹6,000)
Cr
Illustrative TallyPrime screen — GST Utilisation via Journal voucher (recreated to match your interface)
Effect on P&L:  None — this is purely a reclassification of tax already accounted for when the original Sales and Purchase entries were made.
Effect on Balance Sheet:  Output IGST, CGST, and SGST (Liabilities) are all brought down to ₹0. Input IGST, CGST, and SGST (Assets) are also brought down to ₹0. A new GST Payable (Liability) of ₹6,000 — the net cash amount still due — appears in their place.
4. GST Payment
The net GST liability is paid to the government, typically by the 20th of the following month (GSTR-3B due date for regular taxpayers).
Account
Dr / Cr
GST Payable A/c (₹6,000)
Dr
Bank A/c (₹6,000)
Cr
Illustrative TallyPrime screen — GST Payment via bank (recreated to match your interface)
Effect on P&L:  None — GST was never your money; you were only collecting and passing it through.
Effect on Balance Sheet:  GST Payable (Liability) goes to ₹0. Bank (Asset) decreases by ₹6,000.
Bonus: interest and late fees ARE an expense
If GST is paid after the due date, interest (18% p.a.) and late fees are genuine costs — unlike the GST principal itself, these do hit the P&L as an Indirect Expense. Filing GSTR-3B on time avoids this entirely.
Bottom line: Sales and Purchase entries create the GST liability/credit at the CGST+SGST or IGST level depending on geography, but P&L impact only ever comes from the Sales/Purchase value itself, never the tax. Utilisation and Payment are just the mechanics of settling that tax with the government, following a fixed set-off order.`,
  '5.Fixed_Assets_Module': `Fixed Assets Module
Purchase, Depreciation & Sale — Entries and Effect on P&L / Balance Sheet
Fixed Assets are things a business buys to use, not to resell — machinery, furniture, vehicles, computers. This module covers their full lifecycle: buying one, writing down its value every year through depreciation, and eventually selling or disposing of it.
Worked example follows one asset (Machinery) from purchase through a year of depreciation, plus a second, already-depreciated asset (Furniture) being sold.
1. Asset Purchase
New Machinery worth ₹5,00,000 is bought on credit from Bharat Machinery Ltd, plus 18% GST.
Menu Path:  Gateway of Tally → Create → Purchase   (or Alt+G [Go To] → Create Voucher → F9: Purchase)
Entry
Account
Dr / Cr
Machinery A/c (₹5,00,000)
Dr
Input CGST A/c @9% (₹45,000)
Dr
Input SGST A/c @9% (₹45,000)
Dr
Sundry Creditor — Bharat Machinery Ltd A/c (₹5,90,000)
Cr
Illustrative TallyPrime screen — Asset Purchase with GST (recreated to match your interface)
Effect on P&L:  None. Buying a fixed asset is Capital Expenditure, not an expense — it doesn't reduce profit at all. Its cost is instead spread over its useful life through Depreciation.
Effect on Balance Sheet:  Machinery (Fixed Asset) increases by ₹5,00,000. Input GST (Current Asset) increases by ₹90,000 — this GST is generally claimable as ITC, unlike GST on a few blocked categories like motor vehicles for non-transport businesses. Sundry Creditor (Liability) increases by ₹5,90,000.
2. Depreciation
At year-end, the Machinery is depreciated @15% p.a. on a Straight Line basis: ₹5,00,000 × 15% = ₹75,000.
Menu Path:  Gateway of Tally → Create → Journal   (or Alt+G [Go To] → Create Voucher → F7: Journal)
Entry
Account
Dr / Cr
Depreciation A/c (₹75,000)
Dr
Machinery A/c (₹75,000)
Cr
Illustrative TallyPrime screen — Depreciation entry via Journal voucher (recreated to match your interface)
Effect on P&L:  Depreciation A/c is an Indirect Expense — it reduces profit by ₹75,000. This is the mechanism by which a capital purchase eventually does hit the P&L, just spread across several years instead of all at once.
Effect on Balance Sheet:  Machinery (Fixed Asset) decreases by ₹75,000, now carried at its net book value of ₹4,25,000. No cash moves — depreciation is a non-cash entry.
Note: two ways to record depreciation
Direct method (used above, and common for small businesses in TallyPrime): credit the asset ledger directly, so its balance always shows current book value.
Gross Block method (required for companies under Schedule III): keep the asset at original cost forever, and accumulate depreciation in a separate “Accumulated Depreciation” ledger shown as a deduction from the asset on the Balance Sheet. Net effect on profit is identical either way.
3. Asset Sale / Disposal
Old Furniture, carried at a book value of ₹80,000 after previous years' depreciation, is sold for ₹95,000 — a profit of ₹15,000.
Entry
Account
Dr / Cr
Bank A/c (₹95,000)
Dr
Furniture A/c (₹80,000)
Cr
Profit on Sale of Asset A/c (₹15,000)
Cr
If the sale price had been below book value (say ₹70,000), the shortfall would instead go to a “Loss on Sale of Asset A/c”, debited alongside Bank.
Illustrative TallyPrime screen — Asset Sale via Journal voucher (recreated to match your interface)
Effect on P&L:  Profit on Sale of Asset A/c is Non-operating/Indirect Income — it increases profit by ₹15,000. (A Loss on Sale would instead reduce profit.)
Effect on Balance Sheet:  Furniture (Fixed Asset) is removed entirely, at its ₹80,000 book value. Bank (Asset) increases by ₹95,000 received. Net effect: total assets rise by ₹15,000 — exactly matching the profit recognised.
Quick comparison
Purchase
Depreciation
Sale / Disposal
Voucher type
Purchase (F9)
Journal (F7)
Journal (F7)
What is debited?
Asset + Input GST
Depreciation A/c
Bank/Debtor
What is credited?
Creditor / Bank
Asset A/c
Asset A/c + Profit (or Dr Loss)
P&L impact
None (Capital Expenditure)
Reduces profit
Increases (or decreases) profit
Cash movement
Usually deferred (credit purchase)
None — non-cash entry
Cash/bank received immediately
Bonus: two depreciation rate books
Companies often maintain depreciation two ways: Companies Act rates (Straight Line or Written Down Value, for the financial statements shown to shareholders) and Income Tax Act rates (Written Down Value, block-of-assets method, for computing taxable income). The two rarely match exactly, which is one of the reasons book profit and taxable profit differ — a concept covered under Deferred Tax.
Bottom line: buying a fixed asset never touches the P&L on day one — depreciation is what gradually converts that cost into an expense, year by year, until the asset is eventually sold and any final profit or loss on disposal is recognised in one go.`,
  '6.Payables_Module': `Payables Module
Full Payment, Partial Payment & Debit Note — Entries and Effect on P&L / Balance Sheet
Payables is the money you owe suppliers, tracked ledger-by-ledger under Sundry Creditors — the mirror image of Receivables. Every credit purchase creates a payable; this module covers the three ways that balance changes afterwards: paying it off in full, paying part of it, and reducing it through a purchase return.
For bill-by-bill tracking (the New Ref / Against Ref numbers below) to work, the supplier's ledger must have Maintain balances bill-by-bill set to Yes — covered in the Ledger Creation module.
1. Full Payment
Om Suppliers' invoice for ₹35,000 (Ref 5, raised 20-Mar-26) is paid off completely in one go.
Menu Path:  Gateway of Tally → Create → Payment   (or Alt+G [Go To] → Create Voucher → F5: Payment)
Entry
Account
Dr / Cr
Sundry Creditor — Om Suppliers A/c (₹35,000)
Dr
Bank A/c (₹35,000)
Cr
Illustrative TallyPrime screen — Full Payment against Ref 5 (recreated to match your interface)
Effect on P&L:  None — the expense was already booked when the original Purchase entry was made. This payment simply clears the amount owed.
Effect on Balance Sheet:  Om Suppliers' balance in Sundry Creditors goes to ₹0. Bank (Asset) decreases by ₹35,000.
2. Partial Payment
You owe Kavita Textiles ₹40,000 (Ref 8, raised 28-Mar-26) but only pay ₹25,000 for now — the remaining ₹15,000 stays payable against the same reference.
Entry
Account
Dr / Cr
Sundry Creditor — Kavita Textiles A/c (₹25,000)
Dr
Bank A/c (₹25,000)
Cr
Note: ₹15,000 of Ref 8 remains open and will still show up in the Payables Outstanding report until it's cleared.
Illustrative TallyPrime screen — Partial Payment, ₹15,000 still payable (recreated to match your interface)
Effect on P&L:  None, for the same reason as a full payment — no new expense is being recognised here.
Effect on Balance Sheet:  Kavita Textiles' balance in Sundry Creditors falls from ₹40,000 to ₹15,000. Bank (Asset) decreases by ₹25,000.
3. Debit Note (Purchase Return)
You return ₹3,000 worth of defective goods to Metro Distributors from an earlier purchase. A Debit Note reverses that portion of the purchase, including its GST, and reduces what you owe them.
Menu Path:  Gateway of Tally → Create → Debit Note   (enable via F11 features if not visible; typically Ctrl+F9)
Entry
Account
Dr / Cr
Sundry Creditor — Metro Distributors A/c (₹3,540)
Dr
Purchase Return A/c (₹3,000)
Cr
Input CGST A/c @9% (₹270)
Cr
Input SGST A/c @9% (₹270)
Cr
Illustrative TallyPrime screen — Debit Note for a purchase return (recreated to match your interface)
Effect on P&L:  Purchase Return is a contra-expense account — it reduces the Cost of Goods and therefore increases Gross Profit by ₹3,000. This is the one entry in this module that does move the P&L.
Effect on Balance Sheet:  Metro Distributors' balance in Sundry Creditors decreases by ₹3,540 (the amount you no longer owe them). Input GST (Current Asset) decreases by ₹540, since you can no longer claim credit on the returned portion.
Quick comparison
Full Payment
Partial Payment
Debit Note
Voucher type
Payment (F5)
Payment (F5)
Debit Note
What is debited?
Sundry Creditor
Sundry Creditor
Sundry Creditor
What is credited?
Bank
Bank
Purchase Return + Input GST
P&L impact
None
None
Increases Gross Profit
Creditor balance after
Fully cleared
Reduced, not cleared
Reduced (goods returned)
Bonus: Outstanding Payables & Ageing
To see who you owe and for how long, go to Gateway of Tally → Display More Reports → Payables (or Bills Outstanding, viewed from the supplier side). Press F6 to switch the report into an ageing view, which buckets every open bill into ranges like 0–30, 31–60, 61–90, and 90+ days overdue.
Keeping this current matters for cash-flow planning — it tells you exactly what's due and when, so payments can be prioritised before they're overdue.
Bottom line: paying a supplier — in full or in part — never touches the P&L, it just clears a liability with cash. A Debit Note is the exception: because it reverses part of a purchase, it increases Gross Profit the moment it's issued, not when the goods physically leave your warehouse.`,
  '7.Receivables_Module': `Receivables Module
Full Receipt, Partial Receipt & Credit Note — Entries and Effect on P&L / Balance Sheet
Receivables is the money customers owe you, tracked ledger-by-ledger under Sundry Debtors. Every credit sale creates a receivable; this module covers the three ways that balance changes afterwards: getting paid in full, getting paid in part, and reducing it through a sales return.
For bill-by-bill tracking (the New Ref / Against Ref numbers you'll see below) to work, the customer's ledger must have Maintain balances bill-by-bill set to Yes — covered in the Ledger Creation module.
1. Full Receipt
ABC Ltd's invoice for ₹11,800 (Ref 1, raised 1-Apr-26) is paid off completely in one go.
Menu Path:  Gateway of Tally → Create → Receipt   (or Alt+G [Go To] → Create Voucher → F6: Receipt)
Entry
Account
Dr / Cr
Bank A/c (₹11,800)
Dr
Sundry Debtor — ABC Ltd A/c (₹11,800)
Cr
Illustrative TallyPrime screen — Full Receipt against Ref 1 (recreated to match your interface)
Effect on P&L:  None — the income was already booked when the original Sales entry was made. This receipt simply converts a receivable into cash.
Effect on Balance Sheet:  ABC Ltd's balance in Sundry Debtors goes to ₹0. Bank (Asset) increases by ₹11,800.
2. Partial Receipt
Sunrise Enterprises owes ₹25,000 (Ref 6, raised 25-Mar-26) but only pays ₹15,000 for now — the remaining ₹10,000 stays outstanding against the same reference.
Entry
Account
Dr / Cr
Bank A/c (₹15,000)
Dr
Sundry Debtor — Sunrise Enterprises A/c (₹15,000)
Cr
Note: ₹10,000 of Ref 6 remains open and will still show up in the Bills Outstanding report until it's cleared.
Illustrative TallyPrime screen — Partial Receipt, ₹10,000 still outstanding (recreated to match your interface)
Effect on P&L:  None, for the same reason as a full receipt — no new income is being recognised here.
Effect on Balance Sheet:  Sunrise Enterprises' balance in Sundry Debtors falls from ₹25,000 to ₹10,000. Bank (Asset) increases by ₹15,000.
3. Credit Note (Sales Return)
Global Mart returns ₹2,000 worth of goods from an earlier invoice. A Credit Note reverses that portion of the sale, including its GST, and reduces what Global Mart owes.
Menu Path:  Gateway of Tally → Create → Credit Note   (enable via F11 features if not visible; typically Ctrl+F8)
Entry
Account
Dr / Cr
Sales Return A/c (₹2,000)
Dr
Output CGST A/c @9% (₹180)
Dr
Output SGST A/c @9% (₹180)
Dr
Sundry Debtor — Global Mart A/c (₹2,360)
Cr
Illustrative TallyPrime screen — Credit Note for a sales return (recreated to match your interface)
Effect on P&L:  Sales Return is a contra-revenue account — it reduces net Sales and therefore Gross Profit by ₹2,000. This is the one entry in this module that does move the P&L.
Effect on Balance Sheet:  Global Mart's balance in Sundry Debtors decreases by ₹2,360 (the amount they no longer owe you). Output GST (Current Liability) decreases by ₹360, since you no longer need to remit tax on the returned portion.
Quick comparison
Full Receipt
Partial Receipt
Credit Note
Voucher type
Receipt (F6)
Receipt (F6)
Credit Note
What is debited?
Bank
Bank
Sales Return + Output GST
What is credited?
Sundry Debtor
Sundry Debtor
Sundry Debtor
P&L impact
None
None
Reduces Sales / Gross Profit
Debtor balance after
Fully cleared
Reduced, not cleared
Reduced (goods returned)
Bonus: Outstanding Receivables & Ageing
To see who owes you what — and for how long — go to Gateway of Tally → Display More Reports → Receivables (or Bills Outstanding). Press F6 to switch the report into an ageing view, which buckets every open bill into ranges like 0–30, 31–60, 61–90, and 90+ days overdue.
This report only works correctly if bill-by-bill tracking is switched on for each customer ledger — without it, TallyPrime can only show a lump total, not which specific invoices are still open.
Bottom line: receiving money — in full or in part — never touches the P&L, it just converts a receivable into cash. A Credit Note is the exception: because it reverses part of a sale, it reduces Gross Profit the moment it's issued, not when the money changes hands.`,
  '8.Journal_Module': `Journal Module
Outstanding Expense, Prepaid Expense & Bad Debts Written Off
The Journal voucher is the catch-all for adjustment entries that don't involve Cash or Bank directly — you've already seen it used for Depreciation, GST Utilisation, and TDS booking in earlier modules. This module covers three more classic Journal entries: recognising an expense before it's paid, deferring an expense already paid, and writing off money that will never be collected.
By default, TallyPrime blocks Cash and Bank ledgers inside a Journal voucher — that restriction exists precisely so Journal stays reserved for non-cash adjustments like these (it can be lifted via F12 Configure if genuinely needed).
Menu Path:  Gateway of Tally → Create → Journal   (or Alt+G [Go To] → Create Voucher → F7: Journal)
1. Outstanding Expense (Accrual)
March 2027 salary of ₹80,000 has not been paid by year-end, but the expense belongs to March under the accrual basis of accounting — it must be recognised now, not when it's eventually paid.
Entry
Account
Dr / Cr
Salary A/c (₹80,000)
Dr
Outstanding Salary A/c (₹80,000)
Cr
Illustrative TallyPrime screen — Outstanding Expense via Journal voucher (recreated to match your interface)
Effect on P&L:  Salary A/c is an Indirect Expense — it reduces profit by ₹80,000, recognised in the correct accounting period even though the cash hasn't left yet.
Effect on Balance Sheet:  Outstanding Salary (Current Liability) increases by ₹80,000 — money the company owes its employees. When it's eventually paid, this liability is cleared with a normal Payment voucher, exactly like the Payables Module.
2. Prepaid Expense Adjustment
A 12-month insurance premium of ₹24,000 is paid on 1-Jan-2027 and, like most expense payments, is booked entirely to the expense ledger at the time. At year-end (31-Mar-2027), only 3 months (₹6,000) actually belong to this year — the remaining 9 months (₹18,000) need to be carried forward as an asset.
Entry 1 — booking the expense (at the time of payment)
Account
Dr / Cr
Insurance A/c (₹24,000)
Dr
Bank A/c (₹24,000)
Cr
Illustrative TallyPrime screen — Insurance premium paid via Payment voucher (recreated to match your interface)
Effect on P&L (at this point):  Insurance A/c (Expense) increases by the full ₹24,000 — as things stand right now, the entire premium looks like this year's cost, even though 9 months of it actually belong to next year.
Effect on Balance Sheet (at this point):  Bank (Asset) decreases by ₹24,000.
Entry 2 — the prepaid adjustment (at year-end)
Before the books are closed for the year, the 9-month portion that belongs to next year is moved out of the expense and into a Prepaid Asset.
Account
Dr / Cr
Prepaid Insurance A/c (₹18,000)
Dr
Insurance A/c (₹18,000)
Cr
Illustrative TallyPrime screen — Prepaid Expense adjustment via Journal voucher (recreated to match your interface)
Effect on P&L:  Insurance A/c (Expense) decreases by ₹18,000 — this reverses the part of the original payment that doesn't belong to this year, bringing the year's insurance expense down to its correct ₹6,000, and increasing profit correspondingly.
Effect on Balance Sheet:  Prepaid Insurance (Current Asset) increases by ₹18,000 — a benefit the company hasn't used up yet. It gets converted back into an expense next year, as time passes.
3. Bad Debts Written Off
XYZ Traders, a customer owing ₹25,000, has gone out of business — the amount is now irrecoverable and must be removed from the books.
Entry
Account
Dr / Cr
Bad Debts A/c (₹25,000)
Dr
Sundry Debtor — XYZ Traders A/c (₹25,000)
Cr
Illustrative TallyPrime screen — Bad Debts written off via Journal voucher (recreated to match your interface)
Effect on P&L:  Bad Debts A/c is an Indirect Expense — it reduces profit by ₹25,000. This is the honest recognition of a loss that, in reality, happened earlier (at the original sale) but is only confirmed now.
Effect on Balance Sheet:  XYZ Traders' balance in Sundry Debtors is reduced to ₹0 — an asset that was never really going to be collected is removed, so the Balance Sheet stops overstating what the company owns.
Quick comparison
Outstanding Expense
Prepaid Expense
Bad Debts
What is debited?
Expense A/c
Prepaid Expense A/c (Asset)
Bad Debts A/c
What is credited?
Outstanding Expense A/c (Liability)
Expense A/c
Sundry Debtor
P&L impact
Increases expense
Decreases expense
Increases expense
Balance Sheet impact
Creates a new Liability
Creates a new Asset
Removes part of an Asset
Why it's needed
Recognise a cost before cash is paid
Defer a cost already paid but not yet used up
Stop overstating money that won't be collected
Bottom line: all three entries exist for the same reason — to make sure the P&L reflects the right expense for the right period, regardless of when cash actually moves. That's the accrual principle in action, and the Journal voucher is the tool that makes it possible.`,
};

// Which module doc covers each concept — originally the hint ladder's 'reference
// pointer' target (project-overview.md's reference-material-by-concept-tag).
export const CONCEPT_TO_MODULE_DOC: Record<ConceptTag, string> = {
  sales_voucher_basics: '1.Sales_Module',
  purchase_voucher_basics: '2.Purchase_Module',
  payment_voucher_basics: '3.Bank_Module',
  receipt_voucher_basics: '3.Bank_Module',
  contra_voucher_basics: '3.Bank_Module',
  journal_voucher_basics: '8.Journal_Module',
  gst_classification: '4.2 Taxation Module_2_GST',
  tds_classification: '4.1 Taxation Module_1_TDS',
  bill_by_bill_referencing: '6.Payables_Module',
  narration_discipline: '8.Journal_Module',
  trial_balance_tie_out: '8.Journal_Module',
};
