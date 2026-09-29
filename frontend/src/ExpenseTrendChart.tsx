import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from './ThemeContext';
import T from './T';
import { formatAccessibleMoney, formatMoney } from './format';
import { expenseTrendWindow, TREND_WINDOW_SIZE, type TrendExpense, type TrendPeriod } from './expenseTrend';
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

export default function ExpenseTrendChart({ expenses, currency, personalMemberId, personalKind }: {
  expenses: readonly TrendExpense[];
  currency: string;
  personalMemberId?: string | null;
  personalKind?: 'individual' | 'family';
}) {
  const { colors } = useTheme();
  const [period, setPeriod] = useState<TrendPeriod>('daily');
  const [page, setPage] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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

      <View style={styles.selectedSummary} accessible accessibilityLabel={`${selected.detailLabel}, trip net spending ${selectedAccessibleAmount}${personalMemberId ? `, ${personalLabel.toLowerCase()} net ${selectedPersonalAccessibleAmount}` : ''}, ${selected.count} ${selected.count === 1 ? 'transaction' : 'transactions'}`}>
        <T variant="caption" muted importantForAccessibility="no">{selected.detailLabel}</T>
        <View style={styles.metricRow}>
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
        </View>
        {personalMemberId ? (
          <View style={styles.metricRow}>
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
          </View>
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
          const positiveBar = bucket.total > 0;
          const negativeBar = bucket.total < 0;
          const height = barHeight(bucket.total);
          const personalHeight = personalMemberId ? barHeight(bucket.personalTotal) : 0;
          return (
            <Pressable
              key={bucket.key}
              testID={`expense-trend-bar-${bucket.key}`}
              onPress={() => setSelectedKey(bucket.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${bucket.detailLabel}, trip net spending ${formatAccessibleMoney(bucket.total, { currency })}${personalMemberId ? `, ${personalLabel.toLowerCase()} net ${formatAccessibleMoney(bucket.personalTotal, { currency })}` : ''}, ${bucket.count} ${bucket.count === 1 ? 'transaction' : 'transactions'}`}
              style={({ pressed, focused }: any) => [
                styles.bucket,
                active && { backgroundColor: colors.surfaceMuted },
                pressed && { opacity: 0.72 },
                focused && Platform.OS === 'web' && {
                  outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: -2,
                } as any,
              ]}
            >
              <View style={styles.plotColumn}>
                {height > 0 ? (
                  <View
                    testID={`expense-trend-total-bar-${bucket.key}`}
                    style={[
                      styles.bar,
                      positiveBar ? { bottom: negativeHeight, borderTopLeftRadius: RADIUS.sm, borderTopRightRadius: RADIUS.sm }
                        : { top: positiveHeight, borderBottomLeftRadius: RADIUS.sm, borderBottomRightRadius: RADIUS.sm },
                      { height, backgroundColor: negativeBar ? colors.danger : colors.primary, opacity: active ? 0.68 : 0.4 },
                    ]}
                  />
                ) : null}
                {personalHeight > 0 ? (
                  <View
                    testID={`expense-trend-personal-bar-${bucket.key}`}
                    style={[
                      styles.bar,
                      styles.personalBar,
                      bucket.personalTotal > 0
                        ? { bottom: negativeHeight, borderTopLeftRadius: RADIUS.sm, borderTopRightRadius: RADIUS.sm }
                        : { top: positiveHeight, borderBottomLeftRadius: RADIUS.sm, borderBottomRightRadius: RADIUS.sm },
                      { height: personalHeight, backgroundColor: colors.chartPersonal, opacity: active ? 1 : 0.84 },
                    ]}
                  />
                ) : null}
              </View>
              <T
                variant="caption"
                color={active ? colors.textMain : colors.textMuted}
                style={[styles.axisLabel, active && styles.activeAxisLabel]}
                numberOfLines={1}
                importantForAccessibility="no"
              >
                {bucket.axisLabel}
              </T>
            </Pressable>
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
      {expenses.some((expense) => expense.amount < 0) ? (
        <T variant="caption" muted style={styles.refundNote}>Net spend includes refunds</T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: SPACING.md },
  empty: { gap: SPACING.xs },
  selectedSummary: { gap: SPACING.xs, alignItems: 'stretch' },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minWidth: 0 },
  metricSwatch: { width: 8, height: 8, borderRadius: RADIUS.pill },
  metricLabel: { flex: 1, minWidth: 0 },
  amount: { fontVariant: ['tabular-nums'], maxWidth: '70%', flexShrink: 1, textAlign: 'right' },
  chartScroll: { width: '100%', maxWidth: '100%' },
  chartContent: { flexGrow: 1, flexDirection: 'row', height: PLOT_HEIGHT + AXIS_HEIGHT, position: 'relative' },
  guide: { position: 'absolute', height: 1, left: 0, right: 0, opacity: 0.55 },
  baseline: { position: 'absolute', height: 1, left: 0, right: 0 },
  bucket: { flex: 1, minWidth: 44, height: PLOT_HEIGHT + AXIS_HEIGHT, alignItems: 'center', borderRadius: RADIUS.sm },
  plotColumn: { width: '100%', height: PLOT_HEIGHT },
  bar: { position: 'absolute', alignSelf: 'center', width: '56%', maxWidth: 34, minWidth: 8 },
  personalBar: { width: '34%', maxWidth: 20, minWidth: 6 },
  axisLabel: { height: AXIS_HEIGHT, paddingTop: SPACING.sm, textAlign: 'center', fontSize: TYPESCALE.micro, lineHeight: 15 },
  activeAxisLabel: { fontFamily: FONTS.bodyBold },
  navigation: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.xs },
  rangeLabel: { flex: 1, minWidth: 0, textAlign: 'center', fontFamily: FONTS.bodyMedium },
  refundNote: { textAlign: 'center' },
});
