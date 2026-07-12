# Pure unit tests for the Phase 16 report restructure (services.report_builder).
# No HTTP / server / conftest fixtures — operates only on plain dicts/lists, exactly like
# test_report_builder.py. Verifies the new tab builders reconcile and foot, reusing the SAME engine
# helpers the ledger uses so the workbook can never drift from utils.balances._compute_balances.
from utils.display_names import member_display_names
from services.report_builder import (
    build_members_families_rows,
    build_split_math_rows,
    build_summary_spend_rows,
    composition_label,
    entity_ledger_components,
    mode_label,
    settle_adj_by_entity,
    trip_composition,
)


def _fam(mid, size, name=None):
    return {"id": mid, "name": name or mid, "kind": "family",
            "family_members": [f"{mid}-{i}" for i in range(size)],
            "family_member_ids": [f"{mid}:{i}" for i in range(size)]}


def _ind(mid, name=None):
    return {"id": mid, "name": name or mid, "kind": "individual", "family_members": []}


def _exp(eid, amount, split_ids, mode="PER_CAPITA", paid_by="i1",
         date="11-05-26", category="Food", description="x"):
    return {"id": eid, "amount": amount, "split_member_ids": split_ids, "split_mode": mode,
            "paid_by_member_id": paid_by, "date": date, "category": category,
            "description": description}


class TestModeLabel:
    def test_labels(self):
        assert mode_label("PER_CAPITA") == "Per-Person"
        assert mode_label("PER_FAMILY") == "Per-Family"
        assert mode_label(None) == "Per-Person"   # ledger default
        assert mode_label("") == "Per-Person"


class TestComposition:
    def test_mirror_of_frontend_examples(self):
        members = ([_fam("f1", 4), _fam("f2", 4), _fam("f3", 2), _fam("f4", 1),
                    _ind("i1"), _ind("i2")])
        assert trip_composition(members) == (13, 4, 2)
        assert composition_label(members) == "13 Individuals across 4 Families & 2 Singles"
        assert composition_label([_fam("a", 4), _fam("b", 4)]) == "8 Individuals across 2 Families"
        assert composition_label([_fam("a", 2), _ind("x")]) == "3 Individuals across 1 Family & 1 Single"
        assert composition_label([_fam("a", 1)]) == "1 Individual across 1 Family"
        assert composition_label([_ind("x"), _ind("y")]) == "2 Individuals"


class TestSettleAdj:
    def test_payer_plus_receiver_minus(self):
        s = [{"from_member_id": "a", "to_member_id": "b", "amount": 30.0},
             {"from_member_id": "a", "to_member_id": "c", "amount": 10.0}]
        adj = settle_adj_by_entity(s)
        assert adj["a"] == 40.0 and adj["b"] == -30.0 and adj["c"] == -10.0
        assert sum(adj.values()) == 0.0  # settlements are zero-sum

    def test_empty(self):
        assert settle_adj_by_entity([]) == {}

    def test_payments_only(self):
        # Phase 23: payments share the from/to/amount shape, so the same helper rolls them up.
        payments = [{"from_member_id": "a", "to_member_id": "b", "amount": 15.0}]
        adj = settle_adj_by_entity(payments)
        assert adj == {"a": 15.0, "b": -15.0}

    def test_settlements_plus_payments_no_double_count(self):
        # The caller passes `settlements + payments` (the SAME list _compute_balances overlays); a
        # single pass sums both directions once, staying zero-sum.
        settlements = [{"from_member_id": "a", "to_member_id": "b", "amount": 30.0}]
        payments = [{"from_member_id": "a", "to_member_id": "b", "amount": 15.0},
                    {"from_member_id": "c", "to_member_id": "b", "amount": 5.0}]
        adj = settle_adj_by_entity(settlements + payments)
        assert adj["a"] == 45.0 and adj["c"] == 5.0 and adj["b"] == -50.0
        assert round(sum(adj.values()), 2) == 0.0

    def test_zero_payments_matches_settlements_only(self):
        settlements = [{"from_member_id": "a", "to_member_id": "b", "amount": 30.0}]
        assert settle_adj_by_entity(settlements + []) == settle_adj_by_entity(settlements)


class TestEntityLedgerComponents:
    def test_paid_signed_and_share_match_ledger(self):
        members = [_fam("f1", 2), _ind("i1")]
        # 100 PER_CAPITA paid by i1, split all: H = 2 + 1 = 3 -> f1 owes 66.67, i1 owes 33.33.
        paid, share = entity_ledger_components([_exp("e", 100.0, [], paid_by="i1")], members)
        assert paid == {"f1": 0.0, "i1": 100.0}
        assert abs(share["f1"] - 200.0 / 3) < 1e-9
        assert abs(share["i1"] - 100.0 / 3) < 1e-9
        # net == paid - share reconstructs the ledger net (pre-settlement).
        assert abs((paid["i1"] - share["i1"]) - 100.0 / 3 * 2) < 1e-9

    def test_skips_rows_that_split_to_nothing(self):
        # An expense with empty roster split (no members) contributes nothing — like the ledger.
        members = [_ind("i1")]
        paid, share = entity_ledger_components(
            [{"id": "e", "amount": 50.0, "split_member_ids": ["ghost"], "split_mode": "PER_CAPITA",
              "paid_by_member_id": "i1", "date": "1", "category": "c", "description": ""}], members)
        # 'ghost' isn't a member so its share isn't tracked, but i1 (payer) IS credited (the split is
        # non-empty: ghost defaults to weight 1), so paid[i1] == 50.
        assert paid["i1"] == 50.0


class TestSplitMath:
    def test_per_capita_block_section_5a(self):
        members = [_fam("f1", 4), _fam("f2", 4), _fam("f3", 2), _fam("f4", 1),
                   _ind("i1"), _ind("i2")]
        blocks = build_split_math_rows([_exp("e", 130.0, [], paid_by="i1")], members)
        assert len(blocks) == 1
        blk = blocks[0]
        assert blk["mode"] == "Per-Person"
        assert blk["divisor"] == 13
        assert blk["subtotal_units"] == 13
        assert blk["subtotal_allocated"] == 130.0
        # units sum to the divisor; allocated sums to the amount; allocated == units * per_unit.
        assert sum(p["units"] for p in blk["participants"]) == 13
        assert abs(sum(p["allocated"] for p in blk["participants"]) - 130.0) < 0.005 * 6
        by_name = {p["participant"]: p for p in blk["participants"]}
        assert by_name["f1"]["ptype"] == "Family" and by_name["f1"]["units"] == 4
        assert by_name["i1"]["ptype"] == "Individual" and by_name["i1"]["units"] == 1
        assert all(abs(p["per_unit"] - 10.0) < 1e-9 for p in blk["participants"])

    def test_per_family_block_section_5b(self):
        members = [_fam("f1", 4), _fam("f2", 4), _ind("i1")]
        blocks = build_split_math_rows(
            [_exp("e", 120.0, [], mode="PER_FAMILY", paid_by="f1")], members)
        blk = blocks[0]
        assert blk["mode"] == "Per-Family"
        assert blk["divisor"] == 3
        assert all(p["units"] == 1 for p in blk["participants"])     # entity = 1 unit
        assert all(abs(p["per_unit"] - 40.0) < 1e-9 for p in blk["participants"])
        assert blk["subtotal_allocated"] == 120.0
        assert blk["subtotal_units"] == 3

    def test_mixed_modes_each_expense_is_one_block(self):
        members = [_fam("f1", 2), _ind("i1"), _ind("i2")]
        blocks = build_split_math_rows([
            _exp("e1", 100.0, [], mode="PER_CAPITA", paid_by="i1", date="01-01-26"),
            _exp("e2", 60.0, [], mode="PER_FAMILY", paid_by="f1", date="02-01-26"),
        ], members)
        assert [b["mode"] for b in blocks] == ["Per-Person", "Per-Family"]
        for b in blocks:
            assert abs(b["subtotal_allocated"] - round(b["amount"], 2)) <= 0.01

    def test_skipped_expense_has_no_block(self):
        members = [_ind("i1")]
        # all-zero participants -> nothing to split (split_member_ids empty AND no members? use H<=0)
        blocks = build_split_math_rows(
            [{"id": "e", "amount": 100.0, "split_member_ids": [], "split_mode": "PER_FAMILY",
              "paid_by_member_id": "i1", "date": "1", "category": "c", "description": ""}],
            [])  # empty roster -> split_ids resolves to [] -> E<=0 -> skip
        assert blocks == []


class TestMembersFamilies:
    """Integrated scenario proving the Members & Families tab reconciles and foots exactly."""

    def _scenario(self):
        members = [_fam("f1", 2, "Fam"), _ind("i1", "Ann"), _ind("i2", "Bob")]
        expenses = [
            _exp("e1", 100.0, [], mode="PER_CAPITA", paid_by="i1"),   # H=4: f1=50,i1=25,i2=25
            _exp("e2", 60.0, [], mode="PER_FAMILY", paid_by="f1"),    # E=3: 20 each
        ]
        settlements = [{"from_member_id": "i2", "to_member_id": "i1", "amount": 45.0,
                        "status": "paid"}]
        paid, share = entity_ledger_components(expenses, members)
        settle = settle_adj_by_entity(settlements)
        # post-settlement net per entity = paid - share + settle (the ledger identity).
        net = {m["id"]: round(paid[m["id"]] - share[m["id"]] + settle.get(m["id"], 0.0), 2)
               for m in members}
        # per_person mimics bal["per_person"] (family member breakdown sums to the family net).
        fam_net = net["f1"]
        half = round(fam_net / 2, 2)
        per_person = [
            {"member_id": "f1", "member_name": "Fam", "kind": "family", "net_total": fam_net,
             "members": [{"id": "f1:0", "name": "a", "net": half},
                         {"id": "f1:1", "name": "b", "net": round(fam_net - half, 2)}]},
            {"member_id": "i1", "member_name": "Ann", "kind": "individual", "net_total": net["i1"],
             "members": []},
            {"member_id": "i2", "member_name": "Bob", "kind": "individual", "net_total": net["i2"],
             "members": []},
        ]
        display = member_display_names(members)
        return members, paid, share, settle, net, per_person, display

    def test_rows_reconcile_and_foot(self):
        members, paid, share, settle, net, per_person, display = self._scenario()
        rows = build_members_families_rows(per_person, paid, settle, display)

        entity_rows = [r for r in rows if r["kind"] in ("family_subtotal", "individual")]
        member_rows = [r for r in rows if r["kind"] == "family_member"]
        total = [r for r in rows if r["kind"] == "total"][0]

        # 1) Every entity row reconciles: Net = Paid - Share + Settlements (exact, 2dp).
        for r in entity_rows:
            assert abs(round(r["paid"] - r["share"] + r["settle"], 2) - r["net"]) < 1e-9

        # 2) Displayed Share equals the real engine allocation (entity_ledger_components share).
        share_by_name = {display[mid]: round(share[mid], 2) for mid in share}
        for r in entity_rows:
            assert abs(r["share"] - share_by_name[r["name"]]) <= 0.01

        # 3) Family member rows carry only Net and sum to the family's Net (excluded from TOTAL).
        assert all(r["paid"] is None and r["share"] is None and r["settle"] is None
                   for r in member_rows)
        fam = [r for r in entity_rows if r["kind"] == "family_subtotal"][0]
        assert abs(sum(r["net"] for r in member_rows) - fam["net"]) < 1e-9

        # 4) Totals foot: Σ Paid = Σ Share = grand total spent; Σ Settlements = Σ Net = 0.
        grand = round(sum(e["amount"] for e in [{"amount": 100.0}, {"amount": 60.0}]), 2)
        assert total["paid"] == grand
        assert total["share"] == grand
        assert total["settle"] == 0.0
        assert total["net"] == 0.0
        # TOTAL sums entities only (no double counting of family member rows).
        assert abs(total["paid"] - sum(r["paid"] for r in entity_rows)) < 1e-9

    def test_family_then_individuals_then_total_order(self):
        members, paid, share, settle, net, per_person, display = self._scenario()
        rows = build_members_families_rows(per_person, paid, settle, display)
        kinds = [r["kind"] for r in rows]
        assert kinds[0] == "family_subtotal"
        assert kinds[-1] == "total"
        assert kinds.count("family_member") == 2
        assert "individual" in kinds


class TestMembersFamiliesWithPayments:
    """Phase 23 regression — the Settlements column MUST include Phase-20 partial payments (the same
    `settlements + payments` overlay `_compute_balances` applies), or it understates reality and the
    Share column is silently contaminated. The pre-fix code passed settlements only."""

    def _scenario(self):
        members = [_fam("f1", 2, "Fam"), _ind("i1", "Ann"), _ind("i2", "Bob")]
        expenses = [
            _exp("e1", 100.0, [], mode="PER_CAPITA", paid_by="i1"),   # H=4: f1=50,i1=25,i2=25
            _exp("e2", 60.0, [], mode="PER_FAMILY", paid_by="f1"),    # E=3: 20 each
        ]
        # A legacy paid settlement AND a partial payment, BOTH i2 -> i1.
        settlements = [{"from_member_id": "i2", "to_member_id": "i1", "amount": 30.0,
                        "status": "paid"}]
        payments = [{"from_member_id": "i2", "to_member_id": "i1", "amount": 15.0,
                     "created_at": "2026-07-01T10:30:00+00:00"}]
        paid, share = entity_ledger_components(expenses, members)
        # The report must feed the FULL overlay set (settlements + payments), exactly like the ledger.
        settle = settle_adj_by_entity(settlements + payments)
        net = {m["id"]: round(paid[m["id"]] - share[m["id"]] + settle.get(m["id"], 0.0), 2)
               for m in members}
        fam_net = net["f1"]
        half = round(fam_net / 2, 2)
        per_person = [
            {"member_id": "f1", "member_name": "Fam", "kind": "family", "net_total": fam_net,
             "members": [{"id": "f1:0", "name": "a", "net": half},
                         {"id": "f1:1", "name": "b", "net": round(fam_net - half, 2)}]},
            {"member_id": "i1", "member_name": "Ann", "kind": "individual", "net_total": net["i1"],
             "members": []},
            {"member_id": "i2", "member_name": "Bob", "kind": "individual", "net_total": net["i2"],
             "members": []},
        ]
        display = member_display_names(members)
        return members, paid, share, settle, net, per_person, display, settlements, payments

    def test_settlements_column_includes_payment(self):
        members, paid, share, settle, net, per_person, display, settlements, payments = self._scenario()
        rows = build_members_families_rows(per_person, paid, settle, display)
        by_name = {r["name"]: r for r in rows}
        # Bob paid OUT 30 (settlement) + 15 (payment) = 45. Pre-fix this cell would read 30.
        assert round(by_name["Bob"]["settle"], 2) == 45.0
        assert round(by_name["Ann"]["settle"], 2) == -45.0
        # Share stays the TRUE engine allocation (Bob owes 25 + 20 = 45), NOT contaminated by -payment.
        assert round(by_name["Bob"]["share"], 2) == 45.0
        assert round(by_name["Ann"]["share"], 2) == 45.0

    def test_parity_with_ledger_overlay(self):
        # Report Settlements value == _compute_balances' overlay adjustment (settlements + payments).
        members, paid, share, settle, net, per_person, display, settlements, payments = self._scenario()
        overlay = settle_adj_by_entity(settlements + payments)
        rows = build_members_families_rows(per_person, paid, settle, display)
        for r in rows:
            if r["kind"] in ("family_subtotal", "individual"):
                mid = next(m["id"] for m in members if display[m["id"]] == r["name"])
                assert abs(r["settle"] - round(overlay.get(mid, 0.0), 2)) <= 0.01

    def test_every_row_and_total_foot(self):
        members, paid, share, settle, net, per_person, display, settlements, payments = self._scenario()
        rows = build_members_families_rows(per_person, paid, settle, display)
        entity_rows = [r for r in rows if r["kind"] in ("family_subtotal", "individual")]
        member_rows = [r for r in rows if r["kind"] == "family_member"]
        total = [r for r in rows if r["kind"] == "total"][0]
        for r in entity_rows:
            assert abs(round(r["paid"] - r["share"] + r["settle"], 2) - r["net"]) < 1e-9
        # Family member rows still sum to the (payment-inclusive) family Net.
        fam = [r for r in entity_rows if r["kind"] == "family_subtotal"][0]
        assert abs(sum(r["net"] for r in member_rows) - fam["net"]) < 1e-9
        # Σ Settlements == Σ Net == 0 across the sheet (payments are zero-sum too).
        assert round(total["settle"], 2) == 0.0
        assert round(total["net"], 2) == 0.0
        assert total["paid"] == total["share"]  # Σ Paid == Σ Share == grand total spent

    def test_payment_fully_settling_a_pair(self):
        # i2 owes i1 exactly 45 pre-settlement; a 45 payment (no legacy settlement) zeroes the pair.
        members = [_ind("i1", "Ann"), _ind("i2", "Bob")]
        expenses = [_exp("e1", 90.0, [], mode="PER_CAPITA", paid_by="i1")]  # each owes 45; i1 net +45
        payments = [{"from_member_id": "i2", "to_member_id": "i1", "amount": 45.0,
                     "created_at": "2026-07-01T00:00:00+00:00"}]
        paid, share = entity_ledger_components(expenses, members)
        settle = settle_adj_by_entity([] + payments)
        net = {m["id"]: round(paid[m["id"]] - share[m["id"]] + settle.get(m["id"], 0.0), 2)
               for m in members}
        per_person = [{"member_id": m["id"], "member_name": m["name"], "kind": "individual",
                       "net_total": net[m["id"]], "members": []} for m in members]
        display = member_display_names(members)
        rows = build_members_families_rows(per_person, paid, settle, display)
        by_name = {r["name"]: r for r in rows if r["kind"] == "individual"}
        assert round(by_name["Ann"]["net"], 2) == 0.0 and round(by_name["Bob"]["net"], 2) == 0.0
        assert round(by_name["Bob"]["settle"], 2) == 45.0


class TestSummarySpend:
    def test_descending_with_types_and_total(self):
        members = [_fam("f1", 2, "Fam"), _ind("i1", "Ann"), _ind("i2", "Bob")]
        expenses = [
            _exp("e1", 100.0, [], paid_by="i1"),
            _exp("e2", 60.0, [], paid_by="f1"),
            _exp("e3", 30.0, [], paid_by="i1"),
        ]
        out = build_summary_spend_rows(members, expenses)
        rows = out["rows"]
        # Ann fronted 130, Fam 60, Bob 0 -> descending.
        assert [r["name"] for r in rows] == ["Ann", "Fam", "Bob"]
        assert [r["paid"] for r in rows] == [130.0, 60.0, 0.0]
        assert rows[0]["type"] == "Individual" and rows[1]["type"] == "Family"
        assert out["total"] == 190.0

    def test_refunds_excluded_from_gross(self):
        members = [_ind("i1", "Ann")]
        out = build_summary_spend_rows(
            members, [_exp("e1", 100.0, [], paid_by="i1"), _exp("e2", -40.0, [], paid_by="i1")])
        assert out["rows"][0]["paid"] == 100.0   # gross positive only
        assert out["total"] == 100.0
