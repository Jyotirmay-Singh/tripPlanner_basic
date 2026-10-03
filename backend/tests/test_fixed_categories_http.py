"""Run only with scripts/run_isolated_tests.py against a disposable loopback API."""
import os
from urllib.parse import urlparse
import pytest
from category_names import CATEGORIES
BASE = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')
pytestmark = pytest.mark.skipif(urlparse(BASE).hostname != '127.0.0.1' or urlparse(BASE).port != 18081,
    reason='Requires the disposable isolated API on 127.0.0.1:18081')

def test_all_fixed_categories_create_update_and_string_validation(api_client, test_user):
    headers = {'Authorization': f"Bearer {test_user['token']}"}
    trip_response = api_client.post(BASE + '/api/trips', headers=headers, json={'name': 'TEST_Fixed categories', 'currency': 'INR'})
    assert trip_response.status_code == 200
    trip = trip_response.json(); member = trip['members'][0]['id']
    path = BASE + f"/api/trips/{trip['id']}/expenses"
    ids = []
    for category in CATEGORIES:
        body = {'amount': 10, 'category': category, 'date': '03-10-26', 'paid_by_member_id': member, 'split_member_ids': [member]}
        created = api_client.post(path, headers=headers, json=body)
        assert created.status_code == 200
        expense = created.json()['expense']; ids.append(expense['id'])
        assert expense['category'] == category and isinstance(expense['category'], str)
        updated = api_client.patch(path + '/' + ids[0], headers=headers, json={'category': category})
        assert updated.status_code == 200
        assert updated.json()['category'] == category and updated.json()['amount'] == 10
    for invalid in ['Unsupported', ['Food', 'Travel']]:
        rejected = api_client.post(path, headers=headers, json={**body, 'category': invalid})
        assert rejected.status_code in (400, 422)
        assert api_client.patch(path + '/' + ids[0], headers=headers, json={'category': invalid}).status_code in (400, 422)
    listed = api_client.get(path, headers=headers)
    assert listed.headers.get('X-Expense-List-Complete') == 'true'
    assert len(listed.json()) == 30
    meta = api_client.get(BASE + '/api/meta/categories')
    assert meta.json() == CATEGORIES

def test_two_group_lists_payer_summaries_signed_reports_and_access(api_client, test_user):
    headers = {'Authorization': f"Bearer {test_user['token']}"}
    groups = [
        ('A', [('Food', 1000), ('Travel', 500), ('Travel', -500), ('Bank Fees & Interest', -200)], 1500, 700, 800,
         {'Food': 1000, 'Travel': 0, 'Bank Fees & Interest': -200}),
        ('B', [('Groceries', 90), ('Shipping & Delivery', 30), ('Other', -5)], 120, 5, 115,
         {'Groceries': 90, 'Shipping & Delivery': 30, 'Other': -5}),
    ]
    ids_by_group = {}
    trips = []
    for name, rows, gross, refunds, net, by_category in groups:
        created = api_client.post(BASE + '/api/trips', headers=headers, json={'name': 'TEST_Group_' + name, 'currency': 'INR'})
        assert created.status_code == 200
        trip = created.json(); member = trip['members'][0]['id']; trips.append(trip)
        path = BASE + f"/api/trips/{trip['id']}"
        ids = []
        for index, (category, amount) in enumerate(rows):
            response = api_client.post(path + '/expenses', headers=headers, json={
                'amount': amount, 'category': category, 'description': f'{name}-{index}',
                'date': '03-10-26', 'paid_by_member_id': member, 'split_member_ids': [member]})
            assert response.status_code == 200
            ids.append(response.json()['expense']['id'])
        ids_by_group[name] = set(ids)
        listed = api_client.get(path + '/expenses', headers=headers)
        assert listed.status_code == 200 and listed.headers['X-Expense-List-Complete'] == 'true'
        actual = listed.json()
        assert {row['id'] for row in actual} == set(ids)
        assert sorted((row['category'], row['amount']) for row in actual) == sorted(rows)
        assert sum(row['amount'] for row in actual if row['amount'] > 0) == gross
        assert -sum(row['amount'] for row in actual if row['amount'] < 0) == refunds
        summary = api_client.get(path + '/spend-summary', headers=headers)
        assert summary.status_code == 200
        assert summary.json()['total'] == gross
        assert [(r['entity_id'], r['paid'], r['expense_count']) for r in summary.json()['entities']] == [(member, gross, 2)]
        report = api_client.get(path + '/report', headers=headers)
        assert report.status_code == 200
        assert report.json()['trip']['id'] == trip['id'] and report.json()['total_expense'] == net
        assert {row['category']: row['amount'] for row in report.json()['by_category']} == by_category
    assert ids_by_group['A'].isdisjoint(ids_by_group['B'])
    # A separate disposable user must never see either group's reads.
    import uuid
    outsider = api_client.post(BASE + '/api/auth/register', json={
        'name': 'Category outsider', 'email': f'category_outsider_{uuid.uuid4().hex[:8]}@gmail.com', 'password': 'test12345'})
    assert outsider.status_code == 200
    outsider_headers = {'Authorization': f"Bearer {outsider.json()['access_token']}"}
    for trip in trips:
        for suffix in ['/expenses', '/spend-summary', '/report']:
            url = BASE + f"/api/trips/{trip['id']}" + suffix
            assert api_client.get(url, headers=outsider_headers).status_code in (403, 404)
            assert api_client.get(url).status_code == 401
