"""Independent controls against the actual rows saved in an exported workbook."""

from collections import defaultdict
from xml.etree import ElementTree as ET
from zipfile import ZipFile
import io

from openpyxl.utils.cell import range_boundaries


NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def category_table_rows(workbook):
    sheet = workbook['Summary']
    table = sheet.tables['ReportCategoryShares']
    first_column, header, last_column, last = range_boundaries(table.ref)
    assert first_column == 1
    headings = list(sheet.iter_rows(min_row=header, max_row=header, max_col=last_column))[0]
    rows = list(sheet.iter_rows(min_row=header + 1, max_row=last, max_col=last_column, values_only=True))
    footer = next(sheet.iter_rows(min_row=last + 1, max_row=last + 1, max_col=last_column, values_only=True))
    return table, headings, rows, footer


def assert_static_category_table(workbook, expected_net):
    sheet = workbook['Summary']
    assert all(not page._pivots and not page.merged_cells.ranges for page in workbook)
    allocations = [row for row in workbook['Transactions'].values if isinstance(row[0], int)]
    if not allocations:
        assert not sheet.tables
        return
    table, headings, rows, footer = category_table_rows(workbook)
    assert headings[0].value == 'Family / account' and headings[1].value == 'Person'
    assert headings[-1].value == 'Grand Total'
    categories = [cell.comment.text if cell.comment else cell.value for cell in headings[2:-1]]
    assert len({cell.value.casefold() for cell in headings}) == len(headings)
    assert all(len(cell.value.encode('utf-16-le')) <= 510 for cell in headings)
    expected = defaultdict(lambda: defaultdict(int))
    share_column = next(index for index, cell in enumerate(workbook['Transactions'][2])
                        if cell.value.startswith('Expense share ('))
    for allocation in allocations:
        expected[allocation[6], allocation[7]][allocation[2]] += allocation[share_column]
    assert len(rows) == len(expected)
    assert len({row[:2] for row in rows}) == len(rows)
    for row in rows:
        assert row[0] and row[1]
        amounts = [expected[row[:2]][category] for category in categories]
        assert list(row[2:]) == [*amounts, sum(amounts)]
    assert set(categories) == {row[2] for row in allocations}
    assert list(footer) == ['Grand Total', None,
                            *[sum(values[category] for values in expected.values()) for category in categories], expected_net]
    assert sum(row[-1] for row in rows) == sum(row[share_column] for row in allocations) == expected_net
    assert len(table.tableColumns) == len(headings)
    assert table.autoFilter.ref == table.ref
    assert not table.totalsRowShown
    assert all(cell.data_type != 'f' for page in workbook for row in page for cell in row)


def assert_no_pivot_parts(payload):
    with ZipFile(io.BytesIO(payload)) as archive:
        assert not any(name.startswith(('xl/pivotTables/', 'xl/pivotCache/', 'xl/externalLinks/'))
                       for name in archive.namelist())
        assert 'xl/connections.xml' not in archive.namelist()
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                source = archive.read(name)
                root = ET.fromstring(source)
                for element in root.iter():
                    tag_name = element.tag.rsplit('}', 1)[-1]
                    assert tag_name not in {'pivotTableDefinition', 'pivotCaches', 'pivotTableParts', 'pivotTablePart'}
                    assert not any(token in element.get('Type', '') for token in ('/pivotTable', '/pivotCache'))
                    assert not any(token in element.get('ContentType', '') for token in ('pivotTable', 'pivotCache'))
                if name.startswith('xl/worksheets/'):
                    assert root.find('s:mergeCells', NS) is None


def members_detail_rows(workbook):
    rows = list(workbook['Members & Families'].values)
    assert rows[-1][0] == 'Total'
    return rows[2:-1], rows[-1]


def members_account_groups(workbook):
    rows, _ = members_detail_rows(workbook)
    groups = []
    for row in rows:
        if isinstance(row[2], (int, float)):
            groups.append((row, []))
        else:
            assert groups, 'Person details must follow their account total'
            groups[-1][1].append(row)
    return groups
