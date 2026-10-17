"""Download contracts, access checks, and one-load-per-collection regression coverage."""

import asyncio
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from pypdf import PdfReader

from routes import reports
from services.report_model import ReportReconciliationError, build_report_data
from scripts.generate_report_samples import sample_snapshot
from utils import balances as balance_service


class Cursor:
    def __init__(self, rows):
        self.rows = rows
        self.lengths = []

    async def to_list(self, length=None):
        self.lengths.append(length)
        return list(self.rows)


class Collection:
    def __init__(self, rows=(), one=None):
        self.cursor = Cursor(rows)
        self.find = Mock(return_value=self.cursor)
        self.find_one = AsyncMock(return_value=one)


def install(monkeypatch, snapshot=None):
    snapshot = snapshot or sample_snapshot()
    snapshot.trip['owner_id'] = 'owner'
    fake = SimpleNamespace(
        users=Collection(one={'id': 'owner'}),
        trips=Collection(one=snapshot.trip),
        expenses=Collection(snapshot.expenses),
        settlements=Collection(snapshot.settlements),
        payments=Collection(snapshot.payments),
        money_migration_adjustments=Collection(one=snapshot.migration_adjustment),
    )
    monkeypatch.setattr(reports, 'db', fake)
    monkeypatch.setattr(reports, 'decode_token', Mock(return_value={'sub': 'owner'}))
    monkeypatch.setattr(reports, '_trip_or_404', AsyncMock(return_value=snapshot.trip))
    return snapshot, fake


async def payload(response):
    return b''.join([chunk async for chunk in response.body_iterator])


@pytest.mark.parametrize('kind,mime', [('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), ('pdf', 'application/pdf')])
def test_download_loads_each_source_once_and_preserves_public_contract(monkeypatch, kind, mime):
    source, fake = install(monkeypatch)
    monkeypatch.setattr(reports, '_compute_balances', AsyncMock(side_effect=AssertionError('Export must reuse preloaded records')))
    route = getattr(reports, 'report_' + kind)
    response = asyncio.run(route('sample-group', 'token'))
    content = asyncio.run(payload(response))
    assert response.media_type == mime
    assert response.headers['content-disposition'] == 'attachment; filename=Coastal_Journey_-_Sample_report.' + kind
    reports.decode_token.assert_called_once_with('token')
    reports._trip_or_404.assert_awaited_once_with('sample-group', {'id': 'owner'})
    fake.users.find_one.assert_awaited_once()
    for collection in (fake.expenses, fake.settlements, fake.payments):
        collection.find.assert_called_once()
        assert collection.cursor.lengths == [None]
    fake.money_migration_adjustments.find_one.assert_awaited_once()
    assert 'status' in fake.settlements.find.call_args.args[0]
    if kind == 'xlsx':
        wb = load_workbook(io.BytesIO(content))
        assert wb.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
        assert wb['Summary']['G8'].value == build_report_data(source).net
    else:
        assert content.startswith(b'%PDF')
        assert len(PdfReader(io.BytesIO(content)).pages) >= 4


@pytest.mark.parametrize('kind', ['xlsx', 'pdf'])
def test_export_rejects_unknown_user_before_loading_group_records(monkeypatch, kind):
    _, fake = install(monkeypatch)
    fake.users.find_one.return_value = None
    with pytest.raises(HTTPException) as error:
        asyncio.run(getattr(reports, 'report_' + kind)('sample-group', 'token'))
    assert error.value.status_code == 401
    reports._trip_or_404.assert_not_awaited()
    fake.expenses.find.assert_not_called()


@pytest.mark.parametrize('kind', ['xlsx', 'pdf'])
def test_export_preserves_group_access_check(monkeypatch, kind):
    _, fake = install(monkeypatch)
    reports._trip_or_404.side_effect = HTTPException(403, 'Not a group member')
    with pytest.raises(HTTPException) as error:
        asyncio.run(getattr(reports, 'report_' + kind)('sample-group', 'token'))
    assert error.value.status_code == 403
    fake.expenses.find.assert_not_called()


@pytest.mark.parametrize('kind', ['xlsx', 'pdf'])
def test_reconciliation_failure_returns_409_before_starting_download(monkeypatch, kind):
    install(monkeypatch)
    monkeypatch.setattr(reports, 'build_report_data', Mock(side_effect=ReportReconciliationError('Allocation total mismatch.')))
    with pytest.raises(HTTPException) as error:
        asyncio.run(getattr(reports, 'report_' + kind)('sample-group', 'token'))
    assert error.value.status_code == 409
    assert 'could not be reconciled' in error.value.detail
    assert 'Allocation total mismatch.' in error.value.detail


@pytest.mark.parametrize('simplify', [True, False])
def test_exports_use_the_same_plan_as_the_authoritative_balance_route(monkeypatch, simplify):
    source, fake = install(monkeypatch)
    source.trip['simplify_debts'] = simplify
    monkeypatch.setattr(balance_service, 'db', fake)
    balance = asyncio.run(balance_service._compute_balances('sample-group'))
    wb = load_workbook(io.BytesIO(asyncio.run(payload(asyncio.run(reports.report_xlsx('sample-group', 'token'))))))
    rows = list(wb['Payments'].values)
    expected_names = {a.account_id: a.name for a in build_report_data(source).accounts}
    actual = [(r[0], r[1], r[2]) for r in rows if r[3] == 'Suggested']
    assert actual == [(expected_names[t['from_member_id']], expected_names[t['to_member_id']], t['amount']) for t in balance['transfers']]
    label = 'Minimum payment plan' if simplify else 'Direct repayment plan'
    assert wb['Payments']['B3'].value == label
    assert next(r[2] for r in rows if r[0] == 'Outstanding plan total') == sum(t['amount'] for t in balance['transfers'])


def test_json_report_contract_still_uses_existing_aggregation(monkeypatch):
    source, _ = install(monkeypatch)
    monkeypatch.setattr(reports, '_compute_balances', AsyncMock(return_value={'net': {'example': 0}}))
    result = asyncio.run(reports.report('sample-group', {'id': 'owner'}))
    assert set(result) == {'trip', 'total_expense', 'budget', 'by_category', 'by_date', 'balances'}
    assert result['total_expense'] == 251152
    assert result['balances'] == {'net': {'example': 0}}


def test_expense_loader_has_no_accounting_row_cap(monkeypatch):
    _, fake = install(monkeypatch)
    asyncio.run(reports._load_report_expenses('sample-group'))
    assert fake.expenses.cursor.lengths == [None]


@pytest.mark.parametrize('kind', ['xlsx', 'pdf'])
def test_http_download_stream_uses_existing_url_token_and_response_type(monkeypatch, kind):
    install(monkeypatch)
    app = FastAPI()
    app.include_router(reports.router, prefix='/api')
    with TestClient(app) as client:
        missing_token = client.get('/api/trips/sample-group/report.' + kind)
        assert missing_token.status_code == 422
        response = client.get('/api/trips/sample-group/report.' + kind, params={'token': 'token'})
    assert response.status_code == 200
    assert response.headers['content-disposition'].endswith('_report.' + kind)
    if kind == 'xlsx':
        assert 'spreadsheet' in response.headers['content-type']
        assert load_workbook(io.BytesIO(response.content))['Summary']['G8'].value == 251152
    else:
        assert response.headers['content-type'] == 'application/pdf'
        assert PdfReader(io.BytesIO(response.content)).pages
