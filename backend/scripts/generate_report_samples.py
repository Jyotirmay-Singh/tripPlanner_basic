"""Generate anonymised review examples with the production report generators.

Run from backend: python scripts/generate_report_samples.py --output <directory>
No database, network calls, or private workbook/template is used.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.report_model import ReportSnapshot, build_report_data
from services.report_pdf import build_report_pdf
from services.report_xlsx import build_report_xlsx


def sample_snapshot() -> ReportSnapshot:
    trip = {
        "id": "sample-group", "name": "Coastal Journey - Sample", "currency": "INR",
        "code": "DEMO26", "start_date": "2026-10-01", "end_date": "2026-10-07",
        "budget": 350000, "members": [
            {"id": "f1", "name": "Patel family", "kind": "family",
             "family_members": ["Maya", "Kiran", "Kiran"], "family_member_ids": ["p1", "p2", "p3"]},
            {"id": "f2", "name": "Roy family", "kind": "family",
             "family_members": ["Dev", "Rhea"], "family_member_ids": ["p4", "p5"]},
            {"id": "s1", "name": "Alex", "kind": "individual"},
            {"id": "s2", "name": "Alex", "kind": "individual"},
            {"id": "s3", "name": "Jordan", "kind": "individual"},
        ],
    }
    all_ids = [m["id"] for m in trip["members"]]

    def expense(identity, amount, category, payer, *, mode="PER_CAPITA", selected=None, **extra):
        return {"id": identity, "amount": amount, "category": category,
                "description": category + " booking", "paid_by_member_id": payer,
                "split_mode": mode, "split_member_ids": selected or all_ids,
                "date": "2026-10-03", "time": "13:45", "created_at": "2026-10-03T08:15:00Z",
                **extra}

    expenses = (
        expense("e01", 180000, "Accommodation", "f1", date="2026-09-28"),
        expense("e02", 65000, "Transport", "s1", mode="PER_FAMILY"),
        expense("e03", 12001, "Food", "f2", family_participants={"f1": ["p1", "p2"]}),
        expense("e04", 3200, "Activities", "s2", mode="EXACT", selected=["f1", "f2", "s2"],
                custom_amounts={"p1": 1200, "p2": 0, "p4": 1000, "s2": 1000}),
        expense("e05", -20000, "Accommodation", "f1", description="Room cancellation money back"),
        expense("e06", -1500, "Deposit returns", "s1", mode="PER_FAMILY"),
        expense("e07", 8200, "Shopping", "s3", mode="EXACT", selected=["f1", "s3"],
                custom_amounts={"p3": 4100, "s3": 4100}, original_amount=100,
                original_currency="USD", exchange_rate="82.000000000000",
                exchange_rate_date="2026-10-02", exchange_rate_provider="Stored reference rate",
                exchange_rate_mode="manual", original_custom_amounts={"p3": 50, "s3": 50}),
        expense("e08", 1350, "Tolls", "s2", mode="PER_FAMILY", selected=["f1", "s2"]),
        expense("e09", 900, "Tips", "f2", selected=["f2", "s1"]),
        expense("e10", 1, "Other", "f1", selected=["f1", "s1"]),
        expense("e11", 800, "Food", "f1", mode="EXACT", selected=["f1"],
                custom_amounts={"p1": 500, "departed-person": 300},
                family_member_entity_snapshots={"departed-person": "f1"},
                description="Historical exact allocation with a departed person"),
        expense("e12", 1200, "Transport", "departed-account", selected=["departed-account", "s1"],
                description="Historical expense from a settled former account"),
    )
    settlements = (
        {"id": "legacy-1", "from_member_id": "f2", "to_member_id": "f1", "amount": 5000,
         "status": "paid", "paid_at": "2026-10-04T04:30:00Z", "remark": "Cash recorded during trip"},
        {"id": "legacy-pending", "from_member_id": "s1", "to_member_id": "f1", "amount": 999,
         "status": "pending"},
    )
    payments = (
        {"id": "payment-1", "from_member_id": "s1", "to_member_id": "departed-account", "amount": 600,
         "created_at": "2026-10-04T05:30:00Z", "note": "Former account settled"},
        {"id": "payment-2", "from_member_id": "s2", "to_member_id": "f1", "amount": 3000,
         "created_at": "2026-10-05T06:30:00Z", "note": "Partial repayment"},
        {"id": "payment-3", "from_member_id": "f1", "to_member_id": "s1", "amount": 2000,
         "created_at": "2026-10-06T07:30:00Z", "source": "upi_recipient_confirmed"},
        # Two distinct records remain distinct even when their other fields match.
        {"id": "payment-4", "from_member_id": "s3", "to_member_id": "f1", "amount": 700,
         "created_at": "2026-10-08T07:30:00Z"},
        {"id": "payment-5", "from_member_id": "s3", "to_member_id": "f1", "amount": 700,
         "created_at": "2026-10-08T07:30:00Z"},
    )
    migration = {"vector": {"f1": 7, "s1": -7}, "policy_version": "sample-whole-unit-v1",
                 "created_at": "2026-09-30T08:00:00Z"}
    return ReportSnapshot(trip, expenses, settlements, payments, migration)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    target = Path(args.output)
    target.mkdir(parents=True, exist_ok=True)
    data = build_report_data(sample_snapshot())
    (target / "Coastal_Journey_Sample_report.xlsx").write_bytes(build_report_xlsx(data))
    (target / "Coastal_Journey_Sample_report.pdf").write_bytes(build_report_pdf(data))
    print(f"Created Excel and PDF samples. Net spending: {data.net}; outstanding: {data.outstanding}.")


if __name__ == "__main__":
    main()
