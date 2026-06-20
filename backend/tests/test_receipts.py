# Step 22: Attaching Bill's Image (GridFS receipt pipeline)
# Upload -> fetch (header + ?token=) -> RBAC -> delete -> legacy base64 fallback.
# Receipts now live in GridFS; the expense carries only a lightweight receipt_id, and the
# expense-list endpoint never returns image bytes (just a has_receipt flag).
import base64
import os
import uuid

import requests  # noqa: F401  (api_client fixture is a requests.Session)

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

# A real (tiny) 1x1 PNG so content-type sniffing and byte round-trips are meaningful.
PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
PNG_DATA_URI = "data:image/png;base64," + base64.b64encode(PNG_1x1).decode()


class TestReceipts:
    """GridFS-backed receipt upload/stream/delete + RBAC + legacy fallback."""

    # ---------- helpers ----------
    def _auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def _create_trip(self, api_client, token, name="TEST_Receipts Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "travel_date": "15-05-26",
            "currency": "USD",
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Second User"):
        email = f"TEST_receipts_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test1234",
            "pin": "5678",
            "name": name,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["access_token"], data["user"]["id"]

    def _join_trip(self, api_client, token, code):
        resp = api_client.post(f"{BASE_URL}/api/trips/join", json={"code": code},
                               headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_expense(self, api_client, token, trip_id, paid_by_member_id, amount=100.0):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": amount,
            "category": "Food",
            "description": "Receipt fixture expense",
            "date": "16-05-26",
            "paid_by_member_id": paid_by_member_id,
            "split_member_ids": [],
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["expense"]

    def _list_expenses(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/expenses",
                              headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _upload(self, api_client, token, trip_id, expense_id,
                data=PNG_1x1, content_type="image/png", filename="receipt.png"):
        # Content-Type: None removes conftest's session-level application/json so requests
        # computes the multipart/form-data boundary itself.
        return api_client.post(
            f"{BASE_URL}/api/trips/{trip_id}/expenses/{expense_id}/receipt",
            files={"file": (filename, data, content_type)},
            headers={"Authorization": f"Bearer {token}", "Content-Type": None},
        )

    # ---------- upload + fetch round-trip ----------
    def test_upload_then_fetch_via_header(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        up = self._upload(api_client, test_user["token"], trip["id"], exp["id"])
        assert up.status_code == 200, up.text
        receipt_id = up.json()["receipt_id"]
        assert receipt_id

        got = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            headers=self._auth(test_user["token"]),
        )
        assert got.status_code == 200, got.text
        assert got.headers.get("content-type", "").startswith("image/png")
        assert got.content == PNG_1x1

    def test_list_strips_blob_and_flags_has_receipt(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        # before upload: no receipt
        before = next(e for e in self._list_expenses(api_client, test_user["token"], trip["id"])
                      if e["id"] == exp["id"])
        assert before["has_receipt"] is False
        assert "receipt_base64" not in before

        self._upload(api_client, test_user["token"], trip["id"], exp["id"])

        after = next(e for e in self._list_expenses(api_client, test_user["token"], trip["id"])
                     if e["id"] == exp["id"])
        assert after["has_receipt"] is True
        assert after.get("receipt_id")          # lightweight reference kept
        assert "receipt_base64" not in after     # image bytes never returned in the list

    def test_fetch_via_token_query_param(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)
        self._upload(api_client, test_user["token"], trip["id"], exp["id"])

        # no Authorization header — auth carried entirely by ?token= (the <Image>/browser path)
        got = requests.get(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            params={"token": test_user["token"]},
        )
        assert got.status_code == 200, got.text
        assert got.content == PNG_1x1

    # ---------- replace semantics ----------
    def test_reupload_replaces_receipt(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        first = self._upload(api_client, test_user["token"], trip["id"], exp["id"]).json()["receipt_id"]
        second = self._upload(api_client, test_user["token"], trip["id"], exp["id"]).json()["receipt_id"]
        assert first != second  # a fresh GridFS file id each time

        after = next(e for e in self._list_expenses(api_client, test_user["token"], trip["id"])
                     if e["id"] == exp["id"])
        assert after["receipt_id"] == second

    # ---------- validation ----------
    def test_reject_non_image_type(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        resp = self._upload(api_client, test_user["token"], trip["id"], exp["id"],
                            data=b"%PDF-1.4 not an image", content_type="application/pdf",
                            filename="bill.pdf")
        assert resp.status_code == 400, resp.text

    # ---------- RBAC ----------
    def test_non_creator_non_admin_cannot_upload(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])

        resp = self._upload(api_client, member_token, trip["id"], exp["id"])
        assert resp.status_code == 403, resp.text

    def test_non_member_cannot_view(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)
        self._upload(api_client, test_user["token"], trip["id"], exp["id"])

        outsider_token, _ = self._register_user(api_client, "Outsider")  # never joins
        resp = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            headers=self._auth(outsider_token),
        )
        assert resp.status_code == 403, resp.text

    # ---------- missing receipt ----------
    def test_fetch_missing_receipt_404(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        resp = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            headers=self._auth(test_user["token"]),
        )
        assert resp.status_code == 404, resp.text

    # ---------- delete ----------
    def test_delete_receipt(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)
        self._upload(api_client, test_user["token"], trip["id"], exp["id"])

        delete = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            headers=self._auth(test_user["token"]),
        )
        assert delete.status_code == 200, delete.text

        # receipt is gone, flag clears
        got = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            headers=self._auth(test_user["token"]),
        )
        assert got.status_code == 404, got.text
        after = next(e for e in self._list_expenses(api_client, test_user["token"], trip["id"])
                     if e["id"] == exp["id"])
        assert after["has_receipt"] is False

    def test_delete_expense_removes_receipt(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)
        self._upload(api_client, test_user["token"], trip["id"], exp["id"])

        delete = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            headers=self._auth(test_user["token"]),
        )
        assert delete.status_code == 200, delete.text
        # expense (and its receipt) are gone
        remaining = self._list_expenses(api_client, test_user["token"], trip["id"])
        assert all(e["id"] != exp["id"] for e in remaining)

    # ---------- legacy base64 fallback ----------
    def test_legacy_base64_receipt_streams_via_fallback(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        # Simulate a pre-Step-22 row by PATCHing the legacy inline field directly.
        patch = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            json={"receipt_base64": PNG_DATA_URI},
            headers=self._auth(test_user["token"]),
        )
        assert patch.status_code == 200, patch.text

        # list flags has_receipt via the legacy branch but still hides the bytes
        row = next(e for e in self._list_expenses(api_client, test_user["token"], trip["id"])
                   if e["id"] == exp["id"])
        assert row["has_receipt"] is True
        assert "receipt_base64" not in row

        # GET streams the decoded legacy image
        got = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}/receipt",
            headers=self._auth(test_user["token"]),
        )
        assert got.status_code == 200, got.text
        assert got.headers.get("content-type", "").startswith("image/png")
        assert got.content == PNG_1x1
