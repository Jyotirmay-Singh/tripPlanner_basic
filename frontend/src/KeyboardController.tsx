import React from 'react';
import {
  KeyboardAwareScrollView as NativeKeyboardAwareScrollView,
  KeyboardAvoidingView as NativeKeyboardAvoidingView,
  KeyboardController,
  KeyboardProvider,
} from 'react-native-keyboard-controller';

export type {
  KeyboardAwareScrollViewProps,
  KeyboardAwareScrollViewRef,
  KeyboardAvoidingViewProps,
} from 'react-native-keyboard-controller';

export const KeyboardAwareScrollView = NativeKeyboardAwareScrollView;
export const KeyboardAvoidingView = NativeKeyboardAvoidingView;

/**
 * Keyboard Controller needs to know that both Android system bars are translucent in this app.
 * preserveEdgeToEdge prevents a temporary opt-out while the keyboard is animating.
 */
export function AppKeyboardProvider({ children }: React.PropsWithChildren) {
  return (
    <KeyboardProvider
      statusBarTranslucent
      navigationBarTranslucent
      preserveEdgeToEdge
    >
      {children}
    </KeyboardProvider>
  );
}

export function focusNextInput() {
  KeyboardController.setFocusTo('next');
}
