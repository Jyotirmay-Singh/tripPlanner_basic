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
