"""Round-trip both automatic Excel layouts and independently reconcile their saved sources."""

from collections import defaultdict
from copy import deepcopy
from dataclasses import replace
import io
import random
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from bson.decimal128 import Decimal128
from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries
import pytest

from services.report_excel_layout import ExcelReportType, select_excel_report_type
from services.report_model import ReportSnapshot, build_report_data
from services.report_xlsx import build_report_xlsx
from utils.currency_rules import SUPPORTED_CURRENCIES


MEMBERS = [
    {'id': 'family', 'name': 'Shah family', 'kind': 'family',
     'family_member_ids': ['p1', 'p2'], 'family_members': ['Ana', 'Ben']},
    {'id': 'solo', 'name': 'Sam', 'kind': 'individual'},
]
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


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
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Expense Register', 'Transactions', 'Payments']
    assert workbook.properties.subject.endswith('multi_currency' if exchange else 'single_currency')
    transactions, register = workbook['Transactions'], workbook['Expense Register']
    transaction_width, register_width = (20, 17) if exchange else (12, 9)
    assert (transactions.max_column, register.max_column) == (transaction_width, register_width)
    assert transactions.freeze_panes == 'A3' and register.freeze_panes == 'A7'
    assert workbook['Summary'].freeze_panes is None
    assert transactions.column_dimensions['L'].hidden and register.column_dimensions['I'].hidden
    assert not any(cell.data_type == 'f' for sheet in workbook for row in sheet for cell in row)
    header = [cell.value for cell in transactions[2]]
    register_header = [cell.value for cell in register[6]]
    assert ('Original currency' in header) is exchange
    assert ('Original currency' in register_header) is exchange
    if exchange:
        assert register['L6'].value == transactions['O2'].value == f'Stored rate ({data.currency} per original unit)'
        for sheet, columns in ((register, ('J', 'K', 'L')), (transactions, ('M', 'N', 'O'))):
            assert all(not sheet.column_dimensions[column].hidden for column in columns)
        assert register.column_dimensions['M'].hidden and transactions.column_dimensions['P'].hidden
        assert 'M:Q' in register['A5'].value
    else:
        assert 'rate' not in register['A5'].value.lower()
        assert not any('Original ' in name or 'rate' in name.lower() for name in header)
        assert max(dimension.max for dimension in transactions.column_dimensions.values()) <= 12
        assert max(dimension.max for dimension in register.column_dimensions.values()) <= 9
    assert f'${"O" if exchange else "K"}$' in str(transactions.print_area)
    assert f'${"L" if exchange else "H"}$' in str(register.print_area)
    if not data.allocations:
        assert not transactions.tables and not register.tables and not workbook['Summary']._pivots
        assert register['A7'].value == 'No expenses recorded'
        return data, workbook
    row_count = len(data.allocations)
    table = transactions.tables['ReportAllocations']
    assert range_boundaries(table.ref) == (1, 2, transaction_width, row_count + 2)
    assert len(table.tableColumns) == transaction_width
    assert table.autoFilter.ref == table.ref
    rows = list(transactions.iter_rows(min_row=3, max_row=row_count + 2, values_only=True))
    expected_rows = len({row.number for row in data.allocations})
    register_table = register.tables['ReportExpenses']
    assert range_boundaries(register_table.ref) == (1, 6, register_width, expected_rows + 6)
    assert len(register_table.tableColumns) == register_width
    assert register_table.autoFilter.ref == register_table.ref
    register_rows = list(register.iter_rows(min_row=7, max_row=expected_rows + 6, values_only=True))
    assert sum(row[7] for row in register_rows) == sum(row[10] for row in rows) == expected_net
    assert sum(row[7] for row in register_rows if row[7] > 0) == data.gross
    assert -sum(row[7] for row in register_rows if row[7] < 0) == data.money_back
    pivot = workbook['Summary']._pivots[0]
    assert [field.name for field in pivot.cache.cacheFields] == header
    assert len(pivot.pivotFields) == transaction_width
    assert pivot.cache.recordCount == len(rows)
    assert pivot.cache.cacheSource.worksheetSource.name == 'ReportAllocations'
    assert pivot.cache.enableRefresh and not pivot.cache.refreshOnLoad
    totals = defaultdict(int)
    for record, row in zip(pivot.cache.records.r, rows, strict=True):
        assert len(record._fields) == transaction_width
        decoded = tuple(pivot.cache.cacheFields[col].sharedItems._fields[index.v].v
                        if pivot.cache.cacheFields[col].sharedItems._fields[index.v].tagname != 'm' else None
                        for col, index in enumerate(record._fields))
        # Excel stores empty text cells without a value; openpyxl reloads them as None.
        assert tuple(None if value == '' else value for value in decoded) == row
        totals[row[2]] += row[10]
    assert dict(totals) == data.category_totals
    for index in [*(field.x for field in pivot.rowFields), *(field.x for field in pivot.colFields),
                  *(field.fld for field in pivot.pageFields), *(field.fld for field in pivot.dataFields)]:
        assert 0 <= index < transaction_width
    with ZipFile(io.BytesIO(payload)) as archive:
        cache = ET.fromstring(archive.read('xl/pivotCache/pivotCacheDefinition1.xml'))
        assert int(cache.find('s:cacheFields', NS).get('count')) == transaction_width
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(archive.read(name))
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
    ({'original_currency': 'INR', 'exchange_rate': '0.5'}, True),
    ({'original_currency': 'INR', 'exchange_rate': 'unavailable'}, True),
    ({'original_currency': 'INR', 'exchange_rate': 'NaN'}, True),
    ({'original_currency': 'INR', 'exchange_rate': '1', 'exchange_rate_provider': 'manual'}, True),
    ({'original_currency': 'INR', 'exchange_rate': '1', 'exchange_rate_mode': 'manual'}, True),
])
def test_uncertain_historical_evidence_remains_available(fields, exchange):
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
    assert workbook['Expense Register']['D7'].data_type == 's'
    assert '\x00' not in workbook['Expense Register']['D7'].value
    assert workbook['Expense Register'].row_dimensions[7].height <= 409.5


@pytest.mark.parametrize('members', [[], MEMBERS])
def test_empty_groups_use_compact_layout_without_dummy_tables_or_exchange_fields(members):
    assert_export(snapshot(expenses=[], members=members), exchange=False, expected_net=0)


@pytest.mark.parametrize('exchange', [False, True])
def test_included_zero_rows_and_duplicate_ids_do_not_disappear(exchange):
    fields = {'original_currency': 'USD', 'original_amount': 0, 'exchange_rate': '2'} if exchange else {}
    source = snapshot(expenses=[expense('same', 0, **fields), expense('same', 0, **fields)])
    _, workbook = assert_export(source, exchange=exchange, expected_net=0)
    assert workbook['Expense Register']['I7'].value == workbook['Expense Register']['I8'].value == 'same'


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
    register = workbook['Expense Register']
    assert register['J7'].value == 100.25 and register['J7'].number_format == '#,##0.###############'
    assert register['J8'].value == 100 and register['J8'].number_format == '#,##0'


@pytest.mark.parametrize('exchange', [False, True])
@pytest.mark.parametrize('simplify', [False, True])
def test_seeded_large_reports_keep_register_and_pivot_totals_with_payments(exchange, simplify):
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
    for account in data.accounts:
        row = next(row for row in workbook['Members & Families'].values if row[0] == account.name)
        assert row[1] == account.share and row[6] == account.balance
