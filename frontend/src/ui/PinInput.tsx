import React, { useRef, useState } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../ThemeContext';
import { RADIUS, FONTS, TYPESCALE } from '../theme';
import T from '../T';

type Props = {
  value: string;
  onChangeText: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  /** when true, show a dot instead of the digit (PIN entry) */
  secure?: boolean;
  onSubmit?: () => void;
  testID?: string;
  accessibilityLabel?: string;
};

/**
 * OTP-style PIN field: a row of boxes backed by one hidden TextInput. Standardizes the
 * previously-inconsistent PIN inputs (28px/ls16 vs 24px/ls12) into a single premium control.
 * The hidden input receives the existing screen `testID` so integration tests keep working.
 */
export default function PinInput({
  value, onChangeText, length = 4, autoFocus, secure = true, onSubmit, testID, accessibilityLabel = '4-digit PIN',
}: Props) {
  const { colors } = useTheme();
  const ref = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const digits = value.split('');
  const focus = () => ref.current?.focus();

  return (
    <Pressable onPress={focus} accessibilityRole="none">
      <View style={styles.row}>
        {Array.from({ length }).map((_, i) => {
          const filled = i < digits.length;
          const active = focused && i === digits.length;
          return (
            <View
              key={i}
              style={[
                styles.box,
                {
                  backgroundColor: colors.surfaceMuted,
                  borderColor: active ? colors.primary : filled ? colors.border : colors.border,
                  borderWidth: active ? 2 : 1,
                },
              ]}
            >
              {filled ? (
                secure ? (
                  <View style={[styles.dot, { backgroundColor: colors.textMain }]} />
                ) : (
                  <T style={styles.digit}>{digits[i]}</T>
                )
              ) : null}
            </View>
          );
        })}
      </View>
      <TextInput
        ref={ref}
        testID={testID}
        value={value}
        onChangeText={(v) => onChangeText(v.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmit}
        accessibilityLabel={accessibilityLabel}
        caretHidden
        style={styles.hidden}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  box: {
    width: 56, height: 64, borderRadius: RADIUS.md,
    alignItems: 'center', justifyContent: 'center',
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  digit: { fontFamily: FONTS.numberBold, fontSize: TYPESCALE.xl },
  // Visually hidden but still focusable/typeable. Absolute + near-zero opacity over the boxes.
  hidden: {
    position: 'absolute',
    top: 0, left: 0, right: 0, height: 64,
    opacity: 0,
    textAlign: 'center',
    color: 'transparent',
  },
});
