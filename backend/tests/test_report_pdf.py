"""PDF readability, shared-data parity, source evidence, and pagination controls."""

import io
from dataclasses import replace

import pytest
from pypdf import PdfReader
from openpyxl import load_workbook
from bson.decimal128 import Decimal128

from scripts.generate_report_samples import sample_snapshot
from services.report_model import ReportSnapshot, build_report_data
from services.report_pdf import build_report_pdf
from services.report_xlsx import build_report_xlsx
from services.report_formatting import indian_number


def render(source=None):
    data = build_report_data(source or sample_snapshot())
    content = build_report_pdf(data)
    reader = PdfReader(io.BytesIO(content))
    pages = [page.extract_text() or '' for page in reader.pages]
    return data, reader, pages


def test_pdf_and_excel_share_financial_measures_and_separate_report_sections():
    data, reader, pages = render()
    text = ' '.join(' '.join(pages).split())
    workbook = load_workbook(io.BytesIO(build_report_xlsx(data)))
    for col, value in [('A8', data.gross), ('D8', data.money_back), ('G8', data.net), ('J8', data.outstanding)]:
        assert workbook['Summary'][col].value == value
        assert indian_number(value) in text
    for label in ['Gross spending', 'Money back', 'Net spending', 'Still to settle', 'Funding by account',
                  'Expense shares by family and person', 'Members & Families', 'Outstanding settlement plan',
                  'Recorded settlement history', 'Transactions', 'Balance reconciliation notes']:
        assert label in text
    assert 'Split Math' not in text and 'Split Allocations' not in text
    assert '82,905' in text and '70,503' in text  # actual cost and final family position differ
    assert 'Recipient confirmed' in text and 'Legacy settlement' in text
    assert all(e.source_id in text for e in data.events)
    assert all(a.expense_id in text for a in data.allocations)
    assert 'legacy-pending' not in text
    assert 'Category columns 1 to 4 of 9' in text and 'Category columns 5 to 8 of 9' in text
    assert 'Category columns 9 to 9 of 9' in text
    assert all(float(p.mediabox.width) > float(p.mediabox.height) for p in reader.pages)
    assert all(f'Page {n} of {len(pages)}' in p for n, p in enumerate(pages, 1))
    assert not any(p.strip().startswith('Adjustments') for p in pages)
    assert all(a.explanation in text for a in data.adjustments)
    assert all(label not in text for label in ['Share code', 'Exported at (IST)', 'Whole-history snapshot', data.metadata.share_code])
    assert 'Members' not in pages[0] and 'Currency' not in pages[0]


def test_pdf_embeds_noto_sans_and_uses_readable_body_type_with_rupee_glyph():
    _, reader, pages = render()
    fonts = [f.get_object() for p in reader.pages for f in p['/Resources']['/Font'].get_object().values()]
    embedded = [f for f in fonts if 'NotoSans' in str(f.get('/BaseFont'))]
    assert embedded
    assert all('/FontFile2' in f['/FontDescriptor'].get_object() for f in embedded)
    assert '₹' in ''.join(pages)
    seen = []
    reader.pages[0].extract_text(visitor_text=lambda text, cm, tm, font, size: seen.append(size) if text.strip() else None)
    assert 10.5 in seen


def test_fx_evidence_and_private_payment_fields_are_handled_consistently():
    source = sample_snapshot()
    payments = tuple({**p, 'payment_attempt_id': 'private-attempt', 'upi_id_snapshot': 'private@upi',
                      'transaction_reference': 'PRIVATE-REFERENCE'} for p in source.payments)
    expenses = tuple({**e, 'exchange_rate': Decimal128('82.000000000000'), 'original_amount': Decimal128('100.00')}
                     if e['id'] == 'e07' else e for e in source.expenses)
    _, _, pages = render(replace(source, payments=payments, expenses=expenses))
    text = ' '.join(' '.join(pages).split())
    for expected in ['Original amount: 100.00 USD', 'Stored rate: 82.000000000000', 'Effective date: 2026-10-02',
                     'Stored reference rate', 'Mode: manual', 'Original exact allocations: p3: 50; s3: 50']:
        assert expected in text
    for private in ['private-attempt', 'private@upi', 'PRIVATE-REFERENCE']:
        assert private not in text


def test_empty_report_has_meaningful_empty_sections_without_dummy_expenses():
    _, _, pages = render(ReportSnapshot({'id': 'empty', 'name': 'Empty report', 'members': [], 'currency': 'INR'}))
    text = ' '.join(pages)
    assert 'No expenses recorded.' in text
    assert 'Everyone is settled.' in text
    assert 'No recorded settlements.' in text
    assert 'Adjustments' not in text
    assert 'Expense ID:' not in text


def test_long_names_categories_descriptions_and_payment_notes_wrap_and_paginate():
    source = sample_snapshot()
    source.trip['name'] = 'Long <literal> & report'
    for m in source.trip['members']:
        m['name'] += ' with a deliberately long professional display name'
    expenses = tuple({**e, 'category': 'Long category label ' + e['category'],
                      'description': '<Expense> & literal description ' + ('lengthy narrative ' * 60 if i == 0 else str(i))}
                     for i, e in enumerate(source.expenses))
    payments = tuple({**p, 'note': 'A long payment note. ' * 90} if i == 0 else p for i, p in enumerate(source.payments))
    _, _, pages = render(replace(source, expenses=expenses, payments=payments))
    assert len(pages) > 6
    text = ' '.join(' '.join(pages).split())
    assert 'Long <literal> & report' in text
    assert '<Expense> & literal description' in text
    assert text.count('Family / account') >= 4
    assert all(f'Page {n} of {len(pages)}' in page for n, page in enumerate(pages, 1))
    assert 'Event ID: payment-1' in text


@pytest.mark.parametrize('currency,amount,expected', [('JPY', 1235, '1,235'), ('KWD', 1235.5, '1,236')])
def test_currency_precision_stays_whole_units(currency, amount, expected):
    trip = {'id': 't', 'name': 'Currency precision', 'currency': currency,
            'members': [{'id': 'a', 'name': 'Ann', 'kind': 'individual'}]}
    expense = {'id': 'e', 'amount': amount, 'paid_by_member_id': 'a', 'split_mode': 'PER_FAMILY',
               'split_member_ids': ['a'], 'date': '2026-10-17', 'category': 'Food'}
    _, _, pages = render(ReportSnapshot(trip, (expense,)))
    assert expected in ' '.join(pages)
    assert expected + '.00' not in ' '.join(pages)


def test_transaction_continuations_repeat_the_source_expense_identity():
    family = {'id': 'f', 'name': 'Large family', 'kind': 'family',
              'family_members': [f'Person {i}' for i in range(35)]}
    trip = {'id': 't', 'name': 'Continuation check', 'currency': 'INR', 'members': [family]}
    expense = {'id': 'large-expense', 'amount': 3500, 'paid_by_member_id': 'f',
               'split_mode': 'PER_CAPITA', 'split_member_ids': ['f'], 'date': '2026-10-17', 'category': 'Food'}
    _, _, pages = render(ReportSnapshot(trip, (expense,)))
    first = next(i for i, page in enumerate(pages) if 'Transactions' in page)
    assert len(pages[first:]) >= 2
    assert all('Expense ID: large-expense' in page for page in pages[first:])


@pytest.mark.parametrize('currency,symbol', [('AED', 'AED'), ('EUR', '€')])
def test_pdf_financial_columns_follow_trip_currency(currency, symbol):
    source = sample_snapshot()
    data, _, pages = render(replace(source, trip={**source.trip, 'currency': currency}))
    text = ' '.join(' '.join(pages).split())
    for label in ['Gross funded', 'Money back', 'Net funded', 'Expense share', 'Before settlements',
                  'Settlements paid', 'Settlements received', 'Adjustments', 'Balance now', 'Amount']:
        assert f'{label} ({symbol})' in text
    assert f'Accommodation ({symbol})' in text
    assert f'All categories ({symbol})' in text
    assert f'Net spending by category ({currency})' in text
    assert f'{symbol} {indian_number(data.net)}' in text
    assert 'INR' not in text and '₹' not in text
    assert 'Original amount: 100 USD' in text
