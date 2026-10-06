"""Deterministic integer circulation and validation of reviewed coverage bundles."""

from collections import deque
from copy import deepcopy

from services.coverage_support import (
    CoverageError, POLICY_VERSION, add_vector, fingerprint, money, record_errors, stable_id, whole_units,
)
from services.settlement_engine import build_settlement_projection, to_scaled


def _accounts(trip):
    accounts = {}
    for member in trip["members"]:
        if member.get("kind") == "family":
            accounts.update(zip(member.get("family_member_ids") or [], member.get("family_member_user_ids") or []))
        else:
            accounts[member["id"]] = member.get("user_id")
    return accounts


def _current_access(trip, actor):
    from utils.permissions import is_super_admin, role_of, viewer_id
    return role_of(trip, actor) is not None and (
        is_super_admin(actor) or viewer_id(actor) in trip.get("user_ids", [])
    )


def _requirements(snapshot, lines, mode):
    if mode == "direct":
        return [], False
    people, unknown = set(), False
    for line in lines:
        row = snapshot.shares[line["share_id"]]
        if row["person_id"]:
            people.add(row["person_id"])
        else:
            unknown = True
        funding_people = row.get("funding_participant_ids") or []
        people.update(funding_people)
        unknown |= not bool(funding_people)
    accounts = _accounts(snapshot.ledger.trip)
    return sorted(people), unknown or any(not accounts.get(person) for person in people)


def _finish(snapshot, mode, lines, legs, cycles, *, intent_id=None):
    people, override = _requirements(snapshot, lines, mode)
    body = {"policy_version": POLICY_VERSION, "mode": mode,
            "source_snapshot_id": snapshot.snapshot_id,
            "allocation_lines": lines, "cash_legs": legs, "cycles": cycles,
            "required_person_ids": people, "requires_admin_override": override,
            "reservation_intent_id": intent_id}
    plan_hash = fingerprint(body)
    return {**body, "id": stable_id(plan_hash), "plan_hash": plan_hash}


def _line(snapshot, share_id, amount, kind):
    row = snapshot.shares[share_id]
    return {"id": stable_id(share_id, amount, kind), "share_id": share_id,
            "revision_id": row["revision_id"], "amount": money(amount), "kind": kind,
            "debtor_wallet_id": row["debtor_wallet_id"], "creditor_wallet_id": row["creditor_wallet_id"],
            "original_funding_person_id": row.get("funding_person_id"),
            "explanation": "Approved zero-money debt offset" if kind == "approved_offset" else
                "Direct expense payment" if kind == "direct" else
                "Obligation discharged through the reviewed group path; cash recipients are listed separately"}


def plan_direct_allocations(snapshot, requests, *, intent_id=None):
    if not requests:
        raise CoverageError("no_shares_selected")
    amounts, pair = {}, None
    for request in requests:
        share_id = request["share_id"]
        if share_id not in snapshot.shares or share_id in amounts:
            raise CoverageError("invalid_share_selection")
        row = snapshot.shares[share_id]
        amount = whole_units(request["amount"])
        direction = (row["debtor_wallet_id"], row["creditor_wallet_id"])
        if direction[0] == direction[1] or amount > snapshot.available(share_id, intent_id=intent_id):
            raise CoverageError("already_covered_or_reserved")
        if pair is not None and direction != pair:
            raise CoverageError("different_direct_recipients")
        pair, amounts[share_id] = direction, amount
    lines = [_line(snapshot, share_id, amount, "direct") for share_id, amount in sorted(
        amounts.items(), key=lambda item: snapshot.shares[item[0]]["order"],
    )]
    leg_id = stable_id("direct", *pair)
    leg = {"id": leg_id, "from_member_id": pair[0], "to_member_id": pair[1],
           "amount": money(sum(amounts.values())), "dependency": False}
    cycles = [{"amount": line["amount"], "kind": "direct", "edges": [
        {"kind": "obligation", "id": line["share_id"]}, {"kind": "cash", "id": leg_id},
    ]} for line in lines]
    return _finish(snapshot, "direct", lines, [leg], cycles, intent_id=intent_id)


def _circulation(arcs):
    """Lower-bound circulation, Edmonds-Karp with stable arc insertion/BFS order."""
    graph, references, demand = {}, {}, {}

    def edge(u, v, capacity):
        graph.setdefault(u, [])
        graph.setdefault(v, [])
        forward = [v, capacity, len(graph[v])]
        reverse = [u, 0, len(graph[u])]
        graph[u].append(forward)
        graph[v].append(reverse)
        return forward

    for arc in arcs:
        lower = arc.get("lower", 0)
        if lower < 0 or lower > arc["capacity"]:
            raise CoverageError("allocation_unavailable")
        references[arc["key"]] = edge(arc["u"], arc["v"], arc["capacity"] - lower)
        demand[arc["u"]] = demand.get(arc["u"], 0) - lower
        demand[arc["v"]] = demand.get(arc["v"], 0) + lower
    required = 0
    for node in sorted(demand):
        if demand[node] > 0:
            edge("$source", node, demand[node])
            required += demand[node]
        elif demand[node] < 0:
            edge(node, "$sink", -demand[node])
    sent = 0
    while sent < required:
        queue, parent = deque(["$source"]), {"$source": None}
        while queue and "$sink" not in parent:
            u = queue.popleft()
            for index, item in enumerate(graph.get(u, [])):
                if item[1] > 0 and item[0] not in parent:
                    parent[item[0]] = (u, index)
                    queue.append(item[0])
        if "$sink" not in parent:
            raise CoverageError("allocation_unavailable")
        amount, node = required - sent, "$sink"
        while node != "$source":
            u, index = parent[node]
            amount = min(amount, graph[u][index][1])
            node = u
        node = "$sink"
        while node != "$source":
            u, index = parent[node]
            item = graph[u][index]
            item[1] -= amount
            graph[node][item[2]][1] += amount
            node = u
        sent += amount
    return {arc["key"]: arc["capacity"] - references[arc["key"]][1] for arc in arcs}


def _path(arcs, capacities, start, finish, *, exclude=None):
    queue, parents = deque([start]), {start: None}
    while queue and finish not in parents:
        u = queue.popleft()
        for arc in arcs:
            if arc["key"] != exclude and arc["u"] == u and capacities.get(arc["key"], 0) > 0 and arc["v"] not in parents:
                parents[arc["v"]] = (u, arc)
                queue.append(arc["v"])
    if finish not in parents:
        return None
    output, node = [], finish
    while node != start:
        node, arc = parents[node]
        output.append(arc)
    return list(reversed(output))


def _cycles(arcs, capacities, *, complete):
    output = []
    while True:
        found = None
        # Prefer cash-containing cycles; pure cycles are classified separately.
        seeds = sorted(arcs, key=lambda arc: (arc["kind"] != "cash", arc["order"]))
        for seed in seeds:
            if capacities.get(seed["key"], 0) <= 0:
                continue
            path = _path(arcs, capacities, seed["v"], seed["u"], exclude=seed["key"])
            if path is not None:
                found = [seed, *path]
                break
        if found is None:
            if complete and any(capacities.values()):
                raise CoverageError("invalid_circulation")
            return output
        amount = min(capacities[arc["key"]] for arc in found)
        for arc in found:
            capacities[arc["key"]] -= amount
        output.append({"amount": money(amount), "kind": "group" if any(
            arc["kind"] == "cash" for arc in found) else "approved_offset",
            "edges": [{"kind": arc["kind"], "id": arc["id"]} for arc in found]})


def _obligation_arcs(snapshot, intent_id):
    output = []
    for row in sorted(snapshot.shares.values(), key=lambda row: row["order"]):
        if row["id"] in snapshot.blocked or row["debtor_wallet_id"] == row["creditor_wallet_id"]:
            continue
        capacity = snapshot.available(row["id"], intent_id=intent_id)
        if capacity > 0:
            output.append({"key": f"o:{row['id']}", "id": row["id"], "kind": "obligation",
                           "u": row["debtor_wallet_id"], "v": row["creditor_wallet_id"],
                           "capacity": capacity, "order": [0, *row["order"]]})
    return output


def _component_arcs(arcs, seeds):
    seen = set(seeds)
    while True:
        enlarged = seen | {node for arc in arcs if arc["u"] in seen or arc["v"] in seen
                           for node in (arc["u"], arc["v"])}
        if enlarged == seen:
            return [arc for arc in arcs if arc["u"] in seen]
        seen = enlarged


def _lines_from_cycles(snapshot, cycles):
    amounts = {}
    for cycle in cycles:
        for edge in cycle["edges"]:
            if edge["kind"] == "obligation":
                key = (edge["id"], cycle["kind"])
                amounts[key] = amounts.get(key, 0) + to_scaled(cycle["amount"])
    return [_line(snapshot, share_id, amount, kind) for (share_id, kind), amount in sorted(
        amounts.items(), key=lambda item: (snapshot.shares[item[0][0]]["order"], item[0][1]),
    )]


def plan_group_allocations(snapshot, requested_cash_legs, *, intent_id=None):
    if not requested_cash_legs:
        raise CoverageError("no_cash_selected")
    suggestions, _ = build_settlement_projection(snapshot.precise_net, snapshot.ledger.trip.get("currency", "INR"), whole_unit_enabled=True)
    requests = {}
    for request in requested_cash_legs:
        key = (request["from_member_id"], request["to_member_id"])
        if key in requests or key[0] == key[1]:
            raise CoverageError("invalid_cash_selection")
        requests[key] = whole_units(request["amount"])
    obligations = _obligation_arcs(snapshot, intent_id)
    arcs, candidates = list(obligations), {}
    for transfer in sorted(suggestions, key=lambda row: (row["from_member_id"], row["to_member_id"])):
        pair = (transfer["from_member_id"], transfer["to_member_id"])
        leg_id = stable_id("group", *pair)
        capacity = whole_units(transfer["amount"])
        lower = requests.get(pair, 0)
        candidates[leg_id] = {"id": leg_id, "from_member_id": pair[0], "to_member_id": pair[1],
                               "dependency": pair not in requests}
        arcs.append({"key": f"c:{leg_id}", "id": leg_id, "kind": "cash", "u": pair[1], "v": pair[0],
                     "capacity": lower if pair in requests else capacity, "lower": lower,
                     "order": [1, *pair, leg_id]})
        if lower > capacity:
            raise CoverageError("recommendation_changed")
    if any(pair not in {(row["from_member_id"], row["to_member_id"]) for row in suggestions} for pair in requests):
        raise CoverageError("recommendation_changed")
    arcs.sort(key=lambda arc: arc["order"])
    flow = _circulation(arcs)
    cycles = _cycles(arcs, dict(flow), complete=True)
    used_legs = [{**candidates[arc["id"]], "amount": money(flow[arc["key"]])}
                 for arc in arcs if arc["kind"] == "cash" and flow[arc["key"]]]
    component = _component_arcs(obligations, {node for leg in used_legs
                                             for node in (leg["from_member_id"], leg["to_member_id"])})
    residual = {arc["key"]: arc["capacity"] - flow[arc["key"]] for arc in component}
    cycles.extend(_cycles(component, residual, complete=False))
    return _finish(snapshot, "group", _lines_from_cycles(snapshot, cycles), used_legs, cycles, intent_id=intent_id)


def plan_offset_allocations(snapshot, share_ids, *, intent_id=None):
    if not share_ids or any(share_id not in snapshot.shares for share_id in share_ids):
        raise CoverageError("invalid_share_selection")
    for share_id in share_ids:
        snapshot.available(share_id, intent_id=intent_id)
    arcs = _obligation_arcs(snapshot, intent_id)
    component = _component_arcs(arcs, {node for share_id in share_ids for node in (
        snapshot.shares[share_id]["debtor_wallet_id"], snapshot.shares[share_id]["creditor_wallet_id"],
    )})
    cycles = _cycles(component, {arc["key"]: arc["capacity"] for arc in component}, complete=False)
    if not cycles:
        raise CoverageError("no_offset_available")
    return _finish(snapshot, "offset", _lines_from_cycles(snapshot, cycles), [], cycles, intent_id=intent_id)


@record_errors("invalid_plan")
def validate_plan(snapshot, plan, *, historical=False):
    body = {key: value for key, value in plan.items() if key not in {"id", "plan_hash"}}
    if plan.get("policy_version") != POLICY_VERSION or fingerprint(body) != plan.get("plan_hash"):
        raise CoverageError("plan_changed")
    if plan.get("mode") not in {"direct", "group", "offset"} or not plan.get("allocation_lines"):
        raise CoverageError("invalid_plan")
    line_totals, vector, offsets = {}, {}, {}
    expected_kind = {"direct": {"direct"}, "group": {"group", "approved_offset"}, "offset": {"approved_offset"}}[plan["mode"]]
    for line in plan["allocation_lines"]:
        row = snapshot.shares.get(line["share_id"])
        amount = whole_units(line["amount"])
        if (row is None or row["revision_id"] != line["revision_id"] or line["kind"] not in expected_kind
                or row["debtor_wallet_id"] == row["creditor_wallet_id"]
                or (line["debtor_wallet_id"], line["creditor_wallet_id"]) != (row["debtor_wallet_id"], row["creditor_wallet_id"])):
            raise CoverageError("share_revision_changed")
        key = (row["id"], line["kind"])
        line_totals[key] = line_totals.get(key, 0) + amount
        add_vector(vector, row["debtor_wallet_id"], row["creditor_wallet_id"], amount)
        if line["kind"] == "approved_offset":
            add_vector(offsets, row["debtor_wallet_id"], row["creditor_wallet_id"], amount)
    for share_id in {key[0] for key in line_totals}:
        allocated = sum(value for key, value in line_totals.items() if key[0] == share_id)
        available = snapshot.remaining(share_id) if historical else snapshot.available(share_id, intent_id=plan.get("reservation_intent_id"))
        if allocated > available:
            raise CoverageError("already_covered_or_reserved")
    cash, legs, pairs = {}, {}, set()
    for leg in plan["cash_legs"]:
        if leg["id"] in legs or leg["from_member_id"] == leg["to_member_id"]:
            raise CoverageError("invalid_cash_leg")
        amount = whole_units(leg["amount"])
        add_vector(cash, leg["from_member_id"], leg["to_member_id"], amount)
        legs[leg["id"]] = leg
        pairs.add((leg["from_member_id"], leg["to_member_id"]))
    if any(offsets.values()) or {k: v for k, v in vector.items() if v} != {k: v for k, v in cash.items() if v}:
        raise CoverageError("nonconserving_allocation")
    if (plan["mode"] == "offset" and legs) or (plan["mode"] == "direct" and len(pairs) != 1):
        raise CoverageError("invalid_cash_leg")
    witnessed_lines, witnessed_cash = {}, {}
    for cycle in plan["cycles"]:
        if len(cycle["edges"]) < 2 or not any(edge["kind"] == "obligation" for edge in cycle["edges"]):
            raise CoverageError("invalid_explanation")
        amount, start, previous = whole_units(cycle["amount"]), None, None
        has_cash = False
        if cycle["kind"] not in expected_kind:
            raise CoverageError("invalid_explanation")
        for edge in cycle["edges"]:
            if edge["kind"] == "obligation":
                row = snapshot.shares.get(edge["id"])
                if row is None:
                    raise CoverageError("invalid_explanation")
                u, v = row["debtor_wallet_id"], row["creditor_wallet_id"]
                key = (edge["id"], cycle["kind"])
                witnessed_lines[key] = witnessed_lines.get(key, 0) + amount
            elif edge["kind"] == "cash" and edge["id"] in legs:
                leg = legs[edge["id"]]
                u, v = leg["to_member_id"], leg["from_member_id"]
                witnessed_cash[edge["id"]] = witnessed_cash.get(edge["id"], 0) + amount
                has_cash = True
            else:
                raise CoverageError("invalid_explanation")
            start = start or u
            if previous is not None and previous != u:
                raise CoverageError("invalid_explanation")
            previous = v
        if previous != start or (cycle["kind"] == "approved_offset") == has_cash:
            raise CoverageError("invalid_explanation")
    if witnessed_lines != line_totals or witnessed_cash != {key: to_scaled(leg["amount"]) for key, leg in legs.items()}:
        raise CoverageError("invalid_explanation")
    people, requires_override = _requirements(snapshot, plan["allocation_lines"], plan["mode"])
    if people != plan["required_person_ids"] or (not historical and requires_override != plan["requires_admin_override"]):
        raise CoverageError("invalid_approvers")


def cash_uses_for_plan(snapshot, plan, source_ids):
    return [{"leg_id": leg["id"], "source_id": source_ids[leg["id"]], "amount": leg["amount"],
             "source_fingerprint": snapshot.sources[source_ids[leg["id"]]]["fingerprint"]}
            for leg in plan["cash_legs"]]


@record_errors("invalid_cash_use")
def validate_cash_uses(snapshot, plan, uses):
    legs = {leg["id"]: leg for leg in plan["cash_legs"]}
    used_legs, amounts = set(), {}
    for use in uses:
        leg = legs.get(use["leg_id"])
        source = snapshot.sources.get(use["source_id"])
        if (leg is None or source is None or use["leg_id"] in used_legs
                or source["fingerprint"] != use["source_fingerprint"]
                or source["currency"] != snapshot.ledger.trip.get("currency", "INR")
                or use["amount"] != leg["amount"]
                or (source["from_member_id"], source["to_member_id"]) != (leg["from_member_id"], leg["to_member_id"])):
            raise CoverageError("cash_source_changed")
        used_legs.add(use["leg_id"])
        amounts[source["id"]] = amounts.get(source["id"], 0) + whole_units(use["amount"])
    if used_legs != set(legs):
        raise CoverageError("receipt_pending")
    for source_id, amount in amounts.items():
        if amount + snapshot.claimed.get(source_id, 0) > to_scaled(snapshot.sources[source_id]["amount"]):
            raise CoverageError("cash_source_exhausted")


@record_errors("invalid_approval_evidence")
def validate_allocation_bundle(snapshot, plan, uses, approvals, actors):
    """Actors are freshly loaded server user documents, never client-supplied role claims."""
    from utils.permissions import can_record_payment, role_of
    validate_plan(snapshot, plan)
    validate_cash_uses(snapshot, plan, uses)
    accounts = _accounts(snapshot.ledger.trip)
    bound = [approval for approval in approvals if approval.get("plan_hash") == plan["plan_hash"]]
    def admin(approval):
        actor = actors.get(approval.get("actor_user_id"))
        return _current_access(snapshot.ledger.trip, actor) and role_of(snapshot.ledger.trip, actor) in {"owner", "admin", "super_admin"}
    for leg in plan["cash_legs"]:
        if not any(approval.get("scope") == "receipt" and approval.get("leg_id") == leg["id"]
                   and approval.get("action") == "confirmed"
                   and _current_access(snapshot.ledger.trip, actors.get(approval.get("actor_user_id")))
                   and can_record_payment(snapshot.ledger.trip, leg["to_member_id"], actors.get(approval.get("actor_user_id")))
                   for approval in bound):
            raise CoverageError("receipt_pending")
    override = any(approval.get("scope") == "bundle" and approval.get("action") == "admin_override"
                   and str(approval.get("reason") or "").strip() and admin(approval) for approval in bound)
    if plan["mode"] != "direct" and not override:
        if plan["requires_admin_override"] or any(not any(
            approval.get("scope") == "consent" and approval.get("person_id") == person
            and approval.get("action") == "approved" and accounts.get(person)
            and approval.get("actor_user_id") == accounts[person]
            and _current_access(snapshot.ledger.trip, actors.get(approval.get("actor_user_id")))
            for approval in bound) for person in plan["required_person_ids"]):
            raise CoverageError("allocation_consent_pending")
    return {"plan": deepcopy(plan), "cash_uses": deepcopy(uses),
            "approval_evidence": deepcopy(bound), "status": "applied", "policy_version": POLICY_VERSION}
