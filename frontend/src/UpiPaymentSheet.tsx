import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import {
  ApiError,
  createPaymentAttempt,
  getPaymentRecipientDetails,
  previewPaymentHandoff,
  updatePaymentAttemptSender,
} from './api';
import {
  paymentHandoffRequiresReview,
  paymentRecipientRequiresReview,
  snapshotPaymentRecipient,
  validatePaymentAmount,
  validateTransactionReference,
  type PaymentAttempt,
  type PaymentHandoffPreview,
  type PaymentRecipientCandidate,
  type PaymentRecipientDetails,
  type PaymentRecipientSnapshot,
} from './payments';
import {
  copyAndLaunchUpiApp,
  copyUpiId,
  discoverUpiApps,
  type UpiApp,
  type UpiAvailability,
} from './upiLauncher';
import { currencyMinorUnits } from './currencies';
import { useTheme } from './ThemeContext';
import { RADIUS, SPACING } from './theme';
import T from './T';
import { AmountText, Button, Card, Icon, Input, Sheet } from './ui';

export type UpiPaymentSheetProps = {
  visible: boolean;
  tripId: string;
  tripName: string;
  fromMemberId: string;
  fromName: string;
  toMemberId: string;
  toName: string;
  initialAmount: number;
  currency: string;
  wholeUnit: boolean;
  onClose: () => void;
  initialAttempt?: PaymentAttempt | null;
  onAttemptChanged?: (attempt: PaymentAttempt) => void | Promise<void>;
};

const COPY_ONLY: UpiAvailability = { status: 'unsupported', platform: Platform.OS, apps: [] };

export function upiEnabledRecipients(
  details: PaymentRecipientDetails | null | undefined,
): PaymentRecipientCandidate[] {
  return (details?.recipients ?? []).filter(
    (recipient) => recipient.account_linked && !!recipient.upi_id,
  );
}

export function defaultUpiRecipientId(
  details: PaymentRecipientDetails | null | undefined,
): string | null {
  const candidates = upiEnabledRecipients(details);
  return candidates.length === 1 ? candidates[0].person_id : null;
}

function detailsFromPreview(preview: PaymentHandoffPreview): PaymentRecipientDetails {
  return {
    trip_id: preview.trip_id,
    from_member_id: preview.from_member_id,
    to_member_id: preview.to_member_id,
    recipients: preview.recipients,
  };
}

export function paymentHandoffChangeMessage(
  reviewed: PaymentHandoffPreview,
  current: PaymentHandoffPreview,
  recipient: PaymentRecipientSnapshot,
): string {
  if (paymentRecipientRequiresReview(recipient, detailsFromPreview(current))) {
    return 'The recipient or UPI ID changed. Review and approve the latest details.';
  }
  if (reviewed.current_payable !== current.current_payable) {
    return 'The payable changed. Review and approve the latest amount.';
  }
  if (
    reviewed.source_amount !== current.source_amount
    || reviewed.source_currency !== current.source_currency
    || reviewed.inr_amount !== current.inr_amount
  ) {
    return 'The payment amount or conversion changed. Review and approve it again.';
  }
  return 'The exchange-rate quote changed. Review and approve the latest details.';
}

function inputAmount(value: number, currency: string, wholeUnit: boolean): string {
  if (wholeUnit) return String(Math.round(value));
  const digits = currencyMinorUnits(currency);
  return value.toFixed(digits);
}

function expiryLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function handoffErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object'
    ? (error as { detailCode?: string }).detailCode
    : undefined;
  switch (code) {
    case 'quote_expired':
      return 'The reviewed quote expired. Review a new quote before continuing.';
    case 'payable_changed':
      return 'The payable changed. Review and approve the latest amount.';
    case 'payment_pair_inactive':
      return 'This recommendation is no longer active or has been rerouted.';
    case 'quote_mismatch':
      return 'The reviewed amount or currency changed. Review a new quote.';
    case 'wrong_payer':
      return 'Only the account linked to the current payer can continue.';
    case 'conversion_unavailable':
      return 'INR conversion is unavailable right now. Try reviewing again.';
    case 'active_attempt_owned_by_another_payer':
      return 'A UPI payment is already pending. The initiating payer must resume it.';
    default:
      return error instanceof Error ? error.message : 'Could not verify payment details.';
  }
}

function HandoffInstructions({
  recipientName,
  upiId,
  inrAmount,
}: {
  recipientName: string;
  upiId: string;
  inrAmount: string;
}) {
  const steps = [
    `Paste the copied UPI ID (${upiId}) into the payment app.`,
    `Verify that the recipient is ${recipientName} before continuing.`,
    `Enter exactly INR ${inrAmount}. Do not let the app replace the amount.`,
    'Review and authorize inside the payment app. Trip Splitter never asks for your UPI PIN.',
  ];
  return (
    <Card variant="muted" style={styles.instructions} testID="upi-handoff-instructions">
      <T variant="h4">Complete these steps in your payment app</T>
      {steps.map((step, index) => (
        <View key={step} style={styles.stepRow}>
          <View style={styles.stepNumber} accessibilityElementsHidden>
            <T variant="caption" style={styles.stepNumberText}>{index + 1}</T>
          </View>
          <T style={styles.flex}>{step}</T>
        </View>
      ))}
    </Card>
  );
}

function attemptStatusMessage(attempt: PaymentAttempt): string {
  switch (attempt.status) {
    case 'awaiting_confirmation':
      return `Waiting for ${attempt.selected_recipient_name_snapshot} to confirm receipt.`;
    case 'needs_review':
      return attempt.reason === 'no_current_payable'
        ? 'The current payable is zero, so no ledger payment was posted. A recipient or admin can retry or close the review.'
        : 'The recipient reported that the payment was not received. A recipient or admin can retry or close the review.';
    case 'settled_recipient_confirmed':
      return 'The recipient confirmed receipt and the payment was added to the trip ledger.';
    case 'canceled':
      return 'This attempt was canceled without changing the trip balance.';
    case 'expired':
      return 'This unresolved attempt expired without changing the trip balance.';
    case 'closed':
      return 'The review was closed without adding a payment.';
    case 'voided':
      return 'The linked ledger payment was removed. The original confirmation audit remains.';
    default:
      return 'This payment attempt is ready to continue.';
  }
}

export default function UpiPaymentSheet({
  visible,
  tripId,
  tripName,
  fromMemberId,
  fromName,
  toMemberId,
  toName,
  initialAmount,
  currency,
  wholeUnit,
  onClose,
  initialAttempt = null,
  onAttemptChanged,
}: UpiPaymentSheetProps) {
  const { colors } = useTheme();
  const initialAmountText = inputAmount(initialAmount, currency, wholeUnit);
  const [details, setDetails] = useState<PaymentRecipientDetails | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [amount, setAmount] = useState(initialAmountText);
  const [maxPayable, setMaxPayable] = useState(initialAmountText);
  const [preview, setPreview] = useState<PaymentHandoffPreview | null>(null);
  const [recipientSnapshot, setRecipientSnapshot] = useState<PaymentRecipientSnapshot | null>(null);
  const [approved, setApproved] = useState(false);
  const [staleAcknowledged, setStaleAcknowledged] = useState(false);
  const [availability, setAvailability] = useState<UpiAvailability>(COPY_ONLY);
  const [loading, setLoading] = useState(false);
  const [workingAction, setWorkingAction] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [launchedApp, setLaunchedApp] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<PaymentAttempt | null>(initialAttempt);
  const [transactionReference, setTransactionReference] = useState('');
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [decisionReady, setDecisionReady] = useState(!!initialAttempt);
  const [waitingForAppReturn, setWaitingForAppReturn] = useState(false);
  const sawAppBackground = useRef(false);

  const loadOpeningState = useCallback(async (alive: () => boolean = () => true) => {
    setLoading(true);
    setLoadError(null);
    try {
      if (initialAttempt) {
        const detected = await discoverUpiApps();
        if (!alive()) return;
        setAttempt(initialAttempt);
        setDecisionReady(initialAttempt.status === 'initiated');
        setAvailability(detected);
        return;
      }
      const [freshDetails, detected] = await Promise.all([
        getPaymentRecipientDetails(tripId, fromMemberId, toMemberId),
        discoverUpiApps(),
      ]);
      if (!alive()) return;
      setDetails(freshDetails);
      setSelectedPersonId(defaultUpiRecipientId(freshDetails));
      setAvailability(detected);
    } catch (error) {
      if (!alive()) return;
      setLoadError(error instanceof Error ? error.message : 'Could not load recipient details.');
      setAvailability(COPY_ONLY);
    } finally {
      if (alive()) setLoading(false);
    }
  }, [fromMemberId, initialAttempt, toMemberId, tripId]);

  useEffect(() => {
    if (!visible) return undefined;
    let mounted = true;
    setDetails(null);
    setSelectedPersonId(null);
    setAmount(initialAmountText);
    setMaxPayable(initialAmountText);
    setPreview(null);
    setRecipientSnapshot(null);
    setApproved(false);
    setStaleAcknowledged(false);
    setNotice(null);
    setActionError(null);
    setAmountError(null);
    setLaunchedApp(null);
    setAttempt(initialAttempt);
    setTransactionReference(initialAttempt?.transaction_reference ?? '');
    setReferenceError(null);
    setDecisionReady(initialAttempt?.status === 'initiated');
    setWaitingForAppReturn(false);
    sawAppBackground.current = false;
    void loadOpeningState(() => mounted);
    return () => { mounted = false; };
  }, [currency, initialAmountText, initialAttempt, loadOpeningState, visible, wholeUnit]);

  useEffect(() => {
    if (!visible || !waitingForAppReturn) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        sawAppBackground.current = true;
        return;
      }
      if (sawAppBackground.current) {
        setWaitingForAppReturn(false);
        setDecisionReady(true);
        setNotice('You are back in Trip Splitter. Report what happened in the payment app.');
      }
    });
    return () => subscription.remove();
  }, [visible, waitingForAppReturn]);

  const recipients = useMemo(() => upiEnabledRecipients(details), [details]);
  const selectedRecipient = recipients.find(
    (recipient) => recipient.person_id === selectedPersonId,
  ) ?? null;

  const clearReview = (message?: string) => {
    setPreview(null);
    setRecipientSnapshot(null);
    setApproved(false);
    setStaleAcknowledged(false);
    setActionError(null);
    setLaunchedApp(null);
    if (message !== undefined) setNotice(message);
  };

  const chooseRecipient = (personId: string) => {
    setSelectedPersonId(personId);
    clearReview();
  };

  const changeAmount = (value: string) => {
    setAmount(value);
    setAmountError(null);
    clearReview();
  };

  const reviewPayment = async () => {
    const parsedAmount = Number(amount);
    const validation = validatePaymentAmount(parsedAmount, Number(maxPayable), {
      wholeUnit,
      currency,
      rawAmount: amount,
    });
    if (!validation.ok) {
      setAmountError(validation.error);
      return;
    }
    if (!selectedRecipient) {
      setNotice('Choose the person who will receive this payment.');
      return;
    }

    setWorkingAction('review');
    setNotice(null);
    setActionError(null);
    try {
      const fresh = await previewPaymentHandoff(tripId, {
        from_member_id: fromMemberId,
        to_member_id: toMemberId,
        amount,
      });
      const freshDetails = detailsFromPreview(fresh);
      const freshRecipient = upiEnabledRecipients(freshDetails).find(
        (candidate) => candidate.person_id === selectedRecipient.person_id,
      );
      setDetails(freshDetails);
      setMaxPayable(fresh.current_payable);
      setAmount(fresh.source_amount);
      setApproved(false);
      setStaleAcknowledged(false);
      setLaunchedApp(null);
      if (!freshRecipient) {
        setSelectedPersonId(defaultUpiRecipientId(freshDetails));
        setPreview(null);
        setRecipientSnapshot(null);
        setNotice('That recipient is no longer available. Choose from the latest details.');
        return;
      }
      setSelectedPersonId(freshRecipient.person_id);
      setPreview(fresh);
      setRecipientSnapshot(snapshotPaymentRecipient(freshRecipient));
    } catch (error) {
      const detail = typeof ApiError === 'function' && error instanceof ApiError
        ? (error.data as { detail?: { current_payable?: string } } | undefined)?.detail
        : undefined;
      if (detail?.current_payable) setMaxPayable(detail.current_payable);
      clearReview(handoffErrorMessage(error));
    } finally {
      setWorkingAction(null);
    }
  };

  const revalidate = async (): Promise<PaymentRecipientCandidate | null> => {
    if (!preview || !recipientSnapshot) return null;
    try {
      const fresh = await previewPaymentHandoff(tripId, {
        from_member_id: fromMemberId,
        to_member_id: toMemberId,
        amount: preview.source_amount,
        quote_id: preview.quote.quote_id,
      });
      const freshDetails = detailsFromPreview(fresh);
      const freshRecipient = upiEnabledRecipients(freshDetails).find(
        (candidate) => candidate.person_id === recipientSnapshot.person_id,
      );
      setDetails(freshDetails);
      setMaxPayable(fresh.current_payable);
      if (!freshRecipient || paymentHandoffRequiresReview(preview, fresh, recipientSnapshot)) {
        setApproved(false);
        setStaleAcknowledged(false);
        setLaunchedApp(null);
        if (freshRecipient) {
          setSelectedPersonId(freshRecipient.person_id);
          setPreview(fresh);
          setRecipientSnapshot(snapshotPaymentRecipient(freshRecipient));
          setNotice(paymentHandoffChangeMessage(preview, fresh, recipientSnapshot));
        } else {
          setSelectedPersonId(defaultUpiRecipientId(freshDetails));
          setPreview(null);
          setRecipientSnapshot(null);
          setNotice('The selected recipient is no longer available. Review the latest details.');
        }
        return null;
      }
      setPreview(fresh);
      return freshRecipient;
    } catch (error) {
      const detail = typeof ApiError === 'function' && error instanceof ApiError
        ? (error.data as { detail?: { current_payable?: string } } | undefined)?.detail
        : undefined;
      if (detail?.current_payable) setMaxPayable(detail.current_payable);
      clearReview(handoffErrorMessage(error));
      return null;
    }
  };

  const persistAttempt = async (app?: UpiApp): Promise<PaymentAttempt | null> => {
    if (attempt) {
      if (attempt.status !== 'initiated') {
        setNotice(attemptStatusMessage(attempt));
        return null;
      }
      return attempt;
    }
    const currentRecipient = await revalidate();
    if (!currentRecipient?.upi_id || !preview) return null;
    try {
      const requestedQuoteId = preview.quote.quote_id;
      const created = await createPaymentAttempt(tripId, {
        quote_id: requestedQuoteId,
        recipient_person_id: currentRecipient.person_id,
        handoff_method: app?.id ?? 'copy',
      });
      setAttempt(created);
      await onAttemptChanged?.(created);
      // A different quote means the server returned an already-active direction. Surface it without
      // repeating clipboard or app actions (important when another linked family payer started it).
      if (created.quote_id !== requestedQuoteId || created.status !== 'initiated') {
        setNotice(
          created.quote_id !== requestedQuoteId
            ? 'A UPI payment attempt is already active for this payer and recipient.'
            : attemptStatusMessage(created),
        );
        return null;
      }
      return created;
    } catch (error) {
      if (error && typeof error === 'object'
        && (error as { detailCode?: string }).detailCode
          === 'active_attempt_owned_by_another_payer') {
        clearReview(handoffErrorMessage(error));
      } else {
        setActionError(handoffErrorMessage(error));
      }
      return null;
    }
  };

  const copyOrLaunch = async (app?: UpiApp) => {
    setWorkingAction(app?.id ?? 'copy');
    setActionError(null);
    setNotice(null);
    setDecisionReady(false);
    const persisted = await persistAttempt(app);
    if (!persisted) {
      setWorkingAction(null);
      return;
    }
    if (!app) {
      const result = await copyUpiId(persisted.upi_id_snapshot);
      if (result.ok) {
        setDecisionReady(true);
        setNotice('UPI ID copied. Complete all four steps, then report what happened.');
      } else {
        setActionError(result.message);
      }
      setWorkingAction(null);
      return;
    }

    sawAppBackground.current = false;
    setWaitingForAppReturn(true);
    const result = await copyAndLaunchUpiApp(persisted.upi_id_snapshot, app);
    if (result.ok) {
      setLaunchedApp(app.label);
      setNotice(`${app.label} opened. Return here after you finish or cancel in the payment app.`);
    } else {
      setWaitingForAppReturn(false);
      setActionError(result.message);
      if (result.copied) {
        setDecisionReady(true);
        setNotice('The UPI ID was copied. You can open a payment app yourself or retry below.');
      }
    }
    setWorkingAction(null);
  };

  const reportPaid = async () => {
    if (!attempt) return;
    const validated = validateTransactionReference(transactionReference);
    if (!validated.ok) {
      setReferenceError(validated.error);
      return;
    }
    setWorkingAction('report_paid');
    setActionError(null);
    try {
      const updated = await updatePaymentAttemptSender(
        tripId, attempt.id, 'report_paid', validated.value,
      );
      setAttempt(updated);
      setDecisionReady(false);
      setNotice(attemptStatusMessage(updated));
      await onAttemptChanged?.(updated);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not report this payment.');
    } finally {
      setWorkingAction(null);
    }
  };

  const cancelAttempt = async () => {
    if (!attempt) return;
    setWorkingAction('cancel');
    setActionError(null);
    try {
      const updated = await updatePaymentAttemptSender(tripId, attempt.id, 'cancel');
      setAttempt(updated);
      setDecisionReady(false);
      setNotice(attemptStatusMessage(updated));
      await onAttemptChanged?.(updated);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not cancel this attempt.');
    } finally {
      setWorkingAction(null);
    }
  };

  const continueManuallyAfterLaunch = () => {
    setWaitingForAppReturn(false);
    setWorkingAction(null);
    setDecisionReady(true);
    setNotice('Continue manually, then report whether you paid. No balance has changed.');
  };

  const noRecipientMessage = details?.recipients.length === 1
    ? `${details.recipients[0].name || toName} must link an account and add a UPI ID in Payment details.`
    : `A linked person in ${toName} must add a UPI ID in Payment details.`;
  const actionsApproved = !!preview && approved && (!preview.quote.stale || staleAcknowledged);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Pay via UPI"
      testID="upi-payment-sheet"
      closeTestID="upi-sheet-close"
      scrimTestID="upi-sheet-scrim"
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.loading} testID="upi-details-loading">
            <ActivityIndicator color={colors.primary} />
            <T muted>Checking the latest recipient details...</T>
          </View>
        ) : loadError ? (
          <View style={styles.stack}>
            <T accessibilityRole="alert" color={colors.danger} testID="upi-load-error">
              {loadError}
            </T>
            <Button
              label="Try again"
              variant="secondary"
              onPress={() => { void loadOpeningState(); }}
              testID="upi-details-retry"
            />
            <Button label="Close" variant="ghost" onPress={onClose} testID="upi-close" />
          </View>
        ) : attempt ? (
          <View style={styles.stack} testID={`upi-attempt-${attempt.id}`}>
            <Card style={styles.reviewCard}>
              <T variant="label" muted>Recipient</T>
              <T variant="h2" testID="upi-attempt-recipient">
                {attempt.selected_recipient_name_snapshot}
              </T>
              <T variant="label" muted>UPI ID saved for this attempt</T>
              <T variant="h3" selectable testID="upi-attempt-id">{attempt.upi_id_snapshot}</T>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <T variant="label" muted>Trip amount</T>
              <AmountText
                value={Number(attempt.source_amount)}
                currency={attempt.source_currency}
                whole={wholeUnit}
                testID="upi-attempt-source-amount"
              />
              <T variant="label" muted>Enter this INR amount</T>
              <AmountText
                value={attempt.amount_paise / 100}
                currency="INR"
                variant="moneyLg"
                testID="upi-attempt-inr-amount"
              />
            </Card>

            <HandoffInstructions
              recipientName={attempt.selected_recipient_name_snapshot}
              upiId={attempt.upi_id_snapshot}
              inrAmount={attempt.inr_amount}
            />

            {attempt.status === 'initiated' ? (
              <View style={styles.stack} testID="upi-attempt-actions">
                {availability.status !== 'available' ? (
                  <T muted testID="upi-copy-only-guidance">
                    Copy the saved UPI ID, then complete the four steps in your preferred payment app.
                  </T>
                ) : null}
                {availability.apps.map((app) => (
                  <Button
                    key={app.id}
                    label={`Copy UPI ID and open ${app.label}`}
                    icon="wallet"
                    variant={app.id === 'google-pay' ? 'primary' : 'secondary'}
                    onPress={() => { void copyOrLaunch(app); }}
                    loading={workingAction === app.id}
                    disabled={workingAction !== null && workingAction !== app.id}
                    fullWidth
                    testID={`upi-open-${app.id}`}
                  />
                ))}
                <Button
                  label="Copy UPI ID"
                  icon="copy"
                  variant="ghost"
                  onPress={() => { void copyOrLaunch(); }}
                  loading={workingAction === 'copy'}
                  disabled={workingAction !== null && workingAction !== 'copy'}
                  fullWidth
                  testID="upi-copy-id"
                />

                {waitingForAppReturn ? (
                  <Card variant="muted" style={styles.messageCard} testID="upi-awaiting-app-return">
                    <T>Finish or cancel in the payment app, then return here.</T>
                    <T variant="caption" muted>No balance changes until the recipient confirms.</T>
                    <Button
                      label="App didn’t open / continue manually"
                      variant="secondary"
                      size="sm"
                      onPress={continueManuallyAfterLaunch}
                      testID="upi-app-did-not-open"
                    />
                  </Card>
                ) : null}

                {decisionReady ? (
                  <View style={styles.stack} testID="upi-sender-decision">
                    <Input
                      label="Transaction reference (optional)"
                      value={transactionReference}
                      onChangeText={(value) => {
                        setTransactionReference(value);
                        if (referenceError) setReferenceError(null);
                      }}
                      helper="This is your note only. Trip Splitter does not verify it with a bank."
                      error={referenceError}
                      errorTestID="upi-reference-error"
                      accessibilityLabel="Optional transaction reference, not bank verified"
                      testID="upi-transaction-reference"
                    />
                    <Button
                      label="I’ve paid"
                      onPress={() => { void reportPaid(); }}
                      loading={workingAction === 'report_paid'}
                      disabled={workingAction !== null && workingAction !== 'report_paid'}
                      fullWidth
                      testID="upi-report-paid"
                    />
                    <Button
                      label="Not paid"
                      variant="secondary"
                      onPress={() => { void cancelAttempt(); }}
                      loading={workingAction === 'cancel'}
                      disabled={workingAction !== null && workingAction !== 'cancel'}
                      fullWidth
                      testID="upi-not-paid"
                    />
                  </View>
                ) : null}

                {!decisionReady && actionError ? (
                  <Button
                    label="Not paid"
                    variant="secondary"
                    onPress={() => { void cancelAttempt(); }}
                    loading={workingAction === 'cancel'}
                    disabled={workingAction !== null && workingAction !== 'cancel'}
                    fullWidth
                    accessibilityLabel="Cancel this saved UPI payment attempt as not paid"
                    testID="upi-not-paid"
                  />
                ) : null}
              </View>
            ) : (
              <Card variant="muted" style={styles.messageCard} testID="upi-attempt-status">
                <T accessibilityLiveRegion="polite">{attemptStatusMessage(attempt)}</T>
                {attempt.status === 'settled_recipient_confirmed'
                  && attempt.posted_amount != null
                  && Number(attempt.source_amount) !== attempt.posted_amount ? (
                    <T variant="caption" muted testID="upi-capped-amount">
                      INR {attempt.inr_amount} was reported externally; {attempt.posted_currency}{' '}
                      {attempt.posted_amount} was the remaining amount posted to the ledger.
                    </T>
                  ) : null}
              </Card>
            )}

            {notice ? (
              <Card variant="muted" style={styles.messageCard} testID="upi-action-notice">
                <T accessibilityLiveRegion="polite">{notice}</T>
              </Card>
            ) : null}
            {actionError ? (
              <T
                color={colors.danger}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                testID="upi-action-error"
              >
                {actionError}
              </T>
            ) : null}
            {attempt.status !== 'initiated' ? (
              <Button label="Close" onPress={onClose} testID="upi-done" />
            ) : null}
          </View>
        ) : details && recipients.length === 0 ? (
          <View style={styles.stack} testID="upi-no-recipient">
            <Card variant="muted" style={styles.stack}>
              <Icon name="wallet" color={colors.textMuted} />
              <T variant="h3">No UPI ID available</T>
              <T muted>{noRecipientMessage}</T>
            </Card>
            <Button label="Close" onPress={onClose} testID="upi-close" />
          </View>
        ) : details ? (
          <View style={styles.stack}>
            <View style={styles.stack}>
              <T variant="label" muted>Payee</T>
              {recipients.map((recipient) => {
                const selected = recipient.person_id === selectedPersonId;
                return (
                  <Pressable
                    key={recipient.person_id}
                    testID={`upi-recipient-${recipient.person_id}`}
                    accessibilityRole="radio"
                    accessibilityLabel={`Pay ${recipient.name} at ${recipient.upi_id}`}
                    accessibilityState={{ checked: selected }}
                    onPress={() => chooseRecipient(recipient.person_id)}
                    style={[
                      styles.recipient,
                      {
                        borderColor: selected ? colors.primary : colors.border,
                        backgroundColor: selected ? colors.primary + '10' : colors.surface,
                      },
                    ]}
                  >
                    <Icon name={selected ? 'radio-on' : 'radio-off'} color={colors.primary} />
                    <View style={styles.flex}>
                      <T variant="h4">{recipient.name}</T>
                      <T muted numberOfLines={1}>{recipient.upi_id}</T>
                    </View>
                  </Pressable>
                );
              })}
              {recipients.length > 1 && !selectedRecipient ? (
                <T variant="caption" color={colors.warning} testID="upi-recipient-required">
                  Choose one person to continue.
                </T>
              ) : null}
            </View>

            <Input
              label={`Amount (${currency})`}
              value={amount}
              onChangeText={changeAmount}
              keyboardType="decimal-pad"
              helper={`Up to ${maxPayable} ${currency}. You will enter the reviewed INR amount in the payment app.`}
              error={amountError}
              errorTestID="upi-amount-error"
              testID="upi-handoff-amount"
            />

            {!preview ? (
              <Button
                label="Review payment"
                onPress={() => { void reviewPayment(); }}
                loading={workingAction === 'review'}
                disabled={!selectedRecipient}
                fullWidth
                testID="upi-review-payment"
              />
            ) : (
              <View style={styles.stack} testID="upi-payment-review">
                <Card style={styles.reviewCard}>
                  <T variant="label" muted>Trip</T>
                  <T variant="h4">{preview.trip_name || tripName}</T>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                  <T variant="label" muted>Payer</T>
                  <T>{preview.from_name || fromName}</T>
                  <T variant="label" muted>Recipient</T>
                  <T variant="h2" testID="upi-reviewed-recipient">{selectedRecipient?.name}</T>
                  <T variant="label" muted>Current UPI ID</T>
                  <T variant="h2" selectable testID="upi-reviewed-id">{selectedRecipient?.upi_id}</T>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                  <T variant="label" muted>Trip amount</T>
                  <AmountText
                    value={Number(preview.source_amount)}
                    currency={preview.source_currency}
                    whole={wholeUnit}
                    testID="upi-reviewed-source-amount"
                  />
                  <T variant="label" muted>Enter this INR amount</T>
                  <AmountText
                    value={Number(preview.inr_amount)}
                    currency="INR"
                    variant="moneyLg"
                    testID="upi-reviewed-inr-amount"
                  />
                </Card>

                <HandoffInstructions
                  recipientName={selectedRecipient?.name ?? toName}
                  upiId={selectedRecipient?.upi_id ?? ''}
                  inrAmount={preview.inr_amount}
                />

                {preview.source_currency !== 'INR' ? (
                  <Card variant="muted" style={styles.rateCard} testID="upi-conversion-details">
                    <T variant="h4">Reference conversion</T>
                    <T>1 {preview.source_currency} = {preview.quote.rate} INR</T>
                    <T variant="caption" muted>Provider: {preview.quote.provider}</T>
                    <T variant="caption" muted>
                      Effective date: {preview.quote.effective_rate_date || 'Latest available'}
                    </T>
                    <T variant="caption" muted>Quote expires: {expiryLabel(preview.quote.expires_at)}</T>
                  </Card>
                ) : null}

                {preview.quote.stale ? (
                  <Card variant="muted" style={styles.rateCard} testID="upi-stale-warning">
                    <T color={colors.warning} variant="h4">Cached rate may be outdated</T>
                    <T muted>The live provider was unavailable, so this quote uses a recent cached rate.</T>
                  </Card>
                ) : null}

                <Pressable
                  onPress={() => setApproved((value) => !value)}
                  accessibilityRole="checkbox"
                  accessibilityLabel="Approve payment details"
                  accessibilityState={{ checked: approved }}
                  testID="upi-approve-details"
                  style={styles.checkRow}
                >
                  <Icon name={approved ? 'checkbox-on' : 'checkbox-off'} color={colors.primary} />
                  <T style={styles.flex}>Approve payment details</T>
                </Pressable>

                {preview.quote.stale ? (
                  <Pressable
                    onPress={() => setStaleAcknowledged((value) => !value)}
                    accessibilityRole="checkbox"
                    accessibilityLabel="I understand this rate may be outdated"
                    accessibilityState={{ checked: staleAcknowledged }}
                    testID="upi-acknowledge-stale"
                    style={styles.checkRow}
                  >
                    <Icon
                      name={staleAcknowledged ? 'checkbox-on' : 'checkbox-off'}
                      color={colors.primary}
                    />
                    <T style={styles.flex}>I understand this rate may be outdated</T>
                  </Pressable>
                ) : null}

                {actionsApproved ? (
                  <View style={styles.stack} testID="upi-approved-actions">
                    {availability.status === 'unsupported' ? (
                      <T muted testID="upi-copy-only-guidance">
                        {Platform.OS === 'ios'
                          ? 'Copy the UPI ID, then open your preferred payment app and enter the reviewed INR amount.'
                          : 'Copy the UPI ID, then use it in your preferred payment service and enter the reviewed INR amount.'}
                      </T>
                    ) : availability.status === 'discovery_failed' ? (
                      <T muted testID="upi-copy-only-guidance">
                        Installed-app detection failed. You can still copy the reviewed UPI ID safely.
                      </T>
                    ) : availability.status === 'none' ? (
                      <T muted testID="upi-copy-only-guidance">
                        No supported UPI app was detected. You can still copy the reviewed UPI ID.
                      </T>
                    ) : null}

                    {availability.apps.map((app) => (
                      <Button
                        key={app.id}
                        label={`Copy UPI ID and open ${app.label}`}
                        icon="wallet"
                        variant={app.id === 'google-pay' ? 'primary' : 'secondary'}
                        onPress={() => { void copyOrLaunch(app); }}
                        loading={workingAction === app.id}
                        disabled={workingAction !== null && workingAction !== app.id}
                        fullWidth
                        testID={`upi-open-${app.id}`}
                      />
                    ))}
                    <Button
                      label="Copy UPI ID"
                      icon="copy"
                      variant="ghost"
                      onPress={() => { void copyOrLaunch(); }}
                      loading={workingAction === 'copy'}
                      disabled={workingAction !== null && workingAction !== 'copy'}
                      fullWidth
                      testID="upi-copy-id"
                    />
                    <T variant="caption" muted testID="upi-not-paid-warning">
                      Copying, opening an app, returning, or canceling never marks this balance paid.
                    </T>
                  </View>
                ) : null}
              </View>
            )}

            {notice ? (
              <Card variant="muted" style={styles.messageCard} testID="upi-action-notice">
                <T accessibilityLiveRegion="polite">{notice}</T>
              </Card>
            ) : null}
            {actionError ? (
              <T
                color={colors.danger}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                testID="upi-action-error"
              >
                {actionError}
              </T>
            ) : null}
            {launchedApp ? (
              <Button label="Done" onPress={onClose} testID="upi-done" />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  content: { paddingBottom: SPACING.sm },
  stack: { gap: SPACING.md },
  loading: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  flex: { flex: 1, minWidth: 0 },
  recipient: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: RADIUS.md,
  },
  reviewCard: { gap: SPACING.sm },
  rateCard: { gap: SPACING.xs },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: SPACING.xs },
  checkRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  messageCard: { gap: SPACING.xs },
  instructions: { gap: SPACING.sm },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(80, 96, 120, 0.14)',
  },
  stepNumberText: { fontWeight: '700' },
});
