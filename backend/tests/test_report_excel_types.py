"""Round-trip both automatic Excel layouts and independently reconcile their saved sources."""

from copy import deepcopy
from dataclasses import replace
import io
import random

from bson.decimal128 import Decimal128
from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries
import pytest

from services.report_excel_layout import ExcelReportType, select_excel_report_type
from services.report_formatting import currency_symbol
from services.report_model import ReportSnapshot, build_report_data
from services.report_xlsx import build_report_xlsx
from utils.currency_rules import SUPPORTED_CURRENCIES
from report_excel_assertions import assert_static_category_table, assert_no_pivot_parts, members_detail_rows, members_account_groups


MEMBERS = [
    {'id': 'family', 'name': 'Shah family', 'kind': 'family',
     'family_member_ids': ['p1', 'p2'], 'family_members': ['Ana', 'Ben']},
    {'id': 'solo', 'name': 'Sam', 'kind': 'individual'},
]


def expense(identity='e1', amount=100, **fields):
    return {'id': identity, 'amount': amount, 'date': '07-11-26', 'category': 'Food',
            'paid_by_member_id': 'family', 'split_member_ids': ['family', 'solo'],
            'split_mode': 'PER_CAPITA', **fields}


def snapshot(currency='INR', expenses=None, **fields):
    return ReportSnapshot({'id': 'layouts', 'name': 'Layout controls', 'currency': currency,
                           'members': deepcopy(MEMBERS), **fields},
                          tuple(expenses) if expenses is not None else (expense(),))


def assert_export(source, *, exchange, expected_net):
    before = deepcopy(source)
    data = build_report_data(source)
    payload = build_report_xlsx(data)
    workbook = load_workbook(io.BytesIO(payload))
    assert source == before
    assert data.net == expected_net == workbook['Summary']['B9'].value
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
    assert workbook.properties.subject.endswith('multi_currency' if exchange else 'single_currency')
    assert all(not sheet.merged_cells.ranges for sheet in workbook)
    assert all('ReportExpenses' not in sheet.tables for sheet in workbook)
    transactions = workbook['Transactions']
    transaction_width = 15 if exchange else 11
    assert transactions.max_column == transaction_width
    assert transactions.freeze_panes == 'A3'
    assert workbook['Summary'].freeze_panes is None
    assert not any(dimension.hidden for dimension in transactions.column_dimensions.values())
    assert not any(cell.data_type == 'f' for sheet in workbook for row in sheet for cell in row)
    header = [cell.value for cell in transactions[2]]
    assert ('Original currency' in header) is exchange
    assert header[:9] == ['Expense No', 'Date (IST)', 'Category', 'Description', 'Entry type', 'Paid by',
                          'Family / account', 'Person', 'Split method']
    assert all(name not in header for name in ('Expense ID', 'Rate provider', 'Rate mode',
                                               'Original exact allocations', 'Requested rate date'))
    if exchange:
        symbol = currency_symbol(data.currency)
        assert header[9:] == ['Original currency', 'Original amount',
                              f'Stored rate ({data.currency} per original unit)',
                              f'Expense total ({symbol})', f'Expense share ({symbol})',
                              'Effective rate date']
        for column in ('J', 'K', 'L'):
            assert transactions.column_dimensions[column].outlineLevel == 1
            assert transactions.column_dimensions[column].width >= 20
    else:
        assert not any('Original ' in name or 'rate' in name.lower() for name in header)
        assert max(dimension.max for dimension in transactions.column_dimensions.values()) <= 11
        assert not any(dimension.outlineLevel for dimension in transactions.column_dimensions.values())
    assert f'${"O" if exchange else "K"}$' in str(transactions.print_area)
    if not data.allocations:
        assert not transactions.tables and not workbook['Summary']._pivots
        assert transactions['A3'].value == 'No expenses recorded'
        return data, workbook
    row_count = len(data.allocations)
    table = transactions.tables['ReportAllocations']
    assert range_boundaries(table.ref) == (1, 2, transaction_width, row_count + 2)
    assert len(table.tableColumns) == transaction_width
    assert table.autoFilter.ref == table.ref
    rows = list(transactions.iter_rows(min_row=3, max_row=row_count + 2, values_only=True))
    expenses = {}
    for row in rows:
        expenses.setdefault(row[0], row)
    total_column, share_column = (12, 13) if exchange else (9, 10)
    assert sum(row[total_column] for row in expenses.values()) == sum(row[share_column] for row in rows) == expected_net
    assert sum(row[total_column] for row in expenses.values() if row[total_column] > 0) == data.gross
    assert -sum(row[total_column] for row in expenses.values() if row[total_column] < 0) == data.money_back
    assert_static_category_table(workbook, expected_net)
    assert_no_pivot_parts(payload)
    return data, workbook


@pytest.mark.parametrize('currency', SUPPORTED_CURRENCIES)
@pytest.mark.parametrize('modern', [False, True], ids=['legacy', 'saved-identity'])
def test_only_group_currency_omits_exchange_columns_for_every_supported_currency(currency, modern):
    fields = {'currency': currency}
    if modern:
        fields.update(original_currency=currency.lower(), original_amount=100, exchange_rate=Decimal128('1.0000'),
                      exchange_rate_provider='identity', exchange_rate_mode='automatic', conversion_version=1)
    assert_export(snapshot(currency, [expense(**fields)]), exchange=False, expected_net=100)


@pytest.mark.parametrize('currency', SUPPORTED_CURRENCIES)
@pytest.mark.parametrize('foreign_only', [False, True], ids=['mixed', 'one-foreign-source'])
def test_foreign_source_is_compared_with_group_currency_for_every_supported_currency(currency, foreign_only):
    source = 'EUR' if currency == 'USD' else 'USD'
    expenses = [expense(original_currency=source, original_amount=50, exchange_rate=Decimal128('2'),
                        exchange_rate_provider='manual', exchange_rate_mode='manual')]
    if not foreign_only:
        expenses += [expense('local', 50), expense('refund', -10, original_currency=source,
                                                  original_amount=-5, exchange_rate=Decimal128('2'))]
    assert_export(snapshot(currency, expenses), exchange=True, expected_net=100 if foreign_only else 140)


@pytest.mark.parametrize('fields,exchange', [
    ({}, False),
    ({'original_currency': ' inr ', 'exchange_rate': '1E+0'}, False),
    ({'original_currency': 'USD'}, True),
    ({'original_amount': 100}, True),
    ({'original_custom_amounts': {'p1': 100}}, True),
    ({'exchange_rate': Decimal128('1')}, True),
    ({'exchange_rate_provider': 'manual'}, True),
    ({'conversion_version': 1}, True),
    ({'original_currency': 'INR', 'exchange_rate': '0.5'}, False),
    ({'original_currency': 'INR', 'exchange_rate': 'unavailable'}, False),
    ({'original_currency': 'INR', 'exchange_rate': 'NaN'}, False),
    ({'original_currency': 'INR', 'exchange_rate': '1', 'exchange_rate_provider': 'manual'}, False),
    ({'original_currency': 'INR', 'exchange_rate': '1', 'exchange_rate_mode': 'manual'}, False),
])
def test_source_currency_controls_columns_without_redundant_rate_metadata(fields, exchange):
    assert_export(snapshot(expenses=[expense(**fields)]), exchange=exchange, expected_net=100)


@pytest.mark.parametrize('exchange', [False, True])
@pytest.mark.parametrize('split', ['PER_CAPITA', 'PER_FAMILY', 'EXACT'])
@pytest.mark.parametrize('sign', [1, -1])
def test_both_layouts_preserve_family_splits_refunds_and_literal_text(exchange, split, sign):
    fields = {'split_mode': split, 'category': '=Food & سفر', 'description': '=1+1\x00\n' + 'x' * 1000,
              'date': 'unavailable'}
    if split == 'EXACT':
        fields['custom_amounts'] = {'p1': 40 * sign, 'solo': 60 * sign}
    if exchange:
        fields.update(original_currency='USD', original_amount=50 * sign, exchange_rate='2',
                      original_custom_amounts={'p1': 20, 'solo': 30} if split == 'EXACT' else None)
    data, workbook = assert_export(snapshot(expenses=[expense(amount=100 * sign, **fields)]),
                                   exchange=exchange, expected_net=100 * sign)
    assert sum(row.share for row in data.allocations) == 100 * sign
    assert workbook['Transactions']['D3'].data_type == 's'
    assert '\x00' not in workbook['Transactions']['D3'].value
    assert workbook['Transactions'].row_dimensions[3].height <= 409.5


@pytest.mark.parametrize('members', [[], MEMBERS])
def test_empty_groups_use_compact_layout_without_dummy_tables_or_exchange_fields(members):
    assert_export(snapshot(expenses=[], members=members), exchange=False, expected_net=0)


@pytest.mark.parametrize('exchange', [False, True])
def test_included_zero_rows_and_duplicate_ids_do_not_disappear(exchange):
    fields = {'original_currency': 'USD', 'original_amount': 0, 'exchange_rate': '2'} if exchange else {}
    source = snapshot(expenses=[expense('same', 0, **fields), expense('same', 0, **fields)])
    _, workbook = assert_export(source, exchange=exchange, expected_net=0)
    rows = list(workbook['Transactions'].iter_rows(min_row=3, max_row=8, values_only=True))
    assert {row[0] for row in rows} == {1, 2}
    share_column = 13 if exchange else 10
    assert len(rows) == 6 and all(row[share_column] == 0 for row in rows)


def test_repeated_exports_switch_layouts_without_leaking_previous_columns_or_cache():
    local = expense()
    foreign = expense('foreign', 200, original_currency='USD', original_amount=100, exchange_rate='2')
    for expenses, exchange, net in [([local], False, 100), ([local, foreign], True, 300),
                                    ([foreign], True, 200), ([local], False, 100), ([], False, 0)]:
        assert_export(snapshot(expenses=expenses), exchange=exchange, expected_net=net)


def test_layout_selection_and_export_do_not_access_exchange_rate_services(monkeypatch):
    from services import exchange_rates, expense_conversion

    def unexpected(*_args, **_kwargs):
        raise AssertionError('Excel layout selection must use saved evidence without I/O')

    monkeypatch.setattr(exchange_rates, 'get_reference_rate', unexpected)
    monkeypatch.setattr(expense_conversion, 'load_quote', unexpected)
    source = snapshot(expenses=[expense(original_currency='USD', original_amount=50, exchange_rate='2')])
    data = build_report_data(source)
    before = deepcopy(data)
    assert select_excel_report_type(data) is ExcelReportType.MULTI_CURRENCY
    build_report_xlsx(data)
    assert data == before


def test_visible_original_amounts_preserve_historical_decimals_and_format_whole_units_cleanly():
    source = snapshot(expenses=[expense('old', original_currency='USD', original_amount=100.25, exchange_rate='1'),
                                expense('whole', original_currency='USD', original_amount=100, exchange_rate='1')])
    _, workbook = assert_export(source, exchange=True, expected_net=200)
    transactions = workbook['Transactions']
    assert transactions['K3'].value == 100.25 and transactions['K3'].number_format == '#,##0.###############'
    assert transactions['K6'].value == 100 and transactions['K6'].number_format == '#,##0'


@pytest.mark.parametrize('exchange', [False, True])
@pytest.mark.parametrize('simplify', [False, True])
def test_seeded_large_reports_keep_static_summary_totals_with_payments(exchange, simplify):
    rng = random.Random(20261107)
    expenses = []
    for number in range(120):
        amount = rng.randint(1, 100000) * (-1 if number % 7 == 0 else 1)
        fields = {'category': f'Category {number % 13}', 'split_mode': 'PER_FAMILY' if number % 2 else 'PER_CAPITA',
                  'date': f'{number % 28 + 1:02d}-10-26', 'paid_by_member_id': 'solo' if number % 3 else 'family'}
        if exchange:
            fields.update(original_currency=('USD', 'EUR', 'JPY')[number % 3], original_amount=amount,
                          exchange_rate='1', exchange_rate_provider='stored_reference')
        expenses.append(expense(f'expense-{number}', amount, **fields))
    source = replace(snapshot(expenses=expenses, simplify_debts=simplify), payments=(
        {'id': 'payment', 'from_member_id': 'solo', 'to_member_id': 'family', 'amount': 100, 'currency': 'INR'},))
    data, workbook = assert_export(source, exchange=exchange, expected_net=sum(row['amount'] for row in expenses))
    assert sum(row.balance for row in data.accounts) == 0
    rows, footer = members_detail_rows(workbook)
    assert footer[1] == data.net
    groups = {parent[0]: (parent, children) for parent, children in members_account_groups(workbook)}
    for account in data.accounts:
        row, children = groups[account.name]
        assert row[1:7] == (account.share, account.funded, account.before_settlements,
                            account.sent, account.received, account.balance)
        if account.kind == 'Family':
            assert sum(row[1] for row in children) == account.share
            assert all(row[2:6] == (None, None, None, None) for row in children)
        else:
            assert children == []
