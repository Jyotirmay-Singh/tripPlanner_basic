import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE, isEmailTaken, DUPLICATE_EMAIL_MESSAGE } from '../../../src/validation';
import FamilyMembersEditor from '../../../src/FamilyMembersEditor';
import type { FamilyEditorValidationIssue } from '../../../src/FamilyMembersEditor';
import {
  FamilyRow, rowsToPayload, firstFamilyEmailIssue, tripMemberEmails,
} from '../../../src/familyParticipation';
import { FormScreen, Input, Button, SegmentedControl, useToast } from '../../../src/ui';

export default function AddMember() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'individual' | 'family'>('individual');
  const [familyRows, setFamilyRows] = useState<FamilyRow[]>([{ id: null, name: '' }]);
  const [saving, setSaving] = useState(false);
  // Existing trip linked-emails, to mirror the server's one-email-per-trip rule (UX only).
  const [takenEmails, setTakenEmails] = useState<(string | null | undefined)[]>([]);
  const [nameSubmitError, setNameSubmitError] = useState<string | null>(null);
  const [emailSubmitError, setEmailSubmitError] = useState<string | null>(null);
  const [familyValidationIssue, setFamilyValidationIssue] = useState<FamilyEditorValidationIssue | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const trip: any = await api(`/trips/${id}`);
        setTakenEmails(tripMemberEmails(trip.members || []));
      } catch { /* the server still enforces uniqueness on submit */ }
    })();
  }, [id]);

  const emailError = emailSubmitError || (email.trim() && !isGmail(email)
    ? GMAIL_ONLY_MESSAGE
    : isEmailTaken(email, takenEmails) ? DUPLICATE_EMAIL_MESSAGE : null);

  const submit = async () => {
    if (!name.trim()) {
      setNameSubmitError('Name is required');
      return toast.show('Name is required', 'error');
    }
    const { family_members, family_member_ids, family_member_emails } = kind === 'family'
      ? rowsToPayload(familyRows) : { family_members: [], family_member_ids: [], family_member_emails: [] };
    if (kind === 'family' && family_members.length === 0) {
      setFamilyValidationIssue({
        index: Math.max(0, familyRows.findIndex((row) => !row.name.trim())),
        field: 'name',
        message: 'Add at least one family member name',
      });
      return toast.show('Add at least one family member name', 'error');
    }
    if (kind === 'individual') {
      // Phase 26: only an individual carries a linked email; a family's emails live per-member.
      if (email.trim() && !isGmail(email)) {
        setEmailSubmitError(GMAIL_ONLY_MESSAGE);
        return toast.show(GMAIL_ONLY_MESSAGE, 'error');
      }
      if (isEmailTaken(email, takenEmails)) {
        setEmailSubmitError(DUPLICATE_EMAIL_MESSAGE);
        return toast.show(DUPLICATE_EMAIL_MESSAGE, 'error');
      }
    } else {
      const issue = firstFamilyEmailIssue(familyRows, takenEmails);
      if (issue) {
        const message = issue.kind === 'gmail' ? GMAIL_ONLY_MESSAGE : DUPLICATE_EMAIL_MESSAGE;
        setFamilyValidationIssue({ index: issue.index, field: 'email', message });
        return toast.show(message, 'error');
      }
    }
    setNameSubmitError(null);
    setEmailSubmitError(null);
    setFamilyValidationIssue(null);
    setSaving(true);
    try {
      await api(`/trips/${id}/members`, {
        method: 'POST',
        body: {
          name: name.trim(), kind, family_members, family_member_ids, family_member_emails,
          email: kind === 'individual' ? (email.trim() || null) : null,
        },
      });
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not add member', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <FormScreen>
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">Add member</T>

            <SegmentedControl
              segments={[{ value: 'individual', label: 'Individual', icon: 'user' }, { value: 'family', label: 'Family', icon: 'users' }]}
              value={kind}
              onChange={(value) => {
                setKind(value);
                setNameSubmitError(null);
                setEmailSubmitError(null);
                setFamilyValidationIssue(null);
              }}
              testIDPrefix="mem-kind"
            />

            <Input
              testID="mem-name"
              label={`${kind === 'family' ? 'Family name' : 'Name'} *`}
              value={name}
              onChangeText={(value) => { setName(value); setNameSubmitError(null); }}
              placeholder={kind === 'family' ? 'e.g. Sharma Family' : 'e.g. Priya'}
              autoCapitalize="words"
              returnKeyType="next"
              error={nameSubmitError}
              focusOnError={!!nameSubmitError}
            />

            {kind === 'family' && (
              <FamilyMembersEditor
                rows={familyRows}
                onChange={(rows) => { setFamilyRows(rows); setFamilyValidationIssue(null); }}
                takenEmails={takenEmails}
                testIDPrefix="mem-fam"
                validationIssue={familyValidationIssue}
              />
            )}

            {/* Phase 26: only an individual carries a linked email; a family's emails are per-member. */}
            {kind === 'individual' && (
              <Input
                testID="mem-email"
                label="Linked email (optional)"
                value={email}
                onChangeText={(value) => { setEmail(value); setEmailSubmitError(null); }}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                keyboardType="email-address"
                placeholder="member@gmail.com"
                icon="mail"
                error={emailError}
                focusOnError={!!emailSubmitError}
                helper="If this email belongs to an app user, they'll be linked to this member when they join."
                returnKeyType="done"
              />
            )}

            <Button label="Add member" icon="plus" onPress={submit} loading={saving} fullWidth size="lg" testID="mem-submit" style={{ marginTop: SPACING.sm }} />
          </View>
    </FormScreen>
  );
}
