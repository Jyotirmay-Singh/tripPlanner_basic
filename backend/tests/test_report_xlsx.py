"""Static Excel tables, financial totals, layout and literal-text regression checks."""

import io
from dataclasses import replace
from datetime import datetime

import pytest
from openpyxl import load_workbook
from openpyxl.styles import Alignment
from openpyxl.utils.cell import range_boundaries

from scripts.generate_report_samples import sample_snapshot
from services.report_model import ReportSnapshot, build_report_data
from services.report_xlsx import build_report_xlsx, finalize_layout, money_cell
from services.report_formatting import BRAND, indian_number, indian_format
from services.report_summary_table import FILTER_SCOPE
from report_excel_assertions import assert_static_category_table, assert_no_pivot_parts, category_table_rows, members_detail_rows, members_account_groups


def exported(source=None):
    data = build_report_data(source or sample_snapshot())
    payload = build_report_xlsx(data)
    return data, load_workbook(io.BytesIO(payload)), payload


def test_static_table_and_saved_totals_match_allocation_source():
    data, workbook, payload = exported()
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
    assert all(not sheet.merged_cells.ranges for sheet in workbook)
    assert all('ReportExpenses' not in sheet.tables for sheet in workbook)
    assert workbook['Transactions'].tables['ReportAllocations'].ref == f'A2:O{2 + len(data.allocations)}'
    assert_static_category_table(workbook, data.net)
    assert_no_pivot_parts(payload)
    assert not any(sheet._charts for sheet in workbook)

def test_new_export_includes_new_rows_in_source_and_static_summary():
    source = sample_snapshot()
    extra = {**source.expenses[0], 'id': 'new-record', 'amount': 24}
    data, workbook, _ = exported(replace(source, expenses=(*source.expenses, extra)))
    expense_number = next(a.number for a in data.allocations if a.expense_id == 'new-record')
    assert any(row[0] == expense_number for row in workbook['Transactions'].values)
    assert len(data.allocations) > len(build_report_data(source).allocations)
    assert_static_category_table(workbook, data.net)

@pytest.mark.parametrize('missing_date', [False, True])
def test_static_summary_handles_text_and_mixed_dates(missing_date):
    source = sample_snapshot()
    first = {**source.expenses[0], 'description': 'Long recorded description ' * 20}
    if missing_date:
        first['date'] = 'Date not recorded'
    data, workbook, payload = exported(replace(source, expenses=(first, *source.expenses[1:])))
    assert_static_category_table(workbook, data.net)
    assert_no_pivot_parts(payload)
    expense_number = next(a.number for a in data.allocations if a.expense_id == first['id'])
    row = next(row for row in workbook['Transactions'].values if row[0] == expense_number)
    assert row[3] == first['description']
    assert isinstance(row[1], str if missing_date else datetime)

def test_static_summary_shows_each_person_once_without_family_subtotals():
    data, workbook, _ = exported()
    assert_static_category_table(workbook, data.net)
    table, headings, rows, footer = category_table_rows(workbook)
    sheet = workbook['Summary']
    _, header, last_column, last = range_boundaries(table.ref)
    assert header == max(10, 4 + len(data.accounts)) + 4
    assert len(rows) == len({(a.account_id, a.person_id) for a in data.allocations})
    assert all(row[1] is not None for row in rows)
    for number in range(header + 1, last + 1):
        assert sheet.cell(number, last_column).font.bold
    assert all(sheet.cell(last + 1, column).font.bold for column in range(1, last_column + 1))
    assert all(sheet.cell(last + 1, column).fill.fgColor.rgb[-6:] == BRAND for column in range(1, last_column + 1))
    assert footer[-1] == data.net

def test_transactions_have_complete_metadata_on_participating_rows_and_sortable_dates():
    data, workbook, _ = exported()
    rows = list(workbook['Transactions'].values)[2:2 + len(data.allocations)]
    for row, allocation in zip(rows, data.allocations):
        assert row[0:9] == (allocation.number, allocation.occurred_at, allocation.category, allocation.description,
                             allocation.entry_type, allocation.payer, allocation.account, allocation.person,
                             allocation.split_method)
        assert row[9:12] == (allocation.original_currency,
                             float(allocation.original_amount) if allocation.original_amount is not None else None,
                             allocation.exchange_rate)
        assert row[12:14] == (allocation.expense_amount, allocation.share)
        assert row[14] == (datetime.combine(allocation.rate_date, datetime.min.time()) if allocation.rate_date else None)
        assert isinstance(row[1], datetime)
    assert sum(row[13] for row in rows) == data.net
    exact_number = next(a.number for a in data.allocations if a.expense_id == 'e04')
    exact = [r for r in rows if r[0] == exact_number]
    assert sorted(r[13] for r in exact) == [0, 1000, 1000, 1200]
    fx_number = next(a.number for a in data.allocations if a.expense_id == 'e07')
    fx = next(r for r in rows if r[0] == fx_number)
    assert fx[9:12] == ('USD', 100, '82.000000000000')
    assert fx[14] == datetime(2026, 10, 2)
    assert workbook['Transactions']['K3'].number_format == '#,##0'
    assert workbook['Transactions']['O3'].number_format == 'dd mmm yyyy'
    assert not any(dimension.hidden for dimension in workbook['Transactions'].column_dimensions.values())
    assert workbook['Transactions'].freeze_panes == 'A3'


def test_literal_user_text_cannot_become_excel_formulas_in_any_sheet():
    source = sample_snapshot()
    source.trip['name'] = '=1+2'
    source.trip['members'][0]['name'] = '=HYPERLINK("https://invalid.example")'
    expenses = tuple({**e, 'description': '=2+3', 'category': '=4+5'} for e in source.expenses)
    _, workbook, _ = exported(replace(source, expenses=expenses))
    formula_cells = [(s.title, c.coordinate) for s in workbook for row in s for c in row if c.data_type == 'f']
    assert formula_cells == []
    assert workbook['Summary']['A1'].value == '=1+2'
    assert any(row[2] == '=4+5' and row[3] == '=2+3' for row in workbook['Transactions'].values)


def test_static_summary_and_balances_keep_semantic_colours():
    _, workbook, _ = exported()
    assert not workbook['Summary']._charts
    rules = [rule for values in workbook['Members & Families'].conditional_formatting._cf_rules.values() for rule in values]
    assert {r.operator: r.dxf.font.color.rgb[-6:] for r in rules if r.type == 'cellIs' and r.dxf.fill} == {
        'greaterThan': '166534', 'lessThan': '991B1B', 'equal': '475569',
    }
    table, _, _, _ = category_table_rows(workbook)
    sheet = workbook['Summary']
    _, first, last_column, last = range_boundaries(table.ref)
    for row in sheet.iter_rows(min_row=first + 1, max_row=last, min_col=3, max_col=last_column):
        for cell in row:
            if cell.value < 0:
                assert cell.font.color.rgb[-6:] == '166534'
            assert cell.number_format == indian_format(cell.value)

def test_account_totals_exclude_children_and_payments_keep_single_total():
    data, workbook, _ = exported()
    sheet = workbook['Members & Families']
    rows, total = members_detail_rows(workbook)
    assert total[1:] == (data.net, data.net, 0, 12000, 12000, 0, None)
    groups = {parent[0]: (parent, children) for parent, children in members_account_groups(workbook)}
    parent, family = groups['Patel family']
    assert sum(row[1] for row in family) == parent[1] == 82905
    assert all(row[2:6] == (None, None, None, None) for row in family)
    assert all(row[0] != 'Patel family' for row in family)
    assert sum(parent[1] for parent, _ in groups.values()) == total[1]
    assert sum(parent[2] for parent, _ in groups.values()) == total[2]
    history = list(workbook['Payments'].values)
    assert [r[2] for r in history if r[0] == 'Total'] == [12000]
    assert not any(r[0] in ('History total', 'Recorded payments total', 'Legacy settlements total') for r in history)
    assert sum(r[2] for r in history if r[3] == 'Suggested') == data.outstanding
    assert sum(r[6] == 'payment-4' or r[6] == 'payment-5' for r in history) == 2
    assert not any(r[6] == 'legacy-pending' for r in history)


def test_numeric_indian_masks_and_long_labels_fit_without_converting_money_to_text():
    assert indian_number(272628) == '2,72,628'
    assert indian_number(-9876543210123) == '(98,76,54,32,10,123)'
    assert indian_format(272628) == r'0\,00\,000;(0\,00\,000);0'
    _, workbook, _ = exported()
    sheet = workbook['Summary']
    assert isinstance(sheet['B9'].value, int)
    assert r'\,' in sheet['B9'].number_format
    sheet['A70'] = 'Participant with a deliberately long display name ' * 4
    sheet['A70'].alignment = Alignment(wrap_text=True)
    cell = sheet.cell(70, 2, -9876543210123)
    money_cell(cell)
    finalize_layout(sheet, (2,))
    assert sheet.row_dimensions[70].height > 30
    assert sheet.column_dimensions['B'].width >= len(indian_number(cell.value)) + 3


def test_empty_report_has_four_unmerged_tabs_no_dummy_summary_table_and_no_chart():
    source = ReportSnapshot({'id': 'empty', 'name': 'Empty', 'members': [], 'currency': 'INR'})
    _, workbook, _ = exported(source)
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
    assert not workbook['Summary']._pivots and not workbook['Summary']._charts
    assert not workbook['Transactions'].tables
    assert workbook['Transactions']['A3'].value == 'No expenses recorded'
    assert all(not sheet.merged_cells.ranges for sheet in workbook)
    assert [workbook['Summary'][cell].value for cell in ('B7', 'B8', 'B9')] == [0, 0, 0]
    assert any(row[0] == 'No expenses recorded' for row in workbook['Summary'].values)
    assert [row[2] for row in workbook['Payments'].values if row[0] == 'Total'] == [0]


def test_missing_dates_remain_in_the_saved_source_and_static_totals():
    source = sample_snapshot()
    expenses = tuple({**e, 'date': 'unavailable'} for e in source.expenses)
    data, workbook, _ = exported(replace(source, expenses=expenses))
    assert_static_category_table(workbook, data.net)
    assert workbook['Transactions']['B3'].value == 'unavailable'

def test_wide_category_summary_has_no_unused_or_hidden_chart_source_columns():
    source = sample_snapshot()
    expenses = tuple({**source.expenses[0], 'id': str(i), 'category': f'Category {i:02d}', 'amount': 20}
                     for i in range(30))
    data, workbook, _ = exported(ReportSnapshot(source.trip, expenses))
    summary = workbook['Summary']
    assert not summary.column_dimensions['AA'].hidden
    assert summary.max_column == 33
    assert not any(dimension.hidden for dimension in summary.column_dimensions.values())
    assert not summary._charts
    grand = next(row for row in summary.values if row[0] == 'Grand Total')
    assert grand[32] == data.net


def test_an_unrecorded_time_is_displayed_as_a_date_without_invented_midnight():
    source = sample_snapshot()
    expenses = tuple({**e, 'time': None} for e in source.expenses)
    _, workbook, _ = exported(replace(source, expenses=expenses))
    assert workbook['Transactions']['B3'].number_format == 'dd mmm yyyy'


def test_report_is_compact_and_omits_adjustments_and_notes():
    source = replace(sample_snapshot(), financial_review=('Internal correction evidence',))
    data, workbook, _ = exported(source)
    values = [c.value for row in workbook['Summary'] for c in row if isinstance(c.value, str)]
    assert not {'Members', 'Share code', 'Currency', 'Exported at (IST)'} & set(values)
    assert data.metadata.share_code not in values
    assert not any('Whole-history snapshot' in value for value in values)
    assert workbook['Summary']['A5'].value == 'Budget (₹)'
    assert workbook['Summary']['B9'].value == data.net
    assert 'Adjustments' not in workbook.sheetnames
    balances = workbook['Members & Families']
    assert balances['G2'].value == 'Balance now (₹)'
    # Hiding adjustment presentation must not change the authoritative final balances or shares.
    detail, total = members_detail_rows(workbook)
    groups = {parent[0]: (parent, children) for parent, children in members_account_groups(workbook)}
    for account in data.accounts:
        saved, children = groups[account.name]
        assert saved[1:7] == (account.share, account.funded, account.before_settlements,
                              account.sent, account.received, account.balance)
        if account.kind == 'Family':
            assert sum(row[1] for row in children) == account.share
            assert all(row[2:6] == (None, None, None, None) for row in children)
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
    frozen_headers = {'Summary': None, 'Members & Families': 'A3', 'Transactions': 'A3', 'Payments': 'A3'}
    for sheet in workbook:
        assert sheet.freeze_panes == frozen_headers[sheet.title]
        if sheet.title == 'Summary':
            assert sheet.sheet_view.pane is None
        strings = [c.value for row in sheet for c in row if isinstance(c.value, str)]
        assert not any('reconciliation notes' in s.lower() or s.startswith('Adjustments') or 'Internal correction evidence' in s for s in strings)
        assert 'Note' not in strings
        assert sum(not any(c.value is not None for c in row) for row in sheet) <= 1
    assert not any(c.hyperlink for sheet in workbook for row in sheet for c in row)


@pytest.mark.parametrize('currency,symbol', [('AED', 'AED'), ('EUR', '€')])
def test_each_financial_section_uses_the_trip_currency(currency, symbol):
    source = sample_snapshot()
    data, workbook, _ = exported(replace(source, trip={**source.trip, 'currency': currency}))
    summary = workbook['Summary']
    assert summary['A5'].value == f'Budget ({symbol})'
    assert summary['B6'].value == f'Amount ({symbol})'
    assert [summary.cell(row, 1).value for row in range(7, 11)] == [
        'Gross spending', 'Money back', 'Net spending', 'Still to settle']
    funding_header = next(row for row in summary.values if row[3] == 'Account')
    assert funding_header[4:7] == tuple(
        f'{label} ({symbol})' for label in ['Gross funded', 'Money back', 'Net funded'])
    table, _, _, _ = category_table_rows(workbook)
    _, header, _, _ = range_boundaries(table.ref)
    assert summary.cell(header - 2, 1).value == f'Net expense share ({symbol})'
    assert [c.value for c in workbook['Members & Families'][2][1:-1]] == [
        f'{label} ({symbol})' for label in ['Expense share', 'Net funded', 'Before settlements',
                                         'Settlements paid', 'Settlements received', 'Balance now']]
    assert workbook['Transactions']['M2'].value == f'Expense total ({symbol})'
    assert workbook['Transactions']['N2'].value == f'Expense share ({symbol})'
    assert workbook['Payments']['C2'].value == f'Amount ({symbol})'
    assert sum(a.share for a in data.allocations) == summary['B9'].value
    assert not any('₹' in str(c.value) or 'INR' in str(c.value)
                   for sheet in workbook for row in sheet for c in row)


def test_static_table_reconciles_person_category_values_after_reopen():
    data, workbook, _ = exported()
    assert_static_category_table(workbook, data.net)
    _, headings, _, _ = category_table_rows(workbook)
    assert [cell.value for cell in headings[2:-1]] == list(data.categories)

def test_static_table_uses_normal_filters_and_fixed_full_report_footer():
    data, workbook, payload = exported()
    table, headings, _, footer = category_table_rows(workbook)
    sheet = workbook['Summary']
    _, header, last_column, last = range_boundaries(table.ref)
    assert sheet.cell(header - 1, 1).value == FILTER_SCOPE
    assert sheet.cell(header - 2, 1).value == 'Net expense share (₹)'
    assert footer[-1] == data.net and sheet.cell(last + 1, last_column).data_type == 'n'
    assert table.autoFilter.ref == table.ref
    assert_no_pivot_parts(payload)
    assert not any(cell.value == '(All)' for row in sheet for cell in row)
    assert all(s.sheet_properties.tabColor.rgb[-6:] == BRAND for s in workbook)

def test_static_summary_does_not_overlap_a_large_funding_table():
    source = sample_snapshot()
    members = [*source.trip['members'], *[
        {'id': f'extra-{i}', 'name': f'Additional account {i}', 'kind': 'individual'} for i in range(20)]]
    data, workbook, _ = exported(replace(source, trip={**source.trip, 'members': members}))
    table, _, _, _ = category_table_rows(workbook)
    _, header, _, _ = range_boundaries(table.ref)
    assert header - 2 > 4 + len(data.accounts)
    assert workbook['Summary'].cell(header - 1, 1).value == FILTER_SCOPE
    assert workbook['Summary'].cell(4 + len(data.accounts), 4).value == 'Total'

def test_transactions_retain_each_expense_and_reconcile_all_signed_totals():
    data, workbook, _ = exported()
    sheet = workbook['Transactions']
    allocations = list(sheet.iter_rows(min_row=3, max_row=2 + len(data.allocations), values_only=True))
    expenses = {}
    for row in allocations:
        expenses.setdefault(row[0], row)
    rows = list(expenses.values())
    assert len(rows) < len(allocations)
    assert len({row[0] for row in rows}) == len(data.snapshot.expenses)
    assert {row[0] for row in rows} == {allocation.number for allocation in data.allocations}
    assert sum(row[12] for row in rows if row[12] > 0) == data.gross
    assert -sum(row[12] for row in rows if row[12] < 0) == data.money_back
    assert sum(row[12] for row in rows) == sum(row[13] for row in allocations) == data.net == workbook['Summary']['B9'].value
    assert sheet.tables['ReportAllocations'].ref == f'A2:O{2 + len(allocations)}'
    assert sheet.tables['ReportAllocations'].autoFilter.ref == sheet.tables['ReportAllocations'].ref
    fx_number = next(a.number for a in data.allocations if a.expense_id == 'e07')
    fx = next(row for row in rows if row[0] == fx_number)
    assert fx[9:12] == ('USD', 100, '82.000000000000')
    assert fx[14] == datetime(2026, 10, 2)
    assert not any(dimension.hidden for dimension in sheet.column_dimensions.values())
    assert sheet.freeze_panes == 'A3'
    assert sheet.cell(3 + len(allocations), 14).value == data.net


def test_transactions_retain_distinct_records_with_missing_or_duplicate_ids_and_zero_rounding():
    trip = {'id': 'register-boundaries', 'name': 'Register boundaries', 'currency': 'INR',
            'members': [{'id': 'a', 'name': 'A', 'kind': 'individual'}]}
    base = {'paid_by_member_id': 'a', 'split_member_ids': ['a'], 'date': '2026-11-01', 'category': 'Food'}
    expenses = tuple({**base, **fields} for fields in (
        {'id': 'duplicate', 'amount': 100},
        {'id': 'duplicate', 'amount': 100},
        {'amount': 0},
        {'id': 'rounded-zero', 'amount': 0.1},
        {'id': 'money-back', 'amount': -10, 'date': 'unavailable'},
    ))
    data, workbook, _ = exported(ReportSnapshot(trip, expenses))
    sheet = workbook['Transactions']
    rows = list(sheet.iter_rows(min_row=3, max_row=7, values_only=True))
    assert len(rows) == len(expenses)
    assert [r[-2] for r in rows].count(100) == 2
    assert len({r[0] for r in rows}) == len(expenses)
    zero_number = next(a.number for a in data.allocations if a.expense_id == 'rounded-zero')
    assert any(r[-2] == 0 and r[0] == zero_number for r in rows)
    assert sum(r[10] for r in rows) == data.net == 190
    refund_number = next(a.number for a in data.allocations if a.expense_id == 'money-back')
    assert next(r[1] for r in rows if r[0] == refund_number) == 'unavailable'
    assert all(sheet.cell(row, 2).number_format == 'dd mmm yyyy'
               for row in range(3, 8) if isinstance(sheet.cell(row, 2).value, datetime))


@pytest.mark.parametrize('labels', [('Food', 'food'), ('A' * 32768 + '1', 'A' * 32768 + '2'),
                                  ('Food\x00', 'Food\x01')])
def test_excel_text_limits_do_not_merge_category_headers_or_change_source_totals(labels):
    source = sample_snapshot()
    expenses = tuple({**source.expenses[0], 'id': str(index), 'amount': amount, 'category': label,
                      'description': 'Pasted\x00 text ' * 3000}
                     for index, (label, amount) in enumerate(zip(labels, (100, 200))))
    snapshot = ReportSnapshot({**source.trip, 'name': 'यात्रा 🚗\x00'}, expenses)
    data, workbook, _ = exported(snapshot)
    _, headings, _, _ = category_table_rows(workbook)
    categories = [cell.comment.text if cell.comment else cell.value for cell in headings[2:-1]]
    assert len(categories) == len({category.casefold() for category in categories}) == 2
    assert all(len(cell.value.encode('utf-16-le')) <= 510 for cell in headings)
    assert all(len(category) <= 32767 and '\x00' not in category and '\x01' not in category for category in categories)
    allocations = list(workbook['Transactions'].iter_rows(min_row=3, max_row=2 + len(data.allocations), values_only=True))
    assert {row[2] for row in allocations} == set(categories)
    assert all(len(row[3]) <= 32767 and '\x00' not in row[3] for row in allocations)
    assert sum(row[-1] for row in allocations) == workbook['Summary']['B9'].value == data.net == 300
    assert snapshot.trip['name'] == 'यात्रा 🚗\x00'
    assert snapshot.expenses == expenses
    for sheet in workbook:
        assert all(dimension.height <= 409.5 for dimension in sheet.row_dimensions.values())
    assert workbook['Summary']['A1'].value == 'यात्रा 🚗\ufffd'


def test_sanitised_account_and_person_labels_remain_distinct_across_all_sheets():
    trip = {'id': 'text-boundaries', 'name': 'Text', 'currency': 'INR', 'members': [
        {'id': 'a\x00', 'name': 'Same\x00', 'kind': 'family',
         'family_member_ids': ['p\x00', 'p\x01'], 'family_members': ['Person\x00', 'Person\x01']},
        {'id': 'a\x01', 'name': 'Same\x01', 'kind': 'individual'},
    ]}
    expenses = ({'id': 'expense', 'amount': 300, 'category': 'Food', 'description': 'Lunch',
                 'date': '2026-11-01', 'paid_by_member_id': 'a\x00', 'split_member_ids': ['a\x00', 'a\x01']},)
    data, workbook, _ = exported(ReportSnapshot(trip, expenses))
    _, _, summary_rows, _ = category_table_rows(workbook)
    accounts = {row[0] for row in summary_rows}
    people = {row[1] for row in summary_rows}
    assert len({name.casefold() for name in accounts}) == 2
    assert len({name.casefold() for name in people}) == 3
    assert set(accounts).issubset({row[0] for row in workbook['Members & Families'].values})
    assert all('\x00' not in name and '\x01' not in name for name in [*accounts, *people])
    assert sum(row[10] for row in list(workbook['Transactions'].values)[2:2 + len(data.allocations)]) == data.net
