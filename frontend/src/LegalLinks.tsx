import React from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import T from './T';
import { SPACING } from './theme';
import { SUPPORT_EMAIL } from './communitySafety';

export default function LegalLinks() {
  const router = useRouter();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
      {(['privacy', 'terms', 'account-deletion'] as const).map((route) => (
        <Pressable key={route} accessibilityRole="link" testID={`legal-${route}`}
          onPress={() => router.push(`/${route}`)} style={{ minHeight: 44, justifyContent: 'center', padding: 4 }}>
          <T variant="caption" style={{ textDecorationLine: 'underline' }}>
            {{ privacy: 'Privacy', terms: 'Terms', 'account-deletion': 'Account deletion' }[route]}
          </T>
        </Pressable>
      ))}
      <Pressable accessibilityRole="link" accessibilityLabel={`Contact ${SUPPORT_EMAIL}`}
        onPress={() => { void Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => {}); }}
        style={{ minHeight: 44, justifyContent: 'center', padding: 4 }}>
        <T variant="caption" style={{ textDecorationLine: 'underline' }}>Support</T>
      </Pressable>
    </View>
  );
}
