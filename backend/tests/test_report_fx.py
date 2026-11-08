"""Conversion-to-report controls using saved quotes and independent whole-unit totals."""

import asyncio
from copy import deepcopy
from datetime import date
from decimal import Decimal
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bson.decimal128 import Decimal128
from openpyxl import load_workbook
from pypdf import PdfReader
import pytest

from models.exchange_rate import ConversionRequest
from services import exchange_rates, expense_conversion
from services.report_model import ReportReconciliationError, ReportSnapshot, build_report_data
from services.report_pdf import build_report_pdf
from services.report_xlsx import build_report_xlsx
from report_excel_assertions import assert_static_category_table


MEMBERS = [
    {'id': 'f', 'name': 'Family', 'kind': 'family', 'family_member_ids': ['p1', 'p2'],
     'family_members': ['Ana', 'Ben']},
    {'id': 'b', 'name': 'Sam', 'kind': 'individual'},
]


class Quotes:
    def __init__(self):
        self.rows = {}

    async def insert_one(self, document):
        self.rows[document['id']] = deepcopy(document)

    async def find_one(self, query, projection=None):
        row = self.rows.get(query['id'])
        return deepcopy(row) if row and row['user_id'] == query['user_id'] else None


@pytest.mark.parametrize('currency,usd_rate,usd_total,refund_total,jpy_total', [
    ('INR', '82.125', 8213, -2053, 280),
    ('EUR', '0.925', 93, -23, 3),
    ('AED', '3.6725', 367, -92, 12),
    ('KWD', '0.30715', 31, -8, 1),
])
def test_mixed_currency_quotes_flow_into_reconciled_reports_without_reconversion(
    monkeypatch, currency, usd_rate, usd_total, refund_total, jpy_total,
):
    quotes = Quotes()
    monkeypatch.setattr(exchange_rates, 'db', SimpleNamespace(exchange_rate_quotes=quotes))
    monkeypatch.setattr(exchange_rates, 'record_money_normalizations', AsyncMock())
    provider = AsyncMock(return_value={
        'rate_id': 'reference', 'rate': Decimal(usd_rate), 'effective_date': '2026-08-28',
        'provider': exchange_rates.PROVIDER, 'provider_sources': [], 'cache_revision': 3,
        'cache_hit': True, 'stale': False,
    })
    monkeypatch.setattr(exchange_rates, 'get_reference_rate', provider)

    async def convert_all():
        records = []
        for number, source, amount, split, mode, manual_kind, manual_value in (
            (1, currency, 50, 'PER_CAPITA', 'automatic', None, None),
            (2, 'USD', 100, 'PER_FAMILY', 'automatic', None, None),
            (3, 'USD', -25, 'EXACT', 'manual', 'rate', usd_rate),
            (4, 'JPY', 500, 'PER_CAPITA', 'manual', 'target_amount', jpy_total),
        ):
            conversion = None
            if source != currency:
                inputs = {'manual_rate': manual_value} if manual_kind == 'rate' else (
                    {'manual_target_amount': manual_value} if manual_kind else {})
                quote = await exchange_rates.create_quote(
                    user_id='report-test', source_currency=source, target_currency=currency,
                    source_amount=amount, requested_date='2026-08-30', mode=mode,
                    manual_input_type=manual_kind, **inputs)
                conversion = ConversionRequest(mode=mode, quote_id=quote['quote_id'], approved=True,
                                               manual_input_type=manual_kind, **inputs)
            converted = await expense_conversion.convert_expense(
                user_id='report-test', trip_currency=currency, date='30-08-26', split_mode=split,
                members=MEMBERS, original_amount=amount, original_currency=source,
                original_custom_amounts={'p1': 10, 'b': 15} if split == 'EXACT' else None,
                conversion=conversion, version=1, reason='created', paid_by_member_id='f')
            records.append({'id': f'expense-{number}', 'amount': converted['amount'],
                            'currency': converted['currency'], 'paid_by_member_id': 'f',
                            'split_member_ids': ['f', 'b'], 'split_mode': split,
                            'custom_amounts': converted['custom_amounts'], 'category': 'Travel',
                            'description': f'Foreign expense {number}', 'date': '2026-08-30',
                            **converted['metadata']})
        return tuple(records)

    expenses = asyncio.run(convert_all())
    assert [record['amount'] for record in expenses] == [50, usd_total, refund_total, jpy_total]
    assert provider.await_count == 1
    provider.reset_mock()
    provider.side_effect = AssertionError('An export must use the saved rate, not fetch another one')
    loader = AsyncMock(side_effect=AssertionError('An export must not reload or replace a quote'))
    monkeypatch.setattr(expense_conversion, 'load_quote', loader)
    source = ReportSnapshot({'id': 'mixed', 'name': 'Mixed-currency trip', 'currency': currency,
                             'members': MEMBERS}, expenses)
    original = deepcopy(source)
    data = build_report_data(source)
    workbook = load_workbook(io.BytesIO(build_report_xlsx(data)))
    expected_gross, expected_net = 50 + usd_total + jpy_total, 50 + usd_total + refund_total + jpy_total
    assert (data.gross, data.money_back, data.net) == (expected_gross, -refund_total, expected_net)
    assert workbook['Summary']['B9'].value == expected_net
    allocations = list(workbook['Transactions'].iter_rows(min_row=3, max_row=2 + len(data.allocations), values_only=True))
    rows = {row[11]: row for row in allocations}
    assert [rows[f'expense-{number}'][9] for number in range(1, 5)] == [50, usd_total, refund_total, jpy_total]
    assert sum(row[9] for row in rows.values()) == expected_net
    usd = rows['expense-2']
    assert usd[12:15] == (100, 'USD', usd_rate)
    assert usd[15].date() == date(2026, 8, 28)
    assert usd[19].date() == date(2026, 8, 30)
    assert currency in workbook['Transactions']['O2'].value and 'per' in workbook['Transactions']['O2'].value
    assert sum(row[10] for row in allocations) == expected_net
    assert_static_category_table(workbook, expected_net)
    pdf = ' '.join(page.extract_text() for page in PdfReader(io.BytesIO(build_report_pdf(data))).pages)
    assert 'USD' in pdf and 'JPY' in pdf
    assert sum(account.balance for account in data.accounts) == 0
    assert source == original
    provider.assert_not_awaited()
    loader.assert_not_awaited()


@pytest.mark.parametrize('kind', ['expenses', 'payments', 'settlements'])
def test_report_rejects_raw_foreign_money_tagged_as_the_group_total(kind):
    record = {'id': 'foreign', 'amount': 100, 'currency': 'USD', 'date': '2026-08-30',
              'paid_by_member_id': 'f', 'split_member_ids': ['f', 'b'], 'category': 'Food',
              'from_member_id': 'b', 'to_member_id': 'f', 'status': 'paid'}
    source = ReportSnapshot({'id': 'bad', 'name': 'Raw foreign record', 'currency': 'INR', 'members': MEMBERS},
                            **{kind: (record,)})
    with pytest.raises(ReportReconciliationError, match='group currency'):
        build_report_data(source)


def test_missing_original_currency_is_not_falsely_labelled_as_identity_conversion():
    expense = {'id': 'missing-original-code', 'amount': 8200, 'currency': 'INR',
               'paid_by_member_id': 'f', 'split_member_ids': ['f', 'b'], 'category': 'Food',
               'date': '2026-08-30', 'original_amount': Decimal128('100'),
               'exchange_rate': Decimal128('82'), 'exchange_rate_provider': exchange_rates.PROVIDER,
               'exchange_rate_mode': 'automatic'}
    data = build_report_data(ReportSnapshot(
        {'id': 'missing', 'name': 'Missing FX evidence', 'currency': 'INR', 'members': MEMBERS}, (expense,)))
    assert data.allocations[0].original_currency == 'Not recorded'
    assert data.allocations[0].original_amount == 100
    assert data.allocations[0].exchange_rate == '82'
    assert data.net == 8200


@pytest.mark.parametrize('original_code,rate,provider,expected_code,expected_amount', [
    ('USD', None, None, 'USD', None),
    (None, Decimal128('82'), None, 'Not recorded', None),
    (None, Decimal128('1'), 'manual', 'Not recorded', None),
    (None, None, None, 'INR', Decimal(100)),
])
def test_incomplete_foreign_metadata_is_not_reconstructed_from_the_converted_total(
    original_code, rate, provider, expected_code, expected_amount,
):
    expense = {'id': 'legacy', 'amount': 100, 'currency': 'INR', 'paid_by_member_id': 'f',
               'split_member_ids': ['f', 'b'], 'category': 'Food', 'date': '30-08-26',
               'original_currency': original_code, 'exchange_rate': rate, 'exchange_rate_provider': provider}
    data = build_report_data(ReportSnapshot(
        {'id': 'legacy', 'name': 'Legacy FX evidence', 'currency': 'INR', 'members': MEMBERS}, (expense,)))
    assert data.allocations[0].original_currency == expected_code
    assert data.allocations[0].original_amount == expected_amount
    assert data.net == 100


def test_pending_settlements_with_other_currency_are_not_included_or_validated_as_recorded_money():
    pending = {'id': 'not-paid', 'amount': 100, 'currency': 'USD', 'from_member_id': 'b',
               'to_member_id': 'f', 'status': 'pending'}
    data = build_report_data(ReportSnapshot(
        {'id': 'pending', 'name': 'Pending cash', 'currency': 'INR', 'members': MEMBERS}, settlements=(pending,)))
    assert data.events == () and data.net == 0


@pytest.mark.parametrize('simplify', [True, False])
def test_each_expense_keeps_its_own_historical_rate_within_the_same_currency(monkeypatch, simplify):
    provider = AsyncMock(side_effect=AssertionError('Exporting must not fetch current rates'))
    monkeypatch.setattr(exchange_rates, 'get_reference_rate', provider)
    specifications = [('usd-first', 8150, 100, 'USD', '81.5', '28-08-26'),
                      ('usd-second', 8320, 100, 'USD', '83.2', '31-08-26'),
                      ('eur', 9000, 100, 'EUR', '90', '31-08-26'),
                      ('usd-refund', -820, -10, 'USD', '82', '01-09-26')]
    expenses = tuple({'id': key, 'amount': canonical, 'currency': 'INR', 'paid_by_member_id': 'f',
                      'split_member_ids': ['f', 'b'], 'category': 'Travel', 'date': day,
                      'original_amount': Decimal128(str(original)), 'original_currency': currency,
                      'exchange_rate': Decimal128(rate), 'exchange_rate_provider': exchange_rates.PROVIDER,
                      'exchange_rate_mode': 'automatic'}
                     for key, canonical, original, currency, rate, day in specifications)
    data = build_report_data(ReportSnapshot(
        {'id': 'historical', 'name': 'Historical rates', 'currency': 'INR', 'members': MEMBERS,
         'simplify_debts': simplify}, expenses))
    workbook = load_workbook(io.BytesIO(build_report_xlsx(data)))
    rows = {row[11]: row for row in workbook['Transactions'].iter_rows(
        min_row=3, max_row=2 + len(data.allocations), values_only=True)}
    for key, canonical, original, currency, rate, _ in specifications:
        assert rows[key][9] == canonical
        assert rows[key][12:15] == (original, currency, rate)
    assert (data.gross, data.money_back, data.net) == (25470, 820, 24650)
    assert workbook['Summary']['B9'].value == 24650
    provider.assert_not_awaited()


def test_original_amount_without_source_currency_does_not_invent_an_identity_rate():
    expense = {'id': 'incomplete', 'amount': 8200, 'currency': 'INR', 'original_amount': Decimal128('100'),
               'paid_by_member_id': 'f', 'split_member_ids': ['f', 'b'], 'category': 'Food', 'date': '30-08-26'}
    data = build_report_data(ReportSnapshot(
        {'id': 'incomplete', 'name': 'Missing source currency', 'currency': 'INR', 'members': MEMBERS}, (expense,)))
    assert data.allocations[0].original_currency == 'Not recorded'
    assert data.allocations[0].exchange_rate == 'Not recorded'
    assert data.net == 8200
