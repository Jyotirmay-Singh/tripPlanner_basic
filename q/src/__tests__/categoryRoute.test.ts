import { categoryDetailPath, decodeCategoryParam } from '../categoryRoute';

describe('category route helpers', () => {
  it('builds one concrete path and encodes category text exactly once', () => {
    expect(categoryDetailPath('trip 1', 'Food & Drinks'))
      .toBe('/trip/trip%201/category/Food%20%26%20Drinks');
  });

  it('decodes route values and safely preserves malformed legacy values', () => {
    expect(decodeCategoryParam('Local%20Transportation')).toBe('Local Transportation');
    expect(decodeCategoryParam(['Food%20%26%20Drinks'])).toBe('Food & Drinks');
    expect(decodeCategoryParam('%')).toBe('%');
    expect(decodeCategoryParam(undefined)).toBe('');
  });
});
