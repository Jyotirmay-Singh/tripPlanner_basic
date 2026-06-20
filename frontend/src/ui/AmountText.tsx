import React from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import T from '../T';
import { formatMoney } from '../format';

type Props = {
  value: number;
  currency?: string;
  signed?: boolean;
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
 * formatting (grouped thousands, 2 decimals). Use everywhere an amount appears so columns align.
 */
export default function AmountText({
  value, currency, signed, variant = 'money', colorBySign, color, muted, style, testID,
}: Props) {
  // colorBySign is resolved in the screen (needs theme); callers pass an explicit `color`.
  return (
    <T variant={variant} color={color} muted={muted} style={style} testID={testID}>
      {formatMoney(value, { signed, currency })}
    </T>
  );
}
