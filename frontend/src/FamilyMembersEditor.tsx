import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useTheme } from './ThemeContext';
import { SPACING } from './theme';
import T from './T';
import { Input, Icon } from './ui';
import { FamilyRow } from './familyParticipation';

/**
 * Structured family-roster editor: one name input per member, each carrying its stable member id
 * (existing rows keep their id so past-expense participation never misassigns; new rows have a null
 * id and the server mints one). Replaces the old comma-separated text box.
 */
export default function FamilyMembersEditor({
  rows,
  onChange,
  testIDPrefix = 'fam',
}: {
  rows: FamilyRow[];
  onChange: (rows: FamilyRow[]) => void;
  testIDPrefix?: string;
}) {
  const { colors } = useTheme();
  const setName = (i: number, name: string) => onChange(rows.map((r, j) => (j === i ? { ...r, name } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, { id: null, name: '' }]);

  return (
    <View style={{ gap: SPACING.sm }}>
      <T variant="label" muted>Family members *</T>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
          <View style={{ flex: 1 }}>
            <Input
              testID={`${testIDPrefix}-name-${i}`}
              value={r.name}
              onChangeText={(t) => setName(i, t)}
              placeholder={`Member ${i + 1}`}
            />
          </View>
          <TouchableOpacity
            testID={`${testIDPrefix}-remove-${i}`}
            onPress={() => remove(i)}
            accessibilityLabel={`Remove member ${i + 1}`}
            hitSlop={8}
          >
            <Icon name="trash" size={18} color={colors.danger} />
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity
        testID={`${testIDPrefix}-add`}
        onPress={add}
        accessibilityRole="button"
        accessibilityLabel="Add family member"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
      >
        <Icon name="plus" size={16} color={colors.primary} />
        <T color={colors.primary} style={{ fontWeight: '700' }}>Add member</T>
      </TouchableOpacity>
      <T variant="caption" muted>
        Expenses applied to this family split per member; you can exclude specific members on each expense.
      </T>
    </View>
  );
}
