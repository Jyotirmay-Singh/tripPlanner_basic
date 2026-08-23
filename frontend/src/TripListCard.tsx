import React, { useCallback, useState } from 'react';
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import Badge from './Badge';
import T from './T';
import { formatMoney } from './format';
import { useTheme } from './ThemeContext';
import { FONTS, SPACING, TYPESCALE } from './theme';
import type { TripBalanceState } from './tripBalance';
import Card from './ui/Card';
import Icon from './ui/Icon';

type CardLayout = 'inline' | 'stacked';

type TextMeasurements = {
  key: string;
  labelWidth: number;
  amountWidth: number;
};

type Props = {
  title: string;
  subtitle: string;
  meta: string;
  currency: string;
  balance: TripBalanceState;
  onPress: () => void;
  testID: string;
  balanceTestID?: string;
  settledTestID?: string;
};

const ICON_SIZE = 40;
const CHEVRON_SIZE = 20;
const CARD_HORIZONTAL_PADDING = SPACING.md;
const INFORMATION_SHARE = 0.45;

export function chooseTripCardLayout(
  cardWidth: number,
  balanceWidth: number,
  fontScale: number,
): CardLayout {
  if (fontScale >= 1.5 || cardWidth <= 0 || balanceWidth <= 0) return 'stacked';
  const innerWidth = Math.max(0, cardWidth - CARD_HORIZONTAL_PADDING * 2 - 2);
  const fixedChrome = ICON_SIZE + CHEVRON_SIZE + SPACING.sm * 3;
  const informationWidth = innerWidth - fixedChrome - balanceWidth;
  return informationWidth >= innerWidth * INFORMATION_SHARE ? 'inline' : 'stacked';
}

export function shouldUseFullBalanceRow(
  cardWidth: number,
  balanceWidth: number,
  fontScale: number,
): boolean {
  if (fontScale >= 1.5) return true;
  if (cardWidth <= 0 || balanceWidth <= 0) return false;
  const innerWidth = Math.max(0, cardWidth - CARD_HORIZONTAL_PADDING * 2 - 2);
  const indentedBalanceWidth = Math.max(
    0,
    innerWidth - ICON_SIZE - CHEVRON_SIZE - SPACING.sm * 2,
  );
  return balanceWidth > indentedBalanceWidth;
}

export function tripCardAccessibilityLabel(
  title: string,
  balance: TripBalanceState,
  currency: string,
): string {
  if (balance.kind === 'settled') return `${title}, settled`;
  if (balance.kind === 'unavailable') return `${title}, balance unavailable`;
  return `${title}, ${balance.label.toLowerCase()}, ${formatMoney(balance.amount, { currency })}`;
}

function TripBalanceBlock({
  balance,
  currency,
  layout,
  fontScale,
  balanceTestID,
  settledTestID,
}: {
  balance: TripBalanceState;
  currency: string;
  layout: CardLayout;
  fontScale: number;
  balanceTestID?: string;
  settledTestID?: string;
}) {
  const { colors } = useTheme();

  if (balance.kind === 'settled') {
    return (
      <View testID={balanceTestID} pointerEvents="none" style={styles.statusWrap}>
        <View testID={settledTestID}>
          <Badge label={balance.label} color={colors.success} textColor={colors.textMain} />
        </View>
      </View>
    );
  }

  if (balance.kind === 'unavailable') {
    return (
      <View testID={balanceTestID} pointerEvents="none" style={styles.statusWrap}>
        <T variant="caption" muted style={styles.trailingText}>{balance.label}</T>
      </View>
    );
  }

  const amountColor = balance.kind === 'owed' ? colors.success : colors.danger;
  const compactLargeType = layout === 'stacked' && fontScale >= 1.5;

  return (
    <View
      testID={balanceTestID}
      pointerEvents="none"
      style={layout === 'inline' ? styles.inlineBalance : styles.stackedBalance}
    >
      {layout === 'inline' ? (
        <>
          <T variant="label" muted style={styles.trailingText}>{balance.label}</T>
          <T variant="h3" color={amountColor} style={styles.amount}>
            {formatMoney(balance.amount, { currency })}
          </T>
        </>
      ) : (
        <>
          <View style={styles.stackedBalanceHeader}>
            <T variant="label" muted style={styles.stackedLabel}>{balance.label}</T>
            <T variant="label" muted>{currency}</T>
          </View>
          <T
            variant="h3"
            color={amountColor}
            style={[styles.amount, compactLargeType && styles.amountAtLargeScale]}
          >
            {formatMoney(balance.amount)}
          </T>
        </>
      )}
    </View>
  );
}

export default function TripListCard({
  title,
  subtitle,
  meta,
  currency,
  balance,
  onPress,
  testID,
  balanceTestID,
  settledTestID,
}: Props) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [cardWidth, setCardWidth] = useState(0);
  const [measurements, setMeasurements] = useState<TextMeasurements>({
    key: '',
    labelWidth: 0,
    amountWidth: 0,
  });
  const exactInlineAmount = balance.kind === 'owed' || balance.kind === 'owe'
    ? formatMoney(balance.amount, { currency })
    : '';
  const measurementKey = `${balance.kind}|${balance.label}|${exactInlineAmount}|${fontScale}`;
  const labelWidth = measurements.key === measurementKey ? measurements.labelWidth : 0;
  const amountWidth = measurements.key === measurementKey ? measurements.amountWidth : 0;

  const recordCardWidth = useCallback((event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setCardWidth((current) => current === width ? current : width);
  }, []);
  const recordLabelWidth = useCallback((event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setMeasurements((current) => {
      const next = current.key === measurementKey
        ? current
        : { key: measurementKey, labelWidth: 0, amountWidth: 0 };
      return next.labelWidth === width ? next : { ...next, labelWidth: width };
    });
  }, [measurementKey]);
  const recordAmountWidth = useCallback((event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setMeasurements((current) => {
      const next = current.key === measurementKey
        ? current
        : { key: measurementKey, labelWidth: 0, amountWidth: 0 };
      return next.amountWidth === width ? next : { ...next, amountWidth: width };
    });
  }, [measurementKey]);

  const balanceWidth = Math.max(
    labelWidth + (balance.kind === 'settled' ? 14 : 0),
    amountWidth,
  );
  const layout = chooseTripCardLayout(cardWidth, balanceWidth, fontScale);
  const fullBalanceRow = shouldUseFullBalanceRow(cardWidth, balanceWidth, fontScale);
  const metadataLines = layout === 'stacked' ? 2 : 1;
  const accessibilityLabel = tripCardAccessibilityLabel(title, balance, currency);

  const icon = (
    <View
      style={[styles.iconBadge, { backgroundColor: colors.surfaceMuted }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name="briefcase" size={20} color={colors.primary} />
    </View>
  );
  const information = (
    <View style={styles.information}>
      <T variant="h4" numberOfLines={2}>{title}</T>
      <T variant="caption" muted numberOfLines={metadataLines} style={styles.subtitle}>{subtitle}</T>
      <T variant="caption" muted numberOfLines={metadataLines} style={styles.meta}>{meta}</T>
    </View>
  );
  const chevron = (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon name="chevron-right" size={CHEVRON_SIZE} color={colors.textMuted} />
    </View>
  );
  const balanceBlock = (
    <TripBalanceBlock
      balance={balance}
      currency={currency}
      layout={layout}
      fontScale={fontScale}
      balanceTestID={balanceTestID}
      settledTestID={settledTestID}
    />
  );

  return (
    <View style={styles.root} onLayout={recordCardWidth}>
      <Card
        onPress={onPress}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={layout === 'inline' ? styles.inlineCard : styles.stackedCard}
      >
        {layout === 'inline' ? (
          <>
            {icon}
            {information}
            {balanceBlock}
            {chevron}
          </>
        ) : (
          <>
            <View style={styles.topRow}>
              {icon}
              {information}
            </View>
            <View style={[styles.bottomRow, fullBalanceRow && styles.bottomRowFullWidth]}>
              {balanceBlock}
              {chevron}
            </View>
          </>
        )}

        {/* Invisible intrinsic-size probes only; all visible card content stays in normal flow. */}
        <View
          pointerEvents="none"
          style={styles.measurements}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <T variant="label" style={styles.measurementText} onLayout={recordLabelWidth}>
            {balance.label}
          </T>
          {exactInlineAmount ? (
            <T variant="h3" style={[styles.amount, styles.measurementText]} onLayout={recordAmountWidth}>
              {exactInlineAmount}
            </T>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  inlineCard: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  stackedCard: { gap: SPACING.sm },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  bottomRow: {
    marginLeft: ICON_SIZE + SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
  },
  bottomRowFullWidth: { marginLeft: 0 },
  iconBadge: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  information: { flex: 1, minWidth: 0 },
  subtitle: { marginTop: 2 },
  meta: { marginTop: 1 },
  inlineBalance: { alignItems: 'flex-end', flexShrink: 0, minWidth: 0 },
  stackedBalance: { flex: 1, minWidth: 0, alignItems: 'stretch' },
  stackedBalanceHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  stackedLabel: { flexShrink: 1 },
  trailingText: { textAlign: 'right' },
  statusWrap: { alignItems: 'flex-end', flexShrink: 0 },
  amount: {
    fontFamily: FONTS.number,
    fontSize: TYPESCALE.lg,
    lineHeight: 24,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  amountAtLargeScale: { fontSize: TYPESCALE.base, lineHeight: 20 },
  measurements: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    alignItems: 'flex-start',
  },
  measurementText: { alignSelf: 'flex-start' },
});
