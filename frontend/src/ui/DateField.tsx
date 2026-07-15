import React, { useState } from 'react';
import { View } from 'react-native';
import { SPACING } from '../theme';
import T from '../T';
import Input from './Input';
import IconButton from './IconButton';
import Sheet from './Sheet';
import CalendarPicker from './CalendarPicker';
import { toISO, fromISO } from '../date';
import { relativeDateLabel } from '../calendar';

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
 * Labelled calendar-date field: type dd/mm/yyyy manually OR tap the calendar to pick from a themed
 * month grid (Sheet). Both paths write the same dd/mm/yyyy string back, so the text field and picker
 * stay in sync. A relative caption ("Today"/"Yesterday"/"Tomorrow") appears under the field when it
 * applies, otherwise the raw date in the box is the fallback. Timezone-safe throughout (ISO carried
 * as y/m/d via src/date.ts + src/calendar.ts — a picked day never shifts via UTC). Cross-platform:
 * the grid renders identically on native and web (no OS/native picker).
 */
export default function DateField({
  label, value, onChangeText, error, minISO, testID, containerStyle,
}: Props) {
  const [show, setShow] = useState(false);
  const iso = toISO(value);
  const rel = relativeDateLabel(iso);

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
          onPress={() => setShow(true)}
          accessibilityLabel={`Pick ${label || 'date'}`}
          testID={testID ? `${testID}-pick` : undefined}
        />
      </View>

      {rel ? <T variant="caption" muted style={{ marginTop: SPACING.xs }}>{rel}</T> : null}

      <Sheet
        visible={show}
        onClose={() => setShow(false)}
        title={label || 'Pick date'}
        testID={testID ? `${testID}-sheet` : undefined}
      >
        <CalendarPicker
          valueISO={iso}
          minISO={minISO ?? null}
          onSelect={(nextISO) => { onChangeText(fromISO(nextISO)); setShow(false); }}
        />
      </Sheet>
    </View>
  );
}
