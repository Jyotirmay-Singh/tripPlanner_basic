import { themedNavigationStyle } from '../systemBars';

describe('Android navigation icon contrast', () => {
  it('uses the compatibility light buttons before API 26', () => {
    expect(themedNavigationStyle('light', 'android', 24)).toBe('light');
  });

  it('uses dark buttons on a light surface where Android supports them', () => {
    expect(themedNavigationStyle('light', 'android', 26)).toBe('dark');
  });

  it('uses light buttons on dark surfaces on every supported API', () => {
    expect(themedNavigationStyle('dark', 'android', 24)).toBe('light');
    expect(themedNavigationStyle('dark', 'android', 36)).toBe('light');
  });
});
