import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS } from '../theme';
import T from '../T';
import Button from './Button';
import Icon, { IconName } from './Icon';

type Props = {
  icon?: IconName;
  title: string;
  body?: string;
  ctaLabel?: string;
  onCta?: () => void;
  ctaIcon?: IconName;
  testID?: string;
};

/** Friendly empty state: a soft icon medallion, a title, supporting copy, and an optional CTA.
 *  Used wherever a list/section has no data yet. */
export default function EmptyState({ icon = 'sparkles', title, body, ctaLabel, onCta, ctaIcon, testID }: Props) {
  const { colors } = useTheme();
  return (
    <View testID={testID} style={[styles.wrap, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={[styles.medallion, { backgroundColor: colors.surfaceMuted }]}>
        <Icon name={icon} size={28} color={colors.primary} />
      </View>
      <T variant="h3" style={{ marginTop: SPACING.md, textAlign: 'center' }}>{title}</T>
      {body ? <T muted style={{ marginTop: SPACING.xs, textAlign: 'center' }}>{body}</T> : null}
      {ctaLabel && onCta ? (
        <Button label={ctaLabel} onPress={onCta} icon={ctaIcon} style={{ marginTop: SPACING.lg }} testID={testID ? `${testID}-cta` : undefined} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACING.xl, borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center' },
  medallion: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
});
