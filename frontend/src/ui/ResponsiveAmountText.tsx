import React from 'react';
import { View, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import T from '../T';
import { formatAccessibleMoney, formatMoney } from '../format';

type Candidate = { text: string; detachedCurrency: boolean };

type Props = {
  value: number;
  currency?: string;
  signed?: boolean;
  whole?: boolean;
  /** Include the currency symbol visually. The ISO code remains in accessibility text. */
  showCurrency?: boolean;
  label?: string;
  variant?: 'money' | 'moneyLg' | 'caption';
  color?: string;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
};

/** Kept as a small pure seam for layout tests; whole-unit UI has exactly one complete candidate. */
export function responsiveMoneyCandidates(
  value: number,
  opts: { currency?: string; signed?: boolean; showCurrency?: boolean; whole?: boolean },
): Candidate[] {
  return [{
    text: formatMoney(value, {
      currency: opts.currency,
      signed: opts.signed,
      showCurrency: opts.showCurrency,
    }),
    detachedCurrency: false,
  }];
}

/** Complete values are allowed to wrap/grow; they are never replaced by a compact fallback. */
export default function ResponsiveAmountText({
  value,
  currency,
  signed,
  showCurrency = true,
  label,
  variant = 'money',
  color,
  muted,
  style,
  testID,
}: Props) {
  const visual = formatMoney(value, { currency, signed, showCurrency });
  const accessible = formatAccessibleMoney(value, { currency, signed });
  const accessibilityLabel = label ? `${label}, ${accessible}` : accessible;

  return (
    <View
      style={styles.root}
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel}
    >
      <T
        variant={variant}
        color={color}
        muted={muted}
        style={[styles.value, style]}
        importantForAccessibility="no"
      >
        {visual}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    maxWidth: '100%',
    minWidth: 0,
    alignSelf: 'flex-end',
    flexShrink: 1,
  },
  value: {
    flexShrink: 1,
    textAlign: 'right',
  },
});
