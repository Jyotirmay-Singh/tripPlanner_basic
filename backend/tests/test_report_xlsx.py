"""Saved OOXML, cached native pivot, layout, and literal-text regression checks."""

import io
from collections import defaultdict
from dataclasses import replace
from datetime import datetime
from zipfile import ZipFile
from xml.etree import ElementTree as ET

import pytest
from openpyxl import load_workbook
from openpyxl.styles import Alignment
from openpyxl.utils.cell import range_boundaries

from scripts.generate_report_samples import sample_snapshot
from services.report_model import ReportSnapshot, build_report_data
from services.report_xlsx import build_report_xlsx, finalize_layout, money_cell
from services.report_formatting import BRAND, indian_number, indian_format


def exported(source=None):
    data = build_report_data(source or sample_snapshot())
    payload = build_report_xlsx(data)
    return data, load_workbook(io.BytesIO(payload)), payload


def test_native_pivot_cache_and_saved_totals_match_allocation_source():
    data, workbook, payload = exported()
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
    assert all(not sheet.merged_cells.ranges for sheet in workbook)
    assert all('ReportExpenses' not in sheet.tables for sheet in workbook)
    transactions = workbook['Transactions']
    assert transactions.tables['ReportAllocations'].ref == f'A2:T{2 + len(data.allocations)}'
    pivot = workbook['Summary']._pivots[0]
    assert pivot.cache.cacheSource.worksheetSource.name == 'ReportAllocations'
    assert pivot.cache.cacheSource.worksheetSource.sheet == 'Transactions'
    assert pivot.cache.saveData is True and pivot.cache.refreshOnLoad is False
    assert pivot.cache.recordCount == len(data.allocations)
    assert len(pivot.cache.records.r) == len(data.allocations)
    assert [field.x for field in pivot.rowFields] == [6, 7]
    assert [field.x for field in pivot.colFields] == [2]
    assert [field.fld for field in pivot.pageFields] == [1, 4]
    assert [(field.fld, field.subtotal) for field in pivot.dataFields] == [(10, 'sum')]
    assert pivot.rowGrandTotals and pivot.colGrandTotals and pivot.enableDrill
    assert pivot.pivotFields[6].defaultSubtotal
    assert not pivot.pivotFields[7].defaultSubtotal
    assert len(pivot.cache.cacheFields) == 20
    assert not {'Account ID', 'Person ID'} & {f.name for f in pivot.cache.cacheFields}

    # Independently group the serialised cache records using their shared-item indices.
    totals = defaultdict(int)
    for record in pivot.cache.records.r:
        items = record._fields
        category = pivot.cache.cacheFields[2].sharedItems._fields[items[2].v].v
        amount = pivot.cache.cacheFields[10].sharedItems._fields[items[10].v].v
        totals[category] += amount
    assert dict(totals) == data.category_totals
    sheet = workbook['Summary']
    grand = next(row for row in sheet if row[0].value == 'Grand Total')
    assert [cell.value for cell in grand[2:3 + len(data.categories)]] == [*[data.category_totals[c] for c in data.categories], data.net]
    assert len(pivot.rowItems) == len({(a.account_id, a.person_id) for a in data.allocations}) + len(data.accounts) + 1
    with ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
        assert 'xl/pivotTables/pivotTable1.xml' in names
        assert 'xl/pivotCache/pivotCacheRecords1.xml' in names
        assert not any(n.startswith('xl/charts/') for n in names)
        # Every produced XML part remains well formed.
        for name in names:
            if name.endswith('.xml') or name.endswith('.rels'):
                root = ET.fromstring(archive.read(name))
                if name.startswith('xl/worksheets/'):
                    assert root.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}mergeCells') is None


def test_new_export_includes_new_rows_in_named_source_and_cache():
    source = sample_snapshot()
    extra = {**source.expenses[0], 'id': 'new-record', 'amount': 24}
    data, workbook, _ = exported(replace(source, expenses=(*source.expenses, extra)))
    assert workbook['Summary']._pivots[0].cache.recordCount == len(data.allocations)
    assert any(row[11] == 'new-record' for row in workbook['Transactions'].values)
    assert len(data.allocations) > len(build_report_data(source).allocations)


@pytest.mark.parametrize('missing_date', [False, True])
def test_cache_type_flags_describe_the_saved_items_including_text_and_mixed_dates(missing_date):
    source = sample_snapshot()
    first = {**source.expenses[0], 'description': 'Long recorded description ' * 20}
    if missing_date:
        first['date'] = 'Date not recorded'
    _, workbook, _ = exported(replace(source, expenses=(first, *source.expenses[1:])))
    cache = workbook['Summary']._pivots[0].cache
    for field in cache.cacheFields:
        shared = field.sharedItems
        kinds = {item.tagname for item in shared._fields}
        assert shared.containsString == ('s' in kinds)
        assert shared.containsDate == ('d' in kinds)
        assert shared.containsNumber == ('n' in kinds)
        assert shared.containsBlank == ('m' in kinds)
        assert shared.containsSemiMixedTypes == ('s' in kinds)
        assert shared.containsMixedTypes == (len(kinds - {'m'}) > 1)
        assert shared.containsInteger == (
            'n' in kinds and not kinds & {'s', 'd'}
            and all(float(item.v).is_integer() for item in shared._fields if item.tagname == 'n'))
        assert shared.longText == any(item.tagname == 's' and len(item.v) > 255 for item in shared._fields)
    assert cache.cacheFields[3].sharedItems.longText
    assert cache.cacheFields[1].sharedItems.containsMixedTypes == missing_date


def test_prominent_pivot_shows_each_person_net_share_by_category_with_bold_totals():
    data, workbook, _ = exported()
    sheet = workbook['Summary']
    pivot = sheet._pivots[0]
    _, first, last_column, last_row = range_boundaries(pivot.location.ref)
    assert first == 15
    expected = defaultdict(lambda: defaultdict(int))
    for allocation in data.allocations:
        expected[allocation.account, allocation.person][allocation.category] += allocation.share
    saved = {}
    account = None
    for row in sheet.iter_rows(min_row=first + 2, max_row=last_row, max_col=last_column):
        assert row[-1].font.bold
        if row[1].value is not None:
            account = row[0].value or account
            saved[account, row[1].value] = [cell.value for cell in row[2:]]
        else:
            assert all(cell.font.bold for cell in row)
    assert saved == {key: [*[by_category[c] for c in data.categories], sum(by_category.values())]
                     for key, by_category in expected.items()}
    style = next(s for s in workbook._table_styles.tableStyle if s.name == pivot.pivotTableStyleInfo.name)
    last = next(element for element in style.tableStyleElement if element.type == 'lastColumn')
    assert workbook._differential_styles.styles[last.dxfId].font.bold


def test_transactions_have_complete_metadata_on_participating_rows_and_sortable_dates():
    data, workbook, _ = exported()
    rows = list(workbook['Transactions'].values)[2:2 + len(data.allocations)]
    for row, allocation in zip(rows, data.allocations):
        assert row[0:11] == (allocation.number, allocation.occurred_at, allocation.category, allocation.description,
                             allocation.entry_type, allocation.payer, allocation.account, allocation.person,
                             allocation.split_method, allocation.expense_amount, allocation.share)
        assert row[11] == allocation.expense_id
        assert isinstance(row[1], datetime)
    assert sum(row[10] for row in rows) == data.net
    exact = [r for r in rows if r[11] == 'e04']
    assert sorted(r[10] for r in exact) == [0, 1000, 1000, 1200]
    fx = next(r for r in rows if r[11] == 'e07')
    assert fx[12:15] == (100, 'USD', '82.000000000000')
    assert fx[15] == datetime(2026, 10, 2)
    assert fx[17] == 'manual'
    assert workbook['Transactions']['M3'].number_format == '#,##0'
    assert workbook['Transactions']['P3'].number_format == 'dd mmm yyyy'
    assert workbook['Transactions']['T3'].number_format == 'dd mmm yyyy'
    assert workbook['Transactions'].column_dimensions['L'].hidden
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


def test_pivot_replaces_chart_and_receiving_paying_colours_remain_semantic():
    _, workbook, _ = exported()
    assert not workbook['Summary']._charts
    rules = [rule for values in workbook['Members & Families'].conditional_formatting._cf_rules.values() for rule in values]
    assert {r.operator: r.dxf.font.color.rgb[-6:] for r in rules if r.type == 'cellIs' and r.dxf.fill} == {
        'greaterThan': '166534', 'lessThan': '991B1B', 'equal': '475569',
    }
    # Filtering a six-digit total down below one lakh must not display leading zeros.
    pivot_rules = [r for values in workbook['Summary'].conditional_formatting._cf_rules.values() for r in values]
    assert any(r.type == 'expression' and '<100000)' in r.formula[0] and r.dxf.numFmt.formatCode == '#,##0;(#,##0);0' for r in pivot_rules)


def test_account_totals_exclude_children_and_payments_keep_gross_source_totals():
    data, workbook, _ = exported()
    sheet = workbook['Members & Families']
    total = next(row for row in sheet.values if row[0] == 'Total')
    assert total[1:] == (data.net, data.net, 0, 12000, 12000, 0, None)
    family = next(row for row in sheet.values if row[0] == 'Patel family')
    assert family[1] == 82905 and family[4:6] == (2000, 9400)
    history = list(workbook['Payments'].values)
    assert next(r[2] for r in history if r[0] == 'History total') == 12000
    assert next(r[2] for r in history if r[0] == 'Recorded payments total') == 7000
    assert next(r[2] for r in history if r[0] == 'Legacy settlements total') == 5000
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


def test_empty_report_has_four_unmerged_tabs_no_dummy_pivot_source_and_no_chart():
    source = ReportSnapshot({'id': 'empty', 'name': 'Empty', 'members': [], 'currency': 'INR'})
    _, workbook, _ = exported(source)
    assert workbook.sheetnames == ['Summary', 'Members & Families', 'Transactions', 'Payments']
    assert not workbook['Summary']._pivots and not workbook['Summary']._charts
    assert not workbook['Transactions'].tables
    assert workbook['Transactions']['A3'].value == 'No expenses recorded'
    assert all(not sheet.merged_cells.ranges for sheet in workbook)
    assert [workbook['Summary'][cell].value for cell in ('B7', 'B8', 'B9')] == [0, 0, 0]
    assert any(row[0] == 'No expenses recorded' for row in workbook['Summary'].values)


def test_missing_date_matches_saved_source_and_native_cache():
    source = sample_snapshot()
    expenses = tuple({**e, 'date': 'unavailable'} for e in source.expenses)
    _, workbook, _ = exported(replace(source, expenses=expenses))
    pivot = workbook['Summary']._pivots[0]
    assert [item.v for item in pivot.cache.cacheFields[1].sharedItems._fields] == ['unavailable']
    assert workbook['Transactions']['B3'].value == 'unavailable'


def test_wide_category_pivot_has_no_unused_or_hidden_chart_source_columns():
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
    for account in data.accounts:
        saved = next(row for row in balances.values if row[0] == account.name)
        assert saved[1] == account.share and saved[6] == account.balance
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
    pivot = summary._pivots[0]
    assert pivot.dataCaption == f'Net expense share ({symbol})'
    assert pivot.dataFields[0].name == f'Net expense share ({symbol})'
    assert [c.value for c in workbook['Members & Families'][2][1:-1]] == [
        f'{label} ({symbol})' for label in ['Expense share', 'Net funded', 'Before settlements',
                                         'Settlements paid', 'Settlements received', 'Balance now']]
    assert workbook['Transactions']['J2'].value == f'Expense total ({symbol})'
    assert workbook['Transactions']['K2'].value == f'Expense share ({symbol})'
    assert workbook['Payments']['C2'].value == f'Amount ({symbol})'
    assert sum(a.share for a in data.allocations) == summary['B9'].value
    assert not any('₹' in str(c.value) or 'INR' in str(c.value)
                   for sheet in workbook for row in sheet for c in row)


def test_saved_pivot_axes_resolve_to_the_displayed_labels_and_values_after_reopen():
    data, workbook, _ = exported()
    # Exercise another save/reopen, not just the generator's in-memory definition.
    saved = io.BytesIO()
    workbook.save(saved)
    summary = load_workbook(io.BytesIO(saved.getvalue()))['Summary']
    pivot = summary._pivots[0]
    _, first, last_column, _ = range_boundaries(pivot.location.ref)

    def label(field, item_position):
        cache_index = pivot.pivotFields[field].items[item_position].x
        return pivot.cache.cacheFields[field].sharedItems._fields[cache_index].v

    # Source encounter order differs from the report's alphabetical category order.
    assert [i.v for i in pivot.cache.cacheFields[2].sharedItems._fields] != list(data.categories)
    assert [label(2, i) for i in range(len(data.categories))] == list(data.categories)
    assert [label(2, item.x[0].v) for item in pivot.colItems if item.t == 'data'] == list(data.categories)
    assert [summary.cell(first + 1, col).value for col in range(3, last_column)] == list(data.categories)
    assert summary.cell(first + 1, last_column).value == pivot.grandTotalCaption
    assert summary.cell(first, 1).value == pivot.dataFields[0].name == pivot.dataCaption

    expected = defaultdict(lambda: defaultdict(int))
    for record in pivot.cache.records.r:
        values = {col: pivot.cache.cacheFields[col].sharedItems._fields[record._fields[col].v].v
                  for col in (6, 7, 2, 10)}
        expected[values[6], values[7]][values[2]] += values[10]
    previous = []
    for row, item in enumerate(pivot.rowItems, first + 2):
        positions = previous[:item.r] + [index.v for index in item.x]
        if item.t == 'data':
            assert len(positions) == 2
            account, person = label(6, positions[0]), label(7, positions[1])
            assert summary.cell(row, 1).value == (None if item.r else account)
            assert summary.cell(row, 2).value == person
            totals = expected[account, person]
            assert [summary.cell(row, col).value for col in range(3, last_column + 1)] == [
                *[totals[category] for category in data.categories], sum(totals.values())]
        elif item.t == 'default':
            assert summary.cell(row, 1).value == label(6, positions[0]) + ' Total'
        previous = positions


def test_native_page_filters_and_refresh_formats_match_the_saved_cells():
    _, workbook, payload = exported()
    summary = workbook['Summary']
    pivot = summary._pivots[0]
    _, first, last_column, last = range_boundaries(pivot.location.ref)
    assert pivot.preserveFormatting and not pivot.useAutoFormatting
    assert not pivot.cache.invalid and not pivot.cache.backgroundQuery
    assert pivot.showHeaders and not pivot.compact and not pivot.outline
    assert not pivot.mergeItem
    assert (pivot.location.rowPageCount, pivot.location.colPageCount) == (2, 1)
    scope = summary.cell(first - 4, 1)
    assert scope.value == 'Filter scope: pivot only. Headline figures and other sheets show the full export.'
    style = next(style for style in workbook._table_styles.tableStyle if style.name == pivot.pivotTableStyleInfo.name)
    parts = {part.type: workbook._differential_styles.styles[part.dxfId] for part in style.tableStyleElement}
    for row, field in ((first - 3, 1), (first - 2, 4)):
        assert summary.cell(row, 1).value == pivot.cache.cacheFields[field].name
        assert summary.cell(row, 2).value == '(All)'
        for col, kind in ((1, 'pageFieldLabels'), (2, 'pageFieldValues')):
            cell = summary.cell(row, col)
            assert cell.fill == parts[kind].fill
            assert cell.font.color == parts[kind].font.color
            assert cell.font.bold
    assert summary.cell(last, last_column).fill == parts['totalRow'].fill
    worksheet_rules = [rule for area, rules in summary.conditional_formatting._cf_rules.items()
                       if area.pivot for rule in rules]
    with ZipFile(io.BytesIO(payload)) as archive:
        ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        styles = ET.fromstring(archive.read('xl/styles.xml'))
        number_formats = {int(fmt.attrib['numFmtId']): fmt.attrib['formatCode']
                          for fmt in styles.findall('s:numFmts/s:numFmt', ns)}
        for rule in worksheet_rules:
            if rule.dxf.numFmt:
                number_format = rule.dxf.numFmt
                assert number_format.numFmtId >= 164
                assert number_formats[number_format.numFmtId] == number_format.formatCode
        xml = ET.fromstring(archive.read('xl/pivotTables/pivotTable1.xml'))
        # openpyxl 3.1.5 discards conditionalFormats in TableDefinition.__init__
        # during import. Verify the actual delivered OOXML rather than that lossy reader.
        native_rules = xml.findall('s:conditionalFormats/s:conditionalFormat', ns)
        assert {r.priority for r in worksheet_rules} == {int(r.attrib['priority']) for r in native_rules}
        for rule in native_rules:
            assert rule.attrib['scope'] == 'data' and rule.attrib['type'] == 'all'
            areas = rule.findall('s:pivotAreas/s:pivotArea', ns)
            assert areas and all(area.attrib['type'] == 'data' and area.attrib['dataOnly'] == '1'
                                 and area.attrib['grandRow'] == '1' and area.attrib['grandCol'] == '1'
                                 for area in areas)
    assert all(s.sheet_properties.tabColor.rgb[-6:] == BRAND for s in workbook)


def test_filter_scope_and_page_fields_do_not_overlap_a_large_funding_table():
    source = sample_snapshot()
    members = [*source.trip['members'], *[
        {'id': f'extra-{i}', 'name': f'Additional account {i}', 'kind': 'individual'} for i in range(20)]]
    data, workbook, _ = exported(replace(source, trip={**source.trip, 'members': members}))
    summary = workbook['Summary']
    pivot = summary._pivots[0]
    _, first, _, _ = range_boundaries(pivot.location.ref)
    assert first - 4 > 4 + len(data.accounts)
    assert summary.cell(first - 4, 1).value.startswith('Filter scope:')
    assert summary.cell(4 + len(data.accounts), 4).value == 'Total'


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
    assert {row[11] for row in rows} == {expense['id'] for expense in data.snapshot.expenses}
    assert sum(row[9] for row in rows if row[9] > 0) == data.gross
    assert -sum(row[9] for row in rows if row[9] < 0) == data.money_back
    assert sum(row[9] for row in rows) == sum(row[10] for row in allocations) == data.net == workbook['Summary']['B9'].value
    assert sheet.tables['ReportAllocations'].ref == f'A2:T{2 + len(allocations)}'
    assert sheet.tables['ReportAllocations'].autoFilter.ref == sheet.tables['ReportAllocations'].ref
    fx = next(row for row in rows if row[11] == 'e07')
    assert fx[12:16] == (100, 'USD', '82.000000000000', datetime(2026, 10, 2))
    assert fx[17] == 'manual'
    assert sheet.column_dimensions['L'].hidden
    assert sheet.freeze_panes == 'A3'
    assert sheet.cell(3 + len(allocations), 11).value == data.net


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
    assert [r[11] for r in rows].count('duplicate') == 2
    assert len({r[0] for r in rows}) == len(expenses)
    assert any(r[9] == 0 and r[11] == 'rounded-zero' for r in rows)
    assert sum(r[10] for r in rows) == data.net == 190
    assert next(r[1] for r in rows if r[11] == 'money-back') == 'unavailable'
    assert all(sheet.cell(row, 2).number_format == 'dd mmm yyyy'
               for row in range(3, 8) if isinstance(sheet.cell(row, 2).value, datetime))


@pytest.mark.parametrize('labels', [('Food', 'food'), ('A' * 32768 + '1', 'A' * 32768 + '2'),
                                  ('Food\x00', 'Food\x01')])
def test_excel_text_limits_do_not_merge_pivot_categories_or_change_source_totals(labels):
    source = sample_snapshot()
    expenses = tuple({**source.expenses[0], 'id': str(index), 'amount': amount, 'category': label,
                      'description': 'Pasted\x00 text ' * 3000}
                     for index, (label, amount) in enumerate(zip(labels, (100, 200))))
    snapshot = ReportSnapshot({**source.trip, 'name': 'यात्रा 🚗\x00'}, expenses)
    data, workbook, _ = exported(snapshot)
    pivot = workbook['Summary']._pivots[0]
    categories = [item.v for item in pivot.cache.cacheFields[2].sharedItems._fields]
    assert len(categories) == len({category.casefold() for category in categories}) == 2
    assert all(len(category) <= 32767 and '\x00' not in category and '\x01' not in category for category in categories)
    allocations = list(workbook['Transactions'].iter_rows(min_row=3, max_row=2 + len(data.allocations), values_only=True))
    assert {row[2] for row in allocations} == set(categories)
    assert all(len(row[3]) <= 32767 and '\x00' not in row[3] for row in allocations)
    assert sum(row[10] for row in allocations) == workbook['Summary']['B9'].value == data.net == 300
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
    pivot = workbook['Summary']._pivots[0]
    accounts = [item.v for item in pivot.cache.cacheFields[6].sharedItems._fields]
    people = [item.v for item in pivot.cache.cacheFields[7].sharedItems._fields]
    assert len({name.casefold() for name in accounts}) == 2
    assert len({name.casefold() for name in people}) == 3
    assert set(accounts).issubset({row[0] for row in workbook['Members & Families'].values})
    assert all('\x00' not in name and '\x01' not in name for name in [*accounts, *people])
    assert sum(row[10] for row in list(workbook['Transactions'].values)[2:2 + len(data.allocations)]) == data.net
