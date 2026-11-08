"""Static-table behavior for changing dates/categories and flat family detail rows."""

from copy import deepcopy
from dataclasses import replace
import io

from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries
import pytest

from services.report_model import ReportSnapshot, build_report_data
from services.report_xlsx import build_report_xlsx
from report_excel_assertions import (
    assert_no_pivot_parts, assert_static_category_table, category_table_rows, members_detail_rows, members_account_groups,
)


MEMBERS = [
    {'id': 'f', 'name': 'Shah family', 'kind': 'family', 'family_member_ids': ['p2', 'p1'],
     'family_members': ['Ben', 'Ana']},
    {'id': 's', 'name': 'Sam', 'kind': 'individual'},
    {'id': 'g', 'name': 'Roy family', 'kind': 'family', 'family_member_ids': ['p3', 'p4'],
     'family_members': ['Ana', 'Tara']},
]


def source_snapshot(exchange=False):
    expenses = []
    for identity, amount, category, split, date in (
        ('a', 120, 'Food', 'PER_CAPITA', '01-11-26'),
        ('b', 90, 'Transport', 'PER_FAMILY', '02-11-26'),
        ('c', -30, 'Food', 'PER_CAPITA', '03-11-26'),
        ('d', 50, 'Tickets', 'EXACT', '04-11-26'),
    ):
        expenses.append({'id': identity, 'amount': amount, 'currency': 'INR', 'date': date,
                         'category': category, 'paid_by_member_id': 'f', 'split_member_ids': ['f', 's', 'g'],
                         'split_mode': split,
                         **({'custom_amounts': {'p1': 20, 'p2': 0, 'p3': 30}} if split == 'EXACT' else {}),
                         **({'original_currency': 'USD', 'original_amount': amount // 2,
                             'exchange_rate': '2', 'exchange_rate_provider': 'stored_reference',
                             'exchange_rate_mode': 'automatic'} if exchange else {})})
    return ReportSnapshot({'id': 'static', 'name': 'Static report controls', 'currency': 'INR',
                           'members': deepcopy(MEMBERS)}, tuple(expenses))


def exported(source):
    original = deepcopy(source)
    data = build_report_data(source)
    payload = build_report_xlsx(data)
    workbook = load_workbook(io.BytesIO(payload))
    assert source == original
    assert_static_category_table(workbook, data.net)
    assert_no_pivot_parts(payload)
    return data, workbook


@pytest.mark.parametrize('exchange', [False, True])
def test_hand_calculated_person_category_matrix_and_roster_order(exchange):
    data, workbook = exported(source_snapshot(exchange))
    _, headers, rows, footer = category_table_rows(workbook)
    assert [cell.value for cell in headers] == ['Family / account', 'Person', 'Food', 'Tickets', 'Transport', 'Grand Total']
    assert rows == [
        ('Shah family', 'Ben', 18, 0, 15, 33),
        ('Shah family', 'Ana', 18, 20, 15, 53),
        ('Sam', 'Sam', 18, 0, 30, 48),
        ('Roy family', 'Ana', 18, 30, 15, 63),
        ('Roy family', 'Tara', 18, 0, 15, 33),
    ]
    assert footer == ('Grand Total', None, 90, 50, 90, 230)
    assert data.net == 230


@pytest.mark.parametrize('exchange', [False, True])
@pytest.mark.parametrize('dates', [
    ['31-12-25', '01-01-26', '31-12-26', '01-01-27'],
    ['2024-02-29', '2026-01-02', '2026-08-30', '2026-11-08'],
    ['unavailable', None, '', 'Date not recorded'],
    ['04-11-26', '03-11-26', '02-11-26', '01-11-26'],
])
def test_variable_dates_and_expense_order_do_not_change_category_matrix(exchange, dates):
    source = source_snapshot(exchange)
    _, baseline = exported(source)
    expenses = tuple({**expense, 'date': date} for expense, date in zip(source.expenses, dates))
    _, changed = exported(replace(source, expenses=tuple(reversed(expenses))))
    assert category_table_rows(changed)[2:] == category_table_rows(baseline)[2:]


@pytest.mark.parametrize('exchange', [False, True])
def test_repeated_exports_rebuild_added_removed_and_renamed_categories(exchange):
    source = source_snapshot(exchange)
    for categories in [('Food', 'Transport', 'Food', 'Tickets'),
                       ('Meals', 'Travel', 'Meals', 'Activities'),
                       ('One category',) * 4]:
        expenses = tuple({**expense, 'category': category} for expense, category in zip(source.expenses, categories))
        _, workbook = exported(replace(source, expenses=expenses))
        _, headers, _, _ = category_table_rows(workbook)
        assert [cell.value for cell in headers[2:-1]] == sorted(set(categories))
    _, workbook = exported(replace(source, expenses=source.expenses[:1]))
    assert [cell.value for cell in category_table_rows(workbook)[1][2:-1]] == ['Food']


@pytest.mark.parametrize('exchange', [False, True])
@pytest.mark.parametrize('category', [
    'Family / account', 'family / account', 'Person', 'person', 'Grand Total', 'grand total',
    'Grand Total (category)', 'A' * 300, '🧳' * 200, '=1+1', '<Food & drinks>\x00', 'pivotTable',
])
def test_reserved_long_unicode_and_literal_category_headers_are_safe(exchange, category):
    source = source_snapshot(exchange)
    _, workbook = exported(replace(source, expenses=({**source.expenses[0], 'category': category},)))
    _, headings, _, _ = category_table_rows(workbook)
    assert all(cell.data_type == 's' for cell in headings)
    if category.casefold() in {'family / account', 'person', 'grand total'} or len(category.encode('utf-16-le')) > 510:
        assert headings[2].comment.text == category


def test_colliding_shortened_headers_keep_their_own_values_and_full_comments():
    source = source_snapshot()
    labels = ['A' * 300 + 'X', 'A' * 300 + 'Y', '🧳' * 200 + 'X', '🧳' * 200 + 'Y']
    _, workbook = exported(replace(source, expenses=tuple({**expense, 'category': label}
                                                        for expense, label in zip(source.expenses, labels))))
    _, headings, _, _ = category_table_rows(workbook)
    assert {cell.comment.text for cell in headings[2:-1]} == set(labels)


@pytest.mark.parametrize('exchange', [False, True])
@pytest.mark.parametrize('category', [None, '', '  '])
def test_missing_categories_use_the_existing_uncategorized_label(exchange, category):
    source = source_snapshot(exchange)
    _, workbook = exported(replace(source, expenses=({**source.expenses[0], 'category': category},)))
    assert category_table_rows(workbook)[1][2].value == 'Uncategorized'


@pytest.mark.parametrize('exchange', [False, True])
def test_family_account_totals_precede_indented_details_and_footer_reconciles(exchange):
    source = replace(source_snapshot(exchange), payments=(
        {'id': 'cash', 'from_member_id': 's', 'to_member_id': 'f', 'amount': 10},))
    data, workbook = exported(source)
    sheet = workbook['Members & Families']
    assert [cell.value for cell in sheet[2]] == [
        'Name', 'Expense share (₹)', 'Net funded (₹)', 'Before settlements (₹)',
        'Settlements paid (₹)', 'Settlements received (₹)', 'Balance now (₹)', 'Action']
    assert sheet.max_column == 8 and sheet.freeze_panes == 'A3'
    rows, footer = members_detail_rows(workbook)
    assert len(rows) == 7
    groups = {parent[0]: (parent, children) for parent, children in members_account_groups(workbook)}
    for account in data.accounts:
        saved, children = groups[account.name]
        assert saved == (account.name, account.share, account.funded, account.before_settlements,
                         account.sent, account.received, account.balance, account.action)
        if account.kind == 'Family':
            assert [row[0] for row in children] == [person.name for person in data.member_positions
                                                   if person.account_id == account.account_id]
            assert all(row[2:6] == (None, None, None, None) for row in children)
            assert all(row[7] == 'Within family total' for row in children)
            assert sum(row[1] for row in children) == account.share
            assert sum(row[6] for row in children) == account.balance
        else:
            assert children == []
    for row in sheet.iter_rows(min_row=3, max_row=sheet.max_row - 1):
        if row[2].value is not None:
            assert all(cell.fill.fgColor.rgb[-6:] == 'EAF0EE' and cell.font.bold for cell in row)
            assert row[4].font.color.rgb[-6:] == '991B1B'
            assert row[5].font.color.rgb[-6:] == '166534'
        else:
            assert row[0].alignment.indent == 2 and not row[0].font.bold
    assert footer == ('Total', 230, 230, 0, 10, 10, 0, None)
    number = sheet.max_row
    assert all(cell.fill.fgColor.rgb[-6:] == '1C3F39' and cell.font.bold for cell in sheet[number])
    assert all(cell.font.color.rgb[-6:] == 'FFFFFF' for cell in sheet[number])
    assert str(sheet.print_area).endswith(f'$H${number}')
    assert all(any(value is not None for value in row) for row in sheet.values)
    assert not sheet.merged_cells.ranges
    assert not any(dimension.outlineLevel for dimension in sheet.row_dimensions.values())


def test_historical_people_and_accounts_are_retained_without_fabricated_funding():
    source = ReportSnapshot({'id': 'historical', 'name': 'Historical controls', 'currency': 'INR',
                             'members': [{'id': 's', 'name': 'Sam', 'kind': 'individual'}]}, (
        {'id': 'old', 'amount': 100, 'category': 'Food', 'date': '01-11-26', 'paid_by_member_id': 's',
         'split_member_ids': ['old-family', 's'], 'split_mode': 'EXACT',
         'custom_amounts': {'old-person': 40, 's': 60}},), payments=(
        {'id': 'paid', 'from_member_id': 'old-family', 'to_member_id': 's', 'amount': 40},))
    data, workbook = exported(source)
    rows, footer = members_detail_rows(workbook)
    account = next(account for account in data.accounts if account.kind == 'Historical')
    assert any(row[0] == account.name and row[6] == account.balance for row in rows)
    person = next(row for row in rows if row[7] == 'Historical share only')
    assert person[1] == 40 and person[2:7] == (None, None, None, None, None)
    assert footer[1] == data.net == 100


def test_filters_and_local_source_edits_do_not_recalculate_fixed_summary_values():
    _, workbook = exported(source_snapshot())
    sheet = workbook['Summary']
    table, headings, rows, footer = category_table_rows(workbook)
    before = (tuple(cell.value for cell in headings), rows, footer)
    table.autoFilter.add_filter_column(0, ['Shah family'])
    _, header, last_column, last = range_boundaries(table.ref)
    table.autoFilter.add_sort_condition(f'C{header + 1}:C{last}')
    workbook['Transactions']['K3'] = 999999
    output = io.BytesIO()
    workbook.save(output)
    reopened = load_workbook(io.BytesIO(output.getvalue()))
    _, headers, after_rows, after_footer = category_table_rows(reopened)
    assert (tuple(cell.value for cell in headers), after_rows, after_footer) == before
    assert sheet.cell(last + 1, last_column).value == 230


@pytest.mark.parametrize('exchange', [False, True])
def test_exact_zero_participants_remain_in_the_static_table(exchange):
    source = source_snapshot(exchange)
    _, workbook = exported(replace(source, expenses=source.expenses[-1:]))
    _, _, rows, footer = category_table_rows(workbook)
    assert ('Shah family', 'Ben', 0, 0) in rows
    assert len(rows) == 3 and footer[-1] == 50
