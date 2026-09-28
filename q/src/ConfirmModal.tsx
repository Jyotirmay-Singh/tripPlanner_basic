import React from 'react';
import { Modal, View, TouchableOpacity, StyleSheet, Pressable, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';

export type ConfirmAction = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'default' | 'cancel' | 'destructive';
  testID?: string;
  disabled?: boolean;
};

export type ConfirmTextInput = {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder?: string;
  testID?: string;
};

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  actions: ConfirmAction[];
  onRequestClose?: () => void; // hardware back / scrim tap
  testID?: string;
  textInput?: ConfirmTextInput;
};

// Reusable theme-aware confirmation modal. Unlike the native Alert, every color comes from
// ThemeContext so it follows light/dark mode. Actions render as a vertical button stack.
export default function ConfirmModal({
  visible, title, message, actions, onRequestClose, testID, textInput,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

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
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable
        style={[
          styles.scrim,
          {
            paddingTop: insets.top + SPACING.lg,
            paddingBottom: insets.bottom + SPACING.lg,
            paddingLeft: insets.left + SPACING.lg,
            paddingRight: insets.right + SPACING.lg,
          },
        ]}
        onPress={onRequestClose}
      >
        <Pressable
          testID={testID}
          onPress={() => {}}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <T variant="h3">{title}</T>
          {message ? <T muted style={{ marginTop: SPACING.sm, lineHeight: 20 }}>{message}</T> : null}
          {textInput ? (
            <View style={{ marginTop: SPACING.md }}>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>{textInput.label}</T>
              <TextInput
                value={textInput.value}
                onChangeText={textInput.onChangeText}
                placeholder={textInput.placeholder}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={textInput.label}
                testID={textInput.testID}
                cursorColor={colors.primary}
                selectionColor={colors.primary + '55'}
                style={[
                  styles.input,
                  { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border },
                ]}
              />
            </View>
          ) : null}
          <View style={{ marginTop: SPACING.lg, gap: SPACING.sm }}>
            {actions.map((a, i) => (
              <TouchableOpacity
                key={i}
                testID={a.testID}
                onPress={a.onPress}
                disabled={a.disabled}
                accessibilityRole="button"
                accessibilityState={{ disabled: !!a.disabled }}
                style={[styles.btn, btnStyle(a.variant), a.disabled && styles.disabled]}>
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
  },
  card: { borderRadius: RADIUS.lg, borderWidth: 1, padding: SPACING.lg },
  btn: { paddingVertical: 14, borderRadius: RADIUS.pill, alignItems: 'center' },
  disabled: { opacity: 0.45 },
  input: {
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
  },
});
