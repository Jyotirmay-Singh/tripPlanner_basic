import { SPACING, TYPESCALE } from './theme';

export function tabBarMetrics(bottomInset: number, fontScale: number) {
  const scaledLabelHeight = Math.ceil(TYPESCALE.xs * Math.min(Math.max(fontScale, 1), 2) * 1.2);
  const contentHeight = SPACING.sm + 25 + SPACING.xs + scaledLabelHeight + SPACING.sm;
  return {
    height: contentHeight + bottomInset,
    paddingTop: SPACING.sm,
    paddingBottom: bottomInset + SPACING.sm,
  };
}
