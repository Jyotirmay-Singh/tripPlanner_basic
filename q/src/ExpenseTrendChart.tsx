import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from './ThemeContext';
import T from './T';
import { formatAccessibleMoney, formatMoney } from './format';
import { expenseTrendWindow, TREND_WINDOW_SIZE, type TrendExpense, type TrendPeriod, type TrendScope, type TrendSelection } from './expenseTrend';
import { FONTS, RADIUS, SPACING, TYPESCALE } from './theme';
import IconButton from './ui/IconButton';
import SegmentedControl from './ui/SegmentedControl';

const PERIODS: { value: TrendPeriod; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];
const PLOT_HEIGHT = 148;
const AXIS_HEIGHT = 28;

export default function ExpenseTrendChart({ expenses, currency, personalMemberId, personalKind, onOpenPeriod }: {
  expenses: readonly TrendExpense[];
  currency: string;
  personalMemberId?: string | null;
  personalKind?: 'individual' | 'family';
  onOpenPeriod?: (selection: TrendSelection) => void;
}) {
  const { colors } = useTheme();
  const [period, setPeriod] = useState<TrendPeriod>('daily');
  const [page, setPage] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const visibleCount = chartWidth > 0
    ? Math.max(3, Math.min(TREND_WINDOW_SIZE[period], Math.floor(chartWidth / 44)))
    : TREND_WINDOW_SIZE[period];
  const window = useMemo(
    () => expenseTrendWindow(expenses, period, page, visibleCount, personalMemberId),
    [expenses, period, page, visibleCount, personalMemberId],
  );

  const changePeriod = (next: TrendPeriod) => {
    setPeriod(next);
    setPage(0);
    setSelectedKey(null);
  };
  const changePage = (delta: number) => {
    setPage((window?.page ?? 0) + delta);
    setSelectedKey(null);
  };
  const openPeriod = (key: string, scope: TrendScope) => {
    const bucket = window?.buckets.find((item) => item.key === key);
    if (!bucket || (scope === 'trip' ? bucket.count === 0 : bucket.personalCount === 0)) return;
    setSelectedKey(key);
    onOpenPeriod?.({ period, key, scope });
  };

  if (!window) {
    return (
      <View testID="expense-trend-empty" style={styles.empty}>
        <T variant="h4">Spending over time</T>
        <T variant="caption" muted>Add an expense to see how spending changes during this trip.</T>
      </View>
    );
  }

  const selected = window.buckets.find((bucket) => bucket.key === selectedKey)
    ?? [...window.buckets].reverse().find((bucket) => bucket.count > 0)
    ?? window.buckets[window.buckets.length - 1];
  const visibleValues = window.buckets.flatMap((bucket) => personalMemberId
    ? [bucket.total, bucket.personalTotal]
    : [bucket.total]);
  const maxPositive = Math.max(0, ...visibleValues);
  const maxNegative = Math.max(0, ...visibleValues.map((value) => -value));
  const negativeHeight = maxNegative === 0 ? 0 : maxPositive === 0
    ? PLOT_HEIGHT - 12
    : Math.max(32, Math.min(72, PLOT_HEIGHT * maxNegative / (maxPositive + maxNegative)));
  const positiveHeight = PLOT_HEIGHT - negativeHeight;
  const barHeight = (value: number) => value > 0
    ? Math.max(3, (positiveHeight - 8) * value / maxPositive)
    : value < 0
      ? Math.max(3, (negativeHeight - 8) * -value / maxNegative)
      : 0;
  const selectedAmount = formatMoney(selected.total, { currency });
  const selectedAccessibleAmount = formatAccessibleMoney(selected.total, { currency });
  const personalLabel = personalKind === 'family' ? 'Your family paid' : 'You paid';
  const selectedPersonalAmount = formatMoney(selected.personalTotal, { currency });
  const selectedPersonalAccessibleAmount = formatAccessibleMoney(selected.personalTotal, { currency });

  return (
    <View
      testID="expense-trend-chart"
      style={styles.root}
      onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)}
    >
      <T variant="h4">Spending over time</T>
      <SegmentedControl
        segments={PERIODS}
        value={period}
        onChange={changePeriod}
        layout="adaptive"
        testIDPrefix="expense-trend-period"
      />

      <View style={styles.selectedSummary} accessible={!onOpenPeriod} accessibilityLabel={`${selected.detailLabel}, trip net spending ${selectedAccessibleAmount}${personalMemberId ? `, ${personalLabel.toLowerCase()} net ${selectedPersonalAccessibleAmount}` : ''}, ${selected.count} ${selected.count === 1 ? 'transaction' : 'transactions'}`}>
        <T variant="caption" muted importantForAccessibility="no">{selected.detailLabel}</T>
        <Pressable
          testID="expense-trend-trip-summary"
          style={styles.metricRow}
          disabled={selected.count === 0 || !onOpenPeriod}
          onPress={onOpenPeriod ? () => openPeriod(selected.key, 'trip') : undefined}
          accessibilityRole={onOpenPeriod && selected.count > 0 ? 'button' : undefined}
          accessibilityLabel={`${selected.detailLabel}, trip net spending ${selectedAccessibleAmount}${selected.count > 0 ? ', view all transactions' : ''}`}
        >
          <View style={[styles.metricSwatch, { backgroundColor: selected.total < 0 ? colors.danger : colors.primary }]} />
          <T variant="caption" muted style={styles.metricLabel} importantForAccessibility="no">Trip net</T>
          <T
            testID="expense-trend-selected-amount"
            variant="moneyLg"
            color={selected.total < 0 ? colors.danger : colors.textMain}
            style={styles.amount}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.65}
            importantForAccessibility="no"
          >
            {selectedAmount}
          </T>
        </Pressable>
        {personalMemberId ? (
          <Pressable
            testID="expense-trend-personal-summary"
            style={styles.metricRow}
            disabled={selected.personalCount === 0 || !onOpenPeriod}
            onPress={onOpenPeriod ? () => openPeriod(selected.key, 'personal') : undefined}
            accessibilityRole={onOpenPeriod && selected.personalCount > 0 ? 'button' : undefined}
            accessibilityLabel={`${selected.detailLabel}, ${personalLabel.toLowerCase()} net ${selectedPersonalAccessibleAmount}${selected.personalCount > 0 ? ', view those transactions' : ''}`}
          >
            <View style={[styles.metricSwatch, { backgroundColor: colors.chartPersonal }]} />
            <T variant="caption" muted style={styles.metricLabel} importantForAccessibility="no">{personalLabel}</T>
            <T
              testID="expense-trend-personal-amount"
              variant="money"
              color={colors.chartPersonal}
              style={styles.amount}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
              importantForAccessibility="no"
            >
              {selectedPersonalAmount}
            </T>
          </Pressable>
        ) : null}
        <T variant="caption" muted importantForAccessibility="no">
          {selected.count} {selected.count === 1 ? 'transaction' : 'transactions'}
        </T>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chartScroll}
        contentContainerStyle={[styles.chartContent, { minWidth: window.buckets.length * 44 }]}
        accessibilityLabel={`${period} expense chart`}
      >
        <View style={[styles.guide, { top: positiveHeight / 2, backgroundColor: colors.border }]} />
        <View style={[styles.baseline, { top: positiveHeight, backgroundColor: colors.border }]} />
        {window.buckets.map((bucket) => {
          const active = bucket.key === selected.key;
          const negativeBar = bucket.total < 0;
          const tripZeroMarker = bucket.count > 0 && bucket.total === 0;
          const personalZeroMarker = bucket.personalCount > 0 && bucket.personalTotal === 0;
          const height = tripZeroMarker ? 5 : barHeight(bucket.total);
          const personalHeight = personalMemberId
            ? personalZeroMarker ? 5 : barHeight(bucket.personalTotal)
            : 0;
          return (
            <View
              key={bucket.key}
              style={styles.bucket}
            >
              <Pressable
                testID={`expense-trend-bar-${bucket.key}`}
                disabled={bucket.count === 0}
                onPress={() => openPeriod(bucket.key, 'trip')}
                onFocus={() => setFocusedKey(bucket.key)}
                onBlur={() => setFocusedKey(null)}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: bucket.count === 0 }}
                accessibilityLabel={`${bucket.detailLabel}, trip net spending ${formatAccessibleMoney(bucket.total, { currency })}${personalMemberId ? `, ${personalLabel.toLowerCase()} net ${formatAccessibleMoney(bucket.personalTotal, { currency })}` : ''}, ${bucket.count} ${bucket.count === 1 ? 'transaction' : 'transactions'}${onOpenPeriod && bucket.count > 0 ? ', view all transactions' : ''}`}
                style={({ pressed }: any) => [
                  styles.bucketTapArea,
                  pressed && { opacity: 0.72 },
                  Platform.OS === 'web' && { outlineWidth: 0 } as any,
                ]}
              >
                <View style={styles.plotColumn}>
                  {height > 0 ? (
                    <View
                      testID={`expense-trend-total-bar-${bucket.key}`}
                      style={[
                        styles.bar,
                        !negativeBar ? { bottom: negativeHeight, borderTopLeftRadius: RADIUS.sm, borderTopRightRadius: RADIUS.sm }
                          : { top: positiveHeight, borderBottomLeftRadius: RADIUS.sm, borderBottomRightRadius: RADIUS.sm },
                        tripZeroMarker && { borderRadius: RADIUS.pill },
                        { height, backgroundColor: negativeBar ? colors.danger : colors.primary, opacity: tripZeroMarker ? 0.8 : active ? 0.68 : 0.4 },
                      ]}
                    />
                  ) : null}
                </View>
                <T
                  variant="caption"
                  color={active ? colors.textMain : colors.textMuted}
                  style={[styles.axisLabel, active && styles.activeAxisLabel, focusedKey === bucket.key && styles.focusedAxisLabel]}
                  numberOfLines={1}
                  importantForAccessibility="no"
                >
                  {bucket.axisLabel}
                </T>
              </Pressable>
              {personalHeight > 0 ? (
                <Pressable
                  testID={`expense-trend-personal-bar-${bucket.key}`}
                  onPress={() => openPeriod(bucket.key, 'personal')}
                  onFocus={() => setFocusedKey(bucket.key)}
                  onBlur={() => setFocusedKey(null)}
                  hitSlop={personalZeroMarker ? 18 : 12}
                  accessibilityRole="button"
                  accessibilityLabel={`${bucket.detailLabel}, ${personalLabel.toLowerCase()} net ${formatAccessibleMoney(bucket.personalTotal, { currency })}, ${bucket.personalCount} ${bucket.personalCount === 1 ? 'transaction' : 'transactions'}, view those transactions`}
                  style={[
                    styles.bar,
                    styles.personalBar,
                    bucket.personalTotal > 0
                      ? { bottom: AXIS_HEIGHT + negativeHeight, borderTopLeftRadius: RADIUS.sm, borderTopRightRadius: RADIUS.sm }
                      : bucket.personalTotal < 0
                        ? { top: positiveHeight, borderBottomLeftRadius: RADIUS.sm, borderBottomRightRadius: RADIUS.sm }
                        : { bottom: AXIS_HEIGHT + negativeHeight, borderRadius: RADIUS.pill },
                    { height: personalHeight, backgroundColor: colors.chartPersonal, opacity: active ? 1 : 0.84 },
                    Platform.OS === 'web' && { outlineWidth: 0 } as any,
                  ]}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.navigation}>
        <IconButton
          testID="expense-trend-previous"
          name="chevron-left"
          size={18}
          touchSize={44}
          disabled={!window.canPrevious}
          onPress={() => changePage(1)}
          accessibilityLabel={`Earlier ${period} spending`}
        />
        <T testID="expense-trend-range" variant="caption" muted style={styles.rangeLabel}>
          {window.rangeLabel}
        </T>
        <IconButton
          testID="expense-trend-next"
          name="chevron-right"
          size={18}
          touchSize={44}
          disabled={!window.canNext}
          onPress={() => changePage(-1)}
          accessibilityLabel={`Later ${period} spending`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: SPACING.md },
  empty: { gap: SPACING.xs },
  selectedSummary: { gap: SPACING.xs, alignItems: 'stretch' },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minWidth: 0, minHeight: 44 },
  metricSwatch: { width: 8, height: 8, borderRadius: RADIUS.pill },
  metricLabel: { flex: 1, minWidth: 0 },
  amount: { fontVariant: ['tabular-nums'], maxWidth: '70%', flexShrink: 1, textAlign: 'right' },
  chartScroll: { width: '100%', maxWidth: '100%' },
  chartContent: { flexGrow: 1, flexDirection: 'row', height: PLOT_HEIGHT + AXIS_HEIGHT, position: 'relative' },
  guide: { position: 'absolute', height: 1, left: 0, right: 0, opacity: 0.55 },
  baseline: { position: 'absolute', height: 1, left: 0, right: 0 },
  bucket: { flex: 1, minWidth: 44, height: PLOT_HEIGHT + AXIS_HEIGHT, alignItems: 'center', borderRadius: RADIUS.sm },
  bucketTapArea: { ...StyleSheet.absoluteFillObject, alignItems: 'center' },
  plotColumn: { width: '100%', height: PLOT_HEIGHT },
  bar: { position: 'absolute', alignSelf: 'center', width: '56%', maxWidth: 34, minWidth: 8 },
  personalBar: { width: '34%', maxWidth: 20, minWidth: 6 },
  axisLabel: { height: AXIS_HEIGHT, paddingTop: SPACING.sm, textAlign: 'center', fontSize: TYPESCALE.micro, lineHeight: 15 },
  activeAxisLabel: { fontFamily: FONTS.bodyBold },
  focusedAxisLabel: { textDecorationLine: 'underline' },
  navigation: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.xs },
  rangeLabel: { flex: 1, minWidth: 0, textAlign: 'center', fontFamily: FONTS.bodyMedium },
});
