import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from './ThemeContext';
import { buildCategorySummary } from './categorySummary';
import { formatAccessibleMoney, formatMoney } from './format';
import T from './T';
import DonutChart from './DonutChart';
import CategoryBadge from './ui/CategoryBadge';
import Icon from './ui/Icon';
export default function CategorySpendingChart({ expenses, currency, complete, onCategoryPress }: {
  expenses: readonly { category: string; amount: number }[]; currency: string; complete: boolean;
  onCategoryPress?: (name: string) => void;
}) {
  const { mode, colors } = useTheme();
  const model = useMemo(() => buildCategorySummary(expenses, currency, mode), [expenses, currency, mode]);
  const hasRefunds = model.refunds > 0;
  const [expanded, setExpanded] = useState(hasRefunds);
  useEffect(() => { setExpanded(hasRefunds); }, [hasRefunds]);
  if (!complete) return <View testID="category-totals-unverified"><T variant="h3">Spending by category</T>
    <T muted>Category totals need a complete refresh</T></View>;
  return <View testID="category-spending-summary" style={{ gap: 16 }}>
    <T variant="h3">Spending by category</T>
    {model.slices.length ? <DonutChart data={model.slices} currency={currency}
      centerValue={formatMoney(model.gross, { currency })} centerLabel="Gross spending"
      centerAccessibilityLabel={`Gross spending, ${formatAccessibleMoney(model.gross, { currency })}`}
      percentDigits={1} renderLegendMark={(slice) => <CategoryBadge name={slice.key} />}
      onSlicePress={onCategoryPress ? (slice) => onCategoryPress(slice.key) : undefined} />
      : <T muted>{model.refunds > 0 ? 'No positive spending in this view' : 'No spending yet'}</T>}
    {[['Gross spending', model.gross], ['Refunds', model.refunds], ['Net spending', model.net]].map(([label, amount]) =>
      <View key={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
        <T>{label}</T><T variant="h4">{formatMoney(Number(amount), { currency })}</T>
      </View>)}
    {model.rows.length ? <>
      <Pressable testID="category-refund-toggle" accessibilityRole="button" aria-expanded={expanded} accessibilityState={{ expanded }}
        accessibilityLabel="Refunds and net by category" onPress={() => setExpanded((previous) => !previous)}
        style={({ focused }: any) => [{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: colors.border },
          focused && { outlineWidth: 2, outlineColor: colors.primary }]}>
        <T style={{ flex: 1 }}>Refunds and net by category</T><Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={20} />
      </Pressable>
      {expanded ? <View testID="category-refund-breakdown" style={{ gap: 8 }}>
        {model.rows.map((row) => <Pressable key={row.name} testID={`category-net-${row.name}`}
          accessibilityRole={onCategoryPress ? 'button' : 'text'}
          accessibilityLabel={`${row.name}, refunds ${formatAccessibleMoney(row.refunds, { currency })}, net ${formatAccessibleMoney(row.net, { currency })}`}
          onPress={onCategoryPress ? () => onCategoryPress(row.name) : undefined}
          style={({ focused }: any) => [{ minHeight: 48, paddingVertical: 8, gap: 8 }, focused && { outlineWidth: 2, outlineColor: colors.primary }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><CategoryBadge name={row.name} />
            <T style={{ flex: 1, minWidth: 0 }}>{row.name}</T>{onCategoryPress ? <Icon name="chevron-right" size={18} /> : null}</View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginLeft: 48 }}>
            <T variant="caption" muted>Refunds {formatMoney(row.refunds, { currency })}</T>
            <T variant="caption">Net {formatMoney(row.net, { currency })}</T>
          </View>
        </Pressable>)}
      </View> : null}
    </> : null}
  </View>;
}
