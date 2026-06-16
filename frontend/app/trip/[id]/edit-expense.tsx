import React, { useEffect, useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
  KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, CATEGORIES } from '../../../src/theme';
import T from '../../../src/T';
import SplitModeSelector, { SplitMode, splitPreviewLabel } from '../../../src/SplitModeSelector';

type Member = { id: string; name: string; kind: string; family_members: string[] };
type Trip = { id: string; name: string; currency: string; members: Member[] };
type Expense = {
  id: string; kind: 'expense' | 'income'; amount: number; category: string;
  description?: string; date: string; paid_by_member_id: string;
  split_member_ids: string[]; split_mode?: SplitMode;
  weight_snapshots?: Record<string, number> | null; receipt_base64?: string | null;
};

export default function EditExpense() {
  const { id, eid } = useLocalSearchParams<{ id: string; eid: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [cat, setCat] = useState<string>('Food');
  const [date, setDate] = useState('');
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const [splitSel, setSplitSel] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('PER_CAPITA');
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>({});
  const [receipt, setReceipt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await api<Trip>(`/trips/${id}`);
      setTrip(t);
      const exps = await api<Expense[]>(`/trips/${id}/expenses`);
      const e = exps.find((x) => x.id === eid);
      if (!e) return;
      setKind(e.kind); setAmount(String(e.amount)); setDesc(e.description || '');
      setCat(e.category); setDate(e.date); setPaidBy(e.paid_by_member_id);
      const allIds = t.members.map((m) => m.id);
      setSplitSel(e.split_member_ids && e.split_member_ids.length ? e.split_member_ids : allIds);
      setSplitMode(e.split_mode || 'PER_CAPITA');
      setWeightOverrides(e.weight_snapshots || {});
      setReceipt(e.receipt_base64 || null);
    })();
  }, [id, eid]);

  const pickReceipt = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.4, base64: true,
    });
    if (!r.canceled && r.assets[0].base64) {
      setReceipt(`data:image/jpeg;base64,${r.assets[0].base64}`);
    }
  };

  const save = async () => {
    if (!trip || !paidBy) return;
    const a = parseFloat(amount);
    if (!a || a <= 0) return Alert.alert('Invalid', 'Amount must be > 0');
    setSaving(true);
    try {
      const allSelected = trip.members.length > 0 && splitSel.length === trip.members.length;
      // Per-family overrides only apply in PER_CAPITA; PER_FAMILY ignores family size entirely (§5B).
      const snapshots: Record<string, number> = {};
      if (splitMode === 'PER_CAPITA') {
        for (const sid of splitSel) {
          const m = trip.members.find((x) => x.id === sid);
          if (m && m.kind === 'family' && weightOverrides[sid]) {
            const fullSize = Math.max(1, m.family_members.length);
            if (weightOverrides[sid] !== fullSize) snapshots[sid] = weightOverrides[sid];
          }
        }
      }
      await api(`/trips/${id}/expenses/${eid}`, {
        method: 'PATCH',
        body: {
          kind, amount: a, category: cat, description: desc, date,
          paid_by_member_id: paidBy,
          split_member_ids: allSelected ? [] : splitSel,
          split_mode: splitMode,
          weight_snapshots: Object.keys(snapshots).length ? snapshots : null,
          receipt_base64: receipt,
        },
      });
      router.back();
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };

  const onDelete = () => {
    Alert.alert('Delete transaction?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await api(`/trips/${id}/expenses/${eid}`, { method: 'DELETE' }); router.back(); }
          catch (e: any) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  if (!trip) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><T style={{ padding: SPACING.lg }}>Loading…</T></SafeAreaView>;

  const toggleSplit = (mid: string) => {
    setSplitSel((s) => s.includes(mid) ? s.filter((x) => x !== mid) : [...s, mid]);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
          <T variant="h1">Edit transaction</T>

          <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
            {(['expense', 'income'] as const).map((k) => (
              <TouchableOpacity key={k} onPress={() => setKind(k)}
                testID={`ee-kind-${k}`}
                style={[styles.pill, { flex: 1, justifyContent: 'center', backgroundColor: kind === k ? colors.primary : colors.surfaceMuted, borderColor: colors.border }]}>
                <T style={{ fontWeight: '700', textTransform: 'capitalize' }}
                  color={kind === k ? colors.primaryText : colors.textMain}>{k}</T>
              </TouchableOpacity>
            ))}
          </View>

          <View style={[styles.amountBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <T variant="label" muted>{trip.currency} amount *</T>
            <TextInput testID="ee-amount" value={amount} onChangeText={setAmount}
              keyboardType="decimal-pad"
              style={[styles.amountInput, { color: colors.textMain }]} />
          </View>

          <View>
            <T variant="label" muted>Description</T>
            <TextInput testID="ee-desc" value={desc} onChangeText={setDesc}
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Category *</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity key={c} onPress={() => setCat(c)}
                    style={[styles.pill, { backgroundColor: cat === c ? colors.primary : colors.surfaceMuted, borderColor: colors.border }]}>
                    <T style={{ fontWeight: '700' }}
                      color={cat === c ? colors.primaryText : colors.textMain}>{c}</T>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          <View>
            <T variant="label" muted>Date (DD-MM-YY) *</T>
            <TextInput testID="ee-date" value={date} onChangeText={setDate}
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Paid by *</T>
            <View style={{ gap: SPACING.xs, marginTop: 4 }}>
              {trip.members.map((m) => (
                <TouchableOpacity key={m.id} onPress={() => setPaidBy(m.id)}
                  style={[styles.row, { backgroundColor: paidBy === m.id ? colors.surfaceMuted : colors.surface, borderColor: paidBy === m.id ? colors.primary : colors.border }]}>
                  <Ionicons name={paidBy === m.id ? 'radio-button-on' : 'radio-button-off'} size={20} color={colors.primary} />
                  <T style={{ flex: 1 }}>{m.name}</T>
                  <T variant="caption" muted>{m.kind}</T>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T variant="label" muted>Split among ({splitSel.length}/{trip.members.length})</T>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity onPress={() => setSplitSel(trip.members.map((m) => m.id))}>
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Select all</T>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setSplitSel([])}>
                  <T muted style={{ fontWeight: '700' }}>None</T>
                </TouchableOpacity>
              </View>
            </View>
            <View style={{ gap: SPACING.xs, marginTop: SPACING.xs }}>
              {trip.members.map((m) => {
                const active = splitSel.includes(m.id);
                const isFamily = m.kind === 'family';
                const fullSize = Math.max(1, m.family_members.length);
                const currentCount = weightOverrides[m.id] ?? fullSize;
                return (
                  <View key={m.id} style={[styles.row, { backgroundColor: active ? colors.surfaceMuted : colors.surface, borderColor: active ? colors.primary : colors.border, flexDirection: 'column', alignItems: 'stretch', gap: 8 }]}>
                    <TouchableOpacity onPress={() => toggleSplit(m.id)}
                      testID={`ee-split-${m.id}`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                      <Ionicons name={active ? 'checkbox' : 'square-outline'} size={20} color={colors.primary} />
                      <T style={{ flex: 1 }}>{m.name}{isFamily ? ` (${fullSize})` : ''}</T>
                    </TouchableOpacity>
                    {active && isFamily && fullSize > 1 && splitMode === 'PER_CAPITA' && (
                      <View style={{ paddingLeft: 28, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <T variant="caption" muted>Split among</T>
                        {Array.from({ length: fullSize }, (_, i) => i + 1).map((n) => (
                          <TouchableOpacity key={n}
                            testID={`ee-fam-${m.id}-${n}`}
                            onPress={() => setWeightOverrides((w) => ({ ...w, [m.id]: n }))}
                            style={[styles.numChip, { backgroundColor: currentCount === n ? colors.primary : colors.surface, borderColor: currentCount === n ? colors.primary : colors.border }]}>
                            <T variant="caption" style={{ fontWeight: '700' }}
                              color={currentCount === n ? colors.primaryText : colors.textMain}>{n}</T>
                          </TouchableOpacity>
                        ))}
                        <T variant="caption" muted>of {fullSize}</T>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>

          {/* Split mode */}
          <SplitModeSelector
            value={splitMode}
            onChange={setSplitMode}
            subLabel={splitPreviewLabel({
              amount: parseFloat(amount),
              mode: splitMode,
              members: trip.members,
              splitSel,
              weightOverrides,
              currency: trip.currency,
            })}
          />

          <View>
            <T variant="label" muted>Receipt</T>
            {receipt ? (
              <View style={{ marginTop: 6 }}>
                <Image source={{ uri: receipt }} style={{ width: '100%', height: 200, borderRadius: RADIUS.lg }} />
                <TouchableOpacity onPress={() => setReceipt(null)} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                  <T color={colors.owing}>Remove</T>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={pickReceipt}
                style={[styles.receiptBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Ionicons name="image-outline" size={18} color={colors.primary} />
                <T color={colors.primary} style={{ fontWeight: '700' }}>Attach image</T>
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity testID="ee-save" onPress={save} disabled={saving}
            style={[styles.btn, { backgroundColor: colors.primary }]}>
            <T color={colors.primaryText} variant="h3">{saving ? 'Saving…' : 'Save changes'}</T>
          </TouchableOpacity>

          <TouchableOpacity testID="ee-delete" onPress={onDelete}
            style={[styles.btn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.owing }]}>
            <T color={colors.owing} style={{ fontWeight: '700' }}>Delete transaction</T>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  amountBox: { padding: SPACING.lg, borderRadius: RADIUS.xl, borderWidth: 1 },
  amountInput: { fontSize: 44, fontWeight: '700', letterSpacing: -1, paddingVertical: 4 },
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
  receiptBtn: {
    flexDirection: 'row', gap: 8, padding: SPACING.md, borderRadius: RADIUS.md,
    borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  numChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill, borderWidth: 1 },
  btn: { marginTop: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
