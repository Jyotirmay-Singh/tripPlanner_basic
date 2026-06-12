import React from 'react';
import { Text, TextProps, StyleSheet } from 'react-native';
import { useTheme } from './ThemeContext';

type Variant = 'h1' | 'h2' | 'h3' | 'body' | 'label' | 'caption' | 'money';

export default function T({
  variant = 'body', style, muted, color, children, ...rest
}: TextProps & { variant?: Variant; muted?: boolean; color?: string }) {
  const { colors } = useTheme();
  const base: any = { color: color || (muted ? colors.textMuted : colors.textMain) };
  return (
    <Text {...rest} style={[styles[variant], base, style]}>{children}</Text>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: 32, fontWeight: '700', letterSpacing: -0.5 },
  h2: { fontSize: 24, fontWeight: '600', letterSpacing: -0.3 },
  h3: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 15, fontWeight: '400' },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  caption: { fontSize: 12, fontWeight: '400' },
  money: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
});
