# Pure unit tests for EXACT split mode (Phase 22). No HTTP/server/DB — plain dicts + the pure
# services (services.custom_split, services.income_migration.compute_net, services.member_breakdown),
# mirroring test_split_bugfix.py.
#
# EXACT: the author assigns explicit per-person amounts. Person-level input rolls UP to entity shares
# (family = Σ its members present; individual = own) and feeds the SAME ledger/settlement engine as the
# other two modes. The one hard rule (Σ amounts == total) is validated + cent-snapped in custom_split.
import pytest

from services.custom_split import (
    exact_member_shares,
    resolve_exact_entity_shares,
    valid_exact_member_ids,
    validate_exact_amounts,
)
from services.income_migration import compute_net  # faithful _compute_balances replica
from services.member_breakdown import family_member_breakdown
from services.report_builder import build_expense_member_rows, build_split_math_rows, mode_label


# --------------------------------------------------------------------------- helpers
def _fam(mid, ids):
    return {"id": mid, "name": mid, "kind": "family",
            "family_members": [f"m{i}" for i in range(len(ids))], "family_member_ids": ids}


def _ind(mid):
    return {"id": mid, "name": mid, "kind": "individual", "family_members": []}


def _exp(amount, custom_amounts, paid_by, eid="e1"):
    return {"id": eid, "amount": amount, "split_member_ids": [], "split_mode": "EXACT",
            "paid_by_member_id": paid_by, "custom_amounts": custom_amounts}


def _cents(mapping):
    return {k: round(v * 100) for k, v in mapping.items()}


# =========================================================================== validate_exact_amounts
class TestValidate:
    def test_ok_returns_normalized(self):
        out = validate_exact_amounts(100.0, {"a": 80, "b": 10, "c": 10}, {"a", "b", "c"})
        assert out == {"a": 80.0, "b": 10.0, "c": 10.0}
        assert round(sum(out.values()) * 100) == 10000

    def test_penny_snap_sums_exactly(self):
        # 33.33 + 33.33 + 33.34 == 100.00 already; snap is a no-op but must stay exact.
        out = validate_exact_amounts(100.0, {"a": 33.33, "b": 33.33, "c": 33.34}, {"a", "b", "c"})
        assert round(sum(out.values()) * 100) == 10000

    def test_within_one_cent_is_snapped_up(self):
        # 33.33 * 3 = 99.99, one cent under 100 -> allowed (±0.01) and snapped to sum exactly 100.00.
        out = validate_exact_amounts(100.0, {"a": 33.33, "b": 33.33, "c": 33.33}, {"a", "b", "c"})
        assert round(sum(out.values()) * 100) == 10000
        # the extra cent lands on exactly one row
        assert sorted(_cents(out).values()) == [3333, 3333, 3334]

    def test_sum_under_raises(self):
        with pytest.raises(ValueError):
            validate_exact_amounts(100.0, {"a": 80, "b": 10, "c": 8}, {"a", "b", "c"})

    def test_sum_over_raises(self):
        with pytest.raises(ValueError):
            validate_exact_amounts(100.0, {"a": 80, "b": 15, "c": 10}, {"a", "b", "c"})

    def test_negative_amount_raises(self):
        with pytest.raises(ValueError):
            validate_exact_amounts(100.0, {"a": 110, "b": -10}, {"a", "b"})

    def test_all_zero_raises(self):
        with pytest.raises(ValueError):
            validate_exact_amounts(0.0, {"a": 0, "b": 0}, {"a", "b"})

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            validate_exact_amounts(100.0, {}, {"a", "b"})

    def test_unknown_member_raises(self):
        with pytest.raises(ValueError):
            validate_exact_amounts(100.0, {"a": 50, "ghost": 50}, {"a", "b"})


# =========================================================================== valid_exact_member_ids
class TestValidIds:
    def test_individuals_and_family_rosters(self):
        members = [_fam("fA", ["fa1", "fa2", "fa3"]), _ind("i1")]
        assert valid_exact_member_ids(members) == {"fa1", "fa2", "fa3", "i1"}
        # the family ENTITY id itself is NOT a person-level key
        assert "fA" not in valid_exact_member_ids(members)


# =========================================================================== resolve_exact_entity_shares
class TestResolveEntityShares:
    def test_two_in_a_family_plus_individual(self):
        members = [_fam("fA", ["fa1", "fa2"]), _ind("i1")]
        shares = resolve_exact_entity_shares({"fa1": 80, "fa2": 10, "i1": 10}, members)
        assert shares == {"fA": 90.0, "i1": 10.0}

    def test_mixed_multi_family(self):
        members = [_fam("fA", ["a1", "a2", "a3"]), _fam("fB", ["b1", "b2"]), _ind("i1"), _ind("i2")]
        custom = {"a1": 30, "a2": 20, "a3": 10, "b1": 15, "b2": 5, "i1": 12, "i2": 8}
        shares = resolve_exact_entity_shares(custom, members)
        assert shares == {"fA": 60.0, "fB": 20.0, "i1": 12.0, "i2": 8.0}
        assert round(sum(shares.values()) * 100) == round(sum(custom.values()) * 100)

    def test_family_share_is_sum_of_members_property(self):
        members = [_fam("fA", ["a1", "a2", "a3", "a4"]), _ind("i1")]
        custom = {"a1": 12.5, "a3": 7.5, "i1": 80}  # a2, a4 absent => 0
        shares = resolve_exact_entity_shares(custom, members)
        assert shares["fA"] == pytest.approx(20.0)  # 12.5 + 7.5, a2/a4 excluded
        assert "i1" in shares and shares["i1"] == 80.0

    def test_absent_member_contributes_zero_and_entity_omitted_when_zero(self):
        members = [_fam("fA", ["a1", "a2"]), _ind("i1")]
        # family entirely absent -> not in the rollup at all
        shares = resolve_exact_entity_shares({"i1": 50}, members)
        assert shares == {"i1": 50.0}


# =========================================================================== exact_member_shares
class TestExactMemberShares:
    def test_absent_members_are_zero(self):
        assert exact_member_shares({"a1": 80}, ["a1", "a2", "a3"]) == {"a1": 80.0, "a2": 0.0, "a3": 0.0}

    def test_empty_custom(self):
        assert exact_member_shares(None, ["a1", "a2"]) == {"a1": 0.0, "a2": 0.0}


# =========================================================================== ledger (compute_net) reconciliation
class TestLedgerReconciles:
    def test_individuals_only_balances(self):
        # i1 fronts 100, split exact 80/10/10 across i1/i2/i3 -> i1 net = 100 - 80 = +20; i2 -10; i3 -10.
        members = [_ind("i1"), _ind("i2"), _ind("i3")]
        exps = [_exp(100.0, {"i1": 80, "i2": 10, "i3": 10}, paid_by="i1")]
        net = compute_net(members, exps, [])
        assert net == {"i1": 20.0, "i2": -10.0, "i3": -10.0}
        assert round(sum(net.values()) * 100) == 0

    def test_family_and_individual_payer(self):
        # Family fA (a1,a2) consumes 90 (80/10), i1 consumes 10; i1 fronts the whole 100.
        members = [_fam("fA", ["a1", "a2"]), _ind("i1")]
        exps = [_exp(100.0, {"a1": 80, "a2": 10, "i1": 10}, paid_by="i1")]
        net = compute_net(members, exps, [])
        assert net == {"fA": -90.0, "i1": 90.0}

    def test_family_is_payer(self):
        # Family fronts 100; family consumes 90, i1 consumes 10 -> family net = 100 - 90 = +10; i1 -10.
        members = [_fam("fA", ["a1", "a2"]), _ind("i1")]
        exps = [_exp(100.0, {"a1": 80, "a2": 10, "i1": 10}, paid_by="fA")]
        net = compute_net(members, exps, [])
        assert net == {"fA": 10.0, "i1": -10.0}


# =========================================================================== per-member family breakdown
class TestFamilyBreakdown:
    def test_breakdown_equals_typed_amounts_and_foots(self):
        members = [_fam("fA", ["a1", "a2", "a3"]), _ind("i1")]
        exps = [_exp(100.0, {"a1": 80, "a2": 10, "i1": 10}, paid_by="i1")]  # a3 absent => 0
        net = compute_net(members, exps, [])
        rows = family_member_breakdown(members, exps, [], net)["fA"]
        by_id = {r["id"]: r["net"] for r in rows}
        assert by_id == {"a1": -80.0, "a2": -10.0, "a3": 0.0}
        assert round(sum(by_id.values()) * 100) == round(net["fA"] * 100)  # foots to family net


# =========================================================================== report builders (display-only)
class TestReportBuilders:
    def test_mode_label(self):
        assert mode_label("EXACT") == "Exact"

    def test_split_math_rows_exact(self):
        members = [_fam("fA", ["a1", "a2"]), _ind("i1")]
        exps = [_exp(100.0, {"a1": 80, "a2": 10, "i1": 10}, paid_by="i1")]
        block = build_split_math_rows(exps, members)[0]
        assert block["mode"] == "Exact"
        shares = {p["participant"]: p["allocated"] for p in block["participants"]}
        assert shares == {"fA": 90.0, "i1": 10.0}  # entity rollup
        assert round(block["subtotal_allocated"] * 100) == 10000  # foots to the total

    def test_expense_member_rows_exact_reconciles(self):
        members = [_fam("fA", ["a1", "a2"]), _ind("i1")]
        exps = [_exp(100.0, {"a1": 80, "a2": 10, "i1": 10}, paid_by="i1")]
        out = build_expense_member_rows(exps, members)
        # rows key `person` by display name; _fam sets member names m0/m1, _ind uses the id as name.
        payable = {r["person"]: r["payable"] for blk in out["blocks"] for r in blk["rows"]}
        assert payable["m0"] == 80.0 and payable["m1"] == 10.0 and payable["i1"] == 10.0
        assert round(out["grand_amount"] * 100) == round(out["grand_payable"] * 100) == 10000
