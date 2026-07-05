import React, { useEffect, useMemo, useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS, FONTS } from './theme';
import T from './T';
import Icon from './ui/Icon';
import ProgressBar from './ui/ProgressBar';
import { familyMemberIds } from './familyParticipation';
import { familyMemberDisplayNames } from './displayNames';
import { formatMoney } from './format';
import { parseAmount } from './signedAmount';
import { ExactRow, reconcile } from './exactSplit';

type Member = { id: string; name: string; kind: string; family_members: string[]; family_member_ids?: string[] };

type Props = {
  members: Member[];
  currency: string;
  total: number;
  /** Person-level rows to seed the editor once (all-included-blank for a new expense, or rehydrated
   *  from a stored `custom_amounts` on edit). The editor owns display state thereafter. */
  initialRows: ExactRow[];
  onChange: (rows: ExactRow[]) => void;
  displayNames: Record<string, string>;
  editable?: boolean;
};

/**
 * Phase 22 — inline EXACT-amount editor. Person-level: families expand to per-member rows, each with a
 * checkbox + amount; individuals get a checkbox + amount. A live reconciliation bar mirrors the backend
 * save-gate (the parent disables Save until `reconcile().isValid`). Pure math lives in exactSplit.ts.
 */
export default function ExactSplitEditor({ members, currency, total, initialRows, onChange, displayNames, editable = true }: Props) {
  const { colors } = useTheme();
  const [included, setIncluded] = useState<Record<string, boolean>>(
    () => Object.fromEntries(initialRows.map((r) => [r.memberId, r.included])),
  );
  const [texts, setTexts] = useState<Record<string, string>>(
    () => Object.fromEntries(initialRows.map((r) => [r.memberId, r.amount != null ? String(r.amount) : ''])),
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Derive the canonical person-level rows from local display state + the roster (entity mapping).
  const rows = useMemo<ExactRow[]>(() => {
    const out: ExactRow[] = [];
    const add = (memberId: string, entityId: string) => {
      const t = (texts[memberId] ?? '').trim();
      const amt = t === '' ? NaN : parseAmount(t);
      out.push({ memberId, entityId, included: included[memberId] ?? false, amount: Number.isFinite(amt) ? amt : null });
    };
    for (const m of members) {
      if (m.kind === 'family') for (const rid of familyMemberIds(m)) add(rid, m.id);
      else add(m.id, m.id);
    }
    return out;
  }, [members, texts, included]);

  useEffect(() => { onChange(rows); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const rec = reconcile(rows, total);
  const byEntity = (eid: string) => rows.filter((r) => r.entityId === eid);
  const famIncluded = (eid: string) => byEntity(eid).some((r) => r.included);
  const famSubtotal = (eid: string) =>
    byEntity(eid).reduce((s, r) => s + (r.included && r.amount != null ? r.amount : 0), 0);

  const setText = (mid: string, v: string) => {
    if (!editable) return;
    setTexts((s) => ({ ...s, [mid]: v }));
    if (v.trim() !== '') setIncluded((s) => ({ ...s, [mid]: true })); // typing an amount ticks the row
  };
  const toggleMember = (mid: string) => editable && setIncluded((s) => ({ ...s, [mid]: !(s[mid] ?? false) }));
  const toggleExpand = (eid: string) => setExpanded((s) => ({ ...s, [eid]: !s[eid] }));
  const toggleFamily = (m: Member) => {
    if (!editable) return;
    const ids = familyMemberIds(m);
    const turnOn = !famIncluded(m.id);
    setIncluded((s) => { const o = { ...s }; for (const id of ids) o[id] = turnOn; return o; });
    setExpanded((s) => ({ ...s, [m.id]: turnOn }));
  };
  const splitEqually = () => {
    if (!editable) return;
    // Fill ticked-but-blank rows with an equal share of the remainder (snapping the last), then reflect
    // the filled amounts back into the text inputs.
    const blanks = rows.filter((r) => r.included && r.amount == null);
    if (blanks.length === 0) return;
    let assignedC = 0;
    for (const r of rows) if (r.included && r.amount != null) assignedC += Math.round(r.amount * 100);
    const remainingC = Math.max(0, Math.round(total * 100) - assignedC);
    const base = Math.floor(remainingC / blanks.length);
    setTexts((s) => {
      const o = { ...s };
      blanks.forEach((r, i) => {
        const c = i === blanks.length - 1 ? remainingC - base * (blanks.length - 1) : base;
        o[r.memberId] = String(c / 100);
      });
      return o;
    });
  };

  const amountInput = (mid: string) => (
    <TextInput
      testID={`exact-amount-${mid}`}
      value={texts[mid] ?? ''}
      onChangeText={(v) => setText(mid, v)}
      editable={editable}
      keyboardType="numbers-and-punctuation"
      placeholder="0.00"
      placeholderTextColor={colors.textMuted}
      style={[styles.amount, { color: colors.textMain, borderColor: colors.border, backgroundColor: colors.surface }]}
    />
  );

  const barColor = rec.isValid ? colors.success : rec.remaining < 0 ? colors.danger : colors.primary;

  return (
    <View style={{ gap: SPACING.xs }}>
      <T variant="label" muted>Assign exact amounts</T>

      {members.map((m) => {
        if (m.kind !== 'family') {
          const on = included[m.id] ?? false;
          return (
            <View key={m.id} style={[styles.row, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.surfaceMuted : colors.surface }]}>
              <TouchableOpacity onPress={() => toggleMember(m.id)} testID={`exact-tick-${m.id}`} style={styles.tick}>
                <Icon name={on ? 'checkbox-on' : 'checkbox-off'} size={20} color={on ? colors.primary : colors.textMuted} />
                <T style={{ flex: 1 }}>{displayNames[m.id]}</T>
              </TouchableOpacity>
              {amountInput(m.id)}
            </View>
          );
        }
        // family — collapsible with a live subtotal
        const on = famIncluded(m.id);
        const open = !!expanded[m.id];
        const ids = familyMemberIds(m);
        const rosterNames = familyMemberDisplayNames(m);
        const subtotal = famSubtotal(m.id);
        return (
          <View key={m.id} style={[styles.row, { flexDirection: 'column', alignItems: 'stretch', gap: 8, borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.surfaceMuted : colors.surface }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
              <TouchableOpacity onPress={() => toggleFamily(m)} testID={`exact-fam-tick-${m.id}`}>
                <Icon name={on ? 'checkbox-on' : 'checkbox-off'} size={20} color={on ? colors.primary : colors.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => toggleExpand(m.id)} testID={`exact-fam-expand-${m.id}`} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <T style={{ flex: 1, fontWeight: '600' }}>{displayNames[m.id]}</T>
                <T variant="caption" muted>{ids.length} members · {currency} {formatMoney(subtotal)}</T>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            {on && subtotal === 0 ? (
              <T variant="caption" color={colors.warning} testID={`exact-fam-notset-${m.id}`}>Not set — assign amounts or untick</T>
            ) : null}
            {open && (
              <View style={{ paddingLeft: 28, gap: 8 }}>
                {ids.map((rid, i) => {
                  const ron = included[rid] ?? false;
                  return (
                    <View key={rid} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                      <TouchableOpacity onPress={() => toggleMember(rid)} testID={`exact-tick-${rid}`} style={styles.tick}>
                        <Icon name={ron ? 'checkbox-on' : 'checkbox-off'} size={18} color={ron ? colors.primary : colors.textMuted} />
                        <T variant="caption" color={ron ? colors.textMain : colors.textMuted} style={{ flex: 1 }}>{rosterNames[i]}</T>
                      </TouchableOpacity>
                      {amountInput(rid)}
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}

      {/* live reconciliation bar — mirror of the backend save-gate */}
      <View style={{ marginTop: SPACING.xs, gap: 6 }}>
        <ProgressBar progress={total > 0 ? rec.assigned / total : 0} color={barColor} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <T variant="caption" muted testID="exact-assigned">Assigned {currency} {formatMoney(rec.assigned)}</T>
          <T variant="caption" color={rec.isValid ? colors.success : colors.danger} testID="exact-remaining">
            {rec.isValid ? 'Balanced' : `Remaining ${currency} ${formatMoney(rec.remaining)}`}
          </T>
        </View>
        {editable ? (
          <TouchableOpacity onPress={splitEqually} testID="exact-split-equally" style={{ alignSelf: 'flex-start' }}>
            <T color={colors.primary} style={{ fontWeight: '700' }}>Split remaining equally</T>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
  tick: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flex: 1 },
  amount: {
    minWidth: 96, textAlign: 'right', fontFamily: FONTS.number, fontSize: 16,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: RADIUS.sm, borderWidth: 1,
  },
});
