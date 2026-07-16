import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING } from '../../../src/theme';
import { canManageAdmins, canRemoveMemberRow, roleOf } from '../../../src/permissions';
import {
  isSettled, isLastFamilyMember, entityRemovable, entityBlockReason, entityRemoveLabel,
} from '../../../src/removal';
import { memberDisplayNames, familyMemberDisplayNames } from '../../../src/displayNames';
import { familyMemberIds } from '../../../src/familyParticipation';
import { formatMoney } from '../../../src/format';
import T from '../../../src/T';
import Badge from '../../../src/Badge';
import ConfirmModal from '../../../src/ConfirmModal';
import { Screen, Card, Button, IconButton, Icon, useToast } from '../../../src/ui';

type Member = {
  id: string; name: string; kind: 'individual' | 'family'; family_members: string[];
  family_member_ids?: (string | null)[] | null;
  family_member_emails?: (string | null)[] | null;
  family_member_user_ids?: (string | null)[] | null;
  user_id?: string | null; email?: string | null;
};
type Trip = { id: string; name: string; owner_id: string; admin_ids: string[]; user_ids?: string[]; members: Member[] };
type FamRow = { id: string; name: string; net: number };
type Balances = { net: Record<string, number>; per_person: { member_id: string; members?: FamRow[] }[] };

export default function ManageMember() {
  const { id, mid } = useLocalSearchParams<{ id: string; mid: string }>();
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState<null | { uid: string; name: string }>(null);
  // One themed confirm dialog drives both whole-entity removal and per-family-member removal.
  const [confirm, setConfirm] = useState<null | { title: string; message?: string; onYes: () => void; yesId?: string }>(null);

  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        api<Balances>(`/trips/${id}/balances`),
      ]);
      setTrip(t);
      setAdminIds(t.admin_ids ?? []);
      setMember((t.members || []).find((m) => m.id === mid) ?? null);
      setBalances(b);
    } catch (e: any) { setError(e.message); toast.show(e.message || 'Could not load', 'error'); }
  }, [id, mid, toast]);

  useEffect(() => { load(); }, [load]);

  if (!trip || !member) {
    return <Screen edges={['bottom']}><T muted style={{ padding: SPACING.lg }}>Loading…</T></Screen>;
  }

  const memberLabel = memberDisplayNames(trip.members)[member.id] ?? member.name;
  const isOwner = !!member.user_id && member.user_id === trip.owner_id;
  const isMemberAdmin = !!member.user_id && adminIds.includes(member.user_id);
  const role: 'owner' | 'admin' | null = isOwner ? 'owner' : isMemberAdmin ? 'admin' : null;
  // Managing admin roles & ownership transfer are owner-only powers (mirror of the backend).
  const viewerIsOwner = canManageAdmins({ ...trip, admin_ids: adminIds }, user?.id);
  const canTransferToMember = viewerIsOwner && !!member.user_id && !isOwner;

  // Phase 27: admin is per-PERSON. For a family the entity carries no account, so roles live on the
  // individual sub-members: each linked slot (family_member_user_ids[i]) can hold owner/admin.
  const subMembers = member.kind === 'family'
    ? (() => {
        const ids = familyMemberIds({
          id: member.id, kind: member.kind, family_members: member.family_members,
          // Stored ids are always non-null strings; the null entries are only for unsaved editor rows.
          family_member_ids: member.family_member_ids as string[] | null | undefined,
        });
        const names = familyMemberDisplayNames(member);
        const uids = member.family_member_user_ids || [];
        return names.map((name, i) => ({
          id: ids[i], name, uid: (uids[i] as string | null) || null,
        }));
      })()
    : [];
  const roleOfUid = (uid: string): 'owner' | 'admin' | null => {
    const r = roleOf({ ...trip, admin_ids: adminIds }, uid);
    return r === 'owner' || r === 'admin' ? r : null;
  };

  // Removal (settled-only). The owner row is never removable; otherwise an admin may remove any
  // settled member. Settled-ness comes from the balance engine (read-only); the backend re-checks.
  const viewerCanRemove = canRemoveMemberRow({ ...trip, admin_ids: adminIds }, member, user?.id);
  const entityNet = balances ? (balances.net[member.id] ?? 0) : 0;
  const famRows: FamRow[] = balances
    ? (balances.per_person.find((p) => p.member_id === member.id)?.members ?? [])
    : [];
  const blockReason = balances ? entityBlockReason(member, entityNet, famRows) : null;
  const removable = !!balances && entityRemovable(member, entityNet, famRows);

  const toggleAdmin = async (uid: string | null | undefined, currentlyAdmin: boolean) => {
    if (!uid) return;
    setBusy(true); setError(null);
    try {
      if (currentlyAdmin) {
        await api(`/trips/${id}/admins/${uid}`, { method: 'DELETE' });
        setAdminIds((prev) => prev.filter((u) => u !== uid));
        toast.show('Admin removed', 'success');
      } else {
        await api(`/trips/${id}/admins`, { method: 'POST', body: { user_id: uid } });
        setAdminIds((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
        toast.show('Admin added', 'success');
      }
    } catch (e: any) { setError(e.message); toast.show(e.message || 'Could not update role', 'error'); }
    finally { setBusy(false); }
  };

  const doTransfer = async (uid: string) => {
    setConfirmTransfer(null);
    setBusy(true); setError(null);
    try {
      await api(`/trips/${id}/transfer-ownership`, { method: 'POST', body: { user_id: uid } });
      toast.show('Ownership transferred', 'success');
      router.back(); // roster reloads via useFocusEffect; viewer is now a plain admin
      return;
    } catch (e: any) {
      setError(e.message); toast.show(e.message || 'Could not transfer ownership', 'error');
      setBusy(false);
    }
  };

  const doRemoveEntity = async () => {
    setConfirm(null);
    setBusy(true); setError(null);
    try {
      await api(`/trips/${id}/members/${member.id}`, { method: 'DELETE' });
      toast.show(member.kind === 'family' ? 'Family removed' : 'Member removed', 'success');
      router.back();
    } catch (e: any) {
      setError(e.message); toast.show(e.message || 'Could not remove', 'error'); setBusy(false);
    }
  };

  const doRemoveFamilyMember = async (fmId: string) => {
    setConfirm(null);
    setBusy(true); setError(null);
    try {
      await api(`/trips/${id}/members/${member.id}/family-members/${fmId}`, { method: 'DELETE' });
      toast.show('Member removed from family', 'success');
      await load(); // family stays — refresh roster + balances in place
    } catch (e: any) { setError(e.message); toast.show(e.message || 'Could not remove', 'error'); }
    finally { setBusy(false); }
  };

  const askRemoveEntity = () => setConfirm({
    title: member.kind === 'family'
      ? `Remove ${memberLabel} (family of ${member.family_members.length})?`
      : `Remove ${memberLabel}?`,
    message: 'Removes them from the trip. Past expenses are kept and balances stay unchanged.',
    yesId: 'mm-remove-entity-confirm',
    onYes: doRemoveEntity,
  });

  const askRemoveFamilyMember = (row: FamRow) => setConfirm({
    title: `Remove ${row.name}?`,
    message: 'Removes this member from the family. Past expenses are kept.',
    yesId: 'mm-remove-fm-confirm',
    onYes: () => doRemoveFamilyMember(row.id),
  });

  return (
    <Screen edges={['bottom']}>
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
          <T variant="h1">{memberLabel}{member.kind === 'family' ? ` (${member.family_members.length})` : ''}</T>
          {role === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
          {role === 'admin' ? <Badge label="Admin" color={colors.success} /> : null}
        </View>
        <T muted style={{ marginTop: 4 }}>
          {member.kind === 'family' ? `Family of ${member.family_members.length}` : (member.user_id ? 'App user' : 'Individual')}
          {member.email ? ` · ${member.email}` : ''}
        </T>
      </View>

      {member.kind === 'family' ? (
        // Phase 27: admin is per-PERSON. List each family member; a linked slot can hold owner/admin,
        // an unlinked one cannot become admin until its account is linked (via join/claim).
        <Card>
          <T variant="label" muted>Trip roles</T>
          <T variant="caption" muted style={{ marginTop: SPACING.sm }}>
            Admin is held by a specific person, not the whole family. Promote a linked family member to
            let them add and change members and expenses.
          </T>
          {subMembers.map((sm, i) => {
            const smRole = sm.uid ? roleOfUid(sm.uid) : null;
            const isSmOwner = smRole === 'owner';
            const isSmAdmin = smRole === 'admin';
            return (
              <View
                key={sm.id ?? i}
                testID={`mm-subrole-${sm.id ?? i}`}
                style={{ marginTop: SPACING.md, paddingTop: SPACING.md, borderTopWidth: 1, borderTopColor: colors.border, gap: SPACING.sm }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                  <T style={{ flexShrink: 1, minWidth: 0 }} numberOfLines={1}>{sm.name}</T>
                  {isSmOwner ? <Badge label="Owner" color={colors.primary} /> : null}
                  {isSmAdmin ? <Badge label="Admin" color={colors.success} /> : null}
                </View>
                {!sm.uid ? (
                  <T variant="caption" muted>
                    Not linked to an account yet — they can become admin after they join and link their account.
                  </T>
                ) : isSmOwner ? (
                  <T variant="caption" muted>Owner · root admin (cannot be removed).</T>
                ) : !viewerIsOwner ? (
                  <T variant="caption" muted>Only the trip owner can change admin roles.</T>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
                    <Button
                      testID={`mm-admin-${sm.id ?? i}`}
                      label={isSmAdmin ? 'Remove admin' : 'Make admin'}
                      icon={isSmAdmin ? 'close' : 'shield'}
                      variant={isSmAdmin ? 'destructive' : 'primary'}
                      size="sm"
                      onPress={() => toggleAdmin(sm.uid, isSmAdmin)}
                      loading={busy}
                    />
                    <Button
                      testID={`mm-transfer-${sm.id ?? i}`}
                      label="Make owner"
                      icon="arrow-left-right"
                      variant="secondary"
                      size="sm"
                      onPress={() => setConfirmTransfer({ uid: sm.uid as string, name: sm.name })}
                      loading={busy}
                    />
                  </View>
                )}
              </View>
            );
          })}
        </Card>
      ) : (
      <Card>
        <T variant="label" muted>Trip role</T>
        {!member.user_id ? (
          <T variant="caption" muted style={{ marginTop: SPACING.sm }}>
            Only app users who have joined this trip can become admins.
          </T>
        ) : isOwner ? (
          <View style={{ marginTop: SPACING.sm, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
            <Icon name="shield-check" size={18} color={colors.primary} />
            <T>Owner · root admin (cannot be removed)</T>
          </View>
        ) : !viewerIsOwner ? (
          <T testID="mm-admin-owner-note" variant="caption" muted style={{ marginTop: SPACING.sm }}>
            Only the trip owner can change admin roles.
          </T>
        ) : (
          <>
            <T variant="caption" muted style={{ marginTop: SPACING.sm, marginBottom: SPACING.sm }}>
              {isMemberAdmin
                ? 'Admins can add and change members and expenses on this trip.'
                : 'Promote to let this member add and change members and expenses.'}
            </T>
            <Button
              testID={isMemberAdmin ? 'mm-remove-admin' : 'mm-make-admin'}
              label={isMemberAdmin ? 'Remove admin' : 'Make admin'}
              icon={isMemberAdmin ? 'close' : 'shield'}
              variant={isMemberAdmin ? 'destructive' : 'primary'}
              onPress={() => toggleAdmin(member.user_id, isMemberAdmin)}
              loading={busy}
              fullWidth
            />
          </>
        )}

        {canTransferToMember ? (
          <View style={{ marginTop: SPACING.md }}>
            <T variant="caption" muted style={{ marginBottom: SPACING.sm }}>
              Hand over ownership of this trip. You will remain an admin.
            </T>
            <Button
              testID="mm-transfer-ownership"
              label="Transfer ownership"
              icon="arrow-left-right"
              variant="secondary"
              onPress={() => member.user_id && setConfirmTransfer({ uid: member.user_id, name: memberLabel })}
              loading={busy}
              fullWidth
            />
          </View>
        ) : null}
      </Card>
      )}

      <Card>
        <T variant="label" muted>Member configuration</T>
        <T variant="caption" muted style={{ marginTop: SPACING.sm, marginBottom: SPACING.sm }}>
          Update the name{member.kind === 'family' ? ' or family roster (each member can have their own email)' : ', linked email, or member kind'}.
        </T>
        <Button
          testID="mm-edit-details"
          label="Edit member & family details"
          icon="pencil"
          variant="secondary"
          onPress={() => router.push({ pathname: '/trip/[id]/edit-member', params: { id: id as string, mid: mid as string } })}
          fullWidth
        />
      </Card>

      {viewerCanRemove ? (
        <Card>
          <T variant="label" muted>Remove from trip</T>

          {member.kind === 'family' ? (
            <View style={{ marginTop: SPACING.sm, gap: SPACING.xs }}>
              <T variant="caption" muted>Family members</T>
              {!balances ? (
                <T variant="caption" muted>Loading balances…</T>
              ) : (
                famRows.map((row) => {
                  const settled = isSettled(row.net);
                  const disabled = busy || isLastFamilyMember(member) || !settled;
                  return (
                    <View key={row.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T numberOfLines={1}>↳ {row.name}</T>
                        <T variant="caption" color={settled ? colors.textMuted : colors.danger}>
                          {settled ? 'Settled' : `${formatMoney(row.net, { signed: true })} · settle up first`}
                        </T>
                      </View>
                      <IconButton
                        name="trash"
                        color={colors.danger}
                        disabled={disabled}
                        onPress={() => askRemoveFamilyMember(row)}
                        accessibilityLabel={`Remove ${row.name} from family`}
                        testID={`mm-remove-fm-${row.id}`}
                        size={18}
                      />
                    </View>
                  );
                })
              )}
              {isLastFamilyMember(member) ? (
                <T testID="mm-last-member-note" variant="caption" muted style={{ marginTop: SPACING.xs }}>
                  To remove the last member, remove the whole family below.
                </T>
              ) : null}
            </View>
          ) : null}

          {blockReason ? (
            <T testID="mm-remove-blocked" variant="caption" muted style={{ marginTop: SPACING.sm }}>
              {blockReason}
            </T>
          ) : (
            <T variant="caption" muted style={{ marginTop: SPACING.sm, marginBottom: SPACING.xs }}>
              Past expenses are kept; balances stay unchanged.
            </T>
          )}
          <Button
            testID="mm-remove-entity"
            label={entityRemoveLabel(member)}
            icon="trash"
            variant="destructive"
            disabled={busy || !removable}
            onPress={askRemoveEntity}
            fullWidth
            style={{ marginTop: SPACING.sm }}
          />
        </Card>
      ) : null}

      {error ? <T testID="mm-error" variant="caption" color={colors.danger}>{error}</T> : null}

      <ConfirmModal
        visible={!!confirmTransfer}
        testID="mm-transfer-modal"
        title={`Make ${confirmTransfer?.name ?? memberLabel} the owner?`}
        message="You will become an admin. Only the owner can manage admins and delete the trip."
        onRequestClose={() => setConfirmTransfer(null)}
        actions={[
          { label: 'Transfer', variant: 'primary', testID: 'mm-transfer-confirm', onPress: () => confirmTransfer && doTransfer(confirmTransfer.uid) },
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirmTransfer(null) },
        ]}
      />

      <ConfirmModal
        visible={!!confirm}
        testID="mm-remove-modal"
        title={confirm?.title || ''}
        message={confirm?.message}
        onRequestClose={() => setConfirm(null)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirm(null) },
          { label: 'Remove', variant: 'destructive', onPress: () => confirm?.onYes(), testID: confirm?.yesId },
        ]}
      />
    </Screen>
  );
}
