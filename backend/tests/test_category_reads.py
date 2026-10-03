"""No network/database writes: fixed metadata and complete cursor boundary tests."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient
from starlette.middleware.cors import CORSMiddleware
from category_names import CATEGORIES
from routes import expenses, spend, meta

def test_catalog_is_exact_and_metadata_retains_string_list():
    catalog = json.loads((Path(__file__).resolve().parents[2] / 'shared/category-catalog.json').read_text())
    assert CATEGORIES == [row['name'] for row in catalog]
    assert len(CATEGORIES) == len(set(CATEGORIES)) == 30
    assert asyncio.run(meta.get_categories()) == CATEGORIES
    original = ['Travel', 'Accommodation', 'Local Transportation', 'Local Sightseeing', 'Food', 'Shopping', 'Other']
    assert [name for name in CATEGORIES if name in original] == original

class Cursor:
    def __init__(self, rows): self.rows = rows; self.length = 'uncalled'
    async def to_list(self, length):
        self.length = length
        return self.rows if length is None else self.rows[:length]

@pytest.mark.parametrize('size', [999, 1000, 1001, 5001])
@pytest.mark.parametrize('include_metadata', [False, True])
def test_complete_expense_list_retains_oldest_category_and_refund(monkeypatch, size, include_metadata):
    rows = [dict(id=str(i), amount=1, category='Food') for i in range(size - 2)]
    rows += [dict(id='oldest', amount=10, category='Professional Services'), dict(id='refund', amount=-2, category='Professional Services')]
    cursor = Cursor(rows)
    monkeypatch.setattr(expenses, 'db', SimpleNamespace(expenses=SimpleNamespace(aggregate=lambda pipeline: cursor)))
    monkeypatch.setattr(expenses, '_trip_or_404', AsyncMock(return_value={'currency': 'INR', 'members': []}))
    monkeypatch.setattr(expenses, 'expense_share_breakdown', lambda e, m: {})
    response = Response()
    result = asyncio.run(expenses.list_expenses('trip', response, include_metadata=include_metadata, user={'id': 'u'}))
    if include_metadata:
        assert result['complete'] is True
        result = result['items']
    assert cursor.length is None
    assert len(result) == size and result[-2]['category'] == 'Professional Services' and result[-1]['amount'] == -2
    assert response.headers['X-Expense-List-Complete'] == 'true'

def test_expense_metadata_is_readable_when_cors_does_not_expose_the_header(monkeypatch):
    rows = [{'id': 'expense', 'amount': 100, 'category': 'Food'},
            {'id': 'refund', 'amount': -20, 'category': 'Food'}]
    monkeypatch.setattr(expenses, 'db', SimpleNamespace(
        expenses=SimpleNamespace(aggregate=lambda pipeline: Cursor(rows))))
    monkeypatch.setattr(expenses, '_trip_or_404', AsyncMock(return_value={'currency': 'INR', 'members': []}))
    monkeypatch.setattr(expenses, 'expense_share_breakdown', lambda e, m: {})
    app = FastAPI()
    app.include_router(expenses.router, prefix='/api')
    app.dependency_overrides[expenses.get_current_user] = lambda: {'id': 'u'}
    app.add_middleware(CORSMiddleware, allow_origins=['*'])
    response = TestClient(app).get('/api/trips/trip/expenses?include_metadata=true',
                                   headers={'Origin': 'https://tripsplitter-web.vercel.app'})
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == '*'
    assert 'access-control-expose-headers' not in response.headers
    assert response.json()['complete'] is True
    assert [item['amount'] for item in response.json()['items']] == [100, -20]


def test_payer_summary_reads_more_than_5000(monkeypatch):
    rows = [{'amount': 1, 'paid_by_member_id': 'm'} for _ in range(5001)]
    cursor = Cursor(rows)
    monkeypatch.setattr(spend, 'db', SimpleNamespace(expenses=SimpleNamespace(find=lambda *args: cursor)))
    monkeypatch.setattr(spend, '_trip_or_404', AsyncMock(return_value={'currency': 'INR', 'members': [{'id': 'm', 'name': 'Member', 'kind': 'individual'}]}))
    result = asyncio.run(spend.spend_summary('trip', user={'id': 'u'}))
    assert cursor.length is None
    assert result['total'] == 5001
