import React from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import T from '../T';
import { formatAccessibleMoney, formatMoney } from '../format';

type Props = {
  value: number;
  currency?: string;
  /** Visible currency treatment. Accessibility labels always use the ISO code. */
  currencyDisplay?: 'symbol' | 'code';
  signed?: boolean;
  whole?: boolean;
  /** 'money' (24) default, 'moneyLg' (32) for hero balances. */
  variant?: 'money' | 'moneyLg';
  /** Colour by sign: positive→success, negative→danger. Overridden by `color`. */
  colorBySign?: boolean;
  color?: string;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
};

/**
 * Renders a monetary value with tabular figures (via the T money variants) and consistent
 * formatting (complete grouped whole units). Use everywhere an amount appears so columns align.
 */
export default function AmountText({
  value, currency, currencyDisplay, signed, variant = 'money', colorBySign, color, muted, style, testID,
}: Props) {
  // colorBySign is resolved in the screen (needs theme); callers pass an explicit `color`.
  return (
    <T
      variant={variant}
      color={color}
      muted={muted}
      style={[{ flexShrink: 1, textAlign: 'right' }, style]}
      testID={testID}
      accessibilityLabel={formatAccessibleMoney(value, { signed, currency })}
    >
      {formatMoney(value, { signed, currency, currencyDisplay })}
    </T>
  );
}
