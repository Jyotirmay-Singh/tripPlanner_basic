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
import { COMPONENT_SIZE, FONTS, SPACING, TYPESCALE } from './theme';
import type { TripBalanceState } from './tripBalance';
import Card from './ui/Card';
import Icon from './ui/Icon';

export type TripCardLayout = 'trailing' | 'bottom';
export type TripAmountSize = 'lg' | 'base' | 'xs';

type TextMeasurements = {
  key: string;
  labelWidth: number;
  amountLgWidth: number;
  amountBaseWidth: number;
  amountXsWidth: number;
};

type MeasurementField = Exclude<keyof TextMeasurements, 'key'>;

type Props = {
  title: string;
  subtitle?: string;
  meta?: string;
  currency: string;
  balance: TripBalanceState;
  onPress: () => void;
  testID: string;
  balanceTestID?: string;
  settledTestID?: string;
};

const CARD_HORIZONTAL_PADDING = SPACING.md;
const CARD_BORDER_WIDTH = 1;
const HIDDEN_FROM_ACCESSIBILITY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants' as const,
};

const emptyMeasurements = (key: string): TextMeasurements => ({
  key,
  labelWidth: 0,
  amountLgWidth: 0,
  amountBaseWidth: 0,
  amountXsWidth: 0,
});

export function chooseTripCardLayout(
  cardWidth: number,
  balanceWidth: number,
  fontScale: number,
): TripCardLayout {
  if (fontScale >= 1.5 || cardWidth <= 0 || balanceWidth <= 0) return 'bottom';

  const innerWidth = Math.max(
    0,
    cardWidth - CARD_HORIZONTAL_PADDING * 2 - CARD_BORDER_WIDTH * 2,
  );
  const fixedChrome = (
    COMPONENT_SIZE.tripIcon
    + COMPONENT_SIZE.tripChevron
    + SPACING.sm * 3
  );
  const balanceRail = Math.max(COMPONENT_SIZE.tripBalanceRail, balanceWidth);
  const scaledInformationMinimum = (
    COMPONENT_SIZE.tripInformationMin * Math.max(1, Math.min(fontScale, 1.3))
  );

  return innerWidth - fixedChrome - balanceRail >= scaledInformationMinimum
    ? 'trailing'
    : 'bottom';
}

export function chooseTripAmountSize(
  availableWidth: number,
  widths: Record<TripAmountSize, number>,
): TripAmountSize {
  if (availableWidth <= 0 || widths.lg <= 0) return 'lg';
  if (widths.lg <= availableWidth) return 'lg';
  if (widths.base > 0 && widths.base <= availableWidth) return 'base';
  return 'xs';
}

export function tripCardAccessibilityLabel(
  title: string,
  balance: TripBalanceState,
  currency: string,
): string {
  if (balance.kind === 'settled') return `${title}, settled`;
  if (balance.kind === 'unavailable') return `${title}, balance unavailable`;
  return `${title}, ${balance.label.toLowerCase()} ${formatMoney(balance.amount, { currency })}`;
}

function TripBalanceBlock({
  balance,
  currency,
  layout,
  amountSize,
  balanceTestID,
  settledTestID,
}: {
  balance: TripBalanceState;
  currency: string;
  layout: TripCardLayout;
  amountSize: TripAmountSize;
  balanceTestID?: string;
  settledTestID?: string;
}) {
  const { colors } = useTheme();
  const blockStyle = layout === 'trailing'
    ? styles.trailingBalanceBlock
    : styles.bottomBalanceBlock;

  if (balance.kind === 'settled') {
    return (
      <View
        testID={balanceTestID}
        pointerEvents="none"
        style={blockStyle}
        {...HIDDEN_FROM_ACCESSIBILITY}
      >
        <View testID={settledTestID}>
          <Badge
            label={balance.label}
            color={colors.success}
            textColor={colors.textMain}
            size="status"
          />
        </View>
      </View>
    );
  }

  if (balance.kind === 'unavailable') {
    return (
      <View
        testID={balanceTestID}
        pointerEvents="none"
        style={blockStyle}
        {...HIDDEN_FROM_ACCESSIBILITY}
      >
        <T variant="caption" muted style={styles.balanceText}>{balance.label}</T>
      </View>
    );
  }

  const amountColor = balance.kind === 'owed' ? colors.success : colors.danger;
  const amountStyle = amountSize === 'lg'
    ? styles.amountLg
    : amountSize === 'base'
      ? styles.amountBase
      : styles.amountXs;

  return (
    <View
      testID={balanceTestID}
      pointerEvents="none"
      style={blockStyle}
      {...HIDDEN_FROM_ACCESSIBILITY}
    >
      <T variant="label" muted style={styles.balanceText}>{balance.label}</T>
      <T
        variant="money"
        color={amountColor}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={[styles.amount, amountStyle, styles.visibleAmount]}
      >
        {formatMoney(balance.amount, { currency })}
      </T>
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
  const exactAmount = balance.kind === 'owed' || balance.kind === 'owe'
    ? formatMoney(balance.amount, { currency })
    : '';
  const measurementKey = `${balance.kind}|${balance.label}|${exactAmount}|${fontScale}`;
  const [measurements, setMeasurements] = useState<TextMeasurements>(
    () => emptyMeasurements(''),
  );
  const currentMeasurements = measurements.key === measurementKey
    ? measurements
    : emptyMeasurements(measurementKey);

  const recordCardWidth = useCallback((event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setCardWidth((current) => current === width ? current : width);
  }, []);

  const recordMeasurement = useCallback((
    field: MeasurementField,
    event: LayoutChangeEvent,
  ) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setMeasurements((current) => {
      const next = current.key === measurementKey
        ? current
        : emptyMeasurements(measurementKey);
      return next[field] === width ? next : { ...next, [field]: width };
    });
  }, [measurementKey]);

  const recordLabelWidth = useCallback((event: LayoutChangeEvent) => {
    recordMeasurement('labelWidth', event);
  }, [recordMeasurement]);
  const recordAmountLgWidth = useCallback((event: LayoutChangeEvent) => {
    recordMeasurement('amountLgWidth', event);
  }, [recordMeasurement]);
  const recordAmountBaseWidth = useCallback((event: LayoutChangeEvent) => {
    recordMeasurement('amountBaseWidth', event);
  }, [recordMeasurement]);
  const recordAmountXsWidth = useCallback((event: LayoutChangeEvent) => {
    recordMeasurement('amountXsWidth', event);
  }, [recordMeasurement]);

  const statusPadding = balance.kind === 'settled' ? SPACING.sm * 2 + 2 : 0;
  const balanceWidth = Math.max(
    currentMeasurements.labelWidth + statusPadding,
    currentMeasurements.amountLgWidth,
  );
  const layout = chooseTripCardLayout(cardWidth, balanceWidth, fontScale);
  const innerCardWidth = Math.max(
    0,
    cardWidth - CARD_HORIZONTAL_PADDING * 2 - CARD_BORDER_WIDTH * 2,
  );
  const amountSize = layout === 'trailing'
    ? 'lg'
    : chooseTripAmountSize(innerCardWidth, {
      lg: currentMeasurements.amountLgWidth,
      base: currentMeasurements.amountBaseWidth,
      xs: currentMeasurements.amountXsWidth,
    });
  const balanceRailWidth = Math.max(COMPONENT_SIZE.tripBalanceRail, balanceWidth);
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
    <View
      style={styles.information}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <T variant="h4" numberOfLines={2}>{title}</T>
      {subtitle ? (
        <T variant="caption" muted numberOfLines={2} style={styles.subtitle}>{subtitle}</T>
      ) : null}
      {meta ? (
        <T variant="caption" muted numberOfLines={2} style={styles.meta}>{meta}</T>
      ) : null}
    </View>
  );
  const chevron = (
    <View
      style={styles.chevron}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon
        name="chevron-right"
        size={COMPONENT_SIZE.tripChevron}
        color={colors.textMuted}
      />
    </View>
  );
  const balanceBlock = (
    <TripBalanceBlock
      balance={balance}
      currency={currency}
      layout={layout}
      amountSize={amountSize}
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
        style={layout === 'trailing' ? styles.trailingCard : styles.bottomCard}
      >
        {layout === 'trailing' ? (
          <>
            {icon}
            {information}
            <View
              pointerEvents="none"
              style={[styles.balanceRail, { width: balanceRailWidth }]}
            >
              {balanceBlock}
            </View>
            {chevron}
          </>
        ) : (
          <>
            <View style={styles.topRow}>
              {icon}
              {information}
              {chevron}
            </View>
            <View pointerEvents="none" style={styles.bottomBalanceRow}>
              {balanceBlock}
            </View>
          </>
        )}

        {/* Intrinsic-size probes only; visible card content remains in normal document flow. */}
        <View
          pointerEvents="none"
          style={styles.measurements}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <T variant="label" style={styles.measurementText} onLayout={recordLabelWidth}>
            {balance.label}
          </T>
          {exactAmount ? (
            <>
              <T
                variant="money"
                style={[styles.amount, styles.amountLg, styles.measurementText]}
                onLayout={recordAmountLgWidth}
              >
                {exactAmount}
              </T>
              <T
                variant="money"
                style={[styles.amount, styles.amountBase, styles.measurementText]}
                onLayout={recordAmountBaseWidth}
              >
                {exactAmount}
              </T>
              <T
                variant="money"
                style={[styles.amount, styles.amountXs, styles.measurementText]}
                onLayout={recordAmountXsWidth}
              >
                {exactAmount}
              </T>
            </>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  trailingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  bottomCard: { gap: SPACING.sm },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  bottomBalanceRow: {
    width: '100%',
    alignItems: 'flex-end',
  },
  iconBadge: {
    width: COMPONENT_SIZE.tripIcon,
    height: COMPONENT_SIZE.tripIcon,
    borderRadius: COMPONENT_SIZE.tripIcon / 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  information: { flex: 1, minWidth: 0 },
  subtitle: { marginTop: 2 },
  meta: { marginTop: 1 },
  chevron: { flexShrink: 0 },
  balanceRail: {
    flexShrink: 0,
    alignItems: 'stretch',
  },
  trailingBalanceBlock: {
    width: '100%',
    minWidth: 0,
    alignItems: 'flex-end',
  },
  bottomBalanceBlock: {
    width: '100%',
    minWidth: 0,
    alignItems: 'flex-end',
  },
  balanceText: {
    maxWidth: '100%',
    textAlign: 'right',
  },
  amount: {
    maxWidth: '100%',
    fontFamily: FONTS.number,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  visibleAmount: { alignSelf: 'stretch' },
  amountLg: { fontSize: TYPESCALE.lg, lineHeight: 26 },
  amountBase: { fontSize: TYPESCALE.base, lineHeight: 20 },
  amountXs: { fontSize: TYPESCALE.xs, lineHeight: 16 },
  measurements: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    alignItems: 'flex-start',
  },
  measurementText: { alignSelf: 'flex-start' },
});
