import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import T from './T';
import ProfileAvatarButton from './ProfileAvatarButton';
import { SPACING } from './theme';

type Props = {
  title: string;
  eyebrow?: string;
  action?: React.ReactNode;
  compactAction?: React.ReactNode;
};

export function shouldUseCompactHeaderAction(width: number, fontScale: number): boolean {
  return width <= 360 || fontScale >= 1.3;
}

/**
 * Compact header for tab pages. The tabs deliberately have no navigator header, so this row
 * keeps the page identity, optional primary action, and profile shortcut inside the one safe-area
 * owner provided by Screen.
 */
export default function TabPageHeader({ title, eyebrow, action, compactAction }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const visibleAction = compactAction && shouldUseCompactHeaderAction(width, fontScale)
    ? compactAction
    : action;

  return (
    <View style={styles.row}>
      <View style={styles.titleBlock}>
        {eyebrow ? <T variant="label" muted>{eyebrow}</T> : null}
        <T variant="h1" numberOfLines={1} style={eyebrow ? styles.titleWithEyebrow : undefined}>
          {title}
        </T>
      </View>
      <View style={styles.actions}>
        {visibleAction}
        <ProfileAvatarButton containerStyle={styles.inlineAvatar} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  titleBlock: { flex: 1, minWidth: 0 },
  titleWithEyebrow: { marginTop: 2 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: SPACING.md,
  },
  inlineAvatar: { marginRight: 0 },
});
