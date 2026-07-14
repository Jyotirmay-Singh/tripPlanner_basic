import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';
import { Input, Icon } from './ui';
import { FamilyRow } from './familyParticipation';
import { isGmail, GMAIL_ONLY_MESSAGE, isEmailTaken, DUPLICATE_EMAIL_MESSAGE } from './validation';

/**
 * Structured family-roster editor: one card per member carrying a name, its stable member id
 * (existing rows keep their id so past-expense participation never misassigns; new rows have a null
 * id and the server mints one), and an OPTIONAL per-member contact email (Gmail-only, unique across
 * the trip — the backend stays authoritative; these are just inline hints).
 *
 * `takenEmails` is the set of emails already used by OTHER members on this trip (entity + other
 * families' per-member emails), so the duplicate hint mirrors the server's one-email rule.
 */
export default function FamilyMembersEditor({
  rows,
  onChange,
  takenEmails = [],
  testIDPrefix = 'fam',
}: {
  rows: FamilyRow[];
  onChange: (rows: FamilyRow[]) => void;
  takenEmails?: (string | null | undefined)[];
  testIDPrefix?: string;
}) {
  const { colors } = useTheme();
  const setName = (i: number, name: string) => onChange(rows.map((r, j) => (j === i ? { ...r, name } : r)));
  const setEmail = (i: number, email: string) => onChange(rows.map((r, j) => (j === i ? { ...r, email } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, { id: null, name: '', email: '' }]);

  const rowEmailError = (i: number): string | null => {
    const e = (rows[i].email || '').trim();
    if (!e) return null;
    if (!isGmail(e)) return GMAIL_ONLY_MESSAGE;
    // Both external emails and the OTHER rows in this roster occupy the one-email space.
    const others = [...takenEmails, ...rows.filter((_, j) => j !== i).map((r) => r.email)];
    return isEmailTaken(e, others) ? DUPLICATE_EMAIL_MESSAGE : null;
  };

  return (
    <View style={{ gap: SPACING.sm }}>
      <T variant="label" muted>Family members *</T>
      {rows.map((r, i) => (
        <View
          key={i}
          style={{
            gap: SPACING.sm,
            padding: SPACING.sm,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: RADIUS.md,
            backgroundColor: colors.surface,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
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
          <Input
            testID={`${testIDPrefix}-email-${i}`}
            value={r.email || ''}
            onChangeText={(t) => setEmail(i, t)}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="(optional) email@gmail.com"
            icon="mail"
            error={rowEmailError(i)}
          />
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
        Expenses applied to this family split per member; you can exclude specific members on each
        expense. Each member can have their own optional email.
      </T>
    </View>
  );
}
