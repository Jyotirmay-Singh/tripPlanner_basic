"""In-process trip chat fan-out for the current single-worker deployment."""

import asyncio
from collections import defaultdict
from typing import Iterable

from fastapi import WebSocket

from config import logger


class ChatConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, dict[WebSocket, str]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect(self, trip_id: str, user_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[trip_id][websocket] = user_id

    async def disconnect(self, trip_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            trip_connections = self._connections.get(trip_id)
            if not trip_connections:
                return
            trip_connections.pop(websocket, None)
            if not trip_connections:
                self._connections.pop(trip_id, None)

    async def broadcast(self, trip_id: str, event: dict, allowed_user_ids: Iterable[str]) -> None:
        allowed = set(allowed_user_ids)
        async with self._lock:
            targets = list(self._connections.get(trip_id, {}).items())
        for websocket, user_id in targets:
            if user_id not in allowed:
                await self._close_and_remove(trip_id, websocket, 4403)
                continue
            try:
                await websocket.send_json(event)
            except Exception:
                logger.warning(
                    "chat.broadcast_failed trip_id=%s event_type=%s",
                    trip_id,
                    event.get("type", "unknown"),
                )
                await self.disconnect(trip_id, websocket)

    async def disconnect_users(self, trip_id: str, user_ids: Iterable[str]) -> None:
        revoked = {user_id for user_id in user_ids if user_id}
        if not revoked:
            return
        async with self._lock:
            targets = [
                websocket
                for websocket, user_id in self._connections.get(trip_id, {}).items()
                if user_id in revoked
            ]
        for websocket in targets:
            await self._close_and_remove(trip_id, websocket, 4403)

    async def disconnect_trip(self, trip_id: str) -> None:
        async with self._lock:
            targets = list(self._connections.get(trip_id, {}))
        for websocket in targets:
            await self._close_and_remove(trip_id, websocket, 4404)

    async def _close_and_remove(self, trip_id: str, websocket: WebSocket, code: int) -> None:
        await self.disconnect(trip_id, websocket)
        try:
            await websocket.close(code=code)
        except Exception:
            pass


chat_connections = ChatConnectionManager()
