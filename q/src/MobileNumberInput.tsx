import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import type { CountryCode } from 'libphonenumber-js';

import CountryPickerSheet from './CountryPickerSheet';
import T from './T';
import { useTheme } from './ThemeContext';
import { countryOption, formatMobileDraft } from './mobileNumber';
import { COMPONENT_SIZE, CONTROL, FONTS, RADIUS, SPACING } from './theme';
import { Icon } from './ui';

type Props = {
  value: string;
  country: CountryCode;
  onChange: (value: string, country: CountryCode) => void;
  error?: string | null;
  editable?: boolean;
  focusOnError?: boolean;
};

export default function MobileNumberInput({
  value,
  country,
  onChange,
  error,
  editable = true,
  focusOnError = false,
}: Props) {
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const selected = countryOption(country);

  useEffect(() => {
    if (!focusOnError || !error) return undefined;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      AccessibilityInfo.announceForAccessibility(`Mobile number: ${error}`);
    });
    return () => cancelAnimationFrame(frame);
  }, [error, focusOnError]);

  const changeText = (next: string) => {
    const draft = formatMobileDraft(next, country);
    onChange(draft.display, draft.country);
  };

  const selectCountry = (nextCountry: CountryCode) => {
    const draft = formatMobileDraft(value, nextCountry);
    onChange(draft.display, nextCountry);
  };

  const borderColor = error ? colors.danger : focused ? colors.primary : colors.border;

  return (
    <View>
      <T variant="label" muted style={styles.label}>Mobile number</T>
      <View
        style={[
          styles.field,
          { backgroundColor: colors.surfaceMuted, borderColor },
          focused && Platform.OS === 'web' && {
            outlineWidth: 2,
            outlineColor: colors.primary + '55',
            outlineStyle: 'solid',
          } as any,
        ]}
      >
        <Pressable
          testID="mobile-country-trigger"
          onPress={() => setPickerVisible(true)}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={`Country ${selected.name}, dial code ${selected.dialCode}`}
          accessibilityHint="Opens the country picker"
          style={({ pressed }) => [styles.countryButton, pressed && styles.pressed]}
        >
          <T style={styles.flag}>{selected.flag}</T>
          <T color={colors.primary} style={styles.dialCode}>{selected.dialCode}</T>
          <Icon name="chevron-down" size={16} color={colors.textMuted} />
        </Pressable>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <TextInput
          ref={inputRef}
          testID="mobile-number-input"
          value={value}
          onChangeText={changeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="98765 43210"
          placeholderTextColor={colors.textMuted}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          returnKeyType="done"
          editable={editable}
          maxLength={32}
          accessibilityLabel="Mobile number"
          accessibilityState={{
            ...(!editable ? { disabled: true } : null),
            ...(error ? { invalid: true } : null),
          }}
          cursorColor={colors.primary}
          selectionColor={colors.primary + '55'}
          style={[styles.input, { color: colors.textMain }]}
        />
      </View>
      {error ? (
        <View style={styles.errorRow}>
          <Icon name="alert" size={13} color={colors.danger} />
          <T
            testID="mobile-number-error"
            variant="caption"
            color={colors.danger}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {error}
          </T>
        </View>
      ) : null}
      <CountryPickerSheet
        visible={pickerVisible}
        selected={country}
        onSelect={selectCountry}
        onClose={() => setPickerVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: SPACING.xs },
  field: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: CONTROL.radius,
    borderWidth: 1,
    paddingRight: SPACING.md,
  },
  countryButton: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderTopLeftRadius: RADIUS.md,
    borderBottomLeftRadius: RADIUS.md,
  },
  flag: { fontSize: 20, lineHeight: 26 },
  dialCode: { fontFamily: FONTS.bodySemibold },
  divider: { width: StyleSheet.hairlineWidth, height: 28 },
  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: CONTROL.paddingY,
    paddingLeft: SPACING.md,
    fontFamily: FONTS.body,
    fontSize: CONTROL.fontSize,
  },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.xs },
  pressed: { opacity: 0.78 },
});
