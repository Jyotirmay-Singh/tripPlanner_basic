import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  cancelJoinRequest,
  getJoinRequest,
  joinTrip,
  previewJoin,
  requestExistingPerson,
} from '../src/api';
import Badge from '../src/Badge';
import ConfirmModal from '../src/ConfirmModal';
import {
  buildClaimBody,
  buildJoinNewBody,
  buildJoinRequestBody,
  type ExistingPerson,
  type JoinMatch,
  type JoinRequestView,
  mustClaim,
  replacementNeeded,
  replacementNote,
} from '../src/joinIdentity';
import T from '../src/T';
import { useTheme } from '../src/ThemeContext';
import {
  COMPONENT_SIZE,
  FONTS,
  RADIUS,
  SPACING,
  TYPESCALE,
} from '../src/theme';
import { Button, FormScreen, Icon, Input } from '../src/ui';
import type { IconName } from '../src/ui/Icon';


type Stage = 'code' | 'exact' | 'roster' | 'pending' | 'new';
type NewMode = 'individual' | 'new_family';

type Preview = {
  trip: {
    id: string;
    name: string;
    code: string;
    start_date?: string | null;
    end_date?: string | null;
    currency?: string | null;
    member_count: number;
  };
  already_member: boolean;
  existing_people: ExistingPerson[];
  match?: JoinMatch | null;
  active_request?: JoinRequestView | null;
};

type PersonRowProps = {
  person: ExistingPerson;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
};

const personKey = (person: Pick<ExistingPerson, 'member_id' | 'family_member_id'>) =>
  `${person.member_id}:${person.family_member_id ?? ''}`;

const sameRequestTarget = (request: JoinRequestView, person: ExistingPerson) =>
  request.target.member_id === person.member_id
  && (request.target.family_member_id ?? null) === (person.family_member_id ?? null);

function ExistingPersonRow({ person, selected, disabled, onPress }: PersonRowProps) {
  const { colors } = useTheme();
  const familyContext = person.kind === 'family_member'
    ? `Member of ${person.family_name}`
    : 'Individual';

  return (
    <TouchableOpacity
      testID={`jt-person-${personKey(person)}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={`${person.name}, ${familyContext}`}
      accessibilityState={{ selected, disabled }}
      style={[
        styles.personRow,
        {
          backgroundColor: selected ? colors.surfaceMuted : colors.surface,
          borderColor: selected ? colors.primary : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <View style={[styles.personIcon, { backgroundColor: colors.surfaceMuted }]}>
        <Icon
          name={person.kind === 'family_member' ? 'users' : 'user'}
          size={18}
          color={colors.primary}
        />
      </View>
      <View style={styles.flex}>
        <T style={styles.personName}>{person.name}</T>
        <T variant="caption" muted numberOfLines={1}>{familyContext}</T>
      </View>
      <Icon
        name={selected ? 'radio-on' : 'radio-off'}
        size={20}
        color={selected ? colors.primary : colors.textMuted}
      />
    </TouchableOpacity>
  );
}

const NEW_OPTIONS: {
  mode: NewMode;
  icon: IconName;
  title: string;
  description: string;
}[] = [
  {
    mode: 'individual',
    icon: 'user',
    title: 'New individual',
    description: 'Create a separate profile using your account name.',
  },
  {
    mode: 'new_family',
    icon: 'users',
    title: 'New family',
    description: 'Create a family and list yourself first.',
  },
];

export default function JoinTrip() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ requestId?: string | string[] }>();
  const requestId = Array.isArray(params.requestId) ? params.requestId[0] : params.requestId;

  const [stage, setStage] = useState<Stage>('code');
  const [returnStage, setReturnStage] = useState<Exclude<Stage, 'new'>>('code');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<ExistingPerson | null>(null);
  const [joinRequest, setJoinRequest] = useState<JoinRequestView | null>(null);
  const [newMode, setNewMode] = useState<NewMode>('individual');
  const [familyName, setFamilyName] = useState('');
  const [familyText, setFamilyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBody, setPendingBody] = useState<Record<string, unknown> | null>(null);

  const match = preview?.match ?? null;
  const cleanCode = code.toUpperCase().trim();
  const parsedFamilyMembers = familyText.split(',').map((name) => name.trim()).filter(Boolean);
  const individuals = (preview?.existing_people ?? []).filter((person) => person.kind === 'individual');
  const familyMembers = (preview?.existing_people ?? []).filter(
    (person) => person.kind === 'family_member',
  );

  const goToTrip = useCallback((tripId: string) => {
    router.replace(`/trip/${tripId}`);
  }, [router]);

  const applyPreview = useCallback((next: Preview) => {
    if (next.already_member) {
      goToTrip(next.trip.id);
      return;
    }
    setPreview(next);
    setCode(next.trip.code);
    setSelectedPerson(null);
    if (next.active_request) {
      setJoinRequest(next.active_request);
      setStage('pending');
    } else if (next.match) {
      setStage('exact');
    } else if (next.existing_people.length > 0) {
      setStage('roster');
    } else {
      setReturnStage('code');
      setStage('new');
    }
  }, [goToTrip]);

  const loadPreview = useCallback(async (tripCode = cleanCode) => {
    if (tripCode.length !== 6) {
      setError('Trip code is 6 characters');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applyPreview(await previewJoin<Preview>(tripCode));
    } catch (requestError: any) {
      setError(requestError.message || 'Could not find this trip');
    } finally {
      setBusy(false);
    }
  }, [applyPreview, cleanCode]);

  useEffect(() => {
    if (!requestId) return;
    let cancelled = false;
    setStage('pending');
    setBusy(true);
    setError(null);
    getJoinRequest(requestId)
      .then((request) => {
        if (cancelled) return;
        setJoinRequest(request);
        setCode(request.trip.code);
        if (request.status === 'approved') goToTrip(request.trip.id);
      })
      .catch((requestError: any) => {
        if (!cancelled) setError(requestError.message || 'Could not load this join request');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [goToTrip, requestId]);

  useEffect(() => {
    if (stage !== 'pending' || !joinRequest || joinRequest.status !== 'pending') return undefined;
    let cancelled = false;
    let checking = false;
    const poll = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await getJoinRequest(joinRequest.id);
        if (cancelled) return;
        setJoinRequest(next);
        if (next.status === 'approved') goToTrip(next.trip.id);
      } catch {
        // Keep the durable status screen usable while offline; the next interval retries.
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => { void poll(); }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [goToTrip, joinRequest, stage]);

  const backToCode = () => {
    setStage('code');
    setPreview(null);
    setSelectedPerson(null);
    setJoinRequest(null);
    setFamilyName('');
    setFamilyText('');
    setError(null);
  };

  const openNew = (from: Exclude<Stage, 'new'>) => {
    setReturnStage(from);
    setNewMode('individual');
    setError(null);
    setStage('new');
  };

  const doClaim = async () => {
    if (!match) return;
    setBusy(true);
    setError(null);
    try {
      const trip = await joinTrip<{ id: string }>(buildClaimBody(cleanCode, match));
      goToTrip(trip.id);
    } catch (requestError: any) {
      setError(requestError.message || 'Could not link this profile');
    } finally {
      setBusy(false);
    }
  };

  const requestSelectedPerson = async () => {
    if (!selectedPerson) {
      setError('Choose the person you want to join as');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const request = await requestExistingPerson(
        buildJoinRequestBody(cleanCode, selectedPerson),
      );
      setJoinRequest(request);
      setStage('pending');
    } catch (requestError: any) {
      setError(requestError.message || 'Could not send this join request');
      if (requestError.detailCode === 'direct_claim_available') {
        await loadPreview(cleanCode);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelPending = async () => {
    if (!joinRequest) return;
    setBusy(true);
    setError(null);
    try {
      setJoinRequest(await cancelJoinRequest(joinRequest.id));
    } catch (requestError: any) {
      setError(requestError.message || 'Could not cancel this request');
    } finally {
      setBusy(false);
    }
  };

  const chooseAgain = async () => {
    const requestCode = joinRequest?.trip.code || cleanCode;
    await loadPreview(requestCode);
  };

  const doJoinNew = async (body: Record<string, unknown>) => {
    setPendingBody(null);
    setBusy(true);
    setError(null);
    try {
      const trip = await joinTrip<{ id: string }>(body);
      goToTrip(trip.id);
    } catch (requestError: any) {
      setError(requestError.message || 'Could not join this trip');
    } finally {
      setBusy(false);
    }
  };

  const submitNew = () => {
    let body: Record<string, unknown>;
    if (newMode === 'individual') {
      body = buildJoinNewBody(cleanCode, 'individual', {}, match);
    } else {
      const name = familyName.trim();
      if (!name) {
        setError('Family name is required');
        return;
      }
      if (parsedFamilyMembers.length === 0) {
        setError('Add at least one family member name');
        return;
      }
      body = buildJoinNewBody(cleanCode, 'new_family', {
        family_name: name,
        family_members: parsedFamilyMembers,
      }, match);
    }
    if (replacementNeeded(match, 'join_new')) setPendingBody(body);
    else void doJoinNew(body);
  };

  if (stage === 'code') {
    return (
      <FormScreen testID="join-trip-code-screen">
        <View style={[styles.brand, { backgroundColor: colors.primary }]}>
          <Icon name="key" size={26} color={colors.primaryText} strokeWidth={2} />
        </View>
        <T variant="h1" style={styles.titleTop}>Join a trip</T>
        <T muted>Enter the 6-character code shared by the trip organizer.</T>
        <TextInput
          testID="jt-code"
          value={code}
          onChangeText={(value) => {
            setCode(value.toUpperCase().replace(/\s/g, '').slice(0, 6));
            if (error) setError(null);
          }}
          placeholder="ABCD12"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!busy}
          accessibilityLabel="Trip code"
          style={[
            styles.codeInput,
            {
              color: colors.textMain,
              backgroundColor: colors.surfaceMuted,
              borderColor: error ? colors.danger : colors.border,
            },
          ]}
        />
        {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
        <Button
          label="Continue"
          iconRight="chevron-right"
          onPress={() => { void loadPreview(); }}
          loading={busy}
          disabled={code.length !== 6}
          fullWidth
          size="lg"
          testID="jt-submit"
        />
      </FormScreen>
    );
  }

  if (stage === 'exact' && match) {
    const claimOnly = mustClaim(match);
    const location = match.member_type === 'family_member'
      ? `${match.member_name} in ${match.family_name}`
      : match.member_name;
    return (
      <FormScreen testID="join-trip-exact-screen">
        <TouchableOpacity
          testID="jt-back"
          onPress={backToCode}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Back to trip code"
          style={styles.back}
        >
          <Icon name="chevron-left" size={18} color={colors.textMuted} />
          <T muted>Back</T>
        </TouchableOpacity>

        <View style={styles.headingBlock}>
          <Badge label="Gmail match" color={colors.success} />
          <T variant="h1">We found your place</T>
          <T muted testID="jt-identity-summary">
            Your Gmail matches {location} on {preview?.trip.name}.
          </T>
        </View>

        <View style={[styles.matchCard, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
          <View style={[styles.matchIcon, { backgroundColor: colors.surfaceMuted }]}>
            <Icon name={match.member_type === 'family_member' ? 'users' : 'user'} color={colors.primary} />
          </View>
          <View style={styles.flex}>
            <T variant="h3">{match.member_name}</T>
            <T variant="caption" muted>
              {match.member_type === 'family_member' ? `Member of ${match.family_name}` : 'Individual'}
            </T>
          </View>
        </View>

        {claimOnly ? (
          <View style={[styles.noteCard, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
            <Icon name="info" size={18} color={colors.textMuted} />
            <T variant="caption" muted style={styles.noteCopy}>
              This identity has trip history and cannot be safely replaced. If it is incorrect,
              ask a trip admin to update the roster.
            </T>
          </View>
        ) : null}
        {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
        <Button
          label={`Join as ${match.member_name}`}
          icon="check"
          onPress={() => { void doClaim(); }}
          loading={busy}
          fullWidth
          size="lg"
          testID="jt-identity-claim"
        />
        {!claimOnly ? (
          <Button
            label="This isn't me"
            variant="secondary"
            onPress={() => openNew('exact')}
            disabled={busy}
            fullWidth
            testID="jt-identity-new"
          />
        ) : null}
      </FormScreen>
    );
  }

  if (stage === 'roster') {
    const retryBlocked = selectedPerson && joinRequest?.status === 'rejected'
      && joinRequest.retry_after
      && sameRequestTarget(joinRequest, selectedPerson)
      && new Date(joinRequest.retry_after).getTime() > Date.now();
    return (
      <FormScreen testID="join-trip-roster-screen">
        <TouchableOpacity
          testID="jt-back"
          onPress={backToCode}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Back to trip code"
          style={styles.back}
        >
          <Icon name="chevron-left" size={18} color={colors.textMuted} />
          <T muted>Back</T>
        </TouchableOpacity>

        <View style={styles.headingBlock}>
          <T variant="h1">Are you already listed?</T>
          <T muted>
            Choose your name on {preview?.trip.name}. An owner or admin will confirm it before
            you get access.
          </T>
        </View>

        {individuals.length > 0 ? (
          <View style={styles.section} testID="jt-existing-individuals">
            <T variant="h3">Individuals</T>
            {individuals.map((person) => (
              <ExistingPersonRow
                key={personKey(person)}
                person={person}
                selected={selectedPerson ? personKey(selectedPerson) === personKey(person) : false}
                disabled={busy}
                onPress={() => { setSelectedPerson(person); setError(null); }}
              />
            ))}
          </View>
        ) : null}

        {familyMembers.length > 0 ? (
          <View style={styles.section} testID="jt-existing-family-members">
            <View style={styles.sectionHeading}>
              <T variant="h3">Family members</T>
              <T variant="caption" muted>Choose your name inside the family.</T>
            </View>
            {familyMembers.map((person) => (
              <ExistingPersonRow
                key={personKey(person)}
                person={person}
                selected={selectedPerson ? personKey(selectedPerson) === personKey(person) : false}
                disabled={busy}
                onPress={() => { setSelectedPerson(person); setError(null); }}
              />
            ))}
          </View>
        ) : null}

        {retryBlocked ? (
          <View style={[styles.noteCard, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
            <Icon name="clock" size={18} color={colors.textMuted} />
            <T variant="caption" muted style={styles.noteCopy}>
              You can request this person again after {new Date(joinRequest!.retry_after!).toLocaleString()}.
            </T>
          </View>
        ) : null}
        {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
        <Button
          label={selectedPerson ? `Ask to join as ${selectedPerson.name}` : 'Choose your name'}
          icon="check"
          onPress={() => { void requestSelectedPerson(); }}
          loading={busy}
          disabled={!selectedPerson || Boolean(retryBlocked)}
          fullWidth
          size="lg"
          testID="jt-request-existing"
        />
        <Button
          label="None of these is me"
          variant="secondary"
          onPress={() => openNew('roster')}
          disabled={busy}
          fullWidth
          testID="jt-none-existing"
        />
      </FormScreen>
    );
  }

  if (stage === 'pending') {
    const status = joinRequest?.status;
    const statusConfig: Record<NonNullable<typeof status>, {
      title: string;
      description: string;
      icon: IconName;
      color: string;
    }> = {
      pending: {
        title: 'Waiting for approval',
        description: 'A trip owner or admin needs to confirm that this is you. You do not have trip access yet.',
        icon: 'clock',
        color: colors.warning,
      },
      approved: {
        title: 'Request approved',
        description: 'Your account is now linked. Opening the trip…',
        icon: 'check-circle',
        color: colors.success,
      },
      rejected: {
        title: 'Request not approved',
        description: 'You can choose another person or join with a new profile.',
        icon: 'alert',
        color: colors.danger,
      },
      cancelled: {
        title: 'Request cancelled',
        description: 'Choose another person or create a new profile when you are ready.',
        icon: 'info',
        color: colors.textMuted,
      },
      obsolete: {
        title: 'Request no longer available',
        description: 'The trip roster changed. Check the current list before trying again.',
        icon: 'info',
        color: colors.textMuted,
      },
    };
    const presentation = status ? statusConfig[status] : null;
    const targetContext = joinRequest?.target.kind === 'family_member'
      ? ` in ${joinRequest.target.family_name}` : '';

    return (
      <FormScreen testID="join-trip-request-screen">
        <TouchableOpacity
          testID="jt-back"
          onPress={backToCode}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Back to trip code"
          style={styles.back}
        >
          <Icon name="chevron-left" size={18} color={colors.textMuted} />
          <T muted>Back</T>
        </TouchableOpacity>

        {presentation ? (
          <>
            <View style={[styles.statusIcon, { backgroundColor: colors.surfaceMuted }]}>
              <Icon name={presentation.icon} size={28} color={presentation.color} />
            </View>
            <View style={styles.headingBlock} testID="jt-request-status">
              <T variant="h1">{presentation.title}</T>
              <T muted>{presentation.description}</T>
            </View>
            <View style={[styles.requestSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <T variant="caption" muted>{joinRequest!.trip.name}</T>
              <T variant="h3">
                {joinRequest!.target.name}{targetContext}
              </T>
            </View>
            {status === 'rejected' && joinRequest?.rejection_reason ? (
              <View style={[styles.noteCard, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
                <Icon name="info" size={18} color={colors.textMuted} />
                <T variant="caption" muted style={styles.noteCopy}>
                  Admin note: {joinRequest.rejection_reason}
                </T>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.headingBlock}>
            <T variant="h1">Checking your request</T>
            <T muted>Loading the latest status…</T>
          </View>
        )}

        {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
        {status === 'pending' ? (
          <>
            <Button
              label="Cancel request"
              variant="secondary"
              onPress={() => { void cancelPending(); }}
              loading={busy}
              fullWidth
              testID="jt-request-cancel"
            />
            <Button
              label="Join as someone new instead"
              variant="ghost"
              onPress={() => openNew('pending')}
              disabled={busy}
              fullWidth
              testID="jt-request-new"
            />
          </>
        ) : null}
        {status && status !== 'pending' && status !== 'approved' ? (
          <>
            <Button
              label="Check the roster again"
              onPress={() => { void chooseAgain(); }}
              loading={busy}
              fullWidth
              testID="jt-request-choose-again"
            />
            <Button
              label="Join as someone new"
              variant="secondary"
              onPress={() => openNew('pending')}
              disabled={busy}
              fullWidth
              testID="jt-request-new"
            />
          </>
        ) : null}
      </FormScreen>
    );
  }

  const replacementCopy = match && replacementNeeded(match, 'join_new')
    ? (match.member_type === 'family_member'
      ? `Creating a new profile will remove your Gmail from ${match.member_name}, but keep that family member and their trip history.`
      : `Creating a new profile will remove the unused ${match.member_name} profile.`)
    : joinRequest?.status === 'pending'
      ? 'Creating a new profile will cancel your pending request.'
      : null;
  const newDisabled = busy || (
    newMode === 'new_family' && (!familyName.trim() || parsedFamilyMembers.length === 0)
  );

  return (
    <>
      <FormScreen testID="join-trip-new-screen">
        <TouchableOpacity
          testID="jt-back"
          onPress={() => { setError(null); setStage(returnStage); }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.back}
        >
          <Icon name="chevron-left" size={18} color={colors.textMuted} />
          <T muted>Back</T>
        </TouchableOpacity>

        <View style={styles.headingBlock}>
          <T variant="h1">Join as someone new</T>
          <T muted>Create a new place on {preview?.trip.name || joinRequest?.trip.name}.</T>
        </View>

        <View style={styles.section} accessibilityRole="radiogroup">
          {NEW_OPTIONS.map((option) => {
            const selected = newMode === option.mode;
            return (
              <TouchableOpacity
                key={option.mode}
                testID={`jt-mode-${option.mode}`}
                onPress={() => { setNewMode(option.mode); setError(null); }}
                disabled={busy}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: busy }}
                style={[
                  styles.modeCard,
                  {
                    backgroundColor: selected ? colors.primary : colors.surface,
                    borderColor: selected ? colors.primary : colors.border,
                  },
                ]}
              >
                <Icon
                  name={option.icon}
                  size={22}
                  color={selected ? colors.primaryText : colors.primary}
                />
                <View style={styles.flex}>
                  <T variant="h4" color={selected ? colors.primaryText : colors.textMain}>
                    {option.title}
                  </T>
                  <T
                    variant="caption"
                    color={selected ? colors.primaryText : colors.textMuted}
                    style={selected ? styles.selectedDescription : undefined}
                  >
                    {option.description}
                  </T>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {newMode === 'new_family' ? (
          <View style={styles.formFields}>
            <Input
              testID="jt-family-name"
              label="Family name *"
              value={familyName}
              onChangeText={(value) => { setFamilyName(value); if (error) setError(null); }}
              placeholder="e.g. Sharma family"
              editable={!busy}
            />
            <Input
              testID="jt-family-members"
              label="Family member names (comma separated) *"
              value={familyText}
              onChangeText={(value) => { setFamilyText(value); if (error) setError(null); }}
              placeholder="e.g. Arjun, Priya, Rohan"
              editable={!busy}
              helper="Include yourself first. The family's expenses are divided among these people."
            />
          </View>
        ) : null}

        {replacementCopy ? (
          <View style={[styles.noteCard, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
            <Icon name="info" size={18} color={colors.textMuted} />
            <T variant="caption" muted style={styles.noteCopy}>{replacementCopy}</T>
          </View>
        ) : null}
        {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
        <Button
          label="Join trip"
          icon="check"
          onPress={submitNew}
          loading={busy}
          disabled={newDisabled}
          fullWidth
          size="lg"
          testID="jt-join-confirm"
        />
      </FormScreen>

      <ConfirmModal
        visible={pendingBody !== null}
        testID="jt-replace-modal"
        title="Create a new profile?"
        message={match ? replacementNote(match) : undefined}
        onRequestClose={() => setPendingBody(null)}
        actions={[
          {
            label: 'Create new profile',
            variant: 'destructive',
            testID: 'jt-replace-confirm',
            onPress: () => { if (pendingBody) void doJoinNew(pendingBody); },
          },
          {
            label: 'Cancel',
            variant: 'cancel',
            testID: 'jt-replace-cancel',
            onPress: () => setPendingBody(null),
          },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  brand: {
    width: 52,
    height: 52,
    borderRadius: RADIUS.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleTop: { marginTop: SPACING.sm },
  codeInput: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    fontSize: TYPESCALE.xxl,
    letterSpacing: SPACING.sm,
    textAlign: 'center',
    fontFamily: FONTS.numberBold,
  },
  back: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: SPACING.xs,
  },
  headingBlock: { gap: SPACING.sm, alignItems: 'flex-start' },
  section: { gap: SPACING.sm },
  sectionHeading: { gap: SPACING.xs },
  personRow: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    gap: SPACING.md,
  },
  personIcon: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personName: { fontFamily: FONTS.bodySemibold },
  matchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.lg,
    borderRadius: RADIUS.lg,
    borderWidth: 2,
    gap: SPACING.md,
  },
  matchIcon: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeCard: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    gap: SPACING.md,
  },
  selectedDescription: { opacity: 0.82 },
  formFields: { gap: SPACING.md },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    gap: SPACING.sm,
  },
  noteCopy: { flex: 1, minWidth: 0, lineHeight: TYPESCALE.lg },
  statusIcon: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestSummary: {
    padding: SPACING.lg,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    gap: SPACING.xs,
  },
});
