"""Generated-PDF regression tests for the Summary spend reconciliations."""

import io

from bson.decimal128 import Decimal128
from pypdf import PdfReader

from services.report_builder import build_spend_reconciliation
from services.report_pdf import build_report_pdf


def _member(mid, name, kind="individual"):
    return {
        "id": mid,
        "name": name,
        "kind": kind,
        "family_members": [f"{name} member"] if kind == "family" else [],
        "family_member_ids": [f"{mid}:0"] if kind == "family" else [],
    }


def _expense(eid, amount, payer, category="Food", description=None):
    return {
        "id": eid,
        "amount": amount,
        "category": category,
        "description": description or eid,
        "date": "2026-01-01",
        "paid_by_member_id": payer,
        "split_member_ids": [payer],
        "split_mode": "PER_FAMILY",
    }


def _trip(name="PDF reconciliation"):
    return {
        "name": name,
        "start_date": "2026-01-01",
        "end_date": "2026-01-02",
        "currency": "INR",
        "code": "PDF-TEST",
    }


def _render(members, expenses, name="PDF reconciliation"):
    reconciliation = build_spend_reconciliation(members, expenses)
    pdf_bytes = build_report_pdf(
        _trip(name), members, expenses, "INR", reconciliation=reconciliation,
    )
    reader = PdfReader(io.BytesIO(pdf_bytes))
    page_texts = [page.extract_text() or "" for page in reader.pages]
    return reconciliation, pdf_bytes, page_texts


def test_time_example_renders_gross_and_reimbursement_as_distinct_positive_rows():
    members = [_member("time", "Time", kind="family")]
    expenses = [
        _expense("gross", 14_000, "time", "Local Transportation"),
        _expense("refund", -4_000, "time", "Local Transportation"),
    ]
    reconciliation, pdf_bytes, pages = _render(members, expenses, "Time example")
    text = "\n".join(pages)
    summary_text = text.split("Transactions", 1)[0]

    assert pdf_bytes.startswith(b"%PDF")
    assert reconciliation["entities"][0]["net"] == 10_000.0
    assert text.index("Net spend by entity") < text.index("Net spend by category")
    assert summary_text.count("GROSS SPEND") == 2
    assert summary_text.count("REIMBURSEMENTS") == 2
    assert summary_text.count("Gross spend subtotal") == 2
    assert summary_text.count("Total reimbursements") == 2
    assert summary_text.count("14,000.00") >= 2
    assert summary_text.count("4,000.00") >= 2
    assert summary_text.count("10,000.00") >= 3  # metadata + two final net rows
    assert "(4,000.00)" not in summary_text  # positive magnitude inside the labelled section
    assert "Time" in summary_text and "Family" in summary_text
    assert "Local Transportation" in summary_text


def test_empty_reimbursements_and_negative_net_keep_the_full_structure():
    members = [_member("ann", "Ann")]

    _, _, no_refund_pages = _render(members, [_expense("gross", 100, "ann")])
    no_refund_summary = "\n".join(no_refund_pages).split("Transactions", 1)[0]
    assert no_refund_summary.count("REIMBURSEMENTS") == 2
    assert no_refund_summary.count("Total reimbursements") == 2
    assert no_refund_summary.count("Net spend") >= 5

    reconciliation, _, credit_pages = _render(
        members,
        [_expense("gross", 100, "ann"), _expense("refund", -150, "ann")],
        "Net credit",
    )
    credit_summary = "\n".join(credit_pages).split("Transactions", 1)[0]
    assert reconciliation["totals"]["net"] == -50.0
    assert credit_summary.count("(50.00)") >= 3  # metadata plus both final net rows
    assert "150.00" in credit_summary
    assert "(150.00)" not in credit_summary


def test_transactions_render_original_amount_and_locked_fx_audit_metadata():
    members = [_member("ann", "Ann")]
    expense = _expense("fx-dinner", 3520.40, "ann", description="Weekend dinner")
    expense.update({
        "currency": "INR",
        "original_amount": Decimal128("1000.00"),
        "original_currency": "NPR",
        "exchange_rate": Decimal128("3.5204"),
        "exchange_rate_requested_date": "2026-08-30",
        "exchange_rate_date": "2026-08-28",
        "exchange_rate_provider": "frankfurter_v2_blended",
        "exchange_rate_mode": "automatic",
    })

    _, pdf_bytes, pages = _render(members, [expense], "FX audit")
    transaction_text = "\n".join(pages).split("Transactions", 1)[-1]

    assert pdf_bytes.startswith(b"%PDF")
    assert "NPR 1,000.00" in transaction_text
    assert "1 NPR = 3.5204 INR" in transaction_text
    assert "2026-08-28" in transaction_text
    assert "frankfurter_v2_blended" in transaction_text
    assert "automatic" in transaction_text


def test_long_reconciliation_repeats_headers_and_keeps_totals_with_net_across_pages():
    members = [
        _member(
            f"m{i:02d}",
            f"Entity {i:02d} with a deliberately long professional display name",
            kind="family" if i % 3 == 0 else "individual",
        )
        for i in range(48)
    ]
    expenses = []
    for i, member in enumerate(members):
        category = f"Category {i:02d} with a deliberately long report label"
        expenses.append(_expense(f"gross-{i}", 1_000 + i, member["id"], category))
        expenses.append(_expense(f"refund-{i}", -(100 + i), member["id"], category))

    reconciliation, _, pages = _render(members, expenses, "Long pagination test")
    joined = "\n".join(pages)
    summary_pages = []
    for page in pages:
        if "Transactions" in page:
            before_transactions = page.split("Transactions", 1)[0]
            if before_transactions.strip():
                summary_pages.append(before_transactions)
            break
        summary_pages.append(page)

    assert len(pages) > 4
    assert len(summary_pages) > 2
    assert sum("Entity" in page and "Type" in page and "Amount (INR)" in page
               for page in summary_pages) >= 3
    assert sum("Category" in page and "Amount (INR)" in page
               for page in summary_pages) >= 3
    assert joined.count("Total reimbursements") >= 2
    assert joined.count("Gross spend subtotal") >= 2
    assert joined.count("Page ") == len(pages)
    assert all(f"Page {number} of {len(pages)}" in page
               for number, page in enumerate(pages, start=1))

    # ReportLab's NOSPLIT tail keeps each reimbursement subtotal and final net on one page.
    pages_with_reimbursement_total = [page for page in summary_pages if "Total reimbursements" in page]
    assert len(pages_with_reimbursement_total) == 2
    assert all("Net spend" in page for page in pages_with_reimbursement_total)
    assert reconciliation["totals"]["net"] == round(
        reconciliation["totals"]["gross"] - reconciliation["totals"]["reimbursements"], 2
    )
    assert "deliberately long professional" in joined
    assert "deliberately long report" in joined


def test_whole_unit_projection_is_auditable_in_pdf():
    members = [_member("a", "Ann"), _member("b", "Bob")]
    expenses = [_expense("dinner", 10, "a")]
    reconciliation = build_spend_reconciliation(members, expenses)
    projection = {
        "enabled": True,
        "increment": "1",
        "status": "open",
        "policy_version": "whole_unit_v1",
        "precise_net": {"a": "3.333000000000", "b": "-3.333000000000"},
        "rounded_net": {"a": 3, "b": -3},
        "rounding_adjustments": {"a": "-0.333000000000", "b": "0.333000000000"},
        "routing": {"optimal": True},
    }
    payload = build_report_pdf(
        _trip("Rounded audit"), members, expenses, "LKR", reconciliation=reconciliation,
        settlement_projection=projection,
        settlement_transfers=[{"from_member_id": "b", "to_member_id": "a", "amount": 3}],
    )
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(payload)).pages)
    assert "Whole-rupee settlement projection" in text
    assert "Exact balance" in text and "Rounding adjustment" in text
    assert "Minimum payment plan" in text
    assert "3.00" not in text
