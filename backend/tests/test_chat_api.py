"""Live API/MongoDB chat round-trip tests, following the repository's requests-based suites."""

import os
import uuid


BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8000").rstrip("/")


class TestTripChat:
    @staticmethod
    def _headers(token):
        return {"Authorization": f"Bearer {token}"}

    def _register(self, api_client, name):
        email = f"TEST_chat_{uuid.uuid4().hex[:10]}@gmail.com"
        response = api_client.post(
            f"{BASE_URL}/api/auth/register",
            json={"name": name, "email": email, "password": "test12345", "pin": "5678"},
        )
        assert response.status_code == 200, response.text
        return response.json()

    def _create_trip(self, api_client, token):
        response = api_client.post(
            f"{BASE_URL}/api/trips",
            json={
                "name": "TEST_Chat Trip",
                "start_date": "2026-08-22",
                "end_date": "2026-08-23",
                "currency": "INR",
            },
            headers=self._headers(token),
        )
        assert response.status_code == 200, response.text
        return response.json()

    def _send(self, api_client, trip_id, token, text, client_id=None):
        return api_client.post(
            f"{BASE_URL}/api/trips/{trip_id}/chat/messages",
            json={"client_message_id": client_id or str(uuid.uuid4()), "text": text},
            headers=self._headers(token),
        )

    def test_send_edit_delete_and_idempotent_retry(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        client_id = str(uuid.uuid4())
        first = self._send(api_client, trip["id"], test_user["token"], "  Hello trip  ", client_id)
        assert first.status_code == 200, first.text
        message = first.json()
        assert message["text"] == "Hello trip"
        assert message["sender_name"] == test_user["name"]

        retry = self._send(api_client, trip["id"], test_user["token"], "Hello trip", client_id)
        assert retry.status_code == 200
        assert retry.json()["id"] == message["id"]

        edited = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/messages/{message['id']}",
            json={"text": "Meet at eight"},
            headers=self._headers(test_user["token"]),
        )
        assert edited.status_code == 200
        assert edited.json()["edited_at"]

        deleted = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/messages/{message['id']}",
            headers=self._headers(test_user["token"]),
        )
        assert deleted.status_code == 200
        assert deleted.json()["text"] is None
        assert deleted.json()["deleted_at"]

    def test_joined_member_unread_and_owner_clear(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client, "Chat Friend")
        joined = api_client.post(
            f"{BASE_URL}/api/trips/join",
            json={"code": trip["code"], "mode": "individual"},
            headers=self._headers(joiner["access_token"]),
        )
        assert joined.status_code == 200, joined.text

        sent = self._send(api_client, trip["id"], test_user["token"], "Packing list ready")
        assert sent.status_code == 200, sent.text
        message = sent.json()

        unread = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/unread",
            headers=self._headers(joiner["access_token"]),
        )
        assert unread.status_code == 200
        assert unread.json()["count"] == 1

        marked = api_client.put(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/read",
            json={"through_sequence": message["sequence"]},
            headers=self._headers(joiner["access_token"]),
        )
        assert marked.status_code == 200
        assert api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/unread",
            headers=self._headers(joiner["access_token"]),
        ).json()["count"] == 0

        forbidden = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/history",
            headers=self._headers(joiner["access_token"]),
        )
        assert forbidden.status_code == 403
        cleared = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/history",
            headers=self._headers(test_user["token"]),
        )
        assert cleared.status_code == 200
        history = api_client.get(
            f"{BASE_URL}/api/trips/{trip['id']}/chat/messages",
            headers=self._headers(joiner["access_token"]),
        )
        assert history.json()["items"] == []
