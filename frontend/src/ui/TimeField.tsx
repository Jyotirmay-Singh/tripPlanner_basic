import React, { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, CONTROL, FONTS } from '../theme';
import T from '../T';
import Icon from './Icon';
import IconButton from './IconButton';
import Sheet from './Sheet';
import TimePicker from './TimePicker';
import { formatTime24h, normalizeHHMM } from '../time';

type Props = {
  label?: string;
  value: string;                 // 'HH:MM' (24h) or '' for none — the parent owns the raw string
  onChange: (next: string) => void;
  testID?: string;
  containerStyle?: any;
  editable?: boolean;            // when false, render read-only (no picker / clear)
};

/**
 * Optional wall-clock time field. Tap to pick from a themed 24-hour scroll picker (Sheet); clear (✕)
 * to set it back to none. The value is an 'HH:MM' (24h) string or '' (none); the display is also
 * 24-hour by default. Timezone-safe (values built from integers, no Date drift). Cross-platform:
 * the picker renders identically on native and web (no OS/native picker).
 */
export default function TimeField({
  label, value, onChange, testID, containerStyle, editable = true,
}: Props) {
  const { colors } = useTheme();
  const [show, setShow] = useState(false);

  const has = !!normalizeHHMM(value);

  const openPicker = () => { if (editable) setShow(true); };

  return (
    <View style={containerStyle}>
      {label ? <T variant="label" muted style={{ marginBottom: SPACING.xs }}>{label}</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
        <Pressable
          testID={testID}
          onPress={openPicker}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={has ? `${label || 'Time'}: ${formatTime24h(value)}` : `Add ${label || 'time'}`}
          style={[styles.field, { flex: 1, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
        >
          <Icon name="clock" size={18} color={colors.textMuted} />
          <T style={{ flex: 1 }} color={has ? colors.textMain : colors.textMuted}>
            {has ? formatTime24h(value) : 'Add time (optional)'}
          </T>
        </Pressable>
        {has && editable ? (
          <IconButton
            name="close"
            variant="surface"
            size={16}
            onPress={() => onChange('')}
            accessibilityLabel={`Clear ${label || 'time'}`}
            testID={testID ? `${testID}-clear` : undefined}
          />
        ) : null}
      </View>

      <Sheet
        visible={show}
        onClose={() => setShow(false)}
        title={label || 'Pick time'}
        testID={testID ? `${testID}-sheet` : undefined}
      >
        <TimePicker value={value} onApply={(hhmm) => { onChange(hhmm); setShow(false); }} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: CONTROL.paddingY,
    borderRadius: CONTROL.radius,
    borderWidth: 1,
    fontFamily: FONTS.body,
  },
});
