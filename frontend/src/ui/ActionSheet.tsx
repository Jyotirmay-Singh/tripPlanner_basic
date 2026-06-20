import React from 'react';
import { View } from 'react-native';
import { SPACING } from '../theme';
import T from '../T';
import Sheet from './Sheet';
import Button, { ButtonVariant } from './Button';
import { IconName } from './Icon';

export type SheetAction = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  testID?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  actions: SheetAction[];
  testID?: string;
};

/**
 * Choice dialog presented as a bottom sheet — the themed replacement for multi-button
 * `Alert.alert`. Actions render as a vertical button stack; a Cancel ghost button is appended.
 */
export default function ActionSheet({ visible, onClose, title, message, actions, testID }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} testID={testID}>
      {message ? <T muted style={{ marginBottom: SPACING.md, lineHeight: 22 }}>{message}</T> : null}
      <View style={{ gap: SPACING.sm }}>
        {actions.map((a, i) => (
          <Button
            key={i}
            label={a.label}
            icon={a.icon}
            variant={a.variant ?? 'secondary'}
            fullWidth
            onPress={() => { a.onPress(); }}
            testID={a.testID}
          />
        ))}
        <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} testID={testID ? `${testID}-cancel` : undefined} />
      </View>
    </Sheet>
  );
}
