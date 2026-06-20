import React, { useEffect, useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { api, uploadReceipt, deleteReceipt, receiptUrl, getToken } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, FONTS, CATEGORIES, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import SplitModeSelector, { SplitMode, splitPreviewLabel } from '../../../src/SplitModeSelector';
import { canModifyExpense } from '../../../src/permissions';
import ReceiptViewer from '../../../src/ReceiptViewer';
import ConfirmModal from '../../../src/ConfirmModal';
import {
  Card, Button, Input, Pill, SegmentedControl, Icon, ActionSheet, SkeletonCard, useToast,
} from '../../../src/ui';

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
  const toast = useToast();
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
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [newAsset, setNewAsset] = useState<{ uri: string; mimeType?: string; fileName?: string } | null>(null);
  const [hadReceipt, setHadReceipt] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sourceSheet, setSourceSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    setSourceSheet(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast.show('Allow photo access to attach a receipt.', 'error');
    applyAsset(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.4, allowsEditing: true }));
  };

  const takePhoto = async () => {
    setSourceSheet(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return toast.show('Allow camera access to capture a receipt.', 'error');
    applyAsset(await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.4, allowsEditing: true }));
  };

  const chooseReceiptSource = () => {
    if (Platform.OS === 'web') { pickFromLibrary(); return; }
    setSourceSheet(true);
  };

  const save = async () => {
    if (!trip || !paidBy) return;
    const a = parseFloat(amount);
    if (!a || a <= 0) return toast.show('Amount must be greater than 0', 'error');
    setSaving(true);
    try {
      const allSelected = trip.members.length > 0 && splitSel.length === trip.members.length;
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
      if (newAsset) {
        await uploadReceipt(id, eid, newAsset);
      } else if (hadReceipt && !receiptUri) {
        await deleteReceipt(id, eid);
      }
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not save', 'error'); }
    finally { setSaving(false); }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try { await api(`/trips/${id}/expenses/${eid}`, { method: 'DELETE' }); router.back(); }
    catch (e: any) { toast.show(e.message || 'Delete failed', 'error'); }
  };

  if (!trip) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: SPACING.lg, gap: SPACING.md }}><SkeletonCard count={4} /></View>
      </SafeAreaView>
    );
  }

  const canModify = canModifyExpense({ created_by: createdBy }, user?.id, trip);
  const toggleSplit = (mid: string) => setSplitSel((s) => s.includes(mid) ? s.filter((x) => x !== mid) : [...s, mid]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 80, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">Edit transaction</T>

            {!canModify && (
              <View testID="expense-readonly-note" style={[styles.readonlyNote, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
                <Icon name="lock" size={16} color={colors.textMuted} />
                <T variant="caption" muted style={{ flex: 1 }}>
                  Only the person who added this transaction or a trip admin can edit it.
                </T>
              </View>
            )}

            <SegmentedControl
              segments={[{ value: 'expense', label: 'Expense', icon: 'trending-down' }, { value: 'income', label: 'Income', icon: 'trending-up' }]}
              value={kind}
              onChange={setKind}
              testIDPrefix="ee-kind"
            />

            <Card padding="lg" radius={RADIUS.xl}>
              <T variant="label" muted>{trip.currency} amount *</T>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: SPACING.sm, marginTop: 6 }}>
                <T style={{ fontFamily: FONTS.number, fontSize: 28, color: colors.textMuted }}>{trip.currency}</T>
                <TextInput testID="ee-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad"
                  style={[styles.amountInput, { color: colors.textMain }]} />
              </View>
            </Card>

            <Input testID="ee-desc" label="Description" value={desc} onChangeText={setDesc} />

            <View>
              <T variant="label" muted>Category *</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: SPACING.xs }}>
                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  {CATEGORIES.map((c) => (
                    <Pill key={c} label={c} active={cat === c} onPress={() => setCat(c)} />
                  ))}
                </View>
              </ScrollView>
            </View>

            <Input testID="ee-date" label="Date (DD-MM-YY) *" value={date} onChangeText={setDate} icon="calendar" />

            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Paid by *</T>
              <View style={{ gap: SPACING.xs }}>
                {trip.members.map((m) => {
                  const sel = paidBy === m.id;
                  return (
                    <TouchableOpacity key={m.id} onPress={() => setPaidBy(m.id)}
                      style={[styles.row, { backgroundColor: sel ? colors.surfaceMuted : colors.surface, borderColor: sel ? colors.primary : colors.border }]}>
                      <Icon name={sel ? 'radio-on' : 'radio-off'} size={20} color={sel ? colors.primary : colors.textMuted} />
                      <T style={{ flex: 1 }}>{m.name}</T>
                      <T variant="caption" muted>{m.kind}</T>
                    </TouchableOpacity>
                  );
                })}
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
                      <TouchableOpacity onPress={() => toggleSplit(m.id)} testID={`ee-split-${m.id}`}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                        <Icon name={active ? 'checkbox-on' : 'checkbox-off'} size={20} color={active ? colors.primary : colors.textMuted} />
                        <T style={{ flex: 1 }}>{m.name}{isFamily ? ` (${fullSize})` : ''}</T>
                      </TouchableOpacity>
                      {active && isFamily && fullSize > 1 && splitMode === 'PER_CAPITA' && (
                        <View style={{ paddingLeft: 28, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <T variant="caption" muted>Split among</T>
                          {Array.from({ length: fullSize }, (_, i) => i + 1).map((n) => (
                            <TouchableOpacity key={n} testID={`ee-fam-${m.id}-${n}`}
                              onPress={() => setWeightOverrides((w) => ({ ...w, [m.id]: n }))}
                              style={[styles.numChip, { backgroundColor: currentCount === n ? colors.primary : colors.surface, borderColor: currentCount === n ? colors.primary : colors.border }]}>
                              <T variant="caption" style={{ fontWeight: '700' }} color={currentCount === n ? colors.primaryText : colors.textMain}>{n}</T>
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

            <SplitModeSelector
              value={splitMode}
              onChange={setSplitMode}
              subLabel={splitPreviewLabel({
                amount: parseFloat(amount), mode: splitMode, members: trip.members, splitSel, weightOverrides, currency: trip.currency,
              })}
            />

            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Receipt</T>
              {receiptUri ? (
                <View>
                  <TouchableOpacity testID="receipt-view" activeOpacity={0.85} onPress={() => setViewerOpen(true)} accessibilityLabel="View receipt">
                    <Image source={{ uri: receiptUri }} style={{ width: '100%', height: 200, borderRadius: RADIUS.lg }} />
                  </TouchableOpacity>
                  {canModify && (
                    <TouchableOpacity onPress={() => { setReceiptUri(null); setNewAsset(null); }} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                      <T color={colors.danger} style={{ fontWeight: '700' }}>Remove</T>
                    </TouchableOpacity>
                  )}
                </View>
              ) : canModify ? (
                <TouchableOpacity onPress={chooseReceiptSource}
                  style={[styles.receiptBtn, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Attach receipt image">
                  <Icon name="image-plus" size={18} color={colors.primary} />
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Attach image</T>
                </TouchableOpacity>
              ) : (
                <T variant="caption" muted>No receipt attached.</T>
              )}
            </View>

            <ReceiptViewer uri={receiptUri} visible={viewerOpen} onClose={() => setViewerOpen(false)} />

            {canModify && (
              <>
                <Button label="Save changes" icon="check" onPress={save} loading={saving} fullWidth size="lg" testID="ee-save" style={{ marginTop: SPACING.sm }} />
                <Button label="Delete transaction" icon="trash" variant="destructive" onPress={() => setConfirmDelete(true)} fullWidth testID="ee-delete" />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <ActionSheet
        visible={sourceSheet}
        onClose={() => setSourceSheet(false)}
        title="Add receipt"
        actions={[
          { label: 'Take photo', icon: 'camera', onPress: takePhoto },
          { label: 'Choose from library', icon: 'image', onPress: pickFromLibrary },
        ]}
      />

      <ConfirmModal
        visible={confirmDelete}
        title="Delete transaction?"
        message="This permanently removes the transaction and its bill."
        onRequestClose={() => setConfirmDelete(false)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirmDelete(false) },
          { label: 'Delete', variant: 'destructive', onPress: doDelete, testID: 'ee-delete-confirm' },
        ]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  amountInput: { flex: 1, fontFamily: FONTS.numberBold, fontSize: 44, letterSpacing: -1, paddingVertical: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
  receiptBtn: {
    flexDirection: 'row', gap: 8, padding: SPACING.md, borderRadius: RADIUS.md,
    borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center',
  },
  numChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill, borderWidth: 1 },
  readonlyNote: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
});
