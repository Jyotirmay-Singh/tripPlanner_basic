import React, { useState } from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, CONTROL, FONTS } from '../theme';
import T from '../T';
import Icon from './Icon';
import IconButton from './IconButton';
import Button from './Button';
import Sheet from './Sheet';
import { formatTime12h, normalizeHHMM, hhmmFromLocalDate, localDateFromHHMM } from '../time';

// The native picker package has no web build, so require it lazily off-web (a top-level import
// would crash the web bundle). Web uses the browser <input type="time"> instead. Same guard as
// DateField.
const DateTimePicker: any =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Platform.OS !== 'web' ? require('@react-native-community/datetimepicker').default : null;

type Props = {
  label?: string;
  value: string;                 // 'HH:MM' (24h) or '' for none — the parent owns the raw string
  onChange: (next: string) => void;
  testID?: string;
  containerStyle?: any;
  editable?: boolean;            // when false, render read-only (no picker / clear)
};

/**
 * Optional wall-clock time field. Tap to pick a time; clear (✕) to set it back to none. The value
 * is an 'HH:MM' (24h) string or '' (none); only the display is 12-hour. Timezone-safe (local Date
 * in/out via src/time.ts): native → DateTimePicker (Android dialog / iOS inside a Sheet); web →
 * the browser <input type="time">.
 */
export default function TimeField({
  label, value, onChange, testID, containerStyle, editable = true,
}: Props) {
  const { colors } = useTheme();
  const [show, setShow] = useState(false);
  const [tempDate, setTempDate] = useState<Date | null>(null);
  const webRef = React.useRef<any>(null);

  const has = !!normalizeHHMM(value);
  const seed = localDateFromHHMM(value);

  const apply = (selected?: Date | null) => {
    if (selected) onChange(hhmmFromLocalDate(selected));
  };

  const openPicker = () => {
    if (!editable) return;
    if (Platform.OS === 'web') {
      const el = webRef.current;
      if (el?.showPicker) el.showPicker();
      else el?.focus?.();
      return;
    }
    setTempDate(seed);
    setShow(true);
  };

  return (
    <View style={containerStyle}>
      {label ? <T variant="label" muted style={{ marginBottom: SPACING.xs }}>{label}</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
        <Pressable
          testID={testID}
          onPress={openPicker}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={has ? `${label || 'Time'}: ${formatTime12h(value)}` : `Add ${label || 'time'}`}
          style={[styles.field, { flex: 1, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
        >
          <Icon name="clock" size={18} color={colors.textMuted} />
          <T style={{ flex: 1 }} color={has ? colors.textMain : colors.textMuted}>
            {has ? formatTime12h(value) : 'Add time (optional)'}
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

      {Platform.OS === 'web' && (
        // @ts-ignore — raw DOM input, only rendered on web; value is timezone-free HH:MM (24h).
        <input
          ref={webRef}
          type="time"
          value={normalizeHHMM(value)}
          onChange={(e: any) => onChange(normalizeHHMM(e.target.value))}
          aria-hidden
          tabIndex={-1}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, border: 0, padding: 0 }}
        />
      )}

      {DateTimePicker && Platform.OS === 'android' && show && (
        <DateTimePicker
          value={seed}
          mode="time"
          onChange={(event: any, selected?: Date) => {
            setShow(false);
            if (event?.type === 'set') apply(selected);
          }}
        />
      )}

      {DateTimePicker && Platform.OS === 'ios' && (
        <Sheet visible={show} onClose={() => setShow(false)} title={label || 'Pick time'}>
          <DateTimePicker
            value={tempDate || seed}
            mode="time"
            display="spinner"
            onChange={(_e: any, selected?: Date) => { if (selected) setTempDate(selected); }}
          />
          <Button
            label="Done"
            icon="check"
            fullWidth
            size="lg"
            onPress={() => { apply(tempDate); setShow(false); }}
            style={{ marginTop: SPACING.md }}
          />
        </Sheet>
      )}
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
