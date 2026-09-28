// Pure logic for the show/hide ("eye") affordance on password fields. Kept dependency-free so
// the toggle contract is unit-testable without rendering (matches src/permissions.ts, src/bill.ts).
// Components hold a local `visible` boolean (default false = masked) and lean on these helpers.

export type EyeIcon = 'eye' | 'eye-off';

/** Open eye when the value is visible, slashed eye-off when it's masked. */
export const eyeIcon = (visible: boolean): EyeIcon => (visible ? 'eye' : 'eye-off');

/** Flip the reveal state on each tap. */
export const toggleVisible = (visible: boolean): boolean => !visible;

/** Whether the field should currently mask its value (drives secureTextEntry). */
export const isMasked = (visible: boolean): boolean => !visible;

/** Accessibility label that reflects the action the tap performs. */
export const secureA11yLabel = (visible: boolean): string =>
  `${visible ? 'Hide' : 'Show'} password`;
