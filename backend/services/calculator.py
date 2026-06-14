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
