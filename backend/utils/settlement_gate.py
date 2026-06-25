"""Settlement gate for member / family removal.

PURE helpers that read an already-computed ``_compute_balances`` result (the authoritative ledger
from ``utils.balances``) and answer "is this entity / family member fully settled?". They never
touch the database and never change any balance — removal is *gated* by balances, it never alters
them — so they unit-test exactly like ``services/calculator.py``.

"Fully settled" == the net balance rounds to 0.00. ``_compute_balances`` already rounds ``net`` and
every per-member breakdown row to 2dp, so ``abs(x) < SETTLED_EPS`` is equivalent to "rounds to 0.00"
while tolerating float dust.

Shapes consumed (produced by ``utils.balances._compute_balances``):
  balances["net"]:        {member_id: float}
  balances["per_person"]: [{"member_id", ..., "members": [{"id", "name", "net"}, ...]}, ...]
"""

SETTLED_EPS = 0.005  # net is rounded to 2dp upstream; |x| < 0.005 <=> rounds to 0.00


def is_settled(net_value: float) -> bool:
    """True iff ``net_value`` rounds to 0.00 (neither a debtor nor a creditor)."""
    return abs(net_value) < SETTLED_EPS


def entity_net(balances: dict, member_id: str) -> float:
    """The ledger net for an entity (individual or family). Unknown id -> 0.0."""
    return balances.get("net", {}).get(member_id, 0.0)


def family_rows(balances: dict, family_id: str) -> list:
    """The display-only per-member breakdown rows ([{"id","name","net"}]) for a family, or []."""
    for pp in balances.get("per_person", []):
        if pp.get("member_id") == family_id:
            return pp.get("members") or []
    return []


def family_member_net(balances: dict, family_id: str, fm_id: str):
    """Net for one family member from the breakdown, or ``None`` if the family/member is absent."""
    for row in family_rows(balances, family_id):
        if row.get("id") == fm_id:
            return row.get("net", 0.0)
    return None


def unsettled_family_members(balances: dict, family_id: str) -> list:
    """Breakdown rows for a family whose net does NOT round to 0.00 (the blockers)."""
    return [row for row in family_rows(balances, family_id) if not is_settled(row.get("net", 0.0))]
