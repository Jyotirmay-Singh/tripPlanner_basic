import React from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import T from './T';
import { Button, Card, Screen } from './ui';
import LegalLinks from './LegalLinks';
import { COMMUNITY_TERMS_VERSION, SUPPORT_EMAIL } from './communitySafety';

type Section = { title: string; text: string };
type Props = { title: string; sections: Section[]; deletion?: boolean };

export default function LegalPage({ title, sections, deletion = false }: Props) {
  const router = useRouter();
  return (
    <Screen edges={['left', 'right', 'bottom']} testID={`legal-page-${deletion ? 'deletion' : title}`}>
      <Head><title>{title} · Splitora</title></Head>
      <T variant="h1">{title}</T>
      <T muted variant="caption">Splitora · Updated {COMMUNITY_TERMS_VERSION}</T>
      {sections.map((section) => (
        <Card key={section.title}>
          <T variant="h3">{section.title}</T>
          <T selectable style={{ marginTop: 8, lineHeight: 24 }}>{section.text}</T>
        </Card>
      ))}
      {deletion ? <>
        <Button label="Request account deletion by email" icon="mail" testID="email-deletion-request"
          onPress={() => {
            void Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Splitora account deletion request')}`)
              .catch(() => {});
          }} />
        <Button label="Open signed-in deletion review" variant="secondary" onPress={() => router.push('/delete-account')} />
      </> : null}
      <T selectable>Contact {SUPPORT_EMAIL}</T>
      <LegalLinks />
    </Screen>
  );
}
