import React from 'react';
import LegalPage from '../src/LegalPage';

export default function AccountDeletionPage() {
  return <LegalPage title="Account deletion" deletion sections={[
    { title: 'Request deletion from any device', text: 'Email teamsplitora@gmail.com from the Gmail address registered with Splitora, using the subject “Splitora account deletion request”. State that you want your Splitora account and associated account data deleted. Support verifies ownership through your registered address and explains the completion steps and timing. This pathway works after uninstalling the Android app.' },
    { title: 'Delete from your account', text: 'Sign in on the website or app and open Profile → Delete account. Review group membership, family/ownership outcomes and retained financial positions, then complete the displayed acknowledgement and confirmation. An active payment review may require resolution first. Support can help if you cannot sign in or complete a required step.' },
    { title: 'Data removed and retained', text: 'Deletion removes login credentials, email/mobile/UPI account details, tokens, device registrations and live account links. Local account copies are purged after confirmed deletion. Shared group/member names, expenses, balances, payment evidence, receipts, reports and de-identified chat can remain for reconciliation, fraud prevention and dispute resolution while the group record is retained. Describe any personal information within shared content that you want support to review for redaction.' },
    { title: 'After completion', text: 'Support confirms fulfilment and explains retained records. A later registration with the same Gmail address creates a new account. You can also contact the support inbox to request a copy, correction or review of personal information.' },
  ]} />;
}
