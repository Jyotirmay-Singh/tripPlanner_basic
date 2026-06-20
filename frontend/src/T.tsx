import React from 'react';
import { Text, TextProps, StyleSheet } from 'react-native';
import { useTheme } from './ThemeContext';
import { FONTS, TYPESCALE } from './theme';

type Variant =
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'body'
  | 'label'
  | 'caption'
  | 'money'
  | 'moneyLg';

// Variants whose figures should line up in columns (tabular numerals).
const NUMERIC: Variant[] = ['money', 'moneyLg'];

export default function T({
  variant = 'body', style, muted, color, children, ...rest
}: TextProps & { variant?: Variant; muted?: boolean; color?: string }) {
  const { colors } = useTheme();
  const base: any = { color: color || (muted ? colors.textMuted : colors.textMain) };
  if (NUMERIC.includes(variant)) base.fontVariant = ['tabular-nums'];
  return (
    <Text {...rest} style={[styles[variant], base, style]}>{children}</Text>
  );
}

// Weight is encoded in the font-family name (Outfit_700Bold etc.), so we set
// `fontFamily` and deliberately omit `fontWeight` to avoid faux-bold rendering.
const styles = StyleSheet.create({
  display: { fontFamily: FONTS.headingBold, fontSize: TYPESCALE.display, letterSpacing: -1, lineHeight: 44 },
  h1: { fontFamily: FONTS.headingBold, fontSize: TYPESCALE.xxl, letterSpacing: -0.5, lineHeight: 38 },
  h2: { fontFamily: FONTS.heading, fontSize: TYPESCALE.xl, letterSpacing: -0.3, lineHeight: 30 },
  h3: { fontFamily: FONTS.heading, fontSize: TYPESCALE.lg, letterSpacing: -0.2, lineHeight: 26 },
  h4: { fontFamily: FONTS.heading, fontSize: TYPESCALE.md, letterSpacing: -0.1, lineHeight: 22 },
  body: { fontFamily: FONTS.body, fontSize: TYPESCALE.md, lineHeight: 24 },
  label: { fontFamily: FONTS.bodyBold, fontSize: TYPESCALE.xs, letterSpacing: 1.5, textTransform: 'uppercase', lineHeight: 16 },
  caption: { fontFamily: FONTS.body, fontSize: TYPESCALE.sm, lineHeight: 18 },
  money: { fontFamily: FONTS.number, fontSize: TYPESCALE.xl, letterSpacing: -0.3, lineHeight: 28 },
  moneyLg: { fontFamily: FONTS.numberBold, fontSize: TYPESCALE.xxl, letterSpacing: -0.5, lineHeight: 38 },
});
