import React, { useEffect, useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { api, uploadReceipt } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, FONTS, CATEGORIES, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import SplitModeSelector, { SplitMode, splitPreviewLabel } from '../../../src/SplitModeSelector';
import ReceiptViewer from '../../../src/ReceiptViewer';
import ConfirmModal from '../../../src/ConfirmModal';
import { formatDDMMYYYY, partsFromLocalDate, ddmmyyyyToDDMMYY } from '../../../src/date';
import {
  Card, Button, Input, Pill, SegmentedControl, Icon, ActionSheet, SkeletonCard, useToast,
  DateField, TimeField,
} from '../../../src/ui';

type Member = { id: string; name: string; kind: string; family_members: string[] };
type Trip = { id: string; name: string; currency: string; members: Member[] };

export default function AddExpense() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [cat, setCat] = useState<string>('Food');
  // Date is held in display form (dd/mm/yyyy) for the calendar picker; converted to the stored
  // DD-MM-YY format only at submit. Time is optional ('HH:MM' or '' = none), empty by default.
  const [dateDisplay, setDateDisplay] = useState(formatDDMMYYYY(partsFromLocalDate(new Date())));
  const [time, setTime] = useState('');
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const [splitSel, setSplitSel] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('PER_CAPITA');
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>({});
  const [allInited, setAllInited] = useState(false);
  const [receiptAsset, setReceiptAsset] = useState<{ uri: string; mimeType?: string; fileName?: string } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sourceSheet, setSourceSheet] = useState(false);
  const [budgetWarn, setBudgetWarn] = useState<string | null>(null);

  useEffect(() => {
    api<Trip>(`/trips/${id}`).then((t) => {
      setTrip(t);
      if (t.members.length && !paidBy) setPaidBy(t.members[0].id);
      if (!allInited) {
        setSplitSel(t.members.map((m) => m.id));
        setAllInited(true);
      }
    }).catch((e) => toast.show(e.message || 'Could not load trip', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const applyAsset = (r: ImagePicker.ImagePickerResult) => {
    if (!r.canceled && r.assets[0]?.uri) {
      const a = r.assets[0];
      setReceiptAsset({ uri: a.uri, mimeType: a.mimeType || 'image/jpeg', fileName: a.fileName ?? undefined });
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
    // Web has no camera flow here; go straight to file picker. Native shows a themed action sheet.
    if (Platform.OS === 'web') { pickFromLibrary(); return; }
    setSourceSheet(true);
  };

  const submit = async (force = false) => {
    if (!trip || !paidBy) return;
    const a = parseFloat(amount);
    if (!a || a <= 0) return toast.show('Amount must be greater than 0', 'error');
    const date = ddmmyyyyToDDMMYY(dateDisplay);  // -> stored DD-MM-YY (format unchanged)
    if (!date) return toast.show('Enter a valid date as dd/mm/yyyy', 'error');
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
      const body: any = {
        kind, amount: a, category: cat, description: desc, date, time: time || null,
        paid_by_member_id: paidBy,
        split_member_ids: allSelected ? [] : splitSel,
        split_mode: splitMode,
        weight_snapshots: Object.keys(snapshots).length ? snapshots : null,
      };
      const qs = force ? '?force=true' : '';
      const res = await api<any>(`/trips/${id}/expenses${qs}`, { method: 'POST', body });
      if (res.requires_confirmation) {
        setSaving(false);
        return setBudgetWarn(res.warning || 'This exceeds the trip budget.');
      }
      const newId = res.expense?.id;
      if (receiptAsset && newId) {
        try {
          await uploadReceipt(id, newId, receiptAsset);
        } catch (e: any) {
          toast.show(e.message || 'Saved, but the receipt upload failed.', 'error');
        }
      }
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not save', 'error'); }
    finally { setSaving(false); }
  };

  if (!trip) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: SPACING.lg, gap: SPACING.md }}><SkeletonCard count={4} /></View>
      </SafeAreaView>
    );
  }

  const toggleSplit = (mid: string) => setSplitSel((s) => s.includes(mid) ? s.filter((x) => x !== mid) : [...s, mid]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 80, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">New transaction</T>

            {/* Kind toggle */}
            <SegmentedControl
              segments={[{ value: 'expense', label: 'Expense', icon: 'trending-down' }, { value: 'income', label: 'Income', icon: 'trending-up' }]}
              value={kind}
              onChange={setKind}
              testIDPrefix="ae-kind"
            />

            {/* Amount — prominent, currency-prefixed */}
            <Card padding="lg" radius={RADIUS.xl}>
              <T variant="label" muted>{trip.currency} amount *</T>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: SPACING.sm, marginTop: 6 }}>
                <T style={{ fontFamily: FONTS.number, fontSize: 28, color: colors.textMuted }}>{trip.currency}</T>
                <TextInput testID="ae-amount" value={amount} onChangeText={setAmount}
                  keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.textMuted}
                  style={[styles.amountInput, { color: colors.textMain }]} />
              </View>
            </Card>

            <Input testID="ae-desc" label="Description" value={desc} onChangeText={setDesc} placeholder="e.g. Dinner at The Leela" />

            {/* Category */}
            <View>
              <T variant="label" muted>Category *</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: SPACING.xs }}>
                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  {CATEGORIES.map((c) => (
                    <Pill key={c} testID={`ae-cat-${c}`} label={c} active={cat === c} onPress={() => setCat(c)} />
                  ))}
                </View>
              </ScrollView>
            </View>

            {/* Date (calendar picker) + optional time, side by side */}
            <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
              <DateField testID="ae-date" label="Date *" value={dateDisplay} onChangeText={setDateDisplay} containerStyle={{ flex: 1 }} />
              <TimeField testID="ae-time" label="Time" value={time} onChange={setTime} containerStyle={{ flex: 1 }} />
            </View>

            {/* Paid by */}
            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Paid by *</T>
              <View style={{ gap: SPACING.xs }}>
                {trip.members.map((m) => {
                  const sel = paidBy === m.id;
                  return (
                    <TouchableOpacity key={m.id} onPress={() => setPaidBy(m.id)} testID={`ae-paid-${m.id}`}
                      style={[styles.row, { backgroundColor: sel ? colors.surfaceMuted : colors.surface, borderColor: sel ? colors.primary : colors.border }]}>
                      <Icon name={sel ? 'radio-on' : 'radio-off'} size={20} color={sel ? colors.primary : colors.textMuted} />
                      <T style={{ flex: 1 }}>{m.name}</T>
                      <T variant="caption" muted>{m.kind}</T>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Split */}
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T variant="label" muted>Split among ({splitSel.length}/{trip.members.length})</T>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <TouchableOpacity testID="ae-split-all-btn" onPress={() => setSplitSel(trip.members.map((m) => m.id))}>
                    <T color={colors.primary} style={{ fontWeight: '700' }}>Select all</T>
                  </TouchableOpacity>
                  <TouchableOpacity testID="ae-split-none-btn" onPress={() => setSplitSel([])}>
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
                      <TouchableOpacity onPress={() => toggleSplit(m.id)} testID={`ae-split-${m.id}`}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                        <Icon name={active ? 'checkbox-on' : 'checkbox-off'} size={20} color={active ? colors.primary : colors.textMuted} />
                        <T style={{ flex: 1 }}>{m.name}{isFamily ? ` (${fullSize})` : ''}</T>
                      </TouchableOpacity>
                      {active && isFamily && fullSize > 1 && splitMode === 'PER_CAPITA' && (
                        <View style={{ paddingLeft: 28, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <T variant="caption" muted>Split among</T>
                          {Array.from({ length: fullSize }, (_, i) => i + 1).map((n) => (
                            <TouchableOpacity key={n} testID={`ae-fam-${m.id}-${n}`}
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
              <T variant="caption" muted style={{ marginTop: SPACING.xs }}>
                {splitMode === 'PER_CAPITA'
                  ? 'All selected by default — uncheck anyone to exclude. Cost is divided by total people (families count by size).'
                  : 'All selected by default — uncheck anyone to exclude. Cost is divided equally per family/individual, regardless of size.'}
              </T>
            </View>

            <SplitModeSelector
              value={splitMode}
              onChange={setSplitMode}
              subLabel={splitPreviewLabel({
                amount: parseFloat(amount), mode: splitMode, members: trip.members, splitSel, weightOverrides, currency: trip.currency,
              })}
            />

            {/* Receipt */}
            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Receipt (optional)</T>
              {receiptAsset ? (
                <View>
                  <TouchableOpacity testID="receipt-view" activeOpacity={0.85} onPress={() => setViewerOpen(true)} accessibilityLabel="View receipt">
                    <Image source={{ uri: receiptAsset.uri }} style={{ width: '100%', height: 200, borderRadius: RADIUS.lg }} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setReceiptAsset(null)} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                    <T color={colors.danger} style={{ fontWeight: '700' }}>Remove</T>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity testID="ae-receipt" onPress={chooseReceiptSource}
                  style={[styles.receiptBtn, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Attach receipt image">
                  <Icon name="image-plus" size={18} color={colors.primary} />
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Attach image</T>
                </TouchableOpacity>
              )}
            </View>

            <ReceiptViewer uri={receiptAsset?.uri ?? null} visible={viewerOpen} onClose={() => setViewerOpen(false)} />

            <Button label="Save transaction" icon="check" onPress={() => submit(false)} loading={saving} fullWidth size="lg" testID="ae-submit" style={{ marginTop: SPACING.sm }} />
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
        visible={!!budgetWarn}
        title="Budget warning"
        message={budgetWarn || undefined}
        onRequestClose={() => setBudgetWarn(null)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setBudgetWarn(null) },
          { label: 'Save anyway', variant: 'primary', onPress: () => { setBudgetWarn(null); submit(true); } },
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
});
