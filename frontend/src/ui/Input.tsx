import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  View,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, CONTROL, FONTS } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';
import { eyeIcon, toggleVisible, secureA11yLabel } from '../secureField';
import { focusNextInput } from '../KeyboardController';

type Props = TextInputProps & {
  label?: string;
  helper?: string;
  error?: string | null;
  errorTestID?: string;
  icon?: IconName;
  containerStyle?: any;
  fieldStyle?: StyleProp<ViewStyle>;
  /** Focus and announce this field when a submit-time validation error becomes visible. */
  focusOnError?: boolean;
};

export function focusAndAnnounceInputError(
  input: Pick<TextInput, 'focus'> | null,
  label: string | undefined,
  error: string,
) {
  input?.focus();
  AccessibilityInfo.announceForAccessibility(label ? `${label}: ${error}` : error);
}

/**
 * Labelled text field: label above, helper/error below, focus ring, optional left icon.
 * Wraps the repeated label+input+error pattern that lived inline in ~12 screens. Forwards all
 * TextInputProps (incl. testID, value, onChangeText) so callers keep their field wiring.
 */
const Input = forwardRef<TextInput, Props>(function Input(
  {
    label,
    helper,
    error,
    errorTestID,
    icon,
    containerStyle,
    fieldStyle,
    focusOnError = false,
    style,
    onFocus,
    onBlur,
    onSubmitEditing,
    returnKeyType,
    multiline,
    submitBehavior,
    secureTextEntry,
    accessibilityLabel,
    accessibilityState,
    cursorColor,
    selectionColor,
    editable,
    ...rest
  }, ref,
) {
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  // Password fields (secureTextEntry) get a trailing eye toggle. Local + default masked so the
  // plaintext never persists and re-masks on every mount/navigation.
  const [reveal, setReveal] = useState(false);
  const hasError = !!error;
  const borderColor = hasError ? colors.danger : focused ? colors.primary : colors.border;
  const effectiveReturnKeyType = multiline ? returnKeyType : (returnKeyType ?? 'next');
  const effectiveSubmitBehavior = submitBehavior
    ?? (multiline ? 'newline' : effectiveReturnKeyType === 'next' ? 'submit' : 'blurAndSubmit');

  const setInputRef = useCallback((node: TextInput | null) => {
    inputRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  useEffect(() => {
    if (!focusOnError || !error) return undefined;
    const frame = requestAnimationFrame(() => {
      focusAndAnnounceInputError(inputRef.current, label, error);
    });
    return () => cancelAnimationFrame(frame);
  }, [error, focusOnError, label]);

  const submit = (event: Parameters<NonNullable<TextInputProps['onSubmitEditing']>>[0]) => {
    if (onSubmitEditing) onSubmitEditing(event);
    else if (!multiline && effectiveReturnKeyType === 'next') focusNextInput();
  };

  return (
    <View style={containerStyle}>
      {label ? <T variant="label" muted style={{ marginBottom: SPACING.xs }}>{label}</T> : null}
      <View
        style={[
          styles.field,
          { backgroundColor: colors.surfaceMuted, borderColor },
          fieldStyle,
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary + '55', outlineStyle: 'solid' } as any,
        ]}
      >
        {icon ? <Icon name={icon} size={18} color={hasError ? colors.danger : colors.textMuted} /> : null}
        <TextInput
          ref={setInputRef}
          placeholderTextColor={colors.textMuted}
          onFocus={(e) => { setFocused(true); onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); onBlur?.(e); }}
          secureTextEntry={secureTextEntry && !reveal}
          editable={editable}
          multiline={multiline}
          returnKeyType={effectiveReturnKeyType}
          submitBehavior={effectiveSubmitBehavior}
          onSubmitEditing={multiline ? onSubmitEditing : submit}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={{
            ...accessibilityState,
            ...(editable === false ? { disabled: true } : null),
            ...(hasError ? { invalid: true } : null),
          }}
          cursorColor={cursorColor ?? colors.primary}
          selectionColor={selectionColor ?? colors.primary + '55'}
          selectionHandleColor={colors.primary}
          style={[styles.input, { color: colors.textMain }, style]}
          {...rest}
        />
        {secureTextEntry ? (
          <Pressable
            onPress={() => setReveal(toggleVisible)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={secureA11yLabel(reveal)}
            style={styles.eyeBtn}
          >
            <Icon name={eyeIcon(reveal)} size={18} color={colors.textMain} />
          </Pressable>
        ) : null}
      </View>
      {hasError ? (
        <View style={styles.helperRow}>
          <Icon name="alert" size={13} color={colors.danger} />
          <T
            variant="caption"
            color={colors.danger}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            testID={errorTestID}
          >
            {error}
          </T>
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
