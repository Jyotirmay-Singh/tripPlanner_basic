import { tabBarMetrics } from '../tabBarLayout';

describe('edge-to-edge tab bar metrics', () => {
  it('adds the measured navigation inset exactly once', () => {
    const withoutInset = tabBarMetrics(0, 1);
    const withInset = tabBarMetrics(34, 1);

    expect(withInset.height - withoutInset.height).toBe(34);
    expect(withInset.paddingBottom - withoutInset.paddingBottom).toBe(34);
  });

  it('grows the interactive content region for large accessibility text', () => {
    expect(tabBarMetrics(24, 2).height).toBeGreaterThan(tabBarMetrics(24, 1).height);
  });
});
