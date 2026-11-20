"""Authenticated community controls and the application-admin moderation queue."""

import hashlib

from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo.errors import DuplicateKeyError

from database import db
from models.community import (
    CommunityReport, GuardianCode, GuardianConsent, GuardianControls, GuardianRequest,
    GuardianVerification, ReportResolution, TermsAcceptance, AgeCorrection,
)
from services.community_safety import (
    TERMS_VERSION, community_permissions, guardian_child_for_code,
    guardian_code_hash, request_guardian,
)
from services.chat_realtime import chat_connections
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, require_super_admin, _trip_or_404, _expense_or_404
from utils.email_rules import assert_gmail, email_is_verified, normalize_email
from services.community_safety import require_community_access, terms_current
from services.admin_audit import record_admin_action


router = APIRouter(tags=["community-safety"])


def _public_case(case: dict) -> dict:
    return {key: value for key, value in case.items() if key != "_id"}


async def _current_user(user_id: str) -> dict:
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(401, "User not found")
    return user


@router.get("/auth/me/safety")
async def safety_settings(user=Depends(get_current_user)):
    state = await community_permissions(db, user)
    state["blocks"] = await db.community_blocks.find(
        {"user_id": user["id"]}, {"_id": 0, "blocked_user_id": 1, "name": 1},
    ).to_list(None)
    children = await db.users.find(
        {"guardian_consent.guardian_user_id": user["id"]},
        {"_id": 0, "id": 1, "name": 1, "guardian_consent": 1},
    ).to_list(None)
    state["children"] = [{
        "id": child["id"], "name": child["name"],
        "status": child["guardian_consent"]["status"],
        **{field: child["guardian_consent"].get(field, False) for field in (
            "chat_enabled", "receipts_enabled", "contacts_enabled",
        )},
    } for child in children]
    return state


@router.post("/auth/me/safety/terms")
async def accept_terms(body: TermsAcceptance, user=Depends(get_current_user)):
    if body.version != TERMS_VERSION:
        raise HTTPException(409, "The community terms changed. Refresh and review them again.")
    existing_age = user.get("community_age_band")
    if existing_age and existing_age != body.age_band:
        raise HTTPException(409, "Contact support to correct your age group.")
    result = await db.users.update_one(
        {"id": user["id"], "community_age_band": existing_age},
        {"$set": {
            "community_age_band": body.age_band,
            "community_terms_version": TERMS_VERSION,
            "community_terms_accepted_at": now_utc(),
        }},
    )
    if not result.matched_count:
        raise HTTPException(409, "Account settings changed. Refresh and try again.")
    return await safety_settings(await _current_user(user["id"]))


@router.post("/auth/me/safety/guardian-request")
async def create_guardian_request(body: GuardianRequest, user=Depends(get_current_user)):
    assert_gmail(str(body.email))
    code = await request_guardian(db, user, str(body.email))
    await chat_connections.revoke_user(user["id"], code=4403)
    return {"code": code, "expires_in_days": 7}


@router.post("/safety/guardian/preview")
async def preview_guardian_request(body: GuardianCode, user=Depends(get_current_user)):
    child = await guardian_child_for_code(db, user, body.code)
    return {"name": child["name"], "age_band": child["community_age_band"]}


@router.post("/safety/guardian/consent")
async def give_guardian_consent(body: GuardianConsent, user=Depends(get_current_user)):
    child = await guardian_child_for_code(db, user, body.code)
    controls = body.model_dump(include={"chat_enabled", "receipts_enabled", "contacts_enabled"})
    existing = child["guardian_consent"]
    if existing.get("status") != "requested":
        if existing.get("guardian_user_id") == user["id"] and all(
            existing.get(key) == value for key, value in controls.items()
        ):
            return {"status": existing["status"]}
        raise HTTPException(409, "This request was already reviewed. Use your guardian controls.")
    result = await db.users.update_one(
        {"id": child["id"], "guardian_consent.token_hash": guardian_code_hash(body.code),
         "guardian_consent.status": "requested"},
        {"$set": {
            "guardian_consent.status": "pending_verification",
            "guardian_consent.guardian_user_id": user["id"],
            "guardian_consent.consented_at": now_utc(),
            "guardian_consent.terms_version": TERMS_VERSION,
            **{f"guardian_consent.{key}": value for key, value in controls.items()},
        }},
    )
    if not result.matched_count:
        raise HTTPException(409, "The guardian request changed. Refresh and try again.")
    return {"status": "pending_verification"}


@router.patch("/safety/children/{child_id}")
async def update_guardian_controls(child_id: str, body: GuardianControls, user=Depends(get_current_user)):
    await require_community_access(db, user, "account")
    if user.get("community_age_band") != "18_plus" or not email_is_verified(user) \
            or user.get("ugc_suspended_at"):
        raise HTTPException(403, "A verified adult account with current terms is required.")
    result = await db.users.update_one(
        {"id": child_id, "guardian_consent.guardian_user_id": user["id"],
         "guardian_consent.guardian_email": normalize_email(user.get("email")),
         "guardian_consent.status": {"$in": ["pending_verification", "approved"]},
         "guardian_consent.terms_version": TERMS_VERSION},
        {"$set": {
            **{f"guardian_consent.{key}": value for key, value in body.model_dump().items()},
            "guardian_consent.updated_at": now_utc(),
        }},
    )
    if not result.matched_count:
        raise HTTPException(404, "Guardian relationship not found")
    await chat_connections.revoke_user(child_id, code=4403)
    return {"ok": True}


@router.delete("/safety/children/{child_id}/consent")
async def withdraw_guardian_consent(child_id: str, user=Depends(get_current_user)):
    # Withdrawal remains available even when the guardian must renew their own terms.
    result = await db.users.update_one(
        {"id": child_id, "guardian_consent.guardian_user_id": user["id"]},
        {"$set": {"guardian_consent.status": "revoked", "guardian_consent.updated_at": now_utc(),
                  "guardian_consent.chat_enabled": False, "guardian_consent.receipts_enabled": False,
                  "guardian_consent.contacts_enabled": False},
         "$unset": {"guardian_consent.token_hash": ""}},
    )
    if not result.matched_count:
        raise HTTPException(404, "Guardian relationship not found")
    await chat_connections.revoke_user(child_id, code=4403)
    return {"ok": True}


@router.get("/admin/safety/guardians")
async def pending_guardians(user=Depends(require_super_admin)):
    rows = await db.users.find(
        {"guardian_consent.status": "pending_verification"},
        {"_id": 0, "id": 1, "name": 1, "guardian_consent.guardian_user_id": 1,
         "guardian_consent.guardian_email": 1},
    ).limit(100).to_list(100)
    return {"items": rows}


@router.post("/admin/safety/age-corrections/{target_id}")
async def correct_age_group(target_id: str, body: AgeCorrection, user=Depends(require_super_admin)):
    target = await db.users.find_one({"id": target_id})
    if not target:
        raise HTTPException(404, "Account not found")
    await db.users.update_one({"id": target_id}, {
        "$set": {"community_age_band": body.age_band, "age_correction": {
            "reviewed_by": user["id"], "reviewed_at": now_utc(),
            "verification_reference": body.verification_reference,
        }},
        "$unset": {"guardian_consent": "", "community_terms_version": "", "community_terms_accepted_at": ""},
    })
    await chat_connections.revoke_user(target_id, code=4403)
    await record_admin_action(user, "safety.age_corrected", resource_type="user", resource_id=target_id,
                              changed_fields=("community_age_band", "guardian_consent", "community_terms_version"))
    return {"ok": True, "terms_review_required": True}


@router.post("/admin/safety/guardians/{child_id}/verify")
async def verify_guardian(child_id: str, body: GuardianVerification, user=Depends(require_super_admin)):
    child = await db.users.find_one({"id": child_id, "guardian_consent.status": "pending_verification"})
    if not child:
        raise HTTPException(404, "Pending guardian review not found")
    consent = child["guardian_consent"]
    guardian = await db.users.find_one({"id": consent.get("guardian_user_id")})
    if not terms_current(child) or consent.get("terms_version") != TERMS_VERSION \
            or not guardian or guardian.get("community_age_band") != "18_plus" \
            or not email_is_verified(guardian) or guardian.get("community_terms_version") != TERMS_VERSION \
            or normalize_email(guardian.get("email")) != consent.get("guardian_email") \
            or guardian.get("ugc_suspended_at"):
        raise HTTPException(409, "The guardian must have a verified adult account and current terms.")
    result = await db.users.update_one(
        {"id": child_id, "guardian_consent.status": "pending_verification",
         "guardian_consent.guardian_user_id": guardian["id"],
         "guardian_consent.token_hash": consent.get("token_hash"),
         "guardian_consent.terms_version": TERMS_VERSION,
         "guardian_consent.guardian_email": normalize_email(guardian.get("email")),
         "community_terms_version": TERMS_VERSION},
        {"$set": {
            "guardian_consent.status": "approved",
            "guardian_consent.verified_by": user["id"],
            "guardian_consent.verified_at": now_utc(),
            "guardian_consent.verification_reference": body.verification_reference,
        }},
    )
    if not result.matched_count:
        raise HTTPException(409, "The guardian request changed. Refresh and try again.")
    await record_admin_action(user, "safety.guardian_verified", resource_type="user", resource_id=child_id,
                              changed_fields=("guardian_consent.status",))
    return {"ok": True}


async def _trip_person(trip_id: str, target_id: str, user: dict) -> dict:
    trip = await _trip_or_404(trip_id, user)
    if target_id not in trip.get("user_ids", []):
        raise HTTPException(404, "Person not found in this group")
    target = await db.users.find_one({"id": target_id}, {"id": 1, "name": 1})
    if not target:
        raise HTTPException(404, "Person not found in this group")
    return target


@router.put("/trips/{trip_id}/safety/blocks/{target_id}")
async def block_person(trip_id: str, target_id: str, user=Depends(get_current_user)):
    if target_id == user["id"]:
        raise HTTPException(422, "Choose another person to block.")
    target = await _trip_person(trip_id, target_id, user)
    await db.community_blocks.update_one(
        {"user_id": user["id"], "blocked_user_id": target_id},
        {"$set": {"name": target.get("name", "Group member")},
         "$setOnInsert": {"created_at": now_utc()}}, upsert=True,
    )
    await chat_connections.notify_users([user["id"], target_id], {"type": "safety.changed"})
    return {"ok": True}


@router.delete("/auth/me/safety/blocks/{target_id}")
async def unblock_person(target_id: str, user=Depends(get_current_user)):
    await db.community_blocks.delete_one({"user_id": user["id"], "blocked_user_id": target_id})
    await chat_connections.notify_users([user["id"], target_id], {"type": "safety.changed"})
    return {"ok": True}


@router.post("/trips/{trip_id}/safety/reports")
async def report_content(trip_id: str, body: CommunityReport, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user)
    request = {"trip_id": trip_id, **body.model_dump(mode="json")}
    query = {"reporter_user_id": user["id"], "client_report_id": str(body.client_report_id)}
    existing = await db.community_reports.find_one(query)
    if existing:
        if existing["request"] != request:
            raise HTTPException(409, "This report identifier was already used for a different report.")
        return {"id": existing["id"], "status": existing["status"]}
    snapshot, revision, legacy_fingerprint, target_user_id = None, None, None, None
    if body.target_type == "message":
        message = await db.chat_messages.find_one({"id": body.target_id, "trip_id": trip_id})
        if not message:
            raise HTTPException(404, "Message not found")
        target_user_id = message.get("sender_user_id")
        snapshot = (message.get("text") or "")[:2000]
    elif body.target_type == "receipt":
        expense = await _expense_or_404(trip_id, body.target_id)
        if not expense.get("receipt_id") and not expense.get("receipt_base64"):
            raise HTTPException(404, "Receipt not found")
        target_user_id = expense.get("created_by")
        revision = expense.get("receipt_id") or "legacy"
        if revision == "legacy":
            legacy_fingerprint = hashlib.sha256(expense["receipt_base64"].encode()).hexdigest()
    else:
        target = await _trip_person(trip_id, body.target_id, user)
        target_user_id = target["id"]
    case = {
        "id": gen_id(), **query, "request": request, "trip_id": trip_id,
        "target_type": body.target_type, "target_id": body.target_id,
        "target_user_id": target_user_id, "receipt_revision": revision,
        "receipt_legacy_fingerprint": legacy_fingerprint,
        "snapshot": snapshot, "reason": body.reason, "details": body.details,
        "status": "open", "created_at": now_utc(),
    }
    try:
        await db.community_reports.insert_one(case)
    except DuplicateKeyError:
        existing = await db.community_reports.find_one(query)
        if not existing:
            raise
        if existing["request"] != request:
            raise HTTPException(409, "This report identifier was already used for a different report.")
        return {"id": existing["id"], "status": existing["status"]}
    return {"id": case["id"], "status": "open"}


@router.get("/admin/safety/reports")
async def list_reports(
    limit: int = Query(default=30, ge=1, le=100), user=Depends(require_super_admin),
):
    rows = await db.community_reports.find({"status": {"$in": ["open", "action_pending"]}}).sort(
        [("created_at", 1), ("id", 1)],
    ).limit(limit).to_list(limit)
    return {"items": [_public_case(row) for row in rows]}


@router.post("/admin/safety/reports/{case_id}/resolve")
async def resolve_report(case_id: str, body: ReportResolution, user=Depends(require_super_admin)):
    case = await db.community_reports.find_one({"id": case_id})
    if not case:
        raise HTTPException(404, "Report not found")
    if case["status"] == "resolved":
        return {"ok": True, "status": "resolved"}
    if body.action == "remove_content" and case["target_type"] == "user":
        raise HTTPException(422, "Choose an account action for a person report.")
    if body.action == "suspend_user" and not case.get("target_user_id"):
        raise HTTPException(409, "The reported account is unavailable.")
    if case["status"] == "open":
        result = await db.community_reports.update_one(
            {"id": case_id, "status": "open"},
            {"$set": {"status": "action_pending", "action": body.action,
                      "resolution_note": body.note, "moderator_user_id": user["id"]}},
        )
        if not result.matched_count:
            raise HTTPException(409, "Another moderator is reviewing this report. Refresh.")
    elif case.get("action") != body.action:
        raise HTTPException(409, "Retry the pending moderation action before choosing another action.")
    if body.action == "remove_content":
        if case["target_type"] == "message":
            from routes.chat import delete_chat_message
            try:
                await delete_chat_message(case["trip_id"], case["target_id"], user)
            except HTTPException as failure:
                if failure.status_code != 404:
                    raise
        else:
            revision = case.get("receipt_revision")
            await db.community_hidden_receipts.update_one(
                {"trip_id": case["trip_id"], "expense_id": case["target_id"], "revision": revision},
                {"$setOnInsert": {"hidden_at": now_utc(), "report_id": case_id}}, upsert=True,
            )
            receipt_query = {"receipt_id": revision} if revision != "legacy" else {"receipt_id": None}
            await db.expenses.update_one(
                {"id": case["target_id"], "trip_id": case["trip_id"], **receipt_query},
                {"$set": {"receipt_hidden_at": now_utc().isoformat()}},
            )
    if body.action == "suspend_user":
        await db.users.update_one(
            {"id": case["target_user_id"]}, {"$set": {"ugc_suspended_at": now_utc()}},
        )
        await chat_connections.revoke_user(case["target_user_id"], code=4403)
    await db.community_reports.update_one(
        {"id": case_id, "status": "action_pending", "action": body.action},
        {"$set": {"status": "resolved", "resolved_at": now_utc()}},
    )
    return {"ok": True, "status": "resolved"}


@router.delete("/admin/safety/suspensions/{target_id}")
async def restore_community_access(target_id: str, user=Depends(require_super_admin)):
    result = await db.users.update_one({"id": target_id}, {"$unset": {"ugc_suspended_at": ""}})
    if not result.matched_count:
        raise HTTPException(404, "Account not found")
    await record_admin_action(user, "safety.suspension_restored", resource_type="user", resource_id=target_id,
                              changed_fields=("ugc_suspended_at",))
    return {"ok": True}
