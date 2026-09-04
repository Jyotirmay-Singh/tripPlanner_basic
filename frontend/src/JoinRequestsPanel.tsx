import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  approveJoinRequest,
  listJoinRequests,
  rejectJoinRequest,
} from './api';
import ConfirmModal from './ConfirmModal';
import T from './T';
import { useTheme } from './ThemeContext';
import { FONTS, RADIUS, SPACING } from './theme';
import type { JoinRequestView } from './joinIdentity';
import { Button, Card, Icon, Input } from './ui';


type Props = {
  tripId: string;
  onRosterChanged: () => void | Promise<void>;
};

export default function JoinRequestsPanel({ tripId, onRosterChanged }: Props) {
  const { colors } = useTheme();
  const [requests, setRequests] = useState<JoinRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveCandidate, setApproveCandidate] = useState<JoinRequestView | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      setRequests(await listJoinRequests(tripId));
    } catch (requestError: any) {
      setError(requestError.message || 'Could not load join requests');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { void load(); }, [load]);

  const approve = async () => {
    if (!approveCandidate) return;
    const request = approveCandidate;
    setApproveCandidate(null);
    setBusyId(request.id);
    setError(null);
    try {
      await approveJoinRequest(tripId, request.id);
      await Promise.all([load(), Promise.resolve(onRosterChanged())]);
    } catch (requestError: any) {
      setError(requestError.message || 'Could not approve this request');
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (requestId: string) => {
    setBusyId(requestId);
    setError(null);
    try {
      await rejectJoinRequest(tripId, requestId, reason);
      setRejectingId(null);
      setReason('');
      await load();
    } catch (requestError: any) {
      setError(requestError.message || 'Could not reject this request');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <T testID="join-requests-loading" variant="caption" muted>Checking for join requests…</T>;
  }

  if (requests.length === 0 && !error) return null;

  return (
    <Card testID="join-requests-panel" style={styles.panel}>
      <View style={styles.headingRow}>
        <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
          <Icon name="user" size={18} color={colors.primary} />
        </View>
        <View style={styles.flex}>
          <T variant="h4">Pending join requests</T>
          <T variant="caption" muted>
            {requests.length} {requests.length === 1 ? 'person needs' : 'people need'} review
          </T>
        </View>
      </View>

      {error ? <T testID="join-requests-error" variant="caption" color={colors.danger}>{error}</T> : null}

      {requests.map((request) => {
        const isRejecting = rejectingId === request.id;
        const familyContext = request.target.kind === 'family_member'
          ? ` in ${request.target.family_name}` : '';
        return (
          <View
            key={request.id}
            testID={`join-request-${request.id}`}
            style={[styles.request, { borderTopColor: colors.border }]}
          >
            <View style={styles.requestCopy}>
              <T style={styles.flex}>
                <T style={{ fontFamily: FONTS.bodySemibold }}>{request.requester?.name}</T>
                {' wants to join as '}
                <T style={{ fontFamily: FONTS.bodySemibold }}>{request.target.name}</T>
                {familyContext}
              </T>
              <T variant="caption" muted numberOfLines={1}>{request.requester?.email}</T>
              <T variant="caption" muted>
                {request.email_relation === 'different'
                  ? 'Approving replaces the saved email for this person.'
                  : 'This person does not have a saved email yet.'}
              </T>
            </View>

            {isRejecting ? (
              <View style={styles.rejectForm}>
                <Input
                  testID={`join-request-reason-${request.id}`}
                  label="Reason (optional)"
                  value={reason}
                  onChangeText={(value) => setReason(value.slice(0, 500))}
                  placeholder="Tell them what to check"
                  editable={busyId !== request.id}
                  maxLength={500}
                />
                <View style={styles.actions}>
                  <Button
                    label="Cancel"
                    variant="ghost"
                    size="sm"
                    onPress={() => { setRejectingId(null); setReason(''); }}
                    disabled={busyId === request.id}
                  />
                  <Button
                    label="Reject request"
                    variant="destructive"
                    size="sm"
                    testID={`join-request-reject-confirm-${request.id}`}
                    onPress={() => { void reject(request.id); }}
                    loading={busyId === request.id}
                  />
                </View>
              </View>
            ) : (
              <View style={styles.actions}>
                <Button
                  label="Reject"
                  variant="secondary"
                  size="sm"
                  testID={`join-request-reject-${request.id}`}
                  onPress={() => { setRejectingId(request.id); setReason(''); }}
                  disabled={busyId !== null}
                />
                <Button
                  label="Approve"
                  size="sm"
                  testID={`join-request-approve-${request.id}`}
                  onPress={() => setApproveCandidate(request)}
                  loading={busyId === request.id}
                  disabled={busyId !== null && busyId !== request.id}
                />
              </View>
            )}
          </View>
        );
      })}

      <ConfirmModal
        visible={approveCandidate !== null}
        testID="join-request-approve-modal"
        title="Approve this identity?"
        message={approveCandidate
          ? `${approveCandidate.requester?.name} will join as ${approveCandidate.target.name}. ${
            approveCandidate.email_relation === 'different'
              ? 'Their Gmail will replace the email currently saved for this person.'
              : 'Their Gmail will be attached to this person.'
          }`
          : undefined}
        onRequestClose={() => setApproveCandidate(null)}
        actions={[
          { label: 'Approve request', variant: 'primary', testID: 'join-request-approve-confirm', onPress: () => { void approve(); } },
          { label: 'Cancel', variant: 'cancel', onPress: () => setApproveCandidate(null) },
        ]}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  panel: { gap: SPACING.md, borderRadius: RADIUS.lg },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  request: { borderTopWidth: 1, paddingTop: SPACING.md, gap: SPACING.md },
  requestCopy: { gap: SPACING.xs },
  rejectForm: { gap: SPACING.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.sm, flexWrap: 'wrap' },
});
