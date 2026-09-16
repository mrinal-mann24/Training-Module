"""Shifts the diagnostic pack's xlsx files from the 2026 timeline to 2024.

2026-09-16: on 2026-09-09 the simulated timeline moved from April 2026 to
April 2024 because AI Accountant refuses future-dated vouchers
(lib/tutor/timeline.ts, BOOKS_BEGIN_YEAR = 2024). Learner profiles, the
walkthrough and the adaptive batches moved, but the four shared Blossom
Retail pack files were never shifted: they still say "01-Apr-2026", "April
2026", "NEFT/N26040201/..." while learners create books beginning
1-Apr-2024. This script moves every date and year reference back exactly two
years and nothing else.

What is rewritten (text cells only; a real date/datetime cell with year 2026
is also shifted):
    "02-Apr-2026"              -> "02-Apr-2024"   (DD-Mon-YYYY)
    "1-April-2026"             -> "1-April-2024"  (D-Month-YYYY)
    "April 2026" / "Apr 2026"  -> "April 2024"    (Month YYYY)
    "dt 25-Mar-26"             -> "dt 25-Mar-24"  (DD-Mon-YY)
    "NEFT/N26040201/..."       -> "NEFT/N24040201/..."  bank references:
    "UPI/26040301/..."         -> "UPI/24040301/..."    a "/"-delimited
        segment of (N|CD|CW)? + yymmdd + 2-digit line number, rewritten only
        when yy = 26 and mmdd is a real calendar date in both years.
    "2026-27" / "2025-26"      -> "2024-25" / "2023-24"  (FY labels)
    CIN "U52520KA2026PTC012345" -> "...KA2024PTC..."  the CIN's year field is
        the year of incorporation; a company incorporated in 2026 cannot keep
        books from 2024. Remove CIN_PATTERN from RULES to keep it.

What is never touched: amounts and every non-text cell, bill/invoice numbers
that only contain digits (INV-010, DT-99, CA26-101: "CA26" is the vendor's
bill series, the same call the 2026-09-09 SQL patch made for KM/2026/045),
GSTIN, PAN, TAN, account numbers, "Companies Act 2013", styles, number
formats, merged ranges and column widths.

Only a token that names 2026 (or yy 26) is rewritten, so running the script on
its own output changes nothing.

Usage:
    python scripts/shift-pack-year.py <input-folder> <output-folder>

Writes one shifted copy per *.xlsx, prints every changed cell (old -> new),
then re-reads both sides and verifies: only the reported cells changed, every
style is identical, no 2026 / yy-26 date token remains, and every bank
statement running balance still equals previous - debit + credit. Exits 1 on
any verification failure. Build the Educational Mode copy from the output with
scripts/build-educational-pack.py; upload with scripts/apply-pack-year-shift.mjs.
"""

from __future__ import annotations

import calendar
import importlib.util
import re
import sys
from datetime import date, datetime
from pathlib import Path

import openpyxl

FROM_YEAR = 2026
TO_YEAR = 2024
DELTA = TO_YEAR - FROM_YEAR

MON3 = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
MONTH_FULL = "January|February|March|April|May|June|July|August|September|October|November|December"
MONTHS = MON3.split("|")

DD_MON_YYYY = re.compile(rf"\b(\d{{1,2}}-(?:{MON3})-){FROM_YEAR}\b", re.I)
D_MONTH_YYYY = re.compile(rf"\b(\d{{1,2}}-(?:{MONTH_FULL})-){FROM_YEAR}\b", re.I)
MONTH_YYYY = re.compile(rf"\b((?:{MONTH_FULL}|{MON3})\.?\s+){FROM_YEAR}\b", re.I)
DD_MON_YY = re.compile(rf"\b(\d{{1,2}}-(?:{MON3})-){FROM_YEAR % 100:02d}\b(?!-)", re.I)
BANK_REF = re.compile(rf"(?<=/)(N|CD|CW)?{FROM_YEAR % 100:02d}(\d{{2}})(\d{{2}})(\d{{2}})(?=/)")
FY_LABEL = re.compile(r"\b(20\d{2})-(\d{2})\b")
CIN_PATTERN = re.compile(rf"\b([LU]\d{{5}}[A-Z]{{2}}){FROM_YEAR}([A-Z]{{3}}\d{{6}})\b")

# Whole-workbook verification: none of these may survive in the output.
LEFTOVER_CHECKS = [
    ("DD-Mon-2026 / D-Month-2026", re.compile(rf"\b\d{{1,2}}-[A-Za-z]{{3,9}}-{FROM_YEAR}\b")),
    ("Month 2026", re.compile(rf"\b(?:{MONTH_FULL}|{MON3})\.?\s+{FROM_YEAR}\b", re.I)),
    ("DD-Mon-26", re.compile(rf"\b\d{{1,2}}-[A-Za-z]{{3,9}}-{FROM_YEAR % 100:02d}\b(?!-)")),
    ("bank ref yy=26", re.compile(rf"/(?:N|CD|CW)?{FROM_YEAR % 100:02d}\d{{6}}/")),
    ("any 2026", re.compile(rf"{FROM_YEAR}")),
]
# Digit runs that look like a year but are not dates, reported for review.
NOT_A_DATE = re.compile(rf"\b[A-Z]{{1,4}}{FROM_YEAR % 100:02d}[-/]\d+\b")
WEEKDAY = re.compile(
    r"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b\.?",
    re.I,
)


def _valid(year: int, month: int, day: int) -> bool:
    return 1 <= month <= 12 and 1 <= day <= calendar.monthrange(year, month)[1]


def _shift_bank_ref(match: re.Match) -> str:
    prefix, mm, dd, line = match.group(1) or "", match.group(2), match.group(3), match.group(4)
    if not (_valid(FROM_YEAR, int(mm), int(dd)) and _valid(TO_YEAR, int(mm), int(dd))):
        return match.group(0)
    return f"{prefix}{TO_YEAR % 100:02d}{mm}{dd}{line}"


def _shift_fy(match: re.Match) -> str:
    start, end = int(match.group(1)), int(match.group(2))
    if (start + 1) % 100 != end or FROM_YEAR not in (start, start + 1):
        return match.group(0)
    return f"{start + DELTA}-{(start + DELTA + 1) % 100:02d}"


RULES = [
    ("DD-Mon-YYYY", DD_MON_YYYY, lambda m: f"{m.group(1)}{TO_YEAR}"),
    ("D-Month-YYYY", D_MONTH_YYYY, lambda m: f"{m.group(1)}{TO_YEAR}"),
    ("Month YYYY", MONTH_YYYY, lambda m: f"{m.group(1)}{TO_YEAR}"),
    ("DD-Mon-YY", DD_MON_YY, lambda m: f"{m.group(1)}{TO_YEAR % 100:02d}"),
    ("bank ref yymmdd", BANK_REF, _shift_bank_ref),
    ("FY label", FY_LABEL, _shift_fy),
    ("CIN year", CIN_PATTERN, lambda m: f"{m.group(1)}{TO_YEAR}{m.group(2)}"),
]


def shift_text(text: str) -> tuple[str, list[str]]:
    """Returns (new_text, names of the rules that changed something)."""
    fired = []
    for name, pattern, repl in RULES:
        new = pattern.sub(repl, text)
        if new != text:
            fired.append(name)
            text = new
    return text, fired


def shift_value(value):
    if isinstance(value, (datetime, date)) and value.year == FROM_YEAR:
        try:
            return value.replace(year=TO_YEAR), ["date cell"]
        except ValueError:  # 29-Feb in a non-leap target year
            return value, []
    if isinstance(value, str):
        return shift_text(value)
    return value, []


def _load_educational_module():
    # Reuse the style signature the educational build verifies with, so both
    # scripts judge "style unchanged" the same way.
    path = Path(__file__).with_name("build-educational-pack.py")
    spec = importlib.util.spec_from_file_location("build_educational_pack", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rewrite_workbook(src: Path, dst: Path):
    wb = openpyxl.load_workbook(src)
    changes = []  # (sheet, coord, old, new, rules)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                new, fired = shift_value(cell.value)
                if new != cell.value:
                    changes.append((ws.title, cell.coordinate, cell.value, new, fired))
                    cell.value = new
    dst.parent.mkdir(parents=True, exist_ok=True)
    wb.save(dst)
    return changes


def bank_balance_problems(ws) -> list[str]:
    """Checks previous balance - debit + credit = balance under a Date/Debit/Credit/Balance header."""
    header = None
    for row in ws.iter_rows():
        texts = [str(c.value).lower() if c.value is not None else "" for c in row]
        if texts and texts[0].strip() == "date" and any("running balance" in t for t in texts):
            header = (row[0].row, texts)
            break
    if header is None:
        return []
    header_row, texts = header
    col = lambda word: next(i for i, t in enumerate(texts) if t.startswith(word)) + 1  # noqa: E731
    debit_col, credit_col, balance_col = col("debit"), col("credit"), col("running balance")
    problems, previous = [], None
    for r in range(header_row + 1, ws.max_row + 1):
        balance = ws.cell(r, balance_col).value
        if balance is None:
            continue
        debit = ws.cell(r, debit_col).value or 0
        credit = ws.cell(r, credit_col).value or 0
        if previous is not None and round(previous - debit + credit, 2) != round(balance, 2):
            problems.append(f"{ws.title}!row {r}: {previous} - {debit} + {credit} != {balance}")
        previous = balance
    return problems


def verify(src: Path, dst: Path, changes, style_signature) -> list[str]:
    problems: list[str] = []
    expected = {(sheet, coord): new for sheet, coord, _old, new, _r in changes}
    original = openpyxl.load_workbook(src)
    rebuilt = openpyxl.load_workbook(dst)
    if original.sheetnames != rebuilt.sheetnames:
        return [f"sheet names differ: {original.sheetnames} vs {rebuilt.sheetnames}"]
    for ws_old in original.worksheets:
        ws_new = rebuilt[ws_old.title]
        if ws_old.dimensions != ws_new.dimensions:
            problems.append(f"{ws_old.title}: size {ws_old.dimensions} vs {ws_new.dimensions}")
        if set(map(str, ws_old.merged_cells.ranges)) != set(map(str, ws_new.merged_cells.ranges)):
            problems.append(f"{ws_old.title}: merged ranges differ")
        for key, dim in ws_old.column_dimensions.items():
            if ws_new.column_dimensions[key].width != dim.width:
                problems.append(f"{ws_old.title}: column {key} width differs")
        for row_old in ws_old.iter_rows():
            for cell_old in row_old:
                cell_new = ws_new[cell_old.coordinate]
                want = expected.get((ws_old.title, cell_old.coordinate), cell_old.value)
                if cell_new.value != want:
                    problems.append(f"{ws_old.title}!{cell_old.coordinate}: {cell_new.value!r} != {want!r}")
                if style_signature(cell_old) != style_signature(cell_new):
                    problems.append(f"{ws_old.title}!{cell_old.coordinate}: style differs")
                if isinstance(cell_new.value, str):
                    for label, pattern in LEFTOVER_CHECKS:
                        if pattern.search(cell_new.value):
                            problems.append(f"{ws_new.title}!{cell_new.coordinate}: {label} left: {cell_new.value!r}")
                elif isinstance(cell_new.value, (datetime, date)) and cell_new.value.year == FROM_YEAR:
                    problems.append(f"{ws_new.title}!{cell_new.coordinate}: date cell still {FROM_YEAR}")
        problems.extend(bank_balance_problems(ws_new))
    return problems


def review_notes(path: Path):
    """Strings worth a human look: year-like bill numbers and weekday names."""
    wb = openpyxl.load_workbook(path)
    notes = []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if not isinstance(cell.value, str):
                    continue
                for m in NOT_A_DATE.finditer(cell.value):
                    notes.append(f"left as is (bill number, not a date) {ws.title}!{cell.coordinate}: {m.group(0)!r}")
                for m in WEEKDAY.finditer(cell.value):
                    notes.append(f"WEEKDAY name {ws.title}!{cell.coordinate}: {cell.value!r}")
    return notes


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    in_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    sources = sorted(in_dir.glob("*.xlsx"))
    if not sources:
        print(f"No .xlsx files in {in_dir}")
        return 2
    style_signature = _load_educational_module().style_signature

    failed = False
    total = 0
    for src in sources:
        dst = out_dir / src.name
        changes = rewrite_workbook(src, dst)
        total += len(changes)
        print(f"\n== {src.name}: {len(changes)} cell(s) shifted {FROM_YEAR} -> {TO_YEAR}")
        for sheet, coord, old, new, fired in changes:
            print(f"   {sheet}!{coord} [{', '.join(fired)}]: {old!r} -> {new!r}")
        for note in review_notes(dst):
            print(f"   note {note}")
        problems = verify(src, dst, changes, style_signature)
        if problems:
            failed = True
            print(f"   VERIFY FAILED ({len(problems)}):")
            for problem in problems[:50]:
                print(f"     {problem}")
        else:
            print(
                f"   verified: only the cells above changed, styles identical, no {FROM_YEAR} date token left,"
                " running balances consistent"
            )
    print(f"\nTOTAL: {total} cell(s) shifted across {len(sources)} file(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
