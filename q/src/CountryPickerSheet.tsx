import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';

import T from './T';
import { useTheme } from './ThemeContext';
import { searchMobileCountries, type MobileCountry } from './mobileNumber';
import { COMPONENT_SIZE, RADIUS, SPACING } from './theme';
import { Icon, Input, Sheet } from './ui';
import type { CountryCode } from 'libphonenumber-js';

type Props = {
  visible: boolean;
  selected: CountryCode;
  onSelect: (country: CountryCode) => void;
  onClose: () => void;
};

export default function CountryPickerSheet({ visible, selected, onSelect, onClose }: Props) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchMobileCountries(deferredQuery), [deferredQuery]);

  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  const choose = (country: MobileCountry) => {
    onSelect(country.code);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Choose country" testID="mobile-country-sheet">
      <Input
        testID="mobile-country-search"
        value={query}
        onChangeText={setQuery}
        placeholder="Search name, code, or dial code"
        accessibilityLabel="Search countries"
        icon="search"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
      />
      <FlatList
        testID="mobile-country-list"
        data={results}
        keyExtractor={(item) => item.code}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        contentContainerStyle={styles.listContent}
        initialNumToRender={18}
        windowSize={7}
        renderItem={({ item }) => {
          const active = item.code === selected;
          return (
            <Pressable
              testID={`mobile-country-${item.code}`}
              onPress={() => choose(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.dialCode}`}
              accessibilityState={{ selected: active }}
              style={({ pressed, focused }: any) => [
                styles.row,
                { borderBottomColor: colors.border },
                pressed && { backgroundColor: colors.surfaceMuted },
                focused && Platform.OS === 'web' && {
                  outlineWidth: 2,
                  outlineColor: colors.primary,
                  outlineStyle: 'solid',
                  outlineOffset: -2,
                } as any,
              ]}
            >
              <T style={styles.flag}>{item.flag}</T>
              <View style={styles.name}>
                <T numberOfLines={1}>{item.name}</T>
                <T variant="caption" muted>{item.code}</T>
              </View>
              <T color={colors.primary}>{item.dialCode}</T>
              {active ? <Icon name="check" size={18} color={colors.success} /> : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={(
          <T testID="mobile-country-empty" muted style={styles.empty}>
            No countries match “{query.trim()}”.
          </T>
        )}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 420, marginTop: SPACING.sm },
  listContent: { paddingBottom: SPACING.sm },
  row: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.sm,
  },
  flag: { width: 30, fontSize: 20, lineHeight: 26 },
  name: { flex: 1, minWidth: 0 },
  empty: { paddingVertical: SPACING.xl, textAlign: 'center' },
});
