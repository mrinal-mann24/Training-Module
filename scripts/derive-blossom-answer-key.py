# Derives the Blossom Retail Variant A diagnostic answer key from the pack's
# xlsx files (Opening TB, Sales Register, Purchase Register, Bank Statement).
#
# Output:
#   seed/blossom-variant-a/answer_key.json  — AnswerKeySchema-shaped entries
#   seed/blossom-variant-a/answer_key_review.md — human-readable review doc
#
# Every non-mechanical decision (partial-payment allocations, the advance,
# the Mumbai split, month-end JVs) is explicit code below with a comment, so
# the review doc + this file together are the audit trail. Re-run any time:
#   python scripts/derive-blossom-answer-key.py "<path to pack folder>"
#
# Leg model matches lib/schemas/exercise.ts AnswerKeyEntrySchema and the
# scoring engine (lib/tutor/score-submission.ts): one entry per ledger LEG,
# legs of the same voucher share a `sequence`. GST/TDS/voucher_type/
# bill_reference/narration are voucher-level metadata carried on the legs
# (the scorer diffs them once per voucher). gst_head for intra-state is
# 'CGST' — the scorer infers the head from ledger names and checks a single
# head, a known engine limitation flagged in the review doc.
import json
import sys
import os
from datetime import date

import openpyxl
from datetime import datetime


def as_date(value):
    if hasattr(value, "date") and not isinstance(value, date):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value).strip(), "%d-%b-%Y").date()


PACK_DIR = sys.argv[1] if len(sys.argv) > 1 else r"D:\Mrinal.Manna\OneDrive - KOREFI BUSINESS SOLUTIONS PRIVATE LIMITED\Downloads\BlossomRetail_Variant_A\BlossomRetail_Variant_A"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed", "blossom-variant-a")

HOME_STATE = "KA"
BANK = "HDFC Bank — 1234"

# Alternate acceptable ledger names per key account. Learners name ledgers
# from the register's nature text ("Trading goods") or common Tally habits
# ("Credit Sales A/c") — the pilot reviewer accepted these, so the key must.
# Names whose normalized forms already contain each other (engine containment
# matching, min 5 chars) need no alias here.
ACCOUNT_ALIASES = {
    "Purchases": ["Trading goods", "Purchase of Goods"],
    "Office Equipment": ["Office Computers", "Computers", "Fixed Assets"],
    "Legal & Professional Charges": ["Legal services", "Professional services", "Legal Fees", "Professional Fees"],
    "Repairs & Maintenance": ["Interior work", "Repairs"],
    "Office Maintenance": ["Housekeeping", "Cleaning Charges"],
    "Advertisement & Marketing": ["Marketing collaterals", "Advertising", "Marketing Expenses"],
    "Freight & Delivery Charges": ["Logistics — April", "Logistics", "Delivery Charges", "Freight"],
    "Rent": ["Warehouse rent April", "Warehouse Rent", "Rent Expense", "April Rent", "Office Rent"],
    "Software Subscription": ["SaaS subscription", "Software Expenses", "Subscription Charges", "Software Services", "CARESW"],
    "Packing Materials": ["Packaging material", "Packing Expenses"],
    "Salaries": ["Salary", "Salary A/c", "Staff Salary"],
    "Outstanding Expenses": ["Rent Payable", "Outstanding Rent", "Expenses Payable"],
    "Prepaid Software": ["Prepaid Expenses", "Prepaid Exp", "Prepaid Services"],
    "Electricity Charges": ["Electricity Expenses", "Power Charges", "BESCOM"],
    "HDFC Bank — 1234": ["HDFC Bank", "Bank", "HDFC Bank A/c"],
    # Netting a return into the main Sales/Purchases ledger (instead of a
    # separate Returns ledger) is legitimate practice — the pilot trainee did
    # exactly that and the reviewer accepted it.
    "Sales Returns": ["Sales Return", "Sales", "Credit Sales A/c"],
    "Purchase Returns": ["Purchase Return", "Purchases", "Trading goods"],
    "Suspense": ["Suspense A/c", "Suspense Account"],
    "Cash": ["Cash-in-Hand", "Cash A/c"],
    "Interest Income": ["Interest Received", "Bank Interest", "Interest", "INT CREDIT"],
}

vouchers = []  # each: dict(date, vtype, legs=[(account, drcr, amount)], gst_head, gst_rate, tds..., bill_ref, narration, concepts, note)


def V(d, vtype, legs, gst_head=None, gst_rate=None, tds_section=None, tds_rate=None, tds_base=None,
      bill_ref=None, narration=None, concepts=None, note=None, order=0):
    vouchers.append(dict(date=d, vtype=vtype, legs=legs, gst_head=gst_head, gst_rate=gst_rate,
                         tds_section=tds_section, tds_rate=tds_rate, tds_base=tds_base,
                         bill_ref=bill_ref, narration=narration,
                         concepts=concepts or [], note=note or "", order=order))


def gst_head_for(state):
    return "CGST" if state == HOME_STATE else "IGST"


def load(path, sheet=None):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    return list(ws.iter_rows(values_only=True))


def rows_after_header(rows, header_first_cell):
    out = []
    started = False
    for r in rows:
        if started and any(c is not None for c in r):
            out.append(r)
        if r and r[0] == header_first_cell:
            started = True
    return out


# ---------------------------------------------------------------- sales
sales = rows_after_header(load(os.path.join(PACK_DIR, "2. Sales Register.xlsx")), "Date")
for (d, inv, customer, state, base, gst, total, terms) in sales:
    d = as_date(d)
    if inv == "(cash)":
        # Cash sale: Dr Cash, Cr Sales. Also appears in the Cash Memo sheet —
        # it is ONE voucher, entered here only.
        V(d, "Sales", [("Cash", "Dr", total), ("Sales", "Cr", base)],
          gst_head="CGST", gst_rate=18, narration="Being cash sale to walk-in customer",
          concepts=["sales_voucher_basics", "gst_classification"], order=1)
        continue
    if str(inv).startswith("CN-"):
        # Credit note: reverses OUTPUT GST, against the original invoice ref.
        V(d, "Credit Note", [("Sales Returns", "Dr", -base), (customer.split(" (")[0], "Cr", -total)],
          gst_head=gst_head_for(state), gst_rate=18, bill_ref="INV-001",
          narration=f"Being sales return from {customer.split(' (')[0]} against INV-001",
          concepts=["sales_voucher_basics", "gst_classification", "bill_by_bill_referencing"],
          note="Trap: must reverse OUTPUT GST (not Input) and use a Credit Note voucher.", order=1)
        continue
    concepts = ["sales_voucher_basics", "gst_classification", "bill_by_bill_referencing"]
    note = ""
    if inv == "INV-012":
        note = "TRAP (pilot: Elina's one GST slip): Coimbatore Interiors is TAMIL NADU — IGST, not CGST/SGST."
    if inv == "INV-008":
        note = "TRAP: 30d terms — a CREDIT sale to Hyderabad Interiors, must NOT go to Cash Sales."
    if inv == "INV-009":
        note = "Advance ADV-01 (received 12-Apr, 1,50,000) is applied against this invoice; balance 62,400 as New Ref."
    V(d, "Sales", [(customer, "Dr", total), ("Sales", "Cr", base)],
      gst_head=gst_head_for(state), gst_rate=18, bill_ref=str(inv),
      narration=f"Being goods sold to {customer} vide {inv}",
      concepts=concepts, note=note, order=1)

# ---------------------------------------------------------------- purchases
NATURE_ACCOUNT = {
    "Office Computers": ("Office Equipment", ["purchase_voucher_basics", "journal_voucher_basics"],
                         "TRAP: computers are a FIXED ASSET (Office Equipment), not trading purchases."),
    "Legal services": ("Legal & Professional Charges", ["purchase_voucher_basics", "tds_classification"],
                       "NEGATIVE TDS TRAP: Sharma Legal is an individual, 30k < 50k 194J threshold — NO TDS."),
    "Professional services": ("Legal & Professional Charges", ["purchase_voucher_basics", "tds_classification"], ""),
    "Interior work": ("Repairs & Maintenance", ["purchase_voucher_basics", "tds_classification"], ""),
    "Housekeeping": ("Office Maintenance", ["purchase_voucher_basics", "tds_classification"],
                     "NEGATIVE TDS TRAP: 25k below the 30k single-bill 194C limit — NO TDS."),
    "Marketing collaterals": ("Advertisement & Marketing", ["purchase_voucher_basics", "tds_classification"], ""),
    "Logistics — April": ("Freight & Delivery Charges", ["purchase_voucher_basics"], ""),
    "Warehouse rent April": ("Rent", ["purchase_voucher_basics", "tds_classification"], ""),
    "SaaS subscription": ("Software Subscription", ["purchase_voucher_basics"], ""),
}
purchases = rows_after_header(load(os.path.join(PACK_DIR, "3. Purchase Register.xlsx")), "Date")
vendor_net = {}
for (d, bill, vendor, state, nature, base, gst, total, tds, terms) in purchases:
    d = as_date(d)
    vendor_clean = vendor.split(" (")[0]
    if str(bill).startswith("DN-"):
        # Debit note: purchase return to Mumbai Suppliers, reverses INPUT IGST.
        V(d, "Debit Note", [(vendor_clean, "Dr", -total), ("Purchase Returns", "Cr", -base)],
          gst_head="IGST", gst_rate=18, bill_ref=str(bill),
          narration=f"Being goods returned to {vendor_clean} vide {bill}",
          concepts=["purchase_voucher_basics", "gst_classification", "bill_by_bill_referencing"], order=2)
        continue
    account, concepts, note = NATURE_ACCOUNT.get(nature, ("Purchases", ["purchase_voucher_basics", "gst_classification", "bill_by_bill_referencing"], ""))
    if nature.startswith("Trading goods"):
        account, concepts, note = "Purchases", ["purchase_voucher_basics", "gst_classification", "bill_by_bill_referencing"], ""
    tds_section = tds_rate = tds_base = None
    net = total
    tds_str = str(tds)
    if tds_str.startswith("194"):
        sec, pct = tds_str.split(" ")
        tds_section, tds_rate, tds_base = sec, float(pct.rstrip("%")), base
        net = total - base * tds_rate / 100  # TDS on the taxable BASE only
    vendor_net[str(bill)] = net
    V(d, "Purchase", [(account, "Dr", base), (vendor_clean, "Cr", net)],
      gst_head=gst_head_for(state), gst_rate=18,
      tds_section=tds_section, tds_rate=tds_rate, tds_base=tds_base,
      bill_ref=str(bill), narration=f"Being {nature.lower()} from {vendor_clean} vide bill {bill}",
      concepts=concepts, note=note, order=2)

# ---------------------------------------------------------------- bank statement
# Map each statement line to party + refs. Allocations for partial payments
# are explicit decisions here — every one is listed in the review doc.
BANK_MAP = {
    "NEFT/N26040201/DECCAN/MARCHPMT": ("Payment", "Deccan Traders", "DT-99", "Opening-balance settlement (March bill), Against Ref"),
    "UPI/26040301/KAREMP/MARCH-INV": ("Receipt", "Karnataka Emporium", "INV-M-101", "Opening-balance receipt (March invoice), Against Ref"),
    "NEFT/N26040501/MUMBAISUP/MARCHPMT": ("Payment", "Mumbai Suppliers", "MS-M1", "Opening-balance settlement, Against Ref"),
    "NEFT/N26040502/COIMWHL/PMT": ("Payment", "Coimbatore Wholesale", "CW-101", ""),
    "UPI/26040601/LUDWOODS/PMT": ("Receipt", "Ludhiana Woodworks", "INV-010", ""),
    "GOVT PMT — TDS DEPOSIT 194J MARCH": ("Payment", "TDS Payable — u/s 194J", None, "TRAP: clears the opening TDS LIABILITY — not an expense."),
    "UPI/26040701/DBAZAAR/MARCH-INV": ("Receipt", "Delhi Bazaar", "INV-M-102", "Opening-balance receipt, Against Ref"),
    "NEFT/N26040801/AHMDIMPT/PMT": ("Payment", "Ahmedabad Import", "AI-201", ""),
    "NEFT/N26040901/CHENSUP/PMT": ("Payment", "Chennai Suppliers", "CS-092", ""),
    "UPI/26041001/RAJHOME/PMT": ("Receipt", "Rajasthan Home Decor", "INV-011", ""),
    "NEFT/N26041101/COIMINT/PMT": ("Receipt", "Coimbatore Interiors", "INV-012", ""),
    "UPI/26041201/KHANDICRAFT/ORDR": ("Receipt", "Kerala Handicrafts", "ADV-01", "ADVANCE received (Advance ref ADV-01) — not against an invoice; later applied to INV-009."),
    "UPI/26041301/AHMDELITE/PMT": ("Receipt", "Ahmedabad Elite", "INV-013", "PARTIAL: 1,00,000 of 2,12,400 — Against Ref INV-013, balance stays outstanding."),
    "NEFT/N26041501/DECCAN/APRIL-PMT": ("Payment", "Deccan Traders", "DT-115", ""),
    "UPI/26041502/VIZAGFURN/PMT": ("Receipt", "Vizag Furnishings", "INV-015", ""),
    "NEFT/N26041601/MUMBAISUP/PMT": ("Payment", "Mumbai Suppliers", "MS-B1, MS-B2, MS-B3 (part)", "SPLIT 4,50,000 across three bills: B1 2,95,000 + B2 1,41,600 + B3 13,400 partial."),
    "NEFT/N26041602/TRICHYTX/PMT": ("Payment", "Trichy Textiles", "TT-234", ""),
    "UPI/26041701/BNGLOCAL/PMT": ("Receipt", "Bengaluru Local Store", "INV-017", ""),
    "BANK CHRG SMS+MAINT": ("Payment", "Bank Charges", None, "Plain bank charge, no GST component on this line."),
    "UPI/26041801/KAREMP/PMT": ("Receipt", "Karnataka Emporium", "INV-001", "PARTIAL: 1,50,000 against INV-001 (1,94,700 net of CN-001)."),
    "NEFT/N26041802/KOLKATRD/PMT": ("Payment", "Kolkata Traders", "KT-055", ""),
    "UPI/26041901/KOCHIMOD/PMT": ("Receipt", "Kochi Modern", "INV-014", ""),
    "NEFT/N26042001/MEHTA/PMT": ("Payment", "Mehta & Associates", "CA26-101", "Net of 194J TDS: 88,500 − 7,500 = 81,000."),
    "NEFT/N26042002/CHENSUP2/PMT": ("Payment", "Chennai Suppliers", "CS-093", ""),
    "UPI/26042101/GUJRETAIL/PMT": ("Receipt", "Gujarat Retail", "INV-006", ""),
    "UPI/26042102/MYSDECOR/PMT": ("Receipt", "Mysore Decor", "INV-018", ""),
    "NEFT/N26042201/BALAJI/PMT": ("Payment", "Balaji Interiors", "BI-047", "Net of 194C TDS: 1,77,000 − 3,000 = 1,74,000."),
    "NEFT/N26042202/BNGCLEAN/PMT": ("Payment", "Bangalore Cleaning", "BC-078", ""),
    "UPI/26042301/DBAZAAR/PMT": ("Receipt", "Delhi Bazaar", "INV-003", "PARTIAL: 1,00,000 of 1,77,000 against INV-003."),
    "NEFT/N26042301/SLEGAL/PMT": ("Payment", "Sharma Legal", "SL-018", "Full 35,400 — no TDS was deducted (below threshold)."),
    "NEFT/N26042401/BHARATMAC/ADV": ("Payment", "Bharat Machinery", "ADV-02", "ADVANCE paid to a creditor (Advance ref ADV-02) — no bill yet."),
    "NEFT/N26042402/VIZAGV/PMT": ("Payment", "Vizag Vendors", "VV-042", ""),
    "BILLPAY BESCOM ELEC APRIL": ("Payment", "Electricity Charges", None, ""),
    "NEFT/N26042501/SIGNADV/PMT": ("Payment", "Signage Advertising", "SA-101", "TRAP: net payable is 69,600 (70,800 − 1,200 TDS) but bank shows 69,384 — a 216 residual stays on the vendor. Post as per bank."),
    "UPI/26042601/NAGPURRT/PMT": ("Receipt", "Nagpur Retail", "INV-020", ""),
    "NEFT/N26042602/HERORENT/PMT": ("Payment", "Hero Rentals", "HR-118", "Net of 194I TDS: 47,200 − 4,000 = 43,200."),
    "BANK CHRG MAINT+IMPS+GST": ("Payment", "Bank Charges", None, "TRAP: 850 is GROSS incl. GST — split 720.34 charge + 129.66 Input CGST/SGST (do not book gross)."),
    "UPI/26042701/CHENHS/PMT": ("Receipt", "Chennai Home Store", "INV-004", ""),
    "NEFT/N26042702/DELDIR/PMT": ("Payment", "Delivery Direct", "DD-455", ""),
    "NEFT/N26042801/PRIYAS/SAL": ("Payment", "Salaries", None, "April salary — Priya S."),
    "UPI/26042803/HYDINTR/PMT": ("Receipt", "Hyderabad Interiors", "INV-008", ""),
    "UPI/26042901/KAREMP/PMT": ("Receipt", "Karnataka Emporium", "INV-001 (bal), INV-016 (part)", "ALLOCATION: 44,700 clears INV-001's balance, 300 against INV-016."),
    "UPI/26042902/KOLKEMP/PMT": ("Receipt", "Kolkata Emporium", "INV-021", ""),
    "NEFT/N26042903/SCLOUD/PMT": ("Payment", "Software Cloud LLC", "SC-909", ""),
    "NEFT/N26043001/CARESW/PMT": ("Payment", "PREPAID_SOFTWARE", None, "Month-end note 2: 18,000 covers Apr–Sep. Dr Software Subscription 3,000 (April) + Dr Prepaid Software 15,000."),
    "INT CREDIT SAVINGS Q4": ("Receipt", "Interest Income", None, ""),
    "UPI/26043002/UNKNOWN/REF": ("Receipt", "Suspense", None, "TRAP: unidentifiable sender — a proper Suspense ledger, NOT a ledger named UNKNOWN."),
    "UPI/26043003/DBAZAAR2/PMT": ("Receipt", "Delhi Bazaar", "INV-003 (bal)", "ALLOCATION: 55,000 against INV-003's remaining 77,000; 22,000 stays outstanding."),
    "UPI/26043004/BNGBOUTQ/PMT": ("Receipt", "Bengaluru Boutique", "INV-024", ""),
}
bank = rows_after_header(load(os.path.join(PACK_DIR, "4. Bank Statement.xlsx")), "Date")
for (d, desc, debit, credit, _bal) in bank:
    if desc == "OPENING BALANCE B/F":
        continue
    d = as_date(d)
    mapping = BANK_MAP.get(desc)
    if mapping is None:
        raise SystemExit(f"UNMAPPED bank line: {desc}")
    vtype, party, ref, note = mapping
    amount = debit or credit
    concepts = (["payment_voucher_basics"] if vtype == "Payment" else ["receipt_voucher_basics"])
    if ref:
        concepts.append("bill_by_bill_referencing")
    concepts.append("narration_discipline")  # pilot: bank-line narrations need ref + party
    narration = f"{desc} — {party}" if party not in ("Bank Charges", "Suspense", "Interest Income", "Salaries", "Electricity Charges") else desc
    if party == "PREPAID_SOFTWARE":
        V(d, "Payment", [("Software Subscription", "Dr", 18000), (BANK, "Cr", 18000)],
          narration=f"{desc} — 6-month software subscription Apr–Sep",
          concepts=["payment_voucher_basics", "narration_discipline"], note=note, order=3)
        continue
    if desc == "BANK CHRG MAINT+IMPS+GST":
        V(d, "Payment", [("Bank Charges", "Dr", 720.34), (BANK, "Cr", 850)],
          gst_head="CGST", gst_rate=18, narration=desc,
          concepts=["payment_voucher_basics", "gst_classification"], note=note, order=3)
        continue
    if vtype == "Payment":
        legs = [(party, "Dr", amount), (BANK, "Cr", amount)]
    else:
        legs = [(BANK, "Dr", amount), (party, "Cr", amount)]
    V(d, vtype, legs, bill_ref=ref, narration=narration, concepts=concepts, note=note, order=3)

# ---------------------------------------------------------------- cash memo (purchase side; cash sale already booked with sales register)
V(date(2026, 4, 28), "Payment", [("Packing Materials", "Dr", 2800), ("Cash", "Cr", 2800)],
  narration="Being cash purchase of packaging material from Krishna Packers",
  concepts=["payment_voucher_basics"], note="Cash Memo: cash-only, not in bank statement. Small KA vendor, no GST breakup given.", order=4)

# ---------------------------------------------------------------- month-end JVs
# Month-end note 2: software prepaid apportionment — April's share (1/6 of
# 18,000 = 3,000) stays in the expense; 15,000 moves to Prepaid. Modeled as
# its own JV per house practice (pilot KT: "use Journal Dr Prepaid Expense /
# Cr ...; multiple JVs apportioning"), matching how the pilot trainee posted.
V(date(2026, 4, 30), "Journal", [("Prepaid Software", "Dr", 15000), ("Software Subscription", "Cr", 15000)],
  narration="Being 5/6 of the CARESW software subscription (May-Sep) carried to Prepaid",
  concepts=["journal_voucher_basics"], note="Month-end note 2.", order=5)
# Note 1: rent provision.
V(date(2026, 4, 30), "Journal", [("Rent", "Dr", 35000), ("Outstanding Expenses", "Cr", 35000)],
  narration="Being April office rent provided as outstanding — unpaid at month-end",
  concepts=["journal_voucher_basics"], note="Month-end note 1.", order=5)
# Note 3: GST set-off, HEAD-WISE (the learner posts Output/Input CGST, SGST
# and IGST as separate ledgers — an aggregate "Output GST" leg could never
# match their books). Intra-state (KA) GST splits half CGST / half SGST;
# inter-state is IGST. Inputs include the March c/f (CGST 5,000 + SGST 5,000)
# and the 26-Apr bank-charge input split (129.66 → 64.83 + 64.83).
out_cgst = sum(r[5] / 2 for r in sales if r[3] == HOME_STATE)
out_sgst = out_cgst
out_igst = sum(r[5] for r in sales if r[3] != HOME_STATE)
in_cgst = sum(r[6] / 2 for r in purchases if r[3] == HOME_STATE) + 5000 + 64.83
in_sgst = sum(r[6] / 2 for r in purchases if r[3] == HOME_STATE) + 5000 + 64.83
in_igst = sum(r[6] for r in purchases if r[3] != HOME_STATE)
out_gst = out_cgst + out_sgst + out_igst
in_total = in_cgst + in_sgst + in_igst
net_payable = round(out_gst - in_total, 2)
setoff_legs = [
    ("Output CGST", "Dr", round(out_cgst, 2)),
    ("Output SGST", "Dr", round(out_sgst, 2)),
    ("Output IGST", "Dr", round(out_igst, 2)),
    ("Input CGST", "Cr", round(in_cgst, 2)),
    ("Input SGST", "Cr", round(in_sgst, 2)),
    ("Input IGST", "Cr", round(in_igst, 2)),
]
if net_payable > 0:
    setoff_legs.append(("GST Payable", "Cr", net_payable))
else:
    setoff_legs.append(("GST Credit c/f", "Dr", -net_payable))
V(date(2026, 4, 30), "Journal", setoff_legs,
  narration="Being month-end GST utilisation for April — output set off against input incl. carried-forward credit",
  concepts=["journal_voucher_basics", "gst_classification", "trial_balance_tie_out"],
  note=f"Month-end note 3, head-wise. Output {out_gst:,.2f} vs Input {in_total:,.2f} → net {'payable' if net_payable > 0 else 'credit c/f'} {abs(net_payable):,.2f}. All GST-named ledgers are tie-out-exempt in the engine, so head naming variants do not fail the TB check.", order=5)

# ---------------------------------------------------------------- emit
vouchers.sort(key=lambda v: (v["date"], v["order"]))
entries = []
for seq, v in enumerate(vouchers, start=1):
    for (account, drcr, amount) in v["legs"]:
        entries.append({
            "sequence": seq,
            "correct_account": account,
            "account_aliases": ACCOUNT_ALIASES.get(account, []),
            "dr_cr": drcr,
            "amount": round(abs(float(amount)), 2),
            "voucher_type": v["vtype"],
            "gst_head": v["gst_head"],
            "gst_rate": v["gst_rate"],
            "tds_section": v["tds_section"],
            "tds_rate": v["tds_rate"],
            "tds_base": v["tds_base"],
            "bill_reference": v["bill_ref"],
            "narration": v["narration"],
            "concept_tags": v["concepts"],
            "requires_source_document": False,
            "source_document_type": None,
        })

# Opening balances (the pack company's Opening TB) — the engine seeds the
# Trial Balance tie-out with these so closing = opening + movements.
opening_rows = rows_after_header(load(os.path.join(PACK_DIR, "1. Opening TB.xlsx"), "Opening TB"), "Ledger")
opening_balances = []
for row in opening_rows:
    ledger, _group, dr, cr = row[0], row[1], row[2], row[3]
    if ledger == "TOTAL" or ledger is None:
        continue
    if dr:
        opening_balances.append({"account": ledger, "dr_cr": "Dr", "amount": float(dr)})
    if cr:
        opening_balances.append({"account": ledger, "dr_cr": "Cr", "amount": float(cr)})

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "answer_key.json"), "w", encoding="utf-8") as f:
    json.dump({"entries": entries, "opening_balances": opening_balances}, f, indent=2, ensure_ascii=False)

with open(os.path.join(OUT_DIR, "answer_key_review.md"), "w", encoding="utf-8") as f:
    f.write("# Blossom Retail Variant A — Answer Key (REVIEW DRAFT)\n\n")
    f.write(f"{len(vouchers)} vouchers / {len(entries)} ledger legs, derived by `scripts/derive-blossom-answer-key.py`.\n\n")
    f.write("**Review every line marked with a note — those are the authored judgment calls.**\n\n")
    f.write("Known engine limitations (accepted for v1, from the existing scorer): "
            "(1) vouchers match by date-order position, so a learner's same-day ordering must match register order; "
            "(2) intra-state GST is keyed as CGST (single-head check); "
            "(3) narration content isn't extracted by the parser — narration scoring reports presence only.\n\n")
    f.write("| # | Date | Voucher | Legs | GST | TDS | Ref | Note |\n|---|---|---|---|---|---|---|---|\n")
    for seq, v in enumerate(vouchers, start=1):
        legs = "; ".join(f"{drcr} {acc} {amt:,.2f}" for (acc, drcr, amt) in [(a, d_, abs(float(m))) for (a, d_, m) in v["legs"]])
        gst = f"{v['gst_head']} @{v['gst_rate']}%" if v["gst_head"] else ""
        tds = f"{v['tds_section']} @{v['tds_rate']}% on {v['tds_base']:,}" if v["tds_section"] else ""
        f.write(f"| {seq} | {v['date']} | {v['vtype']} | {legs} | {gst} | {tds} | {v['bill_ref'] or ''} | {v['note']} |\n")

print(f"OK: {len(vouchers)} vouchers, {len(entries)} legs -> {OUT_DIR}")
print(f"GST set-off: output {out_gst:,.2f} vs input {in_total:,.2f} -> net {net_payable:,.2f}")
