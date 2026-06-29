import React, { useMemo, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useTheme } from './ThemeContext';
import { SPACING } from './theme';
import T from './T';
import { Icon } from './ui';
import { formatMoney } from './format';
import { rankSpend, SpendSummary } from './spend';

// Horizontal "who spent the most" ranking. Built on react-native-svg (like DonutChart) with all
// colors from useTheme() so it tracks the in-app light/dark toggle. Single hue (theme primary): the
// shade deepens AND the bar lengthens toward the top spender — magnitude is encoded twice, and color
// variety stays reserved for the category donut. A small users/user marker distinguishes family vs
// individual (no second color axis). Values are right-aligned in a tabular column. Pure ranking +
// scaling lives in src/spend.ts::rankSpend (unit-tested); this component is presentation only.

const BAR_H = 12; // bar thickness (px)
const MIN_BAR_PX = 6; // floor so a tiny/zero spender stays visible & legible next to a huge one

export default function SpendBarChart({
  summary,
  displayNames,
  currency,
}: {
  summary: SpendSummary | null | undefined;
  displayNames: Record<string, string>;
  currency: string;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  // Re-ranks whenever the entity list changes, so the chart re-sorts on every data refresh.
  const bars = useMemo(() => rankSpend(summary?.entities), [summary?.entities]);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const total = summary?.total ?? 0;
  const count = summary?.count ?? 0;

  if (total <= 0) {
    // No expenses, or only refunds — nothing to rank.
    return (
      <View testID="spend-bar-chart">
        <T variant="label" muted style={{ marginBottom: SPACING.sm }}>Top spenders</T>
        <T variant="caption" muted>No spending to rank yet.</T>
      </View>
    );
  }

  return (
    <View testID="spend-bar-chart">
      <T variant="label" muted style={{ marginBottom: 2 }}>Top spenders</T>
      <T variant="caption" muted style={{ marginBottom: SPACING.md }}>
        {formatMoney(total, { currency })} spent across {count} {count === 1 ? 'entity' : 'entities'}
      </T>
      <View onLayout={onLayout} style={{ gap: SPACING.md }}>
        {bars.map((b) => {
          const label = displayNames[b.entity_id] || b.name;
          const fillW = width > 0 ? Math.max(MIN_BAR_PX, b.fraction * width) : 0;
          const alpha = 0.45 + 0.55 * b.fraction; // deepest at the top spender (fraction 1)
          return (
            <View key={b.entity_id} testID={`spend-bar-${b.entity_id}`}>
              <View style={styles.labelLine}>
                <View style={styles.labelLeft}>
                  <Icon name={b.entity_type === 'family' ? 'users' : 'user'} size={14} color={colors.textMuted} />
                  <T variant="caption" numberOfLines={1} style={{ flexShrink: 1 }}>{label}</T>
                </View>
                <T variant="caption" style={styles.value}>{formatMoney(b.paid, { currency })}</T>
              </View>
              {width > 0 ? (
                <Svg width={width} height={BAR_H} style={styles.bar}>
                  <Rect x={0} y={0} width={width} height={BAR_H} rx={BAR_H / 2} fill={colors.surfaceMuted} />
                  <Rect x={0} y={0} width={fillW} height={BAR_H} rx={BAR_H / 2} fill={colors.primary} fillOpacity={alpha} />
                </Svg>
              ) : (
                <View style={[styles.bar, { height: BAR_H }]} />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  labelLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  labelLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  value: { fontVariant: ['tabular-nums'] },
  bar: { marginTop: 6 },
});
