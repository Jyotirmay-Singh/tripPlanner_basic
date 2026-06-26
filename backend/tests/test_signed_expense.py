# Pure unit tests for the signed-amount expense model (negatives = money back to the group).
# No HTTP/server/conftest — operates on plain dicts + the pure services + the Pydantic models, like
# test_report_builder.py / test_expense_shares.py. The faithful ledger replica `compute_net`
# (services.income_migration) mirrors utils.balances._compute_balances exactly.
import math

import pytest
from pydantic import ValidationError

from models.expense import ExpenseIn, ExpenseUpdate
from services.income_migration import compute_net
from services.expense_shares import expense_share_breakdown
from services.member_breakdown import family_member_breakdown


# Section 5A roster + an external payer P who is NOT in the split, so net[P] == amount exactly.
def _fam(mid, size):
    return {"id": mid, "name": mid, "kind": "family",
            "family_members": [f"{mid}-{i}" for i in range(size)]}


def _ind(mid):
    return {"id": mid, "name": mid, "kind": "individual", "family_members": []}


def _roster():
    return [_ind("P"), _fam("f1", 4), _fam("f2", 4), _fam("f3", 2), _fam("f4", 1),
            _ind("i1"), _ind("i2")]


def _exp(amount, split_ids, mode="PER_CAPITA", paid_by="P", snaps=None, participants=None):
    e = {"id": "e1", "amount": amount, "split_member_ids": split_ids, "split_mode": mode,
         "paid_by_member_id": paid_by, "date": "01-01-25", "category": "Food", "description": ""}
    if snaps is not None:
        e["weight_snapshots"] = snaps
    if participants is not None:
        e["family_participants"] = participants
    return e


class TestNegativePerCapita:
    # Section 5A example, negated: -130 across 13 humans -> per-human -10. Participants are CREDITED
    # (+share), the receiver P is DEBITED (-130). The exact mirror of a +130 expense.
    def test_section_5a_mirror(self):
        members = _roster()
        net = compute_net(members, [_exp(-130.0, ["f1", "f2", "f3", "f4", "i1", "i2"])], [])
        assert net == {"P": -130.0, "f1": 40.0, "f2": 40.0, "f3": 20.0, "f4": 10.0,
                       "i1": 10.0, "i2": 10.0}
        assert round(sum(net.values()), 2) == 0.0  # conservation

    def test_honors_weight_snapshots(self):
        # Override f1's weight to 1 (partial family). H = 1+1 = 2 -> per-human -25.
        members = _roster()
        net = compute_net(members, [_exp(-50.0, ["f1", "i1"], snaps={"f1": 1})], [])
        assert net["f1"] == 25.0 and net["i1"] == 25.0 and net["P"] == -50.0


class TestNegativePerFamily:
    def test_flat_per_entity_mirror(self):
        # -120 across 6 entities -> each entity credited +20, receiver P debited -120.
        members = _roster()
        net = compute_net(members, [_exp(-120.0, ["f1", "f2", "f3", "f4", "i1", "i2"],
                                         mode="PER_FAMILY")], [])
        assert net["P"] == -120.0
        assert all(net[e] == 20.0 for e in ["f1", "f2", "f3", "f4", "i1", "i2"])
        assert round(sum(net.values()), 2) == 0.0


class TestMixedSignsNet:
    def test_positive_then_negative_nets(self):
        members = _roster()
        ids = ["f1", "f2", "f3", "f4", "i1", "i2"]
        net = compute_net(members, [_exp(130.0, ids), _exp(-130.0, ids)], [])
        assert all(round(v, 2) == 0.0 for v in net.values())  # a full refund zeroes everyone


class TestSharesSumToSignedTotal:
    def test_per_capita_shares_sum_to_negative_amount(self):
        members = _roster()
        bd = expense_share_breakdown(_exp(-100.0, ["f1", "f2", "f3", "f4", "i1", "i2"]), members)
        assert round(sum(ent["share"] for ent in bd["entities"]), 2) == -100.0
        assert all(ent["share"] <= 0 for ent in bd["entities"])


class TestNegativeWithFamilyParticipants:
    # family_participants is DISPLAY-only and must keep working under negation: excluded members show
    # 0, participants split the family's (negative) share, summing exactly to it.
    def _members(self):
        return [
            {"id": "F", "name": "Fam", "kind": "family",
             "family_members": ["a", "b", "c", "d"], "family_member_ids": ["fa", "fb", "fc", "fd"]},
            _ind("i1"),
        ]

    def test_breakdown_credits_only_participants(self):
        members = self._members()
        # -100 PER_CAPITA, H = 4 + 1 = 5, per-human -20 -> F share -80, i1 -20.
        e = _exp(-100.0, ["F", "i1"], paid_by="i1", participants={"F": ["fa", "fb"]})
        bd = expense_share_breakdown(e, members)
        fam = next(ent for ent in bd["entities"] if ent["id"] == "F")
        assert round(fam["share"], 2) == -80.0
        by_id = {m["id"]: m["share"] for m in fam["members"]}
        assert by_id == {"fa": -40.0, "fb": -40.0, "fc": 0.0, "fd": 0.0}
        assert round(sum(m["share"] for m in fam["members"]), 2) == -80.0

    def test_family_member_breakdown_sums_to_family_net(self):
        members = self._members()
        e = _exp(-100.0, ["F", "i1"], paid_by="i1", participants={"F": ["fa", "fb"]})
        net = compute_net(members, [e], [])
        rows = family_member_breakdown(members, [e], [], net)["F"]
        assert round(sum(r["net"] for r in rows), 2) == round(net["F"], 2)


class TestAmountValidation:
    def _kwargs(self, **over):
        base = dict(amount=10.0, category="Food", date="01-01-25", paid_by_member_id="m1")
        base.update(over)
        return base

    def test_negative_and_decimal_accepted(self):
        assert ExpenseIn(**self._kwargs(amount=-50.25)).amount == -50.25
        assert ExpenseUpdate(amount=-5).amount == -5

    @pytest.mark.parametrize("bad", [0, 0.0, float("nan"), float("inf"), -float("inf")])
    def test_zero_and_nonfinite_rejected(self, bad):
        with pytest.raises(ValidationError):
            ExpenseIn(**self._kwargs(amount=bad))
        if not math.isnan(bad):  # ExpenseUpdate(amount=...) rejects the same set
            with pytest.raises(ValidationError):
                ExpenseUpdate(amount=bad)

    def test_update_amount_optional_when_omitted(self):
        assert ExpenseUpdate().amount is None
