"""Transactional in-memory fixture for email auth; real-Mongo coverage is separate."""
import asyncio
from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError


def get(doc, path):
    for part in path.split("."):
        if not isinstance(doc, dict) or part not in doc:
            return None
        doc = doc[part]
    return doc


def put(doc, path, value):
    parts = path.split(".")
    for part in parts[:-1]:
        doc = doc.setdefault(part, {})
    doc[parts[-1]] = value


def expr(value, doc):
    if isinstance(value, str) and value.startswith("$"):
        return get(doc, value[1:])
    if isinstance(value, list):
        return [expr(item, doc) for item in value]
    if not isinstance(value, dict):
        return value
    op, args = next(iter(value.items()))
    if op == "$type":
        return "date" if isinstance(expr(args, doc), datetime) else "missing"
    if op == "$cond":
        return expr(args[1] if expr(args[0], doc) else args[2], doc)
    values = expr(args, doc)
    if op == "$ifNull": return values[0] if values[0] is not None else values[1]
    if op == "$lte": return values[0] <= values[1]
    if op == "$eq": return values[0] == values[1]
    if op == "$in": return values[0] in values[1]
    if op == "$and": return all(values)
    if op == "$add": return sum(values)
    raise AssertionError(op)


def match(doc, query):
    for key, wanted in query.items():
        if key == "$and":
            if not all(match(doc, part) for part in wanted): return False
        elif key == "$or":
            if not any(match(doc, part) for part in wanted): return False
        elif isinstance(wanted, dict):
            actual = get(doc, key)
            for op, val in wanted.items():
                if op == "$exists" and (actual is not None) != val: return False
                if op == "$ne" and actual == val: return False
                if op == "$lt" and (actual is None or actual >= val): return False
                if op == "$lte" and (actual is None or actual > val): return False
                if op == "$gt" and (actual is None or actual <= val): return False
        elif get(doc, key) != wanted:
            return False
    return True


class FakeCollection:
    def __init__(self):
        self.docs = []

    async def insert_one(self, doc, **kwargs):
        stored = deepcopy(doc)
        stored.setdefault("_id", len(self.docs) + 1)
        if any(d["_id"] == stored["_id"] for d in self.docs):
            raise DuplicateKeyError("duplicate test key")
        self.docs.append(stored)
        return SimpleNamespace(inserted_id=stored["_id"])

    def _update(self, doc, update, new=False):
        if isinstance(update, list):
            for stage in update:
                values = {k: expr(v, doc) for k, v in stage["$set"].items()}
                for key, val in values.items(): put(doc, key, val)
            return
        for key, val in update.get("$set", {}).items(): put(doc, key, deepcopy(val))
        for key, val in update.get("$inc", {}).items(): put(doc, key, (get(doc, key) or 0) + val)
        if new:
            for key, val in update.get("$setOnInsert", {}).items(): put(doc, key, deepcopy(val))

    async def find_one(self, query, projection=None, *, sort=None, **kwargs):
        docs = [doc for doc in self.docs if match(doc, query)]
        if sort:
            key, direction = sort[0]
            docs.sort(key=lambda doc: get(doc, key), reverse=direction == -1)
        if not docs: return None
        result = deepcopy(docs[0])
        if projection:
            if any(projection.values()):
                result = {k: v for k, v in result.items() if projection.get(k)}
            else:
                result = {k: v for k, v in result.items() if projection.get(k, 1)}
        return result

    async def update_one(self, query, update, **kwargs):
        for doc in self.docs:
            if match(doc, query):
                self._update(doc, update)
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def update_many(self, query, update, **kwargs):
        for doc in self.docs:
            if match(doc, query): self._update(doc, update)

    async def find_one_and_update(self, query, update, *, upsert=False, return_document=False, **kwargs):
        for doc in self.docs:
            if match(doc, query):
                before = deepcopy(doc)
                self._update(doc, update)
                return deepcopy(doc) if return_document == ReturnDocument.AFTER else before
        if upsert:
            doc = {k: v for k, v in query.items() if not k.startswith("$") and not isinstance(v, dict)}
            self._update(doc, update, new=True)
            await self.insert_one(doc)
            return deepcopy(self.docs[-1]) if return_document == ReturnDocument.AFTER else None
        return None


class FakeDB:
    def __init__(self):
        self._cols = {}
        self._lock = asyncio.Lock()

    def __getitem__(self, name):
        return self._cols.setdefault(name, FakeCollection())

    def __getattr__(self, name):
        return self[name]

    async def transaction(self, callback):
        async with self._lock:
            snapshot = {name: deepcopy(col.docs) for name, col in self._cols.items()}
            try:
                return await callback("test-session")
            except Exception:
                for name, col in self._cols.items(): col.docs = snapshot.get(name, [])
                raise
