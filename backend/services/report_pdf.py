"""Readable A4 PDF presentation of the shared reconciled report snapshot."""

import io
from collections import defaultdict
from functools import partial
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle, PageBreak, CondPageBreak,
)

from services.report_formatting import BRAND, RECEIVE, PAY, NEUTRAL, currency_symbol, indian_number, money_text
from services.report_model import ReportData, routing_label


BRAND_COLOR = colors.HexColor('#' + BRAND)
CELL = ParagraphStyle('ReportCell', fontName='ReportNoto', fontSize=10.5, leading=14)
BOLD = ParagraphStyle('ReportBold', parent=CELL, fontName='ReportNotoBold')
HEADER = ParagraphStyle('ReportHeader', parent=BOLD, textColor=colors.white)
HEADING = ParagraphStyle('ReportHeading', parent=BOLD, fontSize=14, leading=18, textColor=BRAND_COLOR, spaceBefore=6, spaceAfter=4, keepWithNext=True)


def _fonts():
    if 'ReportNoto' not in pdfmetrics.getRegisteredFontNames():
        directory = Path(__file__).resolve().parents[1] / 'assets' / 'fonts'
        pdfmetrics.registerFont(TTFont('ReportNoto', str(directory / 'NotoSans-Regular.ttf')))
        pdfmetrics.registerFont(TTFont('ReportNotoBold', str(directory / 'NotoSans-Bold.ttf')))
        pdfmetrics.registerFontFamily('ReportNoto', normal='ReportNoto', bold='ReportNotoBold')


def _p(value, bold=False, color=None):
    style = BOLD if bold else CELL
    if color:
        style = ParagraphStyle('Role', parent=style, textColor=colors.HexColor('#' + color))
    return Paragraph(escape(str(value if value is not None else '')), style)


def _fmt_money(value, currency):
    return money_text(value, currency) if value is not None else ''


def _table(headers, rows, widths, *, numeric=(), bold_rows=(), bold_columns=(), roles=(), keep_pairs=(), caption=None,
           split_in_row=False, padding=3):
    body = [[_p(value, index in bold_rows or column in bold_columns) for column, value in enumerate(row)] for index, row in enumerate(rows)]
    for row_index, column, color in roles:
        body[row_index][column] = _p(rows[row_index][column], row_index in bold_rows or column in bold_columns, color)
    prefix = [[_p(value, True, 'FFFFFF') for value in headers]]
    if caption:
        prefix.insert(0, [_p(caption, True, BRAND), *[''] * (len(headers) - 1)])
    offset = len(prefix)
    table = Table([*prefix, *body], colWidths=widths,
                  repeatRows=offset, splitByRow=1, splitInRow=int(split_in_row), hAlign='LEFT')
    styles = [('BACKGROUND', (0, offset - 1), (-1, offset - 1), BRAND_COLOR),
              ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
              ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
              ('TOPPADDING', (0, 0), (-1, -1), padding), ('BOTTOMPADDING', (0, 0), (-1, -1), padding),
              ('LINEBELOW', (0, offset - 1), (-1, offset - 1), 0.5, BRAND_COLOR),
              ('ROWBACKGROUNDS', (0, offset), (-1, -1), [colors.white, colors.HexColor('#F4F7F6')])]
    if caption:
        styles += [('SPAN', (0, 0), (-1, 0)), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#EAF0EE'))]
    for col in numeric:
        for row in body:
            row[col].style = ParagraphStyle('Number', parent=row[col].style, alignment=2)
    for index in bold_rows:
        styles.extend([('BACKGROUND', (0, index + offset), (-1, index + offset), colors.HexColor('#EAF0EE')),
                       ('LINEABOVE', (0, index + offset), (-1, index + offset), 0.4, BRAND_COLOR)])
    for first, last in keep_pairs:
        styles.append(('NOSPLIT', (0, first + offset), (-1, last + offset)))
    table.setStyle(TableStyle(styles))
    return table


class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        self.footer = kwargs.pop('footer_left', '')
        self.states = []
        super().__init__(*args, **kwargs)

    def showPage(self):
        self.states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self.states)
        for state in self.states:
            self.__dict__.update(state)
            self.setFont('ReportNoto', 9)
            self.setFillColor(colors.HexColor('#' + NEUTRAL))
            # Leave the numbering legible even when the trip title is very long.
            title = self.footer
            maximum = landscape(A4)[0] - 24 * mm - 125
            while title and pdfmetrics.stringWidth(title, 'ReportNoto', 9) > maximum:
                title = title[:-1]
            if title != self.footer:
                title = title.rstrip() + '...'
            self.drawString(12 * mm, 6 * mm, title)
            self.drawRightString(landscape(A4)[0] - 12 * mm, 6 * mm, f'Page {self._pageNumber} of {total}')
            super().showPage()
        super().save()


def build_report_pdf(data: ReportData) -> bytes:
    _fonts()
    output = io.BytesIO()
    width = landscape(A4)[0] - 24 * mm
    doc = SimpleDocTemplate(output, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm,
                            topMargin=12 * mm, bottomMargin=15 * mm,
                            title=str(data.snapshot.trip.get('name', 'Group')) + ' - Report', author='Trip Splitter')
    meta, symbol = data.metadata, currency_symbol(data.currency)
    title = ParagraphStyle('Title', parent=HEADING, fontSize=20, leading=25, spaceBefore=0)
    story = [Paragraph(escape(meta.trip_name), title)]
    metadata = [
        ('Trip dates', meta.trip_dates, 'Included expense dates', meta.expense_dates),
        ('Budget', _fmt_money(meta.budget, data.currency) if meta.budget is not None else 'Not set',
         'Included settlement dates', meta.settlement_dates),
    ]
    story += [_table(['Trip information', 'Value', 'Report scope', 'Value'], metadata, [100, 245, 160, width - 505]),
              Paragraph('Summary', HEADING)]
    metrics = [('Gross spending', data.gross), ('Money back', data.money_back), ('Net spending', data.net), ('Still to settle', data.outstanding)]
    story.append(_table(['Measure', f'Amount ({symbol})'], [[label, indian_number(value)] for label, value in metrics],
                        [width * .6, width * .4], numeric=(1,), bold_rows=(2, 3), roles=[(1, 1, RECEIVE)]))
    story.append(Paragraph('Funding by account', HEADING))
    rows = [[a.name, indian_number(a.gross_funded), indian_number(a.money_back), indian_number(a.funded)] for a in data.accounts]
    rows.append(['Total', indian_number(data.gross), indian_number(data.money_back), indian_number(data.net)])
    story.append(_table(['Account', f'Gross funded ({symbol})', f'Money back ({symbol})', f'Net funded ({symbol})'], rows,
                        [width * .34, width * .22, width * .22, width * .22], numeric=(1, 2, 3), bold_rows=(len(rows) - 1,),
                        roles=[(i, 2, RECEIVE) for i in range(len(rows))]))
    if data.categories:
        story += [PageBreak(), Paragraph('Net expense shares by person and category', HEADING)]
        grouped = defaultdict(lambda: defaultdict(int))
        labels = {}
        for allocation in data.allocations:
            key = (allocation.account_id, allocation.person_id)
            labels[key] = (allocation.account, allocation.person)
            grouped[key][allocation.category] += allocation.share
        for start in range(0, len(data.categories), 4):
            categories = data.categories[start:start + 4]
            last_band = start + 4 >= len(data.categories)
            band_caption = f'Category columns {start + 1} to {start + len(categories)} of {len(data.categories)}'
            rows, bold, pairs = [], [], []
            for account in data.accounts:
                keys = [key for key in grouped if key[0] == account.account_id]
                if not keys:
                    continue
                for key in keys:
                    row = [account.name, labels[key][1], *[indian_number(grouped[key][c]) for c in categories]]
                    if last_band:
                        row.append(indian_number(sum(grouped[key].values())))
                    rows.append(row)
                bold.append(len(rows))
                pairs.append((len(rows) - 1, len(rows)))
                row = [account.name + ' Total', '', *[indian_number(sum(grouped[k][c] for k in keys)) for c in categories]]
                if last_band:
                    row.append(indian_number(sum(sum(grouped[k].values()) for k in keys)))
                rows.append(row)
            bold.append(len(rows))
            if rows:
                pairs.append((len(rows) - 1, len(rows)))
            row = ['Grand Total', '', *[indian_number(data.category_totals[c]) for c in categories]]
            if last_band:
                row.append(indian_number(data.net))
            rows.append(row)
            heads = ['Family / account', 'Person', *[f'{category} ({symbol})' for category in categories]] + ([f'Total ({symbol})'] if last_band else [])
            money_cols = len(heads) - 2
            roles = [(i, c, RECEIVE) for i, row in enumerate(rows) for c, value in enumerate(row)
                     if c >= 2 and str(value).startswith('(')]
            story.append(CondPageBreak(120))
            story.append(_table(heads, rows, [135, 115] + [(width - 250) / money_cols] * money_cols,
                                numeric=range(2, len(heads)), bold_rows=bold, keep_pairs=pairs,
                                bold_columns=(len(heads) - 1,) if last_band else (),
                                caption=band_caption, roles=roles))
    else:
        story.append(_p('No expenses recorded.'))

    story += [PageBreak(), Paragraph('Members & Families', HEADING)]
    heads = ['Name', *[f'{label} ({symbol})' for label in
                       ['Expense share', 'Net funded', 'Before settlements', 'Settlements paid', 'Settlements received']]]
    heads += [f'Balance now ({symbol})', 'Action']
    rows, bold, roles = [], [], []
    positions = defaultdict(list)
    for person in data.member_positions:
        positions[person.account_id].append(person)
    for account in data.accounts:
        bold.append(len(rows))
        row = [account.name, *[indian_number(v) for v in [account.share, account.funded, account.before_settlements, account.sent, account.received]]]
        row += [indian_number(account.balance), account.action]
        roles += [(len(rows), len(heads) - 2, RECEIVE if account.balance > 0 else PAY if account.balance < 0 else NEUTRAL),
                  (len(rows), 4, PAY), (len(rows), 5, RECEIVE)]
        if account.share < 0:
            roles.append((len(rows), 1, RECEIVE))
        rows.append(row)
        for person in positions[account.account_id]:
            if person.balance is not None:
                roles.append((len(rows), len(heads) - 2, RECEIVE if person.balance > 0 else PAY if person.balance < 0 else NEUTRAL))
            if person.share < 0:
                roles.append((len(rows), 1, RECEIVE))
            row = ['  ' + person.name, indian_number(person.share)] + [''] * (len(heads) - 4) + [indian_number(person.balance) if person.balance is not None else '', 'Within family' if person.balance is not None else 'Historical share']
            rows.append(row)
    totals = ['Total', *[indian_number(sum(getattr(a, field) for a in data.accounts)) for field in ['share', 'funded', 'before_settlements', 'sent', 'received']]]
    totals += ['0', '']
    bold.append(len(rows))
    rows.append(totals)
    story.append(_table(heads, rows, [135] + [(width - 220) / (len(heads) - 2)] * (len(heads) - 2) + [85], numeric=range(1, len(heads) - 1), bold_rows=bold, roles=roles))

    story += [PageBreak(), Paragraph('Payments', HEADING), Paragraph('Outstanding settlement plan', HEADING),
              _p('Routing: ' + routing_label(data))]
    plan_rows = [[t.payer, t.receiver, indian_number(t.amount), 'Suggested'] for t in data.transfers]
    if plan_rows:
        roles = [(i, c, color) for i in range(len(plan_rows)) for c, color in ((0, PAY), (1, RECEIVE))]
        plan_rows.append(['Outstanding plan total', '', indian_number(data.outstanding), ''])
        story.append(_table(['Suggested payer', 'Suggested receiver', f'Amount ({symbol})', 'Status'], plan_rows,
                            [width * .32, width * .32, width * .18, width * .18], numeric=(2,), bold_rows=(len(plan_rows) - 1,), roles=roles))
    else:
        story.append(_p('Everyone is settled.'))
    story.append(Paragraph('Recorded settlement history', HEADING))
    if data.events:
        rows = [[e.payer, e.receiver, indian_number(e.amount), f'{e.occurred_at:%d %b %Y, %I:%M %p}' if e.occurred_at else 'Not recorded', e.source, e.status, e.source_id] for e in data.events]
        roles = [(i, c, color) for i in range(len(rows)) for c, color in ((0, PAY), (1, RECEIVE))]
        for label, value in [('History total', sum(e.amount for e in data.events)),
                             ('Recorded payments total', sum(e.amount for e in data.events if e.source == 'Recorded payment')),
                             ('Legacy settlements total', sum(e.amount for e in data.events if e.source == 'Legacy settlement'))]:
            rows.append([label, '', indian_number(value), '', '', '', ''])
        story.append(_table(['Payer', 'Receiver', f'Amount ({symbol})', 'Date & time (IST)', 'Source', 'Status', 'Event ID'], rows,
                            [105, 105, 85, 120, 100, 100, width - 615], numeric=(2,), bold_rows=range(len(rows) - 3, len(rows)), roles=roles, split_in_row=True))
    else:
        story.append(_p('No recorded settlements.'))

    story += [PageBreak(), Paragraph('Transactions', HEADING)]
    blocks = defaultdict(list)
    for allocation in data.allocations:
        blocks[allocation.expense_id].append(allocation)
    if not blocks:
        story.append(_p('No expenses recorded.'))
    for block in blocks.values():
        expense = block[0]
        stamp = f'{expense.occurred_at:%d %b %Y}' if expense.occurred_at else expense.date_source or 'Date not recorded'
        if expense.occurred_at and expense.time_recorded:
            stamp += f', {expense.occurred_at:%I:%M %p} IST'
        story += [CondPageBreak(160), Paragraph(escape(f'{expense.number}. {expense.description or "Expense"}'), HEADING),
                  _table(['Date (IST)', 'Category', 'Entry type', 'Split method', 'Paid by', f'Expense total ({symbol})'],
                         [[stamp, expense.category, expense.entry_type, expense.split_method, expense.payer, indian_number(expense.expense_amount)]],
                         [135, 140, 100, 100, width - 575, 100], numeric=(5,), bold_columns=(5,))]
        rows = [[a.account, a.person, indian_number(a.share)] for a in block]
        roles = [(i, 2, RECEIVE) for i, a in enumerate(block) if a.share < 0]
        rows.append(['Expense allocation total', '', indian_number(sum(a.share for a in block))])
        story.append(_table(['Family / account', 'Person', f'Expense share ({symbol})'], rows,
                            [width * .4, width * .4, width * .2], numeric=(2,), bold_rows=(len(rows) - 1,), roles=roles,
                            keep_pairs=[(len(rows) - 2, len(rows) - 1)],
                            caption=f'Expense {expense.number}. Expense ID: {expense.expense_id}'))
        foreign = expense.original_currency != data.currency or expense.rate_mode != 'automatic'
        if foreign:
            story.append(_table(['Original amount', 'Original currency', 'Stored rate', 'Effective date', 'Requested date', 'Provider', 'Mode'],
                                [[expense.original_amount, expense.original_currency, expense.exchange_rate, expense.rate_date or 'Not recorded',
                                  expense.rate_requested_date or 'Not recorded', expense.rate_provider, expense.rate_mode]],
                                [90, 85, 120, 90, 90, width - 545, 70]))
        if expense.original_exact:
            story.append(_table(['Original exact allocations'], [[expense.original_exact]], [width]))
    doc.build(story, canvasmaker=partial(NumberedCanvas, footer_left=meta.trip_name))
    return output.getvalue()
