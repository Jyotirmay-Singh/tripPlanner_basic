import React from 'react';
import { Pressable, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../ThemeContext';
import { RADIUS, FONTS } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';

type Props = {
  label: string;
  active?: boolean;
  onPress: () => void;
  icon?: IconName;
  testID?: string;
};

/** Single selectable chip — currency / category selectors. Active = solid primary. */
export default function Pill({ label, active, onPress, icon, testID }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={({ focused }: any) => [
        styles.pill,
        {
          backgroundColor: active ? colors.primary : colors.surfaceMuted,
          borderColor: active ? colors.primary : colors.border,
        },
        focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
      ]}
    >
      {icon ? <Icon name={icon} size={15} color={active ? colors.primaryText : colors.textMain} /> : null}
      <T style={{ fontFamily: FONTS.bodySemibold }} color={active ? colors.primaryText : colors.textMain}>{label}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: RADIUS.pill, borderWidth: 1,
  },
});
