# Pure unit tests for services.report_builder (Step 9 — Synchronize XLSX Export Report).
# No HTTP, no server, no conftest fixtures - operates only on plain dicts/lists, exactly like
# test_per_capita.py / test_per_family.py.
from services.member_breakdown import family_member_ids
from services.report_builder import (
    build_expense_member_rows,
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


def _exp(eid, amount, split_ids, mode="PER_CAPITA", snaps=None,
         paid_by="f1", date="11-05-26", category="Food", description="x"):
    e = {"id": eid, "amount": amount, "split_member_ids": split_ids, "split_mode": mode,
         "paid_by_member_id": paid_by, "date": date, "category": category,
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

    def test_family_participants_counts_as_involved(self):
        # CLAUDE.md §5-A: f1 restricted to 3 of its 4 members counts as 3 humans, identical to the
        # ledger — so the exported report never drifts from the app's Balances. H = 3+4+2+1+1+1 = 12.
        members = _roster()
        e = _exp("e1", 120.0, [])
        e["family_participants"] = {"f1": family_member_ids(members[0])[:3]}
        rows = build_per_capita_rows([e], members)
        assert all(r["total_humans"] == 12 for r in rows)
        assert all(r["per_human"] == 10.0 for r in rows)   # 120 / 12
        by = _by_member(rows)
        assert by["f1"]["member_weight"] == 3              # involved count, not full size (4)
        assert by["f1"]["member_share"] == 30.0            # 3 * 10

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

    def test_negative_amount_included_with_mirrored_shares(self):
        # Money-back rows are real expenses now; they appear with negative shares summing to -100.
        rows = build_per_capita_rows([_exp("e1", -100.0, [])], _roster())
        assert rows  # not excluded
        assert all(r["member_share"] <= 0 for r in rows)
        assert abs(sum(r["member_share"] for r in rows) + 100.0) <= 0.005 * len(rows) + 1e-9

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

    def test_negative_amount_included_with_mirrored_shares(self):
        rows = build_per_family_rows(
            [_exp("e1", -120.0, [], mode="PER_FAMILY")], _roster())
        assert len(rows) == 6
        assert all(r["member_share"] == -20.0 for r in rows)

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

    def test_every_row_has_split_mode_and_signed_amount(self):
        exps = [
            _exp("e1", 130.0, [], mode="PER_CAPITA"),
            _exp("e2", 120.0, ["f1", "i1"], mode="PER_FAMILY"),
            _exp("e3", -50.0, [], mode="PER_CAPITA"),  # money back, negative
        ]
        rows = build_transaction_rows(exps, _roster())
        assert len(rows) == 3
        assert [r["split_mode"] for r in rows] == ["PER_CAPITA", "PER_FAMILY", "PER_CAPITA"]
        assert "kind" not in rows[0]  # the income/kind concept is gone
        assert [r["amount"] for r in rows] == [130.0, 120.0, -50.0]

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


class TestDuplicateNameDisambiguation:
    # Members can now share a stored name; the report must show the SAME disambiguated labels as the
    # app (utils.display_names). Two individuals both "Ravi" -> "Ravi_1" / "Ravi_2".
    def _dup_roster(self):
        return [_ind("a", "Ravi"), _ind("b", "Ravi"), _ind("c", "Priya")]

    def test_transaction_rows_show_disambiguated_paid_by_and_split_among(self):
        rows = build_transaction_rows(
            [_exp("e1", 30.0, ["a", "b", "c"], paid_by="a")], self._dup_roster())
        assert rows[0]["paid_by"] == "Ravi_1"
        assert rows[0]["split_among"] == "Ravi_1, Ravi_2, Priya"

    def test_per_capita_rows_use_disambiguated_member_name(self):
        rows = build_per_capita_rows([_exp("e1", 30.0, ["a", "b", "c"])], self._dup_roster())
        assert {r["member_name"] for r in rows} == {"Ravi_1", "Ravi_2", "Priya"}


class TestOptionalTime:
    """The optional expense time appends '· <12h>' to the date cell only when present; a time-less
    row's date cell is byte-for-byte the bare date (unchanged from before this feature)."""

    def test_timeless_row_date_cell_is_bare_date(self):
        # No 'time' key at all (legacy rows) -> date cell unchanged.
        pc = build_per_capita_rows([_exp("e1", 130.0, [], date="11-05-26")], _roster())
        assert all(r["date"] == "11-05-26" for r in pc)
        tx = build_transaction_rows([_exp("e1", 130.0, [], date="11-05-26")], _roster())
        assert tx[0]["date"] == "11-05-26"

    def test_explicit_none_time_is_treated_as_no_time(self):
        e = _exp("e1", 120.0, [], mode="PER_FAMILY", date="11-05-26")
        e["time"] = None
        rows = build_per_family_rows([e], _roster())
        assert all(r["date"] == "11-05-26" for r in rows)

    def test_time_present_appends_12h_to_date_cell(self):
        e = _exp("e1", 130.0, [], date="11-05-26")
        e["time"] = "14:30"
        pc = build_per_capita_rows([e], _roster())
        assert all(r["date"] == "11-05-26 · 2:30 PM" for r in pc)
        tx = build_transaction_rows([e], _roster())
        assert tx[0]["date"] == "11-05-26 · 2:30 PM"
        ef = _exp("e2", 120.0, [], mode="PER_FAMILY", date="11-05-26")
        ef["time"] = "09:05"
        pf = build_per_family_rows([ef], _roster())
        assert all(r["date"] == "11-05-26 · 9:05 AM" for r in pf)


class TestEmptyInputs:

    def test_no_expenses_yields_no_rows(self):
        members = _roster()
        assert build_per_capita_rows([], members) == []
        assert build_per_family_rows([], members) == []
        assert build_transaction_rows([], members) == []


class TestExplodedTransactions:
    """Phase 18 — build_expense_member_rows reproduces the hand-built image-2 oracle EXACTLY.

    The oracle trip: families Tom & Jerry (2) + Chota Bheem (4) and standalone individual Golmal (7
    people). Six expenses across PER_CAPITA / PER_FAMILY, an excluded-member case, and a negative
    refund. All numbers are read straight off ``desired_transaction_tab.png``.
    """

    def _oracle(self):
        tj = {"id": "tj", "name": "Tom & Jerry", "kind": "family",
              "family_members": ["Tom", "Jerry"], "family_member_ids": ["tom", "jerry"]}
        cb = {"id": "cb", "name": "Chota Bheem", "kind": "family",
              "family_members": ["Bheem", "Raju", "Chutki", "Jaggu"],
              "family_member_ids": ["bheem", "raju", "chutki", "jaggu"]}
        gol = {"id": "gol", "name": "Golmal", "kind": "individual", "family_members": []}
        members = [tj, cb, gol]
        expenses = [
            # 1) Dinner 10,000 PER_CAPITA — Chota Bheem restricted to Bheem+Jaggu -> H=5, per-human 2000
            {"id": "e1", "amount": 10000.0, "split_member_ids": [], "split_mode": "PER_CAPITA",
             "paid_by_member_id": "tj", "date": "12-06-26", "category": "Food",
             "description": "Dinner", "family_participants": {"cb": ["bheem", "jaggu"]}},
            # 2) Train 15,000 PER_FAMILY — E=3, per-entity 5000
            {"id": "e2", "amount": 15000.0, "split_member_ids": [], "split_mode": "PER_FAMILY",
             "paid_by_member_id": "tj", "date": "19-06-26", "category": "Travel",
             "description": "Train"},
            # 3) Refund -600 PER_CAPITA — H=7, per-human -85.714... -> -85.71 naive for all 7
            {"id": "e3", "amount": -600.0, "split_member_ids": [], "split_mode": "PER_CAPITA",
             "paid_by_member_id": "tj", "date": "22-06-26", "category": "Travel",
             "description": "Refund"},
            # 4) Stay 30,000 PER_CAPITA — H=7, per-human 4285.71
            {"id": "e4", "amount": 30000.0, "split_member_ids": [], "split_mode": "PER_CAPITA",
             "paid_by_member_id": "gol", "date": "30-06-26", "category": "Accommodation",
             "description": "Stay"},
            # 5) Lunch 7,800 PER_CAPITA — exclude Tom + Bheem -> H=5, per-human 1560
            {"id": "e5", "amount": 7800.0, "split_member_ids": [], "split_mode": "PER_CAPITA",
             "paid_by_member_id": "gol", "date": "30-06-26", "category": "Food",
             "description": "Lunch",
             "family_participants": {"tj": ["jerry"], "cb": ["raju", "chutki", "jaggu"]}},
            # 6) Water 900 PER_FAMILY — E=3, per-entity 300
            {"id": "e6", "amount": 900.0, "split_member_ids": [], "split_mode": "PER_FAMILY",
             "paid_by_member_id": "cb", "date": "30-06-26", "category": "Food",
             "description": "Water"},
        ]
        return members, expenses

    @staticmethod
    def _rowmap(block):
        return {r["person"]: r for r in block["rows"]}

    def test_pivot_and_grand_totals_match_oracle(self):
        members, expenses = self._oracle()
        out = build_expense_member_rows(expenses, members)
        pivot = {r["name"]: r["total"] for r in out["pivot"]["rows"]}
        assert pivot == {"Bheem": 7525.0, "Chutki": 7085.0, "Golmal": 13060.0,
                         "Jaggu": 9085.0, "Jerry": 10410.0, "Raju": 7085.0, "Tom": 8850.0}
        # pivot is alphabetical by person name
        assert [r["name"] for r in out["pivot"]["rows"]] == \
            ["Bheem", "Chutki", "Golmal", "Jaggu", "Jerry", "Raju", "Tom"]
        # Sum(Amount) == Sum(Total Payable) == pivot Grand Total == 63,100
        assert out["pivot"]["grand_total"] == 63100.0
        assert out["grand_payable"] == 63100.0
        assert out["grand_amount"] == 63100.0

    def test_sr_no_and_block_metadata(self):
        members, expenses = self._oracle()
        blocks = build_expense_member_rows(expenses, members)["blocks"]
        assert [b["sr_no"] for b in blocks] == [1, 2, 3, 4, 5, 6]
        assert [b["description"] for b in blocks] == \
            ["Dinner", "Train", "Refund", "Stay", "Lunch", "Water"]
        assert [b["mode"] for b in blocks] == \
            ["Per-Person", "Per-Family", "Per-Person", "Per-Person", "Per-Person", "Per-Family"]
        assert all(len(b["rows"]) == 7 for b in blocks)  # one row per person, every block
        assert blocks[0]["paid_by"] == "Tom & Jerry"
        assert blocks[3]["paid_by"] == "Golmal"
        assert blocks[5]["paid_by"] == "Chota Bheem"

    def test_per_capita_shares_and_exclusions(self):
        members, expenses = self._oracle()
        out = build_expense_member_rows(expenses, members)
        dinner = self._rowmap(out["blocks"][0])
        for p in ["Tom", "Jerry", "Bheem", "Jaggu", "Golmal"]:
            assert dinner[p]["payable"] == 2000.0
        for p in ["Raju", "Chutki"]:  # excluded -> "-"
            assert dinner[p]["payable"] == 0.0
            assert dinner[p]["participates"] is False
        assert out["blocks"][0]["block_payable"] == 10000.0

    def test_lunch_excludes_tom_and_bheem(self):
        members, expenses = self._oracle()
        out = build_expense_member_rows(expenses, members)
        lunch = self._rowmap(out["blocks"][4])
        for p in ["Tom", "Bheem"]:
            assert lunch[p]["payable"] == 0.0 and lunch[p]["participates"] is False
        for p in ["Jerry", "Raju", "Chutki", "Jaggu", "Golmal"]:
            assert lunch[p]["payable"] == 1560.0 and lunch[p]["participates"] is True
        assert out["blocks"][4]["block_payable"] == 7800.0

    def test_per_family_divides_equally_among_all_members(self):
        members, expenses = self._oracle()
        out = build_expense_member_rows(expenses, members)
        train = self._rowmap(out["blocks"][1])
        assert train["Tom"]["payable"] == 2500.0 and train["Jerry"]["payable"] == 2500.0
        for p in ["Bheem", "Raju", "Chutki", "Jaggu"]:
            assert train[p]["payable"] == 1250.0
        assert train["Golmal"]["payable"] == 5000.0
        water = self._rowmap(out["blocks"][5])
        assert water["Tom"]["payable"] == 150.0 and water["Jerry"]["payable"] == 150.0
        for p in ["Bheem", "Raju", "Chutki", "Jaggu"]:
            assert water[p]["payable"] == 75.0
        assert water["Golmal"]["payable"] == 300.0

    def test_negative_refund_naive_rounding(self):
        members, expenses = self._oracle()
        refund = build_expense_member_rows(expenses, members)["blocks"][2]
        assert all(r["payable"] == -85.71 for r in refund["rows"])
        assert all(r["participates"] is True for r in refund["rows"])  # nonzero (negative)
        assert refund["block_payable"] == -599.97  # naive: -85.71 * 7 (drift cancels in grand total)

    def test_family_member_rows_sum_to_family_entity_share(self):
        members, expenses = self._oracle()
        out = build_expense_member_rows(expenses, members)
        train = self._rowmap(out["blocks"][1])
        assert round(sum(train[p]["payable"] for p in ["Bheem", "Raju", "Chutki", "Jaggu"]), 2) == 5000.0
        assert round(train["Tom"]["payable"] + train["Jerry"]["payable"], 2) == 5000.0

    def test_individual_rows_use_own_name_in_both_columns(self):
        members, expenses = self._oracle()
        gol_row = [r for r in build_expense_member_rows(expenses, members)["blocks"][0]["rows"]
                   if r["person"] == "Golmal"][0]
        assert gol_row["family"] == "Golmal" and gol_row["person"] == "Golmal"

    def test_empty_expenses(self):
        members, _ = self._oracle()
        out = build_expense_member_rows([], members)
        assert out["blocks"] == []
        assert out["pivot"]["rows"] == []
        assert out["grand_amount"] == 0.0 and out["grand_payable"] == 0.0
        assert out["pivot"]["grand_total"] == 0.0

    def test_zero_weight_expense_is_skipped_like_the_ledger(self):
        members, _ = self._oracle()
        # Only entity has snapshot weight 0 -> H<=0 -> entity_shares_raw {} -> skipped (no block).
        e = {"id": "z", "amount": 100.0, "split_member_ids": ["tj"], "split_mode": "PER_CAPITA",
             "paid_by_member_id": "tj", "date": "01-06-26", "category": "Food", "description": "Z",
             "weight_snapshots": {"tj": 0}}
        out = build_expense_member_rows([e], members)
        assert out["blocks"] == []
        assert out["grand_amount"] == 0.0
