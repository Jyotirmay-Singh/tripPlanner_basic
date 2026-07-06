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
import ExactSplitEditor from '../../../src/ExactSplitEditor';
import { ExactRow, buildExactRows, reconcile, resolveEntityShares, rowsToCustomAmounts } from '../../../src/exactSplit';
import { canModifyExpense } from '../../../src/permissions';
import { memberDisplayNames, familyMemberDisplayNames } from '../../../src/displayNames';
import { buildFamilyParticipants, excludedFromParticipants, familyMemberIds, familyShareEach } from '../../../src/familyParticipation';
import { formatMoney } from '../../../src/format';
import { parseAmount, isValidAmount, refundExceedsSpend, REFUND_WARNING } from '../../../src/signedAmount';
import ReceiptViewer from '../../../src/ReceiptViewer';
import ConfirmModal from '../../../src/ConfirmModal';
import { ddmmyyToDDMMYYYY, ddmmyyyyToDDMMYY } from '../../../src/date';
import {
  Card, Button, Input, Pill, Icon, ActionSheet, SkeletonCard, useToast,
  DateField, TimeField,
} from '../../../src/ui';

type Member = { id: string; name: string; kind: string; family_members: string[]; family_member_ids?: string[] };
type Trip = { id: string; name: string; currency: string; owner_id: string; admin_ids: string[]; members: Member[] };
type Expense = {
  id: string; amount: number; category: string;
  description?: string; date: string; time?: string | null; paid_by_member_id: string;
  split_member_ids: string[]; split_mode?: SplitMode;
  weight_snapshots?: Record<string, number> | null; receipt_base64?: string | null;
  family_participants?: Record<string, string[]> | null;
  custom_amounts?: Record<string, number> | null;
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
  const [amount, setAmount] = useState('');
  // Net of every OTHER transaction's signed amount — drives the soft "refund > spend" warning only.
  const [tripNetSpendExcl, setTripNetSpendExcl] = useState(0);
  const [desc, setDesc] = useState('');
  const [cat, setCat] = useState<string>('Food');
  // Date held in display form (dd/mm/yyyy) for the picker; converted to stored DD-MM-YY at save.
  const [dateDisplay, setDateDisplay] = useState('');
  const [time, setTime] = useState('');
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const [splitSel, setSplitSel] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('PER_CAPITA');
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>({});
  // famId -> excluded member ids (default empty = everyone participates).
  const [familyExcluded, setFamilyExcluded] = useState<Record<string, string[]>>({});
  // Phase 22 — EXACT: person-level rows, rehydrated from the stored custom_amounts on load.
  const [exactRows, setExactRows] = useState<ExactRow[]>([]);
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
      setTripNetSpendExcl(exps.filter((x) => x.id !== eid).reduce((s, x) => s + x.amount, 0));
      setCreatedBy(e.created_by ?? null);
      setAmount(String(e.amount)); setDesc(e.description || '');
      setCat(e.category); setDateDisplay(ddmmyyToDDMMYYYY(e.date)); setTime(e.time || '');
      setPaidBy(e.paid_by_member_id);
      const allIds = t.members.map((m) => m.id);
      setSplitSel(e.split_member_ids && e.split_member_ids.length ? e.split_member_ids : allIds);
      setSplitMode(e.split_mode || 'PER_CAPITA');
      setWeightOverrides(e.weight_snapshots || {});
      setFamilyExcluded(excludedFromParticipants(t.members, e.family_participants));
      setExactRows(buildExactRows(t.members, e.custom_amounts));
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
    const a = parseAmount(amount);
    if (!isValidAmount(a)) return toast.show('Enter a non-zero amount', 'error');
    const date = ddmmyyyyToDDMMYY(dateDisplay);  // -> stored DD-MM-YY (format unchanged)
    if (!date) return toast.show('Enter a valid date as dd/mm/yyyy', 'error');
    setSaving(true);
    try {
      let body: any;
      if (splitMode === 'EXACT') {
        // Phase 22 hard rule (mirror of the backend 422): amounts must add up to the total.
        if (!reconcile(exactRows, a).isValid) {
          setSaving(false);
          return toast.show('Assigned amounts must add up to the total.', 'error');
        }
        const shares = resolveEntityShares(exactRows);
        body = {
          amount: a, category: cat, description: desc, date, time: time || null,
          paid_by_member_id: paidBy,
          split_member_ids: Object.keys(shares),
          split_mode: 'EXACT',
          weight_snapshots: null,
          family_participants: null,
          custom_amounts: rowsToCustomAmounts(exactRows),
        };
      } else {
        const allSelected = trip.members.length > 0 && splitSel.length === trip.members.length;
        // Legacy weight_snapshots back-compat: the headcount picker UI is gone, but preserve any
        // per-family weight this expense already carried so editing doesn't silently wipe it.
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
        // At least one member of every ticked family must take part (both split modes).
        for (const sid of splitSel) {
          const m = trip.members.find((x) => x.id === sid);
          if (m && m.kind === 'family') {
            const fam = familyMemberIds(m);
            const excl = familyExcluded[sid] || [];
            if (fam.length > 1 && fam.every((rid) => excl.includes(rid))) {
              setSaving(false);
              return toast.show(`At least one member of ${m.name} must take part.`, 'error');
            }
          }
        }
        body = {
          amount: a, category: cat, description: desc, date, time: time || null,
          paid_by_member_id: paidBy,
          split_member_ids: allSelected ? [] : splitSel,
          split_mode: splitMode,
          weight_snapshots: Object.keys(snapshots).length ? snapshots : null,
          family_participants: buildFamilyParticipants(trip.members, splitSel, splitMode, familyExcluded),
          custom_amounts: null,  // clear any stale EXACT amounts when saving in another mode
        };
      }
      await api(`/trips/${id}/expenses/${eid}`, { method: 'PATCH', body });
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
  const toggleFamMember = (famId: string, memberId: string) =>
    setFamilyExcluded((s) => {
      const cur = s[famId] || [];
      const next = cur.includes(memberId) ? cur.filter((x) => x !== memberId) : [...cur, memberId];
      return { ...s, [famId]: next };
    });
  const displayNames = memberDisplayNames(trip.members);
  const parsedAmount = Number.isFinite(parseAmount(amount)) ? parseAmount(amount) : 0;
  const exactRec = reconcile(exactRows, parsedAmount);

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

            <Card padding="lg" radius={RADIUS.xl}>
              <T variant="label" muted>{trip.currency} amount * (use a minus for money back)</T>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: SPACING.sm, marginTop: 6 }}>
                <T style={{ fontFamily: FONTS.number, fontSize: 28, color: colors.textMuted }}>{trip.currency}</T>
                <TextInput testID="ee-amount" value={amount} onChangeText={setAmount} keyboardType="numbers-and-punctuation"
                  editable={canModify}
                  style={[styles.amountInput, { color: colors.textMain }]} />
              </View>
              {refundExceedsSpend(parseAmount(amount), tripNetSpendExcl) ? (
                <T testID="ee-refund-warn" variant="caption" color={colors.warning} style={{ marginTop: 6 }}>{REFUND_WARNING}</T>
              ) : null}
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

            {/* Date (calendar picker) + optional time, side by side */}
            <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
              <DateField testID="ee-date" label="Date *" value={dateDisplay} onChangeText={canModify ? setDateDisplay : () => {}} containerStyle={{ flex: 1 }} />
              <TimeField testID="ee-time" label="Time" value={time} onChange={setTime} editable={canModify} containerStyle={{ flex: 1 }} />
            </View>

            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Paid by *</T>
              <View style={{ gap: SPACING.xs }}>
                {trip.members.map((m) => {
                  const sel = paidBy === m.id;
                  return (
                    <TouchableOpacity key={m.id} onPress={() => setPaidBy(m.id)}
                      style={[styles.row, { backgroundColor: sel ? colors.surfaceMuted : colors.surface, borderColor: sel ? colors.primary : colors.border }]}>
                      <Icon name={sel ? 'radio-on' : 'radio-off'} size={20} color={sel ? colors.primary : colors.textMuted} />
                      <T style={{ flex: 1 }}>{displayNames[m.id]}</T>
                      <T variant="caption" muted>{m.kind}</T>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Split mode — chosen up front, before the who/how-much controls it drives. */}
            <SplitModeSelector
              value={splitMode}
              onChange={setSplitMode}
              subLabel={splitPreviewLabel({
                amount: parseFloat(amount), mode: splitMode, members: trip.members, splitSel, weightOverrides, currency: trip.currency, familyExcluded,
                exactShares: resolveEntityShares(exactRows), names: displayNames,
              })}
            />

            <View>
              {splitMode === 'EXACT' ? (
              <ExactSplitEditor
                members={trip.members} currency={trip.currency} total={parsedAmount}
                initialRows={exactRows} onChange={setExactRows} displayNames={displayNames}
              />
              ) : (
              <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T variant="label" muted>Split among</T>
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
                  const roster = isFamily ? familyMemberIds(m) : [];
                  const rosterNames = isFamily ? familyMemberDisplayNames(m) : [];
                  const excluded = familyExcluded[m.id] || [];
                  const includedCount = roster.filter((rid) => !excluded.includes(rid)).length;
                  return (
                    <View key={m.id} style={[styles.row, { backgroundColor: active ? colors.surfaceMuted : colors.surface, borderColor: active ? colors.primary : colors.border, flexDirection: 'column', alignItems: 'stretch', gap: 8 }]}>
                      <TouchableOpacity onPress={() => toggleSplit(m.id)} testID={`ee-split-${m.id}`}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                        <Icon name={active ? 'checkbox-on' : 'checkbox-off'} size={20} color={active ? colors.primary : colors.textMuted} />
                        <T style={{ flex: 1 }}>{displayNames[m.id]}</T>
                      </TouchableOpacity>
                      {active && isFamily && fullSize > 1 && (
                        <View style={{ paddingLeft: 28, gap: 8 }}>
                          {/* Who took part: unchecked members owe 0. Per-Person (PER_CAPITA) counts the
                              family by its INVOLVED members, so its total shrinks and each sharer owes the
                              per-human cost (§5-A). Per-Family keeps the flat entity total and only splits
                              it among those who shared. */}
                          <T variant="caption" muted>Who took part?</T>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {roster.map((rid, i) => {
                              const inc = !excluded.includes(rid);
                              return (
                                <TouchableOpacity key={rid} testID={`ee-fammem-${m.id}-${i}`}
                                  onPress={() => toggleFamMember(m.id, rid)}
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                  <Icon name={inc ? 'checkbox-on' : 'checkbox-off'} size={18} color={inc ? colors.primary : colors.textMuted} />
                                  <T variant="caption" color={inc ? colors.textMain : colors.textMuted}>{rosterNames[i]}</T>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                          {includedCount === 0 ? (
                            <T variant="caption" color={colors.danger}>At least one member must take part.</T>
                          ) : includedCount < roster.length ? (
                            <T variant="caption" muted testID={`ee-fam-preview-${m.id}`}>
                              {trip.currency} {formatMoney(familyShareEach(parseFloat(amount), trip.members, splitSel, weightOverrides, m.id, includedCount, splitMode, familyExcluded))} each (excluded owe 0)
                            </T>
                          ) : null}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
              </>
              )}
            </View>

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
                <Button label="Save changes" icon="check" onPress={save} loading={saving} disabled={splitMode === 'EXACT' && !exactRec.isValid} fullWidth size="lg" testID="ee-save" style={{ marginTop: SPACING.sm }} />
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
  readonlyNote: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
});
