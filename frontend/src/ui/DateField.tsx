import React, { useState } from 'react';
import { View, Platform } from 'react-native';
import { SPACING } from '../theme';
import T from '../T';
import Input from './Input';
import IconButton from './IconButton';
import Button from './Button';
import Sheet from './Sheet';
import {
  toISO, fromISO, formatDDMMYYYY, localDateFromISO, partsFromLocalDate,
} from '../date';

// The native picker package has no web build, so require it lazily off-web (a top-level
// import would crash the web bundle). Web uses the browser <input type="date"> instead.
const DateTimePicker: any =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Platform.OS !== 'web' ? require('@react-native-community/datetimepicker').default : null;

type Props = {
  label?: string;
  value: string;                 // dd/mm/yyyy (the parent owns the raw string)
  onChangeText: (next: string) => void;
  error?: string | null;
  minISO?: string | null;        // YYYY-MM-DD lower bound (used for the End field)
  testID?: string;
  containerStyle?: any;
};

/**
 * Labelled calendar-date field: type dd/mm/yyyy manually OR tap the calendar to pick. Both
 * paths write the same dd/mm/yyyy string back to the parent, so the text field and picker
 * stay in sync. Picker is timezone-safe (local Date in/out via src/date.ts): native →
 * DateTimePicker (Android dialog / iOS inside a Sheet); web → the browser <input type="date">.
 */
export default function DateField({
  label, value, onChangeText, error, minISO, testID, containerStyle,
}: Props) {
  const [show, setShow] = useState(false);
  const [tempDate, setTempDate] = useState<Date | null>(null);
  const webRef = React.useRef<any>(null);

  const seed = (() => {
    const iso = toISO(value);
    return iso ? localDateFromISO(iso) : new Date();
  })();
  const minDate = minISO ? localDateFromISO(minISO) : undefined;

  const apply = (selected?: Date | null) => {
    if (selected) onChangeText(formatDDMMYYYY(partsFromLocalDate(selected)));
  };

  const openPicker = () => {
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
        <Input
          containerStyle={{ flex: 1 }}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          error={error}
          placeholder="dd/mm/yyyy"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={10}
        />
        <IconButton
          name="calendar"
          variant="surface"
          onPress={openPicker}
          accessibilityLabel={`Pick ${label || 'date'}`}
          testID={testID ? `${testID}-pick` : undefined}
        />
      </View>

      {Platform.OS === 'web' && (
        // @ts-ignore — raw DOM input, only rendered on web; value/min are timezone-free ISO.
        <input
          ref={webRef}
          type="date"
          value={toISO(value) ?? ''}
          min={minISO ?? undefined}
          onChange={(e: any) => { if (e.target.value) onChangeText(fromISO(e.target.value)); }}
          aria-hidden
          tabIndex={-1}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, border: 0, padding: 0 }}
        />
      )}

      {DateTimePicker && Platform.OS === 'android' && show && (
        <DateTimePicker
          value={seed}
          mode="date"
          minimumDate={minDate}
          onChange={(event: any, selected?: Date) => {
            setShow(false);
            if (event?.type === 'set') apply(selected);
          }}
        />
      )}

      {DateTimePicker && Platform.OS === 'ios' && (
        <Sheet visible={show} onClose={() => setShow(false)} title={label || 'Pick date'}>
          <DateTimePicker
            value={tempDate || seed}
            mode="date"
            display="inline"
            minimumDate={minDate}
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
