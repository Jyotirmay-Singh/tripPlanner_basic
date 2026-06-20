import React from 'react';
import { Modal, View, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';

export type ConfirmAction = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'default' | 'cancel' | 'destructive';
  testID?: string;
};

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  actions: ConfirmAction[];
  onRequestClose?: () => void; // hardware back / scrim tap
  testID?: string;
};

// Reusable theme-aware confirmation modal. Unlike the native Alert, every color comes from
// ThemeContext so it follows light/dark mode. Actions render as a vertical button stack.
export default function ConfirmModal({ visible, title, message, actions, onRequestClose, testID }: Props) {
  const { colors } = useTheme();

  const btnStyle = (variant: ConfirmAction['variant']) => {
    if (variant === 'primary') return { backgroundColor: colors.primary };
    if (variant === 'destructive') return { backgroundColor: colors.owing };
    if (variant === 'cancel') return { backgroundColor: 'transparent' };
    return { backgroundColor: colors.surfaceMuted };
  };
  const btnTextColor = (variant: ConfirmAction['variant']) => {
    if (variant === 'primary' || variant === 'destructive') return colors.primaryText;
    if (variant === 'cancel') return colors.textMuted;
    return colors.textMain;
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <Pressable style={styles.scrim} onPress={onRequestClose}>
        <Pressable
          testID={testID}
          onPress={() => {}}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <T variant="h3">{title}</T>
          {message ? <T muted style={{ marginTop: SPACING.sm, lineHeight: 20 }}>{message}</T> : null}
          <View style={{ marginTop: SPACING.lg, gap: SPACING.sm }}>
            {actions.map((a, i) => (
              <TouchableOpacity
                key={i}
                testID={a.testID}
                onPress={a.onPress}
                style={[styles.btn, btnStyle(a.variant)]}>
                <T color={btnTextColor(a.variant)} style={{ fontWeight: '700' }}>{a.label}</T>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  card: { borderRadius: RADIUS.lg, borderWidth: 1, padding: SPACING.lg },
  btn: { paddingVertical: 14, borderRadius: RADIUS.pill, alignItems: 'center' },
});
