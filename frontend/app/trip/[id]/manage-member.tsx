import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS } from '../../../src/theme';
import T from '../../../src/T';
import Badge from '../../../src/Badge';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; owner_id: string; admin_ids: string[]; members: Member[] };

export default function ManageMember() {
  const { id, mid } = useLocalSearchParams<{ id: string; mid: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const t = await api<Trip>(`/trips/${id}`);
        setTrip(t);
        setAdminIds(t.admin_ids ?? []);
        setMember((t.members || []).find((m) => m.id === mid) ?? null);
      } catch (e: any) { setError(e.message); }
    })();
  }, [id, mid]);

  if (!trip || !member) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <T style={{ padding: SPACING.lg }}>Loading…</T>
      </SafeAreaView>
    );
  }

  const isOwner = !!member.user_id && member.user_id === trip.owner_id;
  const isMemberAdmin = !!member.user_id && adminIds.includes(member.user_id);
  const role: 'owner' | 'admin' | null = isOwner ? 'owner' : isMemberAdmin ? 'admin' : null;

  const toggleAdmin = async () => {
    const uid = member.user_id;
    if (!uid) return;
    setBusy(true); setError(null);
    try {
      if (isMemberAdmin) {
        await api(`/trips/${id}/admins/${uid}`, { method: 'DELETE' });
        setAdminIds((prev) => prev.filter((u) => u !== uid));
      } else {
        await api(`/trips/${id}/admins`, { method: 'POST', body: { user_id: uid } });
        setAdminIds((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
      }
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }}>
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
            <T variant="h1">{member.name}{member.kind === 'family' ? ` (${member.family_members.length})` : ''}</T>
            {role === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
            {role === 'admin' ? <Badge label="Admin" color={colors.owed} /> : null}
          </View>
          <T muted style={{ marginTop: 4 }}>
            {member.kind === 'family' ? `Family of ${member.family_members.length}` : (member.user_id ? 'App user' : 'Individual')}
            {member.email ? ` · ${member.email}` : ''}
          </T>
        </View>

        {/* Trip role */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <T variant="label" muted>Trip role</T>
          {!member.user_id ? (
            <T variant="caption" muted style={{ marginTop: SPACING.sm }}>
              Only app users who have joined this trip can become admins.
            </T>
          ) : isOwner ? (
            <View style={{ marginTop: SPACING.sm, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
              <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
              <T>Owner · root admin (cannot be removed)</T>
            </View>
          ) : (
            <>
              <T variant="caption" muted style={{ marginTop: SPACING.sm }}>
                {isMemberAdmin
                  ? 'Admins can add and change members and expenses on this trip.'
                  : 'Promote to let this member add and change members and expenses.'}
              </T>
              <TouchableOpacity
                testID={isMemberAdmin ? 'mm-remove-admin' : 'mm-make-admin'}
                onPress={toggleAdmin} disabled={busy}
                style={[styles.btn, {
                  marginTop: SPACING.sm,
                  backgroundColor: isMemberAdmin ? colors.surface : colors.primary,
                  borderWidth: isMemberAdmin ? 1 : 0,
                  borderColor: colors.owing,
                  opacity: busy ? 0.6 : 1,
                }]}>
                {busy ? (
                  <ActivityIndicator color={isMemberAdmin ? colors.owing : colors.primaryText} />
                ) : (
                  <T color={isMemberAdmin ? colors.owing : colors.primaryText} style={{ fontWeight: '700' }}>
                    {isMemberAdmin ? 'Remove admin' : 'Make admin'}
                  </T>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Member & family configuration */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <T variant="label" muted>Member configuration</T>
          <T variant="caption" muted style={{ marginTop: SPACING.sm }}>
            Update the name, linked email, or {member.kind === 'family' ? 'family roster' : 'member kind'}.
          </T>
          <TouchableOpacity
            testID="mm-edit-details"
            onPress={() => router.push({ pathname: '/trip/[id]/edit-member', params: { id: id as string, mid: mid as string } })}
            style={[styles.btn, { marginTop: SPACING.sm, backgroundColor: colors.surfaceMuted }]}>
            <Ionicons name="pencil-outline" size={16} color={colors.textMain} />
            <T style={{ fontWeight: '700', marginLeft: 6 }}>Edit member &amp; family details</T>
          </TouchableOpacity>
        </View>

        {error ? <T testID="mm-error" variant="caption" color={colors.owing}>{error}</T> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: { padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1 },
  btn: { flexDirection: 'row', paddingVertical: 14, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
});
