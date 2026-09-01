import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models.trip import TripUpdate
from routes import trips


def test_official_currency_cannot_change_after_trip_creation(monkeypatch):
    trip = {"id": "t1", "currency": "LKR", "members": []}
    monkeypatch.setattr(trips, "_trip_admin_or_403", AsyncMock(return_value=trip))

    with pytest.raises(HTTPException) as caught:
        asyncio.run(trips.update_trip(
            "t1", TripUpdate(currency="NPR"), user={"id": "admin"},
        ))

    assert caught.value.status_code == 409
    assert caught.value.detail == "Official currency cannot be changed after trip creation"
