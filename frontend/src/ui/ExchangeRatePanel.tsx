import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';

import T from '../T';
import { useTheme } from '../ThemeContext';
import { FONTS, RADIUS, SPACING } from '../theme';
import { formatMoney } from '../format';
import {
  ExchangeRateMode,
  ExchangeRateQuote,
  ExpenseConversionRequest,
  ManualExchangeInput,
} from '../api';
import { useExchangeRateQuote } from '../useExchangeRateQuote';
import Button from './Button';
import Input from './Input';

export type LockedConversion = {
  version: number;
  sourceAmount: string;
  sourceCurrency: string;
  targetAmount: number;
  targetCurrency: string;
  requestedDate: string;
  effectiveDate: string | null;
  rate: string;
  provider: string;
  mode: ExchangeRateMode;
  stale: boolean;
  manualInputType?: ManualExchangeInput | null;
  manualInputValue?: string | null;
};

export type ApprovedConversion = {
  request: ExpenseConversionRequest;
  quote: ExchangeRateQuote;
};

type Props = {
  enabled: boolean;
  amount: string;
  sourceCurrency: string;
  targetCurrency: string;
  date: string | null;
  locked?: LockedConversion | null;
  onApprovalChange: (approved: ApprovedConversion | null) => void;
  onQuoteChange?: (quote: ExchangeRateQuote | null) => void;
  onRequoteRequiredChange?: (required: boolean) => void;
  testID?: string;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function displayDate(value: string | null | undefined): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || 'not applicable';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

function moneyKey(value: string | number): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : String(value);
}

export default function ExchangeRatePanel({
  enabled,
  amount,
  sourceCurrency,
  targetCurrency,
  date,
  locked,
  onApprovalChange,
  onQuoteChange,
  onRequoteRequiredChange,
  testID = 'exchange-rate',
}: Props) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<ExchangeRateMode>('automatic');
  const [manualInputType, setManualInputType] = useState<ManualExchangeInput>('rate');
  const [manualValue, setManualValue] = useState('');
  const [explicitRequote, setExplicitRequote] = useState(false);
  const [approvedQuoteId, setApprovedQuoteId] = useState<string | null>(null);
  const hydratedVersion = useRef<number | null>(null);

  useEffect(() => {
    if (!locked || hydratedVersion.current === locked.version) return;
    hydratedVersion.current = locked.version;
    setMode(locked.mode);
    setManualInputType(locked.manualInputType || 'rate');
    setManualValue(locked.manualInputValue || '');
    setExplicitRequote(false);
    setApprovedQuoteId(null);
  }, [locked]);

  const inputsDifferFromLock = useMemo(() => {
    if (!locked) return true;
    if (moneyKey(amount) !== moneyKey(locked.sourceAmount)) return true;
    if (sourceCurrency !== locked.sourceCurrency || date !== locked.requestedDate) return true;
    if (mode !== locked.mode) return true;
    if (mode === 'manual') {
      if (manualInputType !== locked.manualInputType) return true;
      if (moneyKey(manualValue) !== moneyKey(locked.manualInputValue || '')) return true;
    }
    return false;
  }, [amount, date, locked, manualInputType, manualValue, mode, sourceCurrency]);

  const foreign = sourceCurrency !== targetCurrency;
  const quoteActive = foreign && (!locked || inputsDifferFromLock || explicitRequote);
  const quoteResult = useExchangeRateQuote({
    enabled: enabled && quoteActive,
    sourceCurrency,
    targetCurrency,
    amount,
    date,
    mode,
    manualInputType,
    manualValue,
  });

  useEffect(() => {
    setApprovedQuoteId(null);
    onApprovalChange(null);
  }, [
    amount,
    date,
    manualInputType,
    manualValue,
    mode,
    onApprovalChange,
    sourceCurrency,
    targetCurrency,
  ]);

  useEffect(() => {
    onQuoteChange?.(quoteResult.quote);
  }, [onQuoteChange, quoteResult.quote]);

  useEffect(() => {
    onRequoteRequiredChange?.(enabled && quoteActive);
  }, [enabled, onRequoteRequiredChange, quoteActive]);

  const chooseMode = (next: ExchangeRateMode) => {
    setMode(next);
    setExplicitRequote(true);
  };

  const approve = () => {
    const quote = quoteResult.quote;
    if (!quote) return;
    const request: ExpenseConversionRequest = {
      mode,
      quote_id: quote.quote_id,
      approved: true,
      allow_stale: quote.stale,
    };
    if (mode === 'manual') {
      request.manual_input_type = manualInputType;
      if (manualInputType === 'rate') request.manual_rate = manualValue;
      else request.manual_target_amount = manualValue;
    }
    setApprovedQuoteId(quote.quote_id);
    onApprovalChange({ request, quote });
  };

  if (!foreign) {
    return (
      <View testID={`${testID}-identity`} style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
        <T variant="label">No conversion needed</T>
        <T variant="caption" muted>1 {targetCurrency} = 1 {targetCurrency}. No rate service request will be made.</T>
      </View>
    );
  }

  if (!enabled) {
    return (
      <View testID={`${testID}-disabled`} style={[styles.panel, { borderColor: colors.warning, backgroundColor: colors.surfaceMuted }]}>
        <T variant="label" color={colors.warning}>Exchange rate required</T>
        <T variant="caption" muted>Multi-currency expenses are not enabled on this server yet.</T>
      </View>
    );
  }

  if (locked && !quoteActive) {
    return (
      <View testID={`${testID}-locked`} style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
        <T variant="label">Locked conversion</T>
        <T style={styles.primaryAmount}>
          {formatMoney(locked.targetAmount, { currency: locked.targetCurrency })}
        </T>
        <T variant="caption" muted>
          1 {locked.sourceCurrency} = {locked.rate} {locked.targetCurrency}
        </T>
        <T variant="caption" muted>
          {locked.mode === 'manual' ? 'Manual conversion' : `Reference rate from ${displayDate(locked.effectiveDate)}`}
          {' · '}{locked.provider}{locked.stale ? ' · stale cache' : ''}
        </T>
        <Button
          testID={`${testID}-requote`}
          label="Fetch a new reference rate"
          variant="secondary"
          size="sm"
          onPress={() => { setMode('automatic'); setExplicitRequote(true); }}
        />
      </View>
    );
  }

  return (
    <View testID={testID} style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
      <T variant="label">Convert to {targetCurrency}</T>
      <View style={styles.choiceRow}>
        <Choice
          label="Reference rate"
          active={mode === 'automatic'}
          onPress={() => chooseMode('automatic')}
          colors={colors}
          testID={`${testID}-automatic`}
        />
        <Choice
          label="Manual / card"
          active={mode === 'manual'}
          onPress={() => chooseMode('manual')}
          colors={colors}
          testID={`${testID}-manual`}
        />
      </View>

      {mode === 'manual' ? (
        <>
          <View style={styles.choiceRow}>
            <Choice
              label="Enter rate"
              active={manualInputType === 'rate'}
              onPress={() => { setManualInputType('rate'); setManualValue(''); }}
              colors={colors}
              testID={`${testID}-manual-rate`}
            />
            <Choice
              label="Final amount"
              active={manualInputType === 'target_amount'}
              onPress={() => { setManualInputType('target_amount'); setManualValue(''); }}
              colors={colors}
              testID={`${testID}-manual-target`}
            />
          </View>
          <Input
            testID={`${testID}-manual-value`}
            label={manualInputType === 'rate'
              ? `Rate: 1 ${sourceCurrency} in ${targetCurrency}`
              : `Final charged/refunded amount in ${targetCurrency}`}
            helper={manualInputType === 'target_amount'
              ? 'Enter a positive magnitude; refunds keep the original amount’s minus sign.'
              : 'Use the rate shown by your bank, card, or receipt.'}
            value={manualValue}
            onChangeText={setManualValue}
            keyboardType="decimal-pad"
            placeholder="0.00"
          />
        </>
      ) : null}

      {quoteResult.status === 'idle' ? (
        <T variant="caption" muted>Enter a valid amount, date, and conversion input to preview.</T>
      ) : null}
      {quoteResult.status === 'loading' ? (
        <View testID={`${testID}-loading`} style={styles.statusRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <T variant="caption" muted>Loading conversion preview…</T>
        </View>
      ) : null}
      {quoteResult.status === 'error' ? (
        <View testID={`${testID}-error`} style={{ gap: SPACING.sm }}>
          <T variant="caption" color={colors.danger}>{quoteResult.error?.message}</T>
          {quoteResult.error?.retryable !== false ? (
            <Button
              testID={`${testID}-retry`}
              label="Try again"
              size="sm"
              variant="secondary"
              onPress={quoteResult.retry}
            />
          ) : null}
        </View>
      ) : null}
      {quoteResult.quote ? (
        <View testID={`${testID}-success`} style={{ gap: 5 }}>
          <T variant="caption" muted>
            {formatMoney(Number(quoteResult.quote.source_amount), { currency: sourceCurrency })}
          </T>
          <T style={styles.primaryAmount}>
            ≈ {formatMoney(Number(quoteResult.quote.target_amount), { currency: targetCurrency })}
          </T>
          <T variant="caption" muted>
            1 {sourceCurrency} = {quoteResult.quote.rate} {targetCurrency}
          </T>
          <T variant="caption" muted>
            {mode === 'manual'
              ? 'Manual bank/card conversion'
              : `Reference rate from ${displayDate(quoteResult.quote.effective_rate_date)}`}
          </T>
          <View style={styles.badges}>
            {quoteResult.quote.cache_hit ? <Badge label="cached" colors={colors} /> : null}
            {quoteResult.quote.stale ? <Badge label="stale" colors={colors} warning /> : null}
            {quoteResult.quote.manual ? <Badge label="manual" colors={colors} /> : null}
            {!quoteResult.quote.manual
              ? <Badge label={quoteResult.quote.provider} colors={colors} /> : null}
          </View>
          <Button
            testID={`${testID}-approve`}
            label={approvedQuoteId === quoteResult.quote.quote_id ? 'Conversion approved' : 'Use this conversion'}
            icon={approvedQuoteId === quoteResult.quote.quote_id ? 'check' : undefined}
            variant={approvedQuoteId === quoteResult.quote.quote_id ? 'secondary' : 'primary'}
            onPress={approve}
          />
          <T variant="caption" muted>
            The displayed reference is a preview. Saving locks this exact rate and converted amount.
          </T>
        </View>
      ) : null}
    </View>
  );
}

function Choice({ label, active, onPress, colors, testID }: {
  label: string; active: boolean; onPress: () => void; colors: any; testID: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      style={[
        styles.choice,
        { borderColor: active ? colors.primary : colors.border, backgroundColor: colors.surface },
      ]}
    >
      <T variant="caption" color={active ? colors.primary : colors.textMain} style={{ fontFamily: FONTS.bodyBold }}>
        {label}
      </T>
    </TouchableOpacity>
  );
}

function Badge({ label, colors, warning = false }: { label: string; colors: any; warning?: boolean }) {
  return (
    <View style={[styles.badge, { backgroundColor: colors.surface, borderColor: warning ? colors.warning : colors.border }]}>
      <T variant="caption" color={warning ? colors.warning : colors.textMuted}>{label}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.md, gap: SPACING.sm },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  choice: { borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 12, paddingVertical: 8 },
  primaryAmount: { fontFamily: FONTS.numberBold, fontSize: 22 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 3 },
});
