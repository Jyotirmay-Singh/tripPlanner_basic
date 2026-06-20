import React, { useEffect, useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
  KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { api, uploadReceipt, deleteReceipt, receiptUrl, getToken } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, CONTROL, CATEGORIES } from '../../../src/theme';
import T from '../../../src/T';
import SplitModeSelector, { SplitMode, splitPreviewLabel } from '../../../src/SplitModeSelector';
import { canModifyExpense } from '../../../src/permissions';
import ReceiptViewer from '../../../src/ReceiptViewer';

type Member = { id: string; name: string; kind: string; family_members: string[] };
type Trip = { id: string; name: string; currency: string; owner_id: string; admin_ids: string[]; members: Member[] };
type Expense = {
  id: string; kind: 'expense' | 'income'; amount: number; category: string;
  description?: string; date: string; paid_by_member_id: string;
  split_member_ids: string[]; split_mode?: SplitMode;
  weight_snapshots?: Record<string, number> | null; receipt_base64?: string | null;
  receipt_id?: string | null; has_receipt?: boolean;
  created_by?: string | null;
};

export default function EditExpense() {
  const { id, eid } = useLocalSearchParams<{ id: string; eid: string }>();
  const { colors } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [createdBy, setCreatedBy] = useState<string | null | undefined>(undefined);
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [cat, setCat] = useState<string>('Food');
  const [date, setDate] = useState('');
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const [splitSel, setSplitSel] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('PER_CAPITA');
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>({});
  // Step 22: receiptUri is what we preview (existing remote URL or a freshly-picked local file);
  // newAsset is a just-picked image to upload; hadReceipt records whether one existed on load.
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [newAsset, setNewAsset] = useState<{ uri: string; mimeType?: string; fileName?: string } | null>(null);
  const [hadReceipt, setHadReceipt] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await api<Trip>(`/trips/${id}`);
      setTrip(t);
      const exps = await api<Expense[]>(`/trips/${id}/expenses`);
      const e = exps.find((x) => x.id === eid);
      if (!e) return;
      setCreatedBy(e.created_by ?? null);
      setKind(e.kind); setAmount(String(e.amount)); setDesc(e.description || '');
      setCat(e.category); setDate(e.date); setPaidBy(e.paid_by_member_id);
      const allIds = t.members.map((m) => m.id);
      setSplitSel(e.split_member_ids && e.split_member_ids.length ? e.split_member_ids : allIds);
      setSplitMode(e.split_mode || 'PER_CAPITA');
      setWeightOverrides(e.weight_snapshots || {});
      // Step 22: render an existing receipt from the streamed GridFS endpoint (legacy rows
      // surface via has_receipt too). The ?token= URL works in <Image> without auth headers.
      const has = !!(e.has_receipt || e.receipt_id || e.receipt_base64);
      setHadReceipt(has);
      if (has) {
        const token = await getToken();
        if (token) setReceiptUri(receiptUrl(id, eid, token));
      }
    })();
  }, [id, eid]);

  const applyAsset = (r: ImagePicker.ImagePickerResult) => {
    if (!r.canceled && r.assets[0]?.uri) {
      const a = r.assets[0];
      setNewAsset({ uri: a.uri, mimeType: a.mimeType || 'image/jpeg', fileName: a.fileName ?? undefined });
      setReceiptUri(a.uri);
    }
  };

  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert('Permission needed', 'Allow photo access to attach a receipt.');
    applyAsset(await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.4, allowsEditing: true,
    }));
  };

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert('Permission needed', 'Allow camera access to capture a receipt.');
    applyAsset(await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'], quality: 0.4, allowsEditing: true,
    }));
  };

  const chooseReceiptSource = () => {
    // Web has no native action sheet (RN Alert buttons don't render in the browser), so go
    // straight to the file picker. Native keeps the Take photo / Choose from library choice.
    if (Platform.OS === 'web') {
      pickFromLibrary();
      return;
    }
    Alert.alert('Add receipt', undefined, [
      { text: 'Take photo', onPress: takePhoto },
      { text: 'Choose from library', onPress: pickFromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
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
        },
      });
      // Step 22: reconcile the receipt via the dedicated endpoints (GridFS replace semantics).
      if (newAsset) {
        await uploadReceipt(id, eid, newAsset);
      } else if (hadReceipt && !receiptUri) {
        await deleteReceipt(id, eid);
      }
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

  // Step 17: mirror the backend rule — only the creator or a trip admin may edit/delete.
  const canModify = canModifyExpense({ created_by: createdBy }, user?.id, trip);

  const toggleSplit = (mid: string) => {
    setSplitSel((s) => s.includes(mid) ? s.filter((x) => x !== mid) : [...s, mid]);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
          <T variant="h1">Edit transaction</T>

          {!canModify && (
            <View testID="expense-readonly-note"
              style={[styles.readonlyNote, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
              <Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} />
              <T variant="caption" muted style={{ flex: 1 }}>
                Only the person who added this transaction or a trip admin can edit it.
              </T>
            </View>
          )}

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
            {receiptUri ? (
              <View style={{ marginTop: 6 }}>
                <TouchableOpacity testID="receipt-view" activeOpacity={0.8} onPress={() => setViewerOpen(true)}>
                  <Image source={{ uri: receiptUri }} style={{ width: '100%', height: 200, borderRadius: RADIUS.lg }} />
                </TouchableOpacity>
                {/* Step 20/17: only the creator or a trip admin may remove the receipt;
                    everyone can still view it and save it to their gallery. */}
                {canModify && (
                  <TouchableOpacity onPress={() => { setReceiptUri(null); setNewAsset(null); }} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                    <T color={colors.owing}>Remove</T>
                  </TouchableOpacity>
                )}
              </View>
            ) : canModify ? (
              <TouchableOpacity onPress={chooseReceiptSource}
                style={[styles.receiptBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Ionicons name="image-outline" size={18} color={colors.primary} />
                <T color={colors.primary} style={{ fontWeight: '700' }}>Attach image</T>
              </TouchableOpacity>
            ) : (
              <T variant="caption" muted style={{ marginTop: 6 }}>No receipt attached.</T>
            )}
          </View>

          <ReceiptViewer uri={receiptUri} visible={viewerOpen} onClose={() => setViewerOpen(false)} />

          {/* Step 17: hide update/delete affordances unless the user is creator or trip admin. */}
          {canModify && (
            <>
              <TouchableOpacity testID="ee-save" onPress={save} disabled={saving}
                style={[styles.btn, { backgroundColor: colors.primary }]}>
                <T color={colors.primaryText} variant="h3">{saving ? 'Saving…' : 'Save changes'}</T>
              </TouchableOpacity>

              <TouchableOpacity testID="ee-delete" onPress={onDelete}
                style={[styles.btn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.owing }]}>
                <T color={colors.owing} style={{ fontWeight: '700' }}>Delete transaction</T>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  amountBox: { padding: SPACING.lg, borderRadius: RADIUS.xl, borderWidth: 1 },
  amountInput: { fontSize: 44, fontWeight: '700', letterSpacing: -1, paddingVertical: 4 },
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: CONTROL.paddingY, borderRadius: CONTROL.radius, borderWidth: 1, fontSize: CONTROL.fontSize },
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
  readonlyNote: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
});
