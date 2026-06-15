# Pure unit tests for services.report_builder (Step 9 — Synchronize XLSX Export Report).
# No HTTP, no server, no conftest fixtures - operates only on plain dicts/lists, exactly like
# test_per_capita.py / test_per_family.py.
from services.report_builder import (
    build_member_weight_map,
    build_per_capita_rows,
    build_per_family_rows,
    build_transaction_rows,
)


def _fam(mid, size, name=None):
    return {"id": mid, "name": name or mid, "kind": "family",
            "family_members": [f"{mid}-{i}" for i in range(size)]}


def _ind(mid, name=None):
    return {"id": mid, "name": name or mid, "kind": "individual", "family_members": []}


def _exp(eid, amount, split_ids, mode="PER_CAPITA", kind="expense", snaps=None,
         paid_by="f1", date="11-05-26", category="Food", description="x"):
    e = {"id": eid, "amount": amount, "split_member_ids": split_ids, "split_mode": mode,
         "kind": kind, "paid_by_member_id": paid_by, "date": date, "category": category,
         "description": description}
    if snaps is not None:
        e["weight_snapshots"] = snaps
    return e


# Section 5 reference roster: families sized 4, 4, 2, 1 + 2 individuals (H = 13, E = 6).
def _roster():
    return [_fam("f1", 4), _fam("f2", 4), _fam("f3", 2), _fam("f4", 1),
            _ind("i1"), _ind("i2")]


def _by_member(rows):
    return {r["member_name"]: r for r in rows}


class TestWeightMap:

    def test_individual_is_one_family_is_size(self):
        wm = build_member_weight_map(_roster())
        assert wm == {"f1": 4, "f2": 4, "f3": 2, "f4": 1, "i1": 1, "i2": 1}

    def test_empty_family_floors_at_one(self):
        wm = build_member_weight_map([{"id": "f", "name": "F", "kind": "family",
                                       "family_members": []}])
        assert wm["f"] == 1


class TestPerCapita:

    def test_section_5a_reference_example(self):
        # 4 families (4,4,2,1) + 2 individuals = 13 humans; $130 -> per-human 10.
        rows = build_per_capita_rows([_exp("e1", 130.0, [])], _roster())
        assert len(rows) == 6
        assert all(r["total_humans"] == 13 for r in rows)
        assert all(r["per_human"] == 10.0 for r in rows)
        shares = {r["member_name"]: r["member_share"] for r in rows}
        assert shares == {"f1": 40.0, "f2": 40.0, "f3": 20.0, "f4": 10.0,
                          "i1": 10.0, "i2": 10.0}
        weights = {r["member_name"]: r["member_weight"] for r in rows}
        assert weights == {"f1": 4, "f2": 4, "f3": 2, "f4": 1, "i1": 1, "i2": 1}

    def test_weight_snapshot_override_wins(self):
        # f1 attends as 1 person via snapshot; H = 1 (f1) + 1 (i1) = 2; per-human 60.
        rows = build_per_capita_rows(
            [_exp("e1", 120.0, ["f1", "i1"], snaps={"f1": 1})], _roster())
        by = _by_member(rows)
        assert by["f1"]["member_weight"] == 1
        assert by["f1"]["total_humans"] == 2
        assert by["f1"]["per_human"] == 60.0
        assert by["f1"]["member_share"] == 60.0
        assert by["i1"]["member_share"] == 60.0

    def test_per_family_expense_never_in_per_capita_rows(self):
        rows = build_per_capita_rows(
            [_exp("e1", 120.0, ["f1", "i1"], mode="PER_FAMILY")], _roster())
        assert rows == []

    def test_missing_split_mode_treated_as_per_capita(self):
        e = {"id": "e1", "amount": 20.0, "split_member_ids": ["i1", "i2"],
             "kind": "expense", "paid_by_member_id": "i1", "date": "1", "category": "c",
             "description": ""}  # no split_mode key
        rows = build_per_capita_rows([e], _roster())
        assert len(rows) == 2 and all(r["member_share"] == 10.0 for r in rows)

    def test_income_excluded(self):
        rows = build_per_capita_rows(
            [_exp("e1", 100.0, [], kind="income")], _roster())
        assert rows == []

    def test_split_among_all_includes_everyone(self):
        rows = build_per_capita_rows([_exp("e1", 130.0, [])], _roster())
        assert {r["member_name"] for r in rows} == {"f1", "f2", "f3", "f4", "i1", "i2"}

    def test_h_le_zero_skips_expense(self):
        # All-zero snapshot weights -> H = 0 -> split returns {} -> no rows.
        rows = build_per_capita_rows(
            [_exp("e1", 100.0, ["f1"], snaps={"f1": 0})], _roster())
        assert rows == []

    def test_stale_member_id_emits_default_weight_and_unknown_name(self):
        # "ghost" not in roster -> weight defaults to 1, name '?'. H = 4 (f1) + 1 (ghost) = 5.
        rows = build_per_capita_rows([_exp("e1", 100.0, ["f1", "ghost"])], _roster())
        by = _by_member(rows)
        assert "?" in by
        assert by["?"]["member_weight"] == 1
        assert by["f1"]["total_humans"] == 5

    def test_shares_sum_to_amount_within_tolerance(self):
        # $100 across H = 13 produces repeating decimals; rounded shares still reconcile.
        # Each 2dp share can drift up to 0.005, so n rows bound the total drift at 0.005 * n.
        rows = build_per_capita_rows([_exp("e1", 100.0, [])], _roster())
        assert abs(sum(r["member_share"] for r in rows) - 100.0) <= 0.005 * len(rows) + 1e-9


class TestPerFamily:

    def test_section_5b_reference_example(self):
        # 4 families + 2 individuals = 6 entities; $120 -> flat 20 each, regardless of size.
        rows = build_per_family_rows(
            [_exp("e1", 120.0, [], mode="PER_FAMILY")], _roster())
        assert len(rows) == 6
        assert all(r["total_entities"] == 6 for r in rows)
        assert all(r["per_entity"] == 20.0 for r in rows)
        assert all(r["member_share"] == 20.0 for r in rows)

    def test_ignores_weight_snapshots_and_size(self):
        # Snapshot present but per-family ignores it: 2 entities -> 60 each.
        rows = build_per_family_rows(
            [_exp("e1", 120.0, ["f1", "i1"], mode="PER_FAMILY", snaps={"f1": 1})],
            _roster())
        assert {r["member_name"]: r["member_share"] for r in rows} == {"f1": 60.0, "i1": 60.0}
        assert all(r["total_entities"] == 2 for r in rows)

    def test_per_capita_expense_never_in_per_family_rows(self):
        rows = build_per_family_rows(
            [_exp("e1", 120.0, ["f1", "i1"], mode="PER_CAPITA")], _roster())
        assert rows == []

    def test_income_excluded(self):
        rows = build_per_family_rows(
            [_exp("e1", 120.0, [], mode="PER_FAMILY", kind="income")], _roster())
        assert rows == []

    def test_duplicate_ids_are_deduped(self):
        # split [f1, f1, i1] -> 2 distinct entities -> 60 each, 2 rows.
        rows = build_per_family_rows(
            [_exp("e1", 120.0, ["f1", "f1", "i1"], mode="PER_FAMILY")], _roster())
        assert len(rows) == 2
        assert all(r["total_entities"] == 2 and r["member_share"] == 60.0 for r in rows)

    def test_split_among_all_includes_every_entity(self):
        rows = build_per_family_rows(
            [_exp("e1", 120.0, [], mode="PER_FAMILY")], _roster())
        assert {r["member_name"] for r in rows} == {"f1", "f2", "f3", "f4", "i1", "i2"}

    def test_shares_sum_to_amount_within_tolerance(self):
        # $100 across 6 entities -> 16.67 each; rounded shares still reconcile.
        # Each 2dp share can drift up to 0.005, so n rows bound the total drift at 0.005 * n.
        rows = build_per_family_rows(
            [_exp("e1", 100.0, [], mode="PER_FAMILY")], _roster())
        assert abs(sum(r["member_share"] for r in rows) - 100.0) <= 0.005 * len(rows) + 1e-9


class TestTransactions:

    def test_every_row_has_split_mode_and_both_kinds_present(self):
        exps = [
            _exp("e1", 130.0, [], mode="PER_CAPITA"),
            _exp("e2", 120.0, ["f1", "i1"], mode="PER_FAMILY"),
            _exp("e3", 50.0, [], mode="PER_CAPITA", kind="income"),
        ]
        rows = build_transaction_rows(exps, _roster())
        assert len(rows) == 3
        assert [r["split_mode"] for r in rows] == ["PER_CAPITA", "PER_FAMILY", "PER_CAPITA"]
        assert {r["kind"] for r in rows} == {"expense", "income"}

    def test_split_among_names_and_unknown_payer(self):
        rows = build_transaction_rows(
            [_exp("e1", 10.0, ["f1", "i1"], paid_by="ghost")], _roster())
        assert rows[0]["split_among"] == "f1, i1"
        assert rows[0]["paid_by"] == "?"

    def test_split_among_empty_when_split_among_all(self):
        rows = build_transaction_rows([_exp("e1", 10.0, [])], _roster())
        assert rows[0]["split_among"] == ""

    def test_missing_split_mode_defaults_to_per_capita(self):
        e = {"id": "e1", "amount": 10.0, "split_member_ids": [], "kind": "expense",
             "paid_by_member_id": "f1", "date": "1", "category": "c", "description": ""}
        rows = build_transaction_rows([e], _roster())
        assert rows[0]["split_mode"] == "PER_CAPITA"


class TestEmptyInputs:

    def test_no_expenses_yields_no_rows(self):
        members = _roster()
        assert build_per_capita_rows([], members) == []
        assert build_per_family_rows([], members) == []
        assert build_transaction_rows([], members) == []
