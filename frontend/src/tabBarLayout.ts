import { SPACING, TYPESCALE } from './theme';

export function tabBarMetrics(bottomInset: number, fontScale: number) {
  // Reserve two complete label lines on narrow screens and at enlarged font scales.
  const scaledLabelHeight = Math.ceil(TYPESCALE.xs * Math.max(fontScale, 1) * 1.5) * 2;
  const contentHeight = SPACING.sm + 25 + SPACING.xs + scaledLabelHeight + SPACING.sm;
  return {
    height: contentHeight + bottomInset,
    paddingTop: SPACING.sm,
    paddingBottom: bottomInset + SPACING.sm,
  };
}
