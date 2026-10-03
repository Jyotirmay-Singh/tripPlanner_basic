import { CATEGORIES, CATEGORY_CATALOG, CATEGORY_SECTIONS, categoryMetadata, categoryLayout, searchCategories } from '../categories';
import { categoryDetailPath, decodeCategoryParam } from '../categoryRoute';
const approved = ["Travel", "Accommodation", "Local Transportation", "Local Sightseeing", "Food", "Groceries", "Fuel", "Parking & Tolls", "Rent", "Utilities", "Phone & Internet", "Household Supplies", "Repairs & Maintenance", "Shopping", "Electronics & Equipment", "Healthcare", "Personal Care", "Education & Training", "Pets", "Entertainment & Hobbies", "Gifts & Donations", "Subscriptions & Memberships", "Insurance", "Taxes & Government Fees", "Bank Fees & Interest", "Office Supplies", "Professional Services", "Advertising & Marketing", "Shipping & Delivery", "Other"];
it('preserves the exact ordered 30-name contract, each grouped once', () => {
  expect(CATEGORIES).toEqual(approved);
  expect(new Set(CATEGORIES).size).toBe(30);
  expect(CATEGORY_SECTIONS.flatMap((section) => CATEGORY_CATALOG.filter((row) => row.section === section))).toHaveLength(30);
  for (const name of CATEGORIES) expect(decodeCategoryParam(categoryDetailPath('t', name).split('/').pop())).toBe(name);
});
it.each([['taxi', 'Local Transportation'], ['FASTag', 'Parking & Tolls'], ['phone and internet', 'Phone & Internet'], ['Subscriptions & Memberships', 'Subscriptions & Memberships'], [' BANK   charge! ', 'Bank Fees & Interest']])('finds %s by name or alias', (query, expected) => {
  expect(searchCategories(query)[0].name).toBe(expected);
});
it('matches all query words, ranks names first, and never rewrites unknown historical labels', () => {
  expect(searchCategories('taxi medical')).toEqual([]);
  expect(searchCategories('zzzz')).toEqual([]);
  expect(searchCategories('gift')[0].name).toBe('Gifts & Donations');
  expect(categoryMetadata('Old category')).toMatchObject({ name: 'Old category', icon: 'tag' });
});
it('selects accessible lists for large text and narrow widths', () => {
  expect(categoryLayout(263, 1)).toBe('list'); expect(categoryLayout(300, 1.3)).toBe('list');
  expect(categoryLayout(300, 2)).toBe('list'); expect(categoryLayout(300, 1)).toBe(2);
  expect(categoryLayout(552, 1)).toBe(3);
});
