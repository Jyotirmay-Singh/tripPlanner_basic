import React, { forwardRef, useState } from 'react';
import { View, TextInput, Pressable, StyleSheet, Platform, type TextInputProps } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, CONTROL, FONTS } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';
import { eyeIcon, toggleVisible, secureA11yLabel } from '../secureField';

type Props = TextInputProps & {
  label?: string;
  helper?: string;
  error?: string | null;
  icon?: IconName;
  containerStyle?: any;
};

/**
 * Labelled text field: label above, helper/error below, focus ring, optional left icon.
 * Wraps the repeated label+input+error pattern that lived inline in ~12 screens. Forwards all
 * TextInputProps (incl. testID, value, onChangeText) so callers keep their field wiring.
 */
const Input = forwardRef<TextInput, Props>(function Input(
  { label, helper, error, icon, containerStyle, style, onFocus, onBlur, secureTextEntry, ...rest }, ref,
) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  // Password fields (secureTextEntry) get a trailing eye toggle. Local + default masked so the
  // plaintext never persists and re-masks on every mount/navigation.
  const [reveal, setReveal] = useState(false);
  const hasError = !!error;
  const borderColor = hasError ? colors.danger : focused ? colors.primary : colors.border;

  return (
    <View style={containerStyle}>
      {label ? <T variant="label" muted style={{ marginBottom: SPACING.xs }}>{label}</T> : null}
      <View
        style={[
          styles.field,
          { backgroundColor: colors.surfaceMuted, borderColor },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary + '55', outlineStyle: 'solid' } as any,
        ]}
      >
        {icon ? <Icon name={icon} size={18} color={hasError ? colors.danger : colors.textMuted} /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={colors.textMuted}
          onFocus={(e) => { setFocused(true); onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); onBlur?.(e); }}
          secureTextEntry={secureTextEntry && !reveal}
          style={[styles.input, { color: colors.textMain }, style]}
          {...rest}
        />
        {secureTextEntry ? (
          <Pressable
            onPress={() => setReveal(toggleVisible)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={secureA11yLabel(reveal, 'password')}
            style={styles.eyeBtn}
          >
            <Icon name={eyeIcon(reveal)} size={18} color={colors.textMain} />
          </Pressable>
        ) : null}
      </View>
      {hasError ? (
        <View style={styles.helperRow}>
          <Icon name="alert" size={13} color={colors.danger} />
          <T variant="caption" color={colors.danger}>{error}</T>
        </View>
      ) : helper ? (
        <T variant="caption" muted style={{ marginTop: SPACING.xs }}>{helper}</T>
      ) : null}
    </View>
  );
});

export default Input;

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: CONTROL.radius,
    borderWidth: 1,
  },
  input: {
    flex: 1,
    paddingVertical: CONTROL.paddingY,
    fontSize: CONTROL.fontSize,
    fontFamily: FONTS.body,
  },
  helperRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.xs },
  eyeBtn: { padding: 4, alignItems: 'center', justifyContent: 'center' },
});
