import React, { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  View,
  StyleSheet,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
  type TextStyle,
  type StyleProp,
} from 'react-native';
import T from '../T';
import { formatCompactMoney, formatMoney } from '../format';

type Candidate = { text: string; detachedCurrency: boolean };

type Props = {
  value: number;
  currency?: string;
  signed?: boolean;
  /** Include the currency code in the visual amount. It is always present in accessibility text. */
  showCurrency?: boolean;
  label?: string;
  variant?: 'money' | 'moneyLg' | 'caption';
  color?: string;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
};

export function responsiveMoneyCandidates(
  value: number,
  opts: { currency?: string; signed?: boolean; showCurrency?: boolean },
): Candidate[] {
  const visualCurrency = opts.showCurrency === false ? undefined : opts.currency;
  const exact = formatMoney(value, { currency: visualCurrency, signed: opts.signed });
  const candidates: Candidate[] = [{ text: exact, detachedCurrency: false }];

  for (const maximumFractionDigits of [2, 1, 0] as const) {
    candidates.push({
      text: formatCompactMoney(value, {
        currency: visualCurrency,
        signed: opts.signed,
        maximumFractionDigits,
      }),
      detachedCurrency: false,
    });
  }

  // At extreme font scales a three-letter ISO code can be wider than the compact number. Keep
  // the code visibly attached as a small context line rather than clipping or dropping it.
  if (visualCurrency) {
    for (const maximumFractionDigits of [2, 1, 0] as const) {
      candidates.push({
        text: formatCompactMoney(value, { signed: opts.signed, maximumFractionDigits }),
        detachedCurrency: true,
      });
    }
  }

  return candidates.filter((candidate, index, all) => (
    all.findIndex((other) => (
      other.text === candidate.text && other.detachedCurrency === candidate.detachedCurrency
    )) === index
  ));
}

export function firstFittingCandidate(fits: boolean[], candidateCount: number): number {
  const index = fits.findIndex(Boolean);
  return index >= 0 ? index : Math.max(0, candidateCount - 1);
}

/** React Native Web does not emit `onTextLayout`, so use the rendered DOM box instead. */
export function webTextFits(target: unknown, layoutWidth: number): boolean | null {
  const element = target as { scrollWidth?: number; clientWidth?: number } | null;
  const scrollWidth = element?.scrollWidth;
  const clientWidth = element?.clientWidth;
  if (typeof scrollWidth !== 'number' || !Number.isFinite(scrollWidth)) return null;

  const availableWidth = typeof clientWidth === 'number' && clientWidth > 0
    ? clientWidth
    : layoutWidth;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return null;
  return scrollWidth <= availableWidth + 1;
}

/**
 * Shows an exact amount whenever it fits on one line, then moves through compact candidates.
 * Measurement copies use the same typography and are hidden from layout/accessibility.
 */
export default function ResponsiveAmountText({
  value,
  currency,
  signed,
  showCurrency = true,
  label,
  variant = 'money',
  color,
  muted,
  style,
  testID,
}: Props) {
  const { width: windowWidth, height: windowHeight, fontScale } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  const exact = formatMoney(value, { currency, signed });
  const candidates = useMemo(
    () => responsiveMoneyCandidates(value, { currency, signed, showCurrency }),
    [currency, showCurrency, signed, value],
  );
  const [fits, setFits] = useState<boolean[]>([]);
  const [webSelection, setWebSelection] = useState({ index: 0, resolved: false });

  useEffect(() => {
    setFits([]);
    setWebSelection({ index: 0, resolved: false });
  }, [candidates, fontScale, windowHeight, windowWidth]);

  const nativeMeasured = fits.filter((fit) => fit !== undefined).length === candidates.length;
  const measured = isWeb ? webSelection.resolved : nativeMeasured;
  const selectedIndex = isWeb
    ? Math.min(webSelection.index, candidates.length - 1)
    : nativeMeasured ? firstFittingCandidate(fits, candidates.length) : 0;
  const selected = candidates[selectedIndex];
  const accessibilityLabel = label ? `${label}, ${exact}` : exact;
  const recordFit = (index: number) => (
    event: NativeSyntheticEvent<TextLayoutEventData>,
  ) => {
    const fit = event.nativeEvent.lines.length <= 1;
    setFits((current) => {
      if (current[index] === fit) return current;
      const next = [...current];
      next[index] = fit;
      return next;
    });
  };
  const recordWebFit = (event: LayoutChangeEvent) => {
    const nativeEvent = event.nativeEvent as typeof event.nativeEvent & { target?: unknown };
    const fit = webTextFits(
      nativeEvent.target,
      nativeEvent.layout.width,
    );
    setWebSelection((current) => {
      // Ignore a delayed ResizeObserver callback from a candidate that has already been replaced.
      if (current.index !== selectedIndex) return current;
      if (fit === true || current.index >= candidates.length - 1) {
        return current.resolved ? current : { ...current, resolved: true };
      }
      if (fit === null) {
        return { index: candidates.length - 1, resolved: true };
      }
      return { index: current.index + 1, resolved: false };
    });
  };

  return (
    <View style={styles.root} testID={testID} accessible accessibilityLabel={accessibilityLabel}>
      {selected.detachedCurrency && currency ? (
        <T variant="label" color={color} muted={muted} style={styles.currencyContext} importantForAccessibility="no">
          {currency}
        </T>
      ) : null}
      <T
        key={isWeb ? `web-candidate-${selectedIndex}` : 'native-candidate'}
        variant={variant}
        color={color}
        muted={muted}
        style={[style, !isWeb && !measured && styles.measuring]}
        numberOfLines={1}
        onLayout={isWeb ? recordWebFit : undefined}
        importantForAccessibility="no"
      >
        {selected.text}
      </T>
      {!isWeb ? (
        <View
          pointerEvents="none"
          style={styles.measurements}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {candidates.map((candidate, index) => (
            <T
              key={`${candidate.detachedCurrency ? 'detached' : 'inline'}-${candidate.text}`}
              variant={variant}
              style={style}
              onTextLayout={recordFit(index)}
            >
              {candidate.text}
            </T>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    maxWidth: '100%',
    minWidth: 0,
    position: 'relative',
    alignSelf: 'flex-start',
    flexShrink: 1,
  },
  measuring: { opacity: 0 },
  measurements: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
  },
  currencyContext: { marginBottom: 2 },
});
