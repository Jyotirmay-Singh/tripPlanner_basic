import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING } from '../theme';
import T from '../T';
import Card from './Card';
import Icon, { IconName } from './Icon';

type Props = {
  title: string;
  subtitle?: string;
  meta?: string;
  /** leading round icon badge */
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  /** right-hand slot (amount, chevron, action). If onPress is set and no right node, a chevron shows. */
  right?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};

/** The canonical tappable list item: optional leading icon badge, title + subtitle/meta,
 *  and a right slot. Replaces the ad-hoc "icon + content + chevron" rows across screens. */
export default function ListRow({
  title, subtitle, meta, icon, iconColor, iconBg, right, onPress, showChevron, testID, accessibilityLabel,
}: Props) {
  const { colors } = useTheme();
  return (
    <Card onPress={onPress} testID={testID} accessibilityLabel={accessibilityLabel || title} style={styles.row}>
      {icon ? (
        <View style={[styles.badge, { backgroundColor: iconBg ?? colors.surfaceMuted }]}>
          <Icon name={icon} size={20} color={iconColor ?? colors.primary} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="h4" numberOfLines={1}>{title}</T>
        {subtitle ? <T variant="caption" muted numberOfLines={1} style={{ marginTop: 2 }}>{subtitle}</T> : null}
        {meta ? <T variant="caption" muted numberOfLines={1} style={{ marginTop: 1 }}>{meta}</T> : null}
      </View>
      {right ?? (onPress && showChevron !== false ? <Icon name="chevron-right" size={20} color={colors.textMuted} /> : null)}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  badge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
