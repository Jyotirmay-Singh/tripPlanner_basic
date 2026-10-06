"""Reviewed roster changes preserve financial identities and frozen historical allocations."""
from copy import deepcopy

from services.coverage_support import CoverageError, stable_id
from services.expense_coverage import build_coverage_snapshot
from services.financial_ledger import versioned_revision
from services.settlement_engine import to_scaled
from utils.email_rules import assert_gmail, normalize_email


def people(members):
    result = {}
    for member in members:
        if member.get("kind") == "family":
            arrays = [member.get(key, []) for key in (
                "family_member_ids", "family_members", "family_member_emails", "family_member_user_ids")]
            if not arrays[0] or len({len(value) for value in arrays}) != 1:
                raise CoverageError("invalid_family_identity")
            entries = zip(*arrays)
        else:
            entries = [(member["id"], member["name"], member.get("email"), member.get("user_id"))]
        for pid, name, email, uid in entries:
            if not pid or pid in result:
                raise CoverageError("duplicate_person_identity")
            result[pid] = {"wallet_id": member["id"], "name": name, "email": email, "user_id": uid}
    return result


def validate_roster(trip, members):
    identities = people(members)
    users, emails = set(), set()
    if len({m["id"] for m in members}) != len(members):
        raise CoverageError("duplicate_wallet_identity")
    for person in identities.values():
        email = normalize_email(person["email"])
        if email:
            assert_gmail(email)
            if email in emails:
                raise CoverageError("duplicate_person_email")
            emails.add(email)
        uid = person["user_id"]
        if uid:
            if uid in users:
                raise CoverageError("duplicate_person_account")
            users.add(uid)
    if trip.get("owner_id") not in users:
        raise CoverageError("owner_identity_required")
    return identities


def removal_blockers(ledger, removed_people, removed_wallets):
    snapshot = build_coverage_snapshot(ledger, infer_history=False)
    affected = {row["id"] for row in snapshot.shares.values()
                if row["person_id"] in removed_people or row["wallet_id"] in removed_wallets
                or row["creditor_wallet_id"] in removed_wallets}
    if any(snapshot.remaining(sid) or snapshot.shares[sid]["reservations"] for sid in affected):
        raise CoverageError("financial_departure_blocked")
    wallets = set(removed_wallets) | {row["wallet_id"] for row in snapshot.shares.values()
                                    if row["person_id"] in removed_people}
    if any(to_scaled(row["amount"]) > snapshot.claimed.get(sid, 0)
           and {row["from_member_id"], row["to_member_id"]} & wallets
           for sid, row in snapshot.sources.items()):
        raise CoverageError("financial_credit_departure_blocked")
    if any(set(case["share_ids"]) & affected for case in snapshot.review_cases):
        raise CoverageError("financial_review_departure_blocked")
    if any(not case.get("evidence", {}).get("share_ids") or
           set(case["evidence"]["share_ids"]).intersection(affected) for case in ledger.reconciliation_cases):
        raise CoverageError("financial_review_departure_blocked")
    for intent in ledger.intents:
        if intent.get("status") in {"applied", "reversed", "rejected", "canceled", "expired"}:
            continue
        if (any(line.get("share_id") in affected for line in intent.get("plan", {}).get("allocation_lines", []))
                or any({leg.get("from_member_id"), leg.get("to_member_id")} & wallets
                       or {leg.get("actual_payer_person_id"), leg.get("actual_receiver_person_id")} & set(removed_people)
                       for leg in intent.get("cash_legs", []))):
            raise CoverageError("financial_report_departure_blocked")
    for attempt in ledger.attempts:
        from services.payment_attempts import has_sent_evidence, MEMBER_BLOCKING_PAYMENT_ATTEMPT_STATUSES
        if (attempt.get("status") in {"initiated", "awaiting_confirmation", "needs_review"} or
                (has_sent_evidence(attempt) and attempt.get("status") not in
                 {"settled_recipient_confirmed", "voided", "canceled", "rejected", "resolved_not_sent"})) and (
                {attempt.get("from_member_id"), attempt.get("to_member_id")} & wallets):
            raise CoverageError("financial_report_departure_blocked")


async def plan_roster_change(trip, ledger, body, operation_id, at, *, database=None, session=None):
    members = deepcopy(trip["members"])
    target = next((row for row in members if row["id"] == body.target_id), None)
    old_people = people(members)
    expenses, revisions = [], []
    if body.operation == "add_member":
        from models.member import MemberIn
        parsed = MemberIn(**body.changes)
        if set(body.changes) - set(MemberIn.model_fields):
            raise CoverageError("invalid_correction_fields")
        target = {"id": stable_id(operation_id, "wallet"), "name": parsed.name, "kind": parsed.kind,
                  "email": normalize_email(parsed.email) if parsed.kind == "individual" else None,
                  "user_id": None, "family_members": parsed.family_members if parsed.kind == "family" else [],
                  "family_member_ids": [], "family_member_emails": [], "family_member_user_ids": []}
        for index, name in enumerate(target["family_members"]):
            target["family_member_ids"].append(stable_id(operation_id, "person", index))
            target["family_member_emails"].append(normalize_email((parsed.family_member_emails or [])[index])
                if index < len(parsed.family_member_emails or []) else None)
            target["family_member_user_ids"].append(None)
        members.append(target)
    elif body.operation == "reassign_family":
        if set(body.changes) - {"person_id", "destination_wallet_id"}:
            raise CoverageError("invalid_correction_fields")
        pid, dest_id = body.changes.get("person_id"), body.changes.get("destination_wallet_id")
        identity = old_people.get(pid)
        dest = next((row for row in members if row["id"] == dest_id and row.get("kind") == "family"), None)
        if not target or not identity or identity["wallet_id"] != target["id"] or not dest or dest is target:
            raise CoverageError("invalid_family_reassignment")
        if target["kind"] == "family":
            index = target["family_member_ids"].index(pid)
            if len(target["family_member_ids"]) == 1:
                raise CoverageError("nonempty_family_required")
            for key in ("family_members", "family_member_ids", "family_member_emails", "family_member_user_ids"):
                target[key].pop(index)
        else:
            members.remove(target)
        for key, value in (("family_members", identity["name"]), ("family_member_ids", pid),
                           ("family_member_emails", identity["email"]), ("family_member_user_ids", identity["user_id"])):
            dest[key].append(value)
    elif body.operation == "reallocate_history":
        if set(body.changes) - {"expense_ids"}:
            raise CoverageError("invalid_correction_fields")
        selected = set(body.changes.get("expense_ids") or [])
        if not selected or selected - {row["id"] for row in ledger.expenses}:
            raise CoverageError("invalid_expense_selection")
        for expense in ledger.expenses:
            if expense["id"] not in selected:
                continue
            row = {key: value for key, value in deepcopy(expense).items() if not key.startswith("_")}
            revision = versioned_revision(row, members, trip["id"],
                max([r.get("revision_number", 0) for r in ledger.revisions if r["expense_id"] == row["id"]] + [0]) + 1,
                row.get("active_revision_id"), operation_id, at)
            row["active_revision_id"] = revision["id"]
            expenses.append(row)
            revisions.append(revision)
    elif not target:
        raise CoverageError("member_not_found")
    elif body.operation == "link_person":
        if set(body.changes) not in ({"person_id", "user_id"}, {"person_id", "email"}):
            raise CoverageError("invalid_correction_fields")
        pid, uid = body.changes["person_id"], body.changes.get("user_id")
        if pid not in old_people or old_people[pid]["wallet_id"] != target["id"]:
            raise CoverageError("person_changed")
        if database is None:
            raise CoverageError("account_context_required")
        lookup = {"id": uid} if uid else {"email": normalize_email(body.changes.get("email"))}
        supplied = uid or body.changes.get("email")
        if body.changes.get("email"):
            assert_gmail(body.changes["email"])
        account = await database.users.find_one(lookup, {"_id": 0, "id": 1, "email": 1}, session=session) if supplied else None
        if supplied and not account:
            raise CoverageError("recipient_unavailable")
        uid = account["id"] if account else None
        if old_people[pid]["user_id"] == trip["owner_id"] and uid != trip["owner_id"]:
            raise CoverageError("owner_identity_required")
        if target["kind"] == "family":
            index = target["family_member_ids"].index(pid)
            target["family_member_user_ids"][index] = uid
            target["family_member_emails"][index] = account["email"] if account else None
        else:
            target["user_id"], target["email"] = uid, account["email"] if account else None
    elif body.operation == "remove_member":
        if body.changes:
            raise CoverageError("invalid_correction_fields")
        members.remove(target)
    elif body.operation == "update_member":
        from models.member import MemberUpdate
        if set(body.changes) - set(MemberUpdate.model_fields):
            raise CoverageError("invalid_correction_fields")
        parsed = MemberUpdate(**body.changes)
        if parsed.reweight_past and "reweight_past" in body.changes:
            raise CoverageError("explicit_historical_correction_required")
        if parsed.kind is not None and parsed.kind != target["kind"]:
            raise CoverageError("use_family_reassignment")
        if parsed.name is not None:
            target["name"] = parsed.name
        if target["kind"] == "family":
            names = parsed.family_members if parsed.family_members is not None else target["family_members"]
            supplied = parsed.family_member_ids
            if supplied is None:
                supplied = target["family_member_ids"][:len(names)] + [None] * max(0, len(names) - len(target["family_member_ids"]))
            if len(supplied) != len(names) or any(pid and pid not in target["family_member_ids"] for pid in supplied):
                raise CoverageError("invalid_family_identity")
            new_ids = [pid or stable_id(operation_id, "person", index) for index, pid in enumerate(supplied)]
            emails, users = {}, {}
            for pid, identity in old_people.items():
                if identity["wallet_id"] == target["id"]:
                    emails[pid], users[pid] = identity["email"], identity["user_id"]
            target.update(family_members=names, family_member_ids=new_ids,
                family_member_emails=[normalize_email(parsed.family_member_emails[index])
                    if parsed.family_member_emails is not None and index < len(parsed.family_member_emails)
                    else emails.get(pid) for index, pid in enumerate(new_ids)],
                family_member_user_ids=[users.get(pid) for pid in new_ids], email=None, user_id=None)
            target["family_member_user_ids"] = [uid if normalize_email(emails.get(pid)) == normalize_email(target["family_member_emails"][index]) else None
                for index, (pid, uid) in enumerate(zip(new_ids, target["family_member_user_ids"]))]
        elif parsed.email is not None:
            email = normalize_email(parsed.email)
            if email != normalize_email(target.get("email")):
                target["user_id"] = None
            target["email"] = email
    else:
        raise CoverageError("unsupported_roster_correction")
    new_people = validate_roster(trip, members)
    removed_people = set(old_people) - set(new_people)
    removed_wallets = {row["id"] for row in trip["members"]} - {row["id"] for row in members}
    # Reassignment archives the old wallet and keeps its obligations; removal requires settlement.
    if body.operation != "reassign_family":
        removal_blockers(ledger, removed_people, removed_wallets)
    return members, expenses, revisions


async def apply_roster_change(trip, members, correction_id, session, database):
    validate_roster(trip, members)
    for person in people(members).values():
        if person["user_id"]:
            account = await database.users.find_one({"id": person["user_id"]}, {"_id": 0, "id": 1, "email": 1}, session=session)
            if not account or normalize_email(account["email"]) != normalize_email(person["email"]):
                raise CoverageError("person_account_changed")
            await database.users.update_one({"id": account["id"]}, {"$inc": {"settlement_action_version": 1}}, session=session)
    at = __import__("utils.common", fromlist=["now_utc"]).now_utc().isoformat()
    for member in trip["members"]:
        await database.ledger_identity_snapshots.insert_one({"id": stable_id(correction_id, member["id"]),
            "trip_id": trip["id"], "member_id": member["id"], "member_snapshot": deepcopy(member),
            "correction_id": correction_id, "created_at": at}, session=session)
    old_users = {person["user_id"] for person in people(trip["members"]).values()} - {None}
    new_users = {person["user_id"] for person in people(members).values()} - {None}
    vanished = old_users - new_users
    await database.trips.update_one({"id": trip["id"]}, {"$set": {"members": deepcopy(members),
        "user_ids": sorted((set(trip.get("user_ids", [])) - vanished) | new_users),
        "admin_ids": [uid for uid in trip.get("admin_ids", []) if uid not in vanished]},
        "$inc": {"membership_revision": 1}}, session=session)
    await database.trip_mobile_claims.delete_many({"trip_id": trip["id"], "user_id": {"$in": sorted(vanished)}}, session=session)
    # Move existing claims with their current account, never with a historical account snapshot.
    identities = people(members)
    for pid, person in identities.items():
        if person["user_id"]:
            await database.trip_mobile_claims.update_one({"trip_id": trip["id"], "user_id": person["user_id"]},
                {"$set": {"member_id": person["wallet_id"], "family_member_id": pid if pid != person["wallet_id"] else None,
                          "member_name": person["name"]}}, session=session)


def restore_financial_roster(historical, current):
    """Restore identities/assignments without restoring a removed account's access or email claim."""
    result = deepcopy(historical)
    live = people(current)
    for member in result:
        if member["kind"] == "family":
            member["user_id"] = None
            member["family_member_user_ids"] = [live.get(pid, {}).get("user_id") for pid in member["family_member_ids"]]
            member["family_member_emails"] = [live.get(pid, {}).get("email") for pid in member["family_member_ids"]]
        else:
            member["user_id"] = live.get(member["id"], {}).get("user_id")
            member["email"] = live.get(member["id"], {}).get("email")
    return result
