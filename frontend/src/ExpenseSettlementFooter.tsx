import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from './ThemeContext';
import { SPACING } from './theme';
import T from './T';
import Button from './ui/Button';
import type { Coverage, CoverageSummary } from './financialReview';
import { footerProgress } from './expenseSettlement';

export default function ExpenseSettlementFooter({ expenseId, summary, data, loading, source, onOpen }: {
  expenseId: string; summary?: CoverageSummary; data: Coverage | null; loading: boolean;
  source: 'live' | 'cache' | 'unavailable'; onOpen: () => void;
}) {
  const { colors } = useTheme();
  const unavailable = ['disabled', 'not_activated'].includes(data?.availability?.status ?? '');
  const label = loading && !summary ? 'Checking settlement…' : unavailable
    ? 'Expense settlement is not enabled for this group' : footerProgress(summary);
  const settle = !loading && source === 'live' && data?.availability?.new_starts_available
    && summary?.viewer_status === 'unpaid' && !summary.review_required && summary.remaining_amount !== null;
  return <View style={[styles.footer, { borderTopColor: colors.border }]} testID={`expense-settlement-footer-${expenseId}`}>
    <View style={{ flex: 1, minWidth: 120, gap: SPACING.xs }}>
      <T variant="caption" testID={`expense-settlement-progress-${expenseId}`}>{label}</T>
      {summary?.viewer_status === 'covered' && <T variant="caption" testID={`expense-your-share-settled-${expenseId}`}>Your share settled</T>}
      {!!summary?.inferred_settled_count && <T variant="caption" muted>Includes inferred history</T>}
    </View>
    <Button label={settle ? 'Settle' : 'View shares'} variant="ghost" size="sm" onPress={onOpen}
      testID={`expense-settlement-open-${expenseId}`} accessibilityLabel={`${settle ? 'Settle' : 'View shares for'} this expense`} />
  </View>;
}
const styles = StyleSheet.create({ footer: { marginTop: SPACING.sm, paddingTop: SPACING.xs,
  borderTopWidth: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm } });
