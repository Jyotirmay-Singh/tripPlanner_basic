import React from 'react';
import { View, StyleSheet } from 'react-native';
import { RADIUS } from './theme';
import T from './T';

// Small bordered pill used for role/status labels (e.g. Owner, Admin, You, Linked).
// Extracted from the inline badge in join-trip.tsx so the roster, the manage modal,
// and the join wizard share one definition.
export default function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <T variant="caption" color={color} style={styles.text}>{label}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 },
  text: { fontWeight: '700', fontSize: 10 },
});
