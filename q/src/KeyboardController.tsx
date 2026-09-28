import React from 'react';
import {
  KeyboardAwareScrollView as NativeKeyboardAwareScrollView,
  KeyboardAvoidingView as NativeKeyboardAvoidingView,
  KeyboardStickyView as NativeKeyboardStickyView,
  KeyboardController,
  KeyboardProvider,
  useKeyboardState,
} from 'react-native-keyboard-controller';

export type {
  KeyboardAwareScrollViewProps,
  KeyboardAwareScrollViewRef,
  KeyboardAvoidingViewProps,
  KeyboardStickyViewProps,
} from 'react-native-keyboard-controller';

export const KeyboardAwareScrollView = NativeKeyboardAwareScrollView;
export const KeyboardAvoidingView = NativeKeyboardAvoidingView;
export const KeyboardStickyView = NativeKeyboardStickyView;

/** A small platform seam for UI that needs stable, post-inset keyboard geometry. */
export function useAppKeyboardState() {
  return useKeyboardState(({ height, isVisible }) => ({
    height: Math.max(0, Number(height) || 0),
    isVisible,
  }));
}

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
