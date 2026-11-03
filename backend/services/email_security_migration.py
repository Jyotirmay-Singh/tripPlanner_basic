"""Idempotent migration: historical flags alone are not proof of email ownership."""


async def migrate_email_security(db) -> None:
    await db.users.update_many(
        {"email_security_migration": {"$ne": 1}},
        [{"$set": {
            "email_verified": {"$and": [
                {"$eq": [{"$ifNull": ["$email_verified_for", None]}, "$email"]},
                {"$eq": [{"$type": "$email_verified_at"}, "date"]},
                {"$in": ["$email_verification_method", ["email_link", "google"]]},
            ]},
            "session_version": {"$ifNull": ["$session_version", 0]},
            "email_security_migration": 1,
        }}],
    )
    # Old links were longer-lived and not email-bound. They cannot be safely upgraded.
    await db.auth_tokens.update_many(
        {"$or": [{"email": {"$exists": False}}, {"version": {"$exists": False}}], "used": False},
        {"$set": {"used": True}},
    )
