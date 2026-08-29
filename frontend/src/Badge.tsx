import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COMPONENT_SIZE, FONTS, RADIUS, SPACING, TYPESCALE } from './theme';
import T from './T';

// Small bordered pill used for role/status labels (e.g. Owner, Admin, You, Linked).
// Extracted from the inline badge in join-trip.tsx so the roster, the manage modal,
// and the join wizard share one definition.
export default function Badge({
  label,
  color,
  textColor = color,
  size = 'compact',
}: {
  label: string;
  color: string;
  textColor?: string;
  size?: 'compact' | 'status';
}) {
  return (
    <View style={[styles.badge, size === 'status' && styles.statusBadge, { borderColor: color }]}>
      <T
        variant="caption"
        color={textColor}
        style={size === 'status' ? styles.statusText : styles.text}
      >
        {label}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 },
  text: { fontWeight: '700', fontSize: 10 },
  statusBadge: {
    minHeight: COMPONENT_SIZE.statusPill,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: {
    fontFamily: FONTS.bodyBold,
    fontSize: TYPESCALE.xs,
    lineHeight: 16,
  },
});
