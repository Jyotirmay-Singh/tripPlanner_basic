import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS, FONTS, SHADOW } from './theme';
import T from './T';
import { perCapitaHumans } from './familyParticipation';

export type SplitMode = 'PER_CAPITA' | 'PER_FAMILY' | 'EXACT';

const OPTIONS: { mode: SplitMode; label: string; icon: keyof typeof Ionicons.glyphMap; testID: string }[] = [
  { mode: 'PER_CAPITA', label: 'Per Person', icon: 'person-outline', testID: 'split-mode-per_capita' },
  { mode: 'PER_FAMILY', label: 'Per Family', icon: 'people-outline', testID: 'split-mode-per_family' },
  { mode: 'EXACT', label: 'Exact', icon: 'create-outline', testID: 'split-mode-exact' },
];

type Props = {
  value: SplitMode;
  onChange: (mode: SplitMode) => void;
  subLabel?: string;
};

/**
 * Segmented control for an expense's split mode (CLAUDE.md §5). Three connected
 * segments share one muted "track"; the selected segment is raised with the brand
 * fill + a soft shadow — a cleaner, more finished look than three detached pills.
 */
export default function SplitModeSelector({ value, onChange, subLabel }: Props) {
  const { colors } = useTheme();
  return (
    <View>
      <T variant="label" muted>Split mode</T>
      <View style={[styles.track, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
        {OPTIONS.map((o) => {
          const active = value === o.mode;
          return (
            <TouchableOpacity
              key={o.mode}
              testID={o.testID}
              onPress={() => onChange(o.mode)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.segment, active ? [{ backgroundColor: colors.primary }, SHADOW.card] : null]}
            >
              <Ionicons name={o.icon} size={15} color={active ? colors.primaryText : colors.textMuted} />
              <T
                variant="caption"
                style={{ fontFamily: FONTS.bodySemibold }}
                color={active ? colors.primaryText : colors.textMain}
              >
                {o.label}
              </T>
            </TouchableOpacity>
          );
        })}
      </View>
      {subLabel ? (
        <T testID="split-mode-preview" variant="caption" muted style={{ marginTop: SPACING.sm }}>{subLabel}</T>
      ) : null}
    </View>
  );
}

type PreviewMember = { id: string; kind: string; family_members: string[] };

/**
 * Pure preview of how an expense splits under the active mode. This is a
 * display-only estimate — the authoritative split is computed server-side in
 * services/calculator.py. Mirrors resolve_weights/split_per_capita/split_per_family.
 */
export function splitPreviewLabel(opts: {
  amount: number;
  mode: SplitMode;
  members: PreviewMember[];
  splitSel: string[];
  weightOverrides: Record<string, number>;
  currency: string;
  familyExcluded?: Record<string, string[]>;
  /** EXACT: entity rollup {entityId -> amount} and entity display names, for the "Sharma 90 · Alex 10"
   *  preview. Both come from the ExactSplitEditor's live rows. */
  exactShares?: Record<string, number>;
  names?: Record<string, string>;
}): string {
  const { amount, mode, members, splitSel, weightOverrides, currency, familyExcluded } = opts;
  const HINT = "Enter an amount and pick who's splitting";

  if (mode === 'EXACT') {
    // §5C: each entity's exact rollup (family = Σ its members, individual = own).
    const entries = Object.entries(opts.exactShares ?? {});
    if (!entries.length) return 'Assign each person an exact amount';
    return entries.map(([eid, amt]) => `${opts.names?.[eid] ?? eid} ${currency} ${amt.toFixed(2)}`).join(' · ');
  }

  // amount may be negative (money back); only 0 / blank falls back to the hint.
  if (!Number.isFinite(amount) || amount === 0 || splitSel.length === 0) return HINT;

  if (mode === 'PER_FAMILY') {
    // §5B: divide equally across entities; family size is ignored.
    const E = splitSel.length;
    const per = amount / E;
    return `${currency} ${per.toFixed(2)} per group`;
  }

  // §5A: divide across total INVOLVED humans (individual = 1, family = override ?? involved count ??
  // size). Mirrors backend resolve_weights; familyExcluded lets a partial family count correctly.
  const H = perCapitaHumans(members, splitSel, weightOverrides, familyExcluded ?? {});
  if (H <= 0) return HINT;
  const per = amount / H;
  return `${currency} ${per.toFixed(2)} per person`;
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    gap: 4,
    marginTop: SPACING.xs,
    padding: 4,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: RADIUS.pill,
  },
});
