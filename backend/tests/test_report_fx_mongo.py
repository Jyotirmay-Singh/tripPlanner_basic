"""Actual FX quote, expense, edit and download flow on a disposable loopback database."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import io
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
from uuid import uuid4

from bson.decimal128 import Decimal128
import jwt
from openpyxl import load_workbook
from pymongo import MongoClient
import pytest
import requests


@pytest.mark.parametrize('currency,rate,positive,refund,jpy', [
    ('INR', '82.125', 8213, -2053, 280), ('AED', '3.6725', 367, -92, 12),
])
def test_saved_mixed_currency_expenses_and_reports_keep_locked_rates(currency, rate, positive, refund, jpy):
    mongo_url = os.environ.get('COVERAGE_TEST_MONGO_URL')
    if not mongo_url:
        pytest.skip('Set COVERAGE_TEST_MONGO_URL to a disposable loopback replica set')
    assert urlparse(mongo_url).hostname in {'127.0.0.1', 'localhost'}
    mongo = MongoClient(mongo_url, serverSelectionTimeoutMS=1500)
    database = mongo['trip_splitter_report_fx_' + uuid4().hex]
    process = None
    http = requests.Session()
    http.trust_env = False
    try:
        assert mongo.admin.command('hello').get('setName')
        user_id, trip_id, rate_id = (str(uuid4()) for _ in range(3))
        members = [
            {'id': 'f', 'name': 'Family', 'kind': 'family', 'family_members': ['Ana', 'Ben'],
             'family_member_ids': ['p1', 'p2']},
            {'id': 'b', 'name': 'Sam', 'kind': 'individual'},
        ]
        database.users.insert_one({'id': user_id, 'email': 'fx-smoke@gmail.com', 'name': 'FX checks'})
        database.trips.insert_one({'id': trip_id, 'name': 'Mixed-currency controls', 'currency': currency,
                                   'owner_id': user_id, 'admin_ids': [user_id], 'user_ids': [user_id],
                                   'members': members, 'version': 0, 'simplify_debts': True,
                                   'start_date': '2026-08-28', 'end_date': '2026-08-30'})
        database.exchange_rates.insert_one({
            'id': rate_id, 'provider': 'frankfurter_v2_blended', 'source_currency': 'USD',
            'target_currency': currency, 'effective_date': '2026-08-28', 'rate': Decimal128(rate),
            'revision': 1, 'provider_sources': [], 'fetched_at': datetime.now(timezone.utc),
        })
        database.exchange_rate_aliases.insert_one({
            'provider': 'frankfurter_v2_blended', 'source_currency': 'USD', 'target_currency': currency,
            'requested_key': '2026-08-30', 'rate_id': rate_id,
        })
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        secret = 'disposable-fx-report-check-only-secret'
        environment = {**os.environ, 'MONGO_URL': mongo_url, 'DB_NAME': database.name, 'JWT_SECRET': secret,
                       'MULTI_CURRENCY_EXPENSES_ENABLED': 'true', 'EXPENSE_SETTLEMENT_ENABLED': 'false',
                       'EMAIL_FEATURES_ENABLED': 'false', 'PUSH_NOTIFICATIONS_ENABLED': 'false',
                       'INVITE_LINKS_ENABLED': 'false', 'ADMIN_PASSWORD': 'disposable-fx-check-only'}
        base = f'http://127.0.0.1:{port}'
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(
                [sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', str(port),
                 '--log-level', 'warning'], cwd=Path(__file__).resolve().parents[1], env=environment,
                stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    if http.get(base + '/api/health', timeout=1).status_code == 200:
                        break
                except requests.ConnectionError:
                    pass
                time.sleep(.1)
            else:
                pytest.fail('Private FX test API did not start')
            token = jwt.encode({'sub': user_id, 'type': 'access', 'sv': 0,
                                'exp': datetime.now(timezone.utc) + timedelta(minutes=10)}, secret, algorithm='HS256')
            http.headers['Authorization'] = f'Bearer {token}'
            url = base + f'/api/trips/{trip_id}'
            created = []
            for source, amount, mode, manual_kind, manual_value, split in (
                (currency, 50, 'automatic', None, None, 'PER_CAPITA'),
                ('USD', 100, 'automatic', None, None, 'PER_FAMILY'),
                ('USD', -25, 'manual', 'rate', rate, 'EXACT'),
                ('JPY', 500, 'manual', 'target_amount', jpy, 'PER_CAPITA'),
            ):
                conversion = None
                if source != currency:
                    inputs = {'manual_rate': manual_value} if manual_kind == 'rate' else (
                        {'manual_target_amount': manual_value} if manual_kind else {})
                    quote = http.get(base + '/api/exchange-rates/quote', params={
                        'from': source, 'to': currency, 'amount': amount, 'date': '2026-08-30',
                        'mode': mode, **({'manual_input_type': manual_kind} if manual_kind else {}), **inputs}, timeout=10)
                    assert quote.status_code == 200, quote.text
                    reviewed = quote.json()
                    if mode == 'automatic':
                        assert reviewed['cache_hit'] is True
                        assert reviewed['effective_rate_date'] == '2026-08-28'
                    conversion = {'mode': mode, 'quote_id': reviewed['quote_id'], 'approved': True,
                                  **({'manual_input_type': manual_kind} if manual_kind else {}), **inputs}
                response = http.post(url + '/expenses', json={
                    'original_amount': amount, 'original_currency': source, 'category': 'Food',
                    'description': 'Foreign currency entry', 'date': '30-08-26',
                    'paid_by_member_id': 'f', 'split_member_ids': ['f', 'b'], 'split_mode': split,
                    **({'conversion': conversion} if conversion else {}),
                    **({'original_custom_amounts': {'p1': 10, 'b': 15}} if split == 'EXACT' else {}),
                }, timeout=15)
                assert response.status_code == 200, response.text
                created.append(response.json()['expense'])
                if len(created) == 1:
                    compact = http.get(url + '/report.xlsx', params={'token': token}, timeout=15)
                    assert compact.status_code == 200, compact.text
                    compact_workbook = load_workbook(io.BytesIO(compact.content))
                    assert 'Expense Register' not in compact_workbook.sheetnames
                    assert all(not sheet.merged_cells.ranges for sheet in compact_workbook)
                    assert compact_workbook['Transactions'].max_column == 12
                    assert compact_workbook['Summary']['B9'].value == 50
                    assert len(compact_workbook['Summary']._pivots[0].cache.cacheFields) == 12
            assert [expense['amount'] for expense in created] == [50, positive, refund, jpy]
            expected_net = 50 + positive + refund + jpy
            original = database.expenses.find_one({'id': created[1]['id']})
            assert original['exchange_rate'].to_decimal() == Decimal(rate)
            database.exchange_rates.update_one({'id': rate_id}, {'$set': {'rate': Decimal128('999')}, '$inc': {'revision': 1}})
            latest = http.get(base + '/api/exchange-rates/quote', params={
                'from': 'USD', 'to': currency, 'amount': 100, 'date': '2026-08-30'}, timeout=10)
            assert latest.status_code == 200 and latest.json()['target_amount'] == '99900'
            edit = http.patch(url + f"/expenses/{created[1]['id']}", json={'description': 'Description edited'}, timeout=15)
            assert edit.status_code == 200, edit.text
            saved = database.expenses.find_one({'id': created[1]['id']})
            assert saved['amount'] == positive and saved['exchange_rate'] == original['exchange_rate']
            assert saved['conversion_version'] == original['conversion_version']
            for _ in range(2):
                report = http.get(url + '/report.xlsx', params={'token': token}, timeout=15)
                assert report.status_code == 200, report.text
                workbook = load_workbook(io.BytesIO(report.content))
                assert workbook['Summary']['B9'].value == expected_net
                transaction_sheet = workbook['Transactions']
                allocations = list(transaction_sheet.iter_rows(
                    min_row=3, max_row=transaction_sheet.max_row - 1, values_only=True))
                expenses = {row[11]: row for row in allocations}
                assert expenses[created[1]['id']][14] == rate
                assert sum(row[9] for row in expenses.values()) == sum(row[10] for row in allocations) == expected_net
                assert 'Expense Register' not in workbook.sheetnames
                assert all(not sheet.merged_cells.ranges for sheet in workbook)
                assert workbook['Transactions'].max_column == 20
                assert not workbook['Transactions'].column_dimensions['M'].hidden
            pdf = http.get(url + '/report.pdf', params={'token': token}, timeout=15)
            assert pdf.status_code == 200 and pdf.content.startswith(b'%PDF')
            assert pdf.headers['content-type'] == 'application/pdf'
            summary = http.get(url + '/report', timeout=10)
            assert summary.status_code == 200 and summary.json()['total_expense'] == expected_net
            assert database.expenses.count_documents({'trip_id': trip_id}) == 4
            for foreign in created[1:]:
                deleted = http.delete(url + f"/expenses/{foreign['id']}", timeout=15)
                assert deleted.status_code == 200, deleted.text
            compact = http.get(url + '/report.xlsx', params={'token': token}, timeout=15)
            assert compact.status_code == 200, compact.text
            compact_workbook = load_workbook(io.BytesIO(compact.content))
            assert 'Expense Register' not in compact_workbook.sheetnames
            assert all(not sheet.merged_cells.ranges for sheet in compact_workbook)
            assert compact_workbook['Transactions'].max_column == 12
            assert compact_workbook['Summary']['B9'].value == 50
            assert len(compact_workbook['Summary']._pivots[0].cache.cacheFields) == 12
            bad = {**saved, 'id': str(uuid4()), 'currency': 'USD'}
            bad.pop('_id')
            database.expenses.insert_one(bad)
            for endpoint in ('/report', '/report.xlsx', '/report.pdf'):
                rejected = http.get(url + endpoint, params={'token': token}, timeout=15)
                assert rejected.status_code == 409 and 'group currency' in rejected.text
    finally:
        http.close()
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        mongo.drop_database(database.name)
        mongo.close()
