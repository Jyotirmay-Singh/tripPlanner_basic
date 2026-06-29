def _chosen_participants(participant_ids: list, roster_ids: list) -> list:
    """The family members who actually took part — `participant_ids` ∩ roster (in roster order),
    falling back to the FULL roster when that intersection is empty (no recorded participants, or
    every recorded one was since removed). Single source of truth for "who is in"; both
    ``involved_count`` (the PER_CAPITA share-sizing weight) and ``allocate_within_family`` (the
    intra-family divisor) read it, so the count used to SIZE a family's share and the count used to
    DIVIDE it are provably identical.
    """
    roster = list(dict.fromkeys(roster_ids))  # de-dupe, preserve order
    if not roster:
        return []
    chosen = [mid for mid in roster if mid in set(participant_ids or [])]
    return chosen if chosen else roster


def involved_count(participant_ids: list, roster_ids: list) -> int:
    """Number of involved family members (CLAUDE.md §5-A "involved humans") — exactly the count
    ``allocate_within_family`` divides by. Empty roster -> 0 (caller falls back to the base weight).
    """
    return len(_chosen_participants(participant_ids, roster_ids))


def resolve_weights(split_ids: list, base_weights: dict, snapshots: dict = None,
                    family_participants: dict = None, rosters: dict = None) -> dict:
    """Effective per-member human-count weights for one PER_CAPITA expense.

    split_ids: member ids participating in the split.
    base_weights: member_id -> base human count (individual=1, family=size).
    snapshots: optional per-transaction weight overrides (the `split_family_count` concept / Step 8
        size-freeze pins).
    family_participants: optional {family_id -> [participating member ids]} (CLAUDE.md §5-A). When a
        family is restricted to a proper subset of its roster, the family counts as its INVOLVED
        member count, not its full size — so the same involved count both sizes the family's share
        (here) and divides it among members (``allocate_within_family``).
    rosters: optional {family_id -> [roster member ids]}, needed to resolve the involved count.

    Precedence per id: an explicit ``snapshots`` override wins; else, for a family with a recorded
    participant restriction, its ``involved_count``; else the member's base weight; unknown/stale ids
    default to 1 (matches the previous inline wt() behavior). With ``family_participants``/``rosters``
    omitted (the default) the result is byte-identical to the original snapshot-or-base behavior, so
    callers that don't pass them (and direct unit tests) are unaffected.
    """
    snapshots = snapshots or {}
    family_participants = family_participants or {}
    rosters = rosters or {}
    out = {}
    for sid in split_ids:
        if sid in snapshots:
            out[sid] = int(snapshots[sid])
        elif sid in family_participants and sid in rosters:
            out[sid] = involved_count(family_participants[sid], rosters[sid])
        else:
            out[sid] = base_weights.get(sid, 1)
    return out


def distribute_chronological(events: list, roster: list) -> dict:
    """Replay a family's expenses and settlements in CHRONOLOGICAL order to get each member's
    outstanding position. DISPLAY-only — the family's ledger net is never changed, only its internal
    division; this is the per-member view of "what's left UNSETTLED".

    events: a chronologically-ordered list of ``(kind, value, chosen)``:
      * ``("exp", net_e, chosen_ids)`` — the family's net for that expense
        (``(amount if the family paid else 0) − its share``) split EVENLY among only the members who
        took part (``chosen_ids``); a member NOT in ``chosen_ids`` gets exactly 0 from that expense.
      * ``("settle", delta, None)`` — a non-pending settlement's effect on the family net (same sign
        as ``_compute_balances``: ``+amount`` when the family is the payer, ``−amount`` when it
        receives). It SCALES the running positions proportionally toward 0, so a FULL settlement
        zeroes every member (settled money disappears) and only later expenses remain; a partial
        settlement shrinks each open position proportionally. When the running positions already net
        to 0 the delta is split evenly across the roster (rare).

    roster: the family's member ids (result keys + the even-split fallback divisor).

    Returns RAW (unrounded) positions over ``roster`` summing to the family's post-settlement net
    within float epsilon; the caller apportions to an exact 2dp sum. Never ÷0. Empty ``roster`` -> {}.
    """
    pos = {mid: 0.0 for mid in roster}
    if not roster:
        return pos
    for kind, value, chosen in events:
        if kind == "exp":
            chosen = [m for m in (chosen or []) if m in pos]
            if not chosen or not value:
                continue
            share = value / len(chosen)
            for mid in chosen:
                pos[mid] += share
        else:  # "settle": scale open positions toward 0 by the settlement delta
            if not value:
                continue
            total = sum(pos.values())
            if abs(total) > 1e-9:
                scale = (total + value) / total
                for mid in pos:
                    pos[mid] *= scale
            else:
                per = value / len(roster)
                for mid in roster:
                    pos[mid] += per
    return pos


def split_per_capita(amount: float, weights: dict) -> dict:
    """PER_CAPITA (Section 5A): divide `amount` across total humans.

    H = sum(weights); per_human = amount / H; each member owes per_human * weight.
    No intermediate rounding (sum(shares) == amount within float epsilon); the single
    final round() of net in _compute_balances stays the only rounding.
    Empty weights or H <= 0 -> {} (caller skips the expense).
    """
    total = sum(weights.values())
    if total <= 0:
        return {}
    per_human = amount / total
    return {mid: per_human * w for mid, w in weights.items()}


def split_per_family(amount: float, member_ids: list) -> dict:
    """PER_FAMILY (Section 5B): divide `amount` equally across entities.

    member_ids: selected entities (each family OR individual id is ONE entity).
    E = number of distinct entities; each owes amount / E, FLAT, regardless of
    family size. Family size and weight_snapshots are intentionally ignored here
    (the defining difference from split_per_capita). No intermediate rounding
    (sum(shares) == amount within float epsilon); the single final round() of net
    in _compute_balances stays the only rounding.
    Empty member_ids or E <= 0 -> {} (caller skips the expense).
    """
    ids = list(dict.fromkeys(member_ids))  # de-dupe, preserve order
    entity_count = len(ids)
    if entity_count <= 0:
        return {}
    per_entity = amount / entity_count
    return {mid: per_entity for mid in ids}


def allocate_within_family(family_share: float, participant_ids: list, all_member_ids: list) -> dict:
    """Intra-family per-member division (Model A) — DISPLAY-only, ledger-neutral.

    Splits ONE family's already-computed `family_share` equally among the members who took part in
    that expense; non-participants get exactly 0.0; the excluded portion is absorbed by the
    participating members of the SAME family. The family's total `family_share` is never changed —
    only its internal division — so the trip headcount, the ledger net, and every other entity stay
    untouched.

    participant_ids: the member ids that took part. None/empty, or a list that doesn't intersect the
    current roster, means "everyone participates" (exact back-compat / robust to removed members).
    all_member_ids: the family's current roster member ids.

    Returns {member_id: share} over `all_member_ids`. No intermediate rounding
    (sum(shares) == family_share within float epsilon); rounding happens once at the display layer.
    Empty roster -> {} (caller renders nothing).
    """
    roster = list(dict.fromkeys(all_member_ids))  # de-dupe, preserve order
    if not roster:
        return {}
    # Restrict to participants that still exist in the roster; fall back to "all" when the recorded
    # participants are absent/empty or none survive (e.g. every recorded participant was removed).
    # Shared with ``involved_count`` so the divisor here equals the share-sizing weight in
    # ``resolve_weights`` (the count that sizes a family's PER_CAPITA share == the count that divides
    # it among members).
    chosen = _chosen_participants(participant_ids, roster)
    per = family_share / len(chosen)
    chosen_set = set(chosen)
    return {mid: (per if mid in chosen_set else 0.0) for mid in roster}


def minimize_transfers(net: dict) -> list:
    """Greedy minimum-transaction settlement.

    net: member_id -> rounded net balance (positive = creditor, negative = debtor).
    Returns transfers: [{"from_member_id", "to_member_id", "amount"}], amount rounded to 2dp.
    """
    debtors = sorted([(mid, v) for mid, v in net.items() if v < -0.01], key=lambda x: x[1])
    creditors = sorted([(mid, v) for mid, v in net.items() if v > 0.01], key=lambda x: -x[1])
    transfers = []
    i = j = 0
    d = list(debtors); c = list(creditors)
    while i < len(d) and j < len(c):
        owe = -d[i][1]
        receive = c[j][1]
        pay = min(owe, receive)
        if pay > 0.01:
            transfers.append({"from_member_id": d[i][0], "to_member_id": c[j][0],
                              "amount": round(pay, 2)})
        d[i] = (d[i][0], d[i][1] + pay)
        c[j] = (c[j][0], c[j][1] - pay)
        if abs(d[i][1]) < 0.01:
            i += 1
        if abs(c[j][1]) < 0.01:
            j += 1
    return transfers
