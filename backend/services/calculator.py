def resolve_weights(split_ids: list, base_weights: dict, snapshots: dict = None) -> dict:
    """Effective per-member human-count weights for one expense.

    split_ids: member ids participating in the split.
    base_weights: member_id -> base human count (individual=1, family=size).
    snapshots: optional per-transaction overrides (partial family / Step 8 snapshots).

    A snapshot override wins; otherwise the member's base weight; unknown/stale ids
    default to 1 (matches the previous inline wt() behavior).
    """
    snapshots = snapshots or {}
    out = {}
    for sid in split_ids:
        if sid in snapshots:
            out[sid] = int(snapshots[sid])
        else:
            out[sid] = base_weights.get(sid, 1)
    return out


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
    chosen = [mid for mid in roster if mid in set(participant_ids or [])]
    if not chosen:
        chosen = roster
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
