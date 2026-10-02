import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { SPACING } from '../theme';
import T from '../T';
import Card from './Card';
import Icon, { IconName } from './Icon';

type Props = {
  label: string;
  value: string;
  valueColor?: string;
  caption?: string;
  icon?: IconName;
  variant?: 'default' | 'muted';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Compact metric tile: uppercase label, large value, optional caption. Used in the bento
 *  dashboard and the trip-summary stat row. */
export default function StatCard({ label, value, valueColor, caption, icon, variant = 'default', style, testID }: Props) {
  return (
    <Card variant={variant} padding="md" style={[{ flex: 1 }, style]} testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.xs }}>
        {icon ? <Icon name={icon} size={14} /> : null}
        <T variant="label" muted style={{ flexShrink: 1, minWidth: 0 }}>{label}</T>
      </View>
      <T variant="h2" color={valueColor} style={{ marginTop: SPACING.xs }}>
        {value}
      </T>
      {caption ? <T variant="caption" muted style={{ marginTop: 2 }}>{caption}</T> : null}
    </Card>
  );
}
