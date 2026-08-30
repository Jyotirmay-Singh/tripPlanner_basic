import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useTheme } from '../ThemeContext';
import { COMPONENT_SIZE, CONTROL, FONTS, RADIUS, SPACING } from '../theme';
import T from '../T';
import { currencyDefinition, filterCurrencies } from '../currencies';
import Icon from './Icon';
import Input from './Input';
import Sheet from './Sheet';

type Props = {
  value: string;
  onChange?: (code: string) => void;
  label?: string;
  helper?: string;
  disabled?: boolean;
  testID?: string;
};

export default function CurrencyPicker({
  value,
  onChange,
  label = 'Currency',
  helper,
  disabled = false,
  testID = 'currency-picker',
}: Props) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const selected = currencyDefinition(value);
  const currencies = useMemo(() => filterCurrencies(query), [query]);

  const close = () => {
    setVisible(false);
    setQuery('');
  };

  const choose = (code: string) => {
    onChange?.(code);
    close();
  };

  return (
    <View>
      {label ? <T variant="label" muted style={styles.label}>{label}</T> : null}
      <Pressable
        testID={`${testID}-trigger`}
        disabled={disabled}
        onPress={() => setVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${selected.code}, ${selected.name}`}
        accessibilityHint={disabled ? 'The official currency is locked' : 'Opens the currency list'}
        accessibilityState={{ disabled }}
        style={({ focused }: any) => [
          styles.trigger,
          { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
          focused && Platform.OS === 'web' && {
            outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid',
          } as any,
          disabled && styles.disabled,
        ]}
      >
        <View style={[styles.symbolBadge, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <T style={[styles.symbol, { color: colors.textMain }]}>{selected.symbol}</T>
        </View>
        <View style={styles.selectedCopy}>
          <T style={styles.code}>{selected.code}</T>
          <T variant="caption" muted numberOfLines={1}>{selected.name}</T>
        </View>
        <Icon name={disabled ? 'lock' : 'chevron-down'} size={18} color={colors.textMuted} />
      </Pressable>
      {helper ? <T variant="caption" muted style={styles.helper}>{helper}</T> : null}

      <Sheet visible={visible} onClose={close} title="Choose currency" testID={`${testID}-sheet`}>
        <Input
          testID={`${testID}-search`}
          value={query}
          onChangeText={setQuery}
          placeholder="Search code, currency, or symbol"
          icon="search"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search currencies"
        />
        <ScrollView
          style={[styles.list, { maxHeight: Math.max(220, height * 0.55) }]}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {currencies.length ? currencies.map((currency) => {
            const active = currency.code === selected.code;
            return (
              <Pressable
                key={currency.code}
                testID={`${testID}-row-${currency.code}`}
                onPress={() => choose(currency.code)}
                accessibilityRole="radio"
                accessibilityLabel={`${currency.code}, ${currency.symbol}, ${currency.name}`}
                accessibilityState={{ selected: active }}
                style={({ pressed, focused }: any) => [
                  styles.row,
                  {
                    backgroundColor: active ? colors.surfaceMuted : colors.surface,
                    borderColor: active ? colors.primary : colors.border,
                    opacity: pressed ? 0.82 : 1,
                  },
                  focused && Platform.OS === 'web' && {
                    outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid',
                  } as any,
                ]}
              >
                <View style={[styles.rowSymbol, { backgroundColor: colors.surfaceMuted }]}>
                  <T style={styles.symbol}>{currency.symbol}</T>
                </View>
                <View style={styles.rowCopy}>
                  <View style={styles.rowTitle}>
                    <T style={styles.code}>{currency.code}</T>
                    <T muted>({currency.symbol})</T>
                  </View>
                  <T variant="caption" muted>{currency.name}</T>
                </View>
                {active ? <Icon name="check-circle" size={20} color={colors.primary} /> : null}
              </Pressable>
            );
          }) : (
            <View style={styles.empty}>
              <T variant="label">No currencies found</T>
              <T variant="caption" muted>Try an ISO code such as USD or a name such as rupee.</T>
            </View>
          )}
        </ScrollView>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: SPACING.xs },
  trigger: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderRadius: CONTROL.radius,
  },
  disabled: { opacity: 0.78 },
  symbolBadge: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  symbol: { fontFamily: FONTS.number, fontSize: 16 },
  code: { fontFamily: FONTS.bodyBold, letterSpacing: 0.8 },
  selectedCopy: { flex: 1, gap: 2 },
  helper: { marginTop: SPACING.xs },
  list: { marginTop: SPACING.md },
  listContent: { gap: SPACING.xs, paddingBottom: SPACING.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.sm,
    borderWidth: 1,
    borderRadius: RADIUS.md,
  },
  rowSymbol: {
    width: 44,
    height: 40,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  empty: { paddingVertical: SPACING.xl, alignItems: 'center', gap: SPACING.xs },
});
