import { eyeIcon, toggleVisible, isMasked, secureA11yLabel } from '../secureField';

// The show/hide ("eye") toggle on password & PIN fields. Drives Input.tsx + PinInput.tsx, which hold
// a local `visible` boolean starting at false (masked). These pure helpers are the toggle contract.
describe('secureField', () => {
  describe('masked by default', () => {
    it('starts masked: slashed eye-off icon, secureTextEntry on', () => {
      expect(eyeIcon(false)).toBe('eye-off');
      expect(isMasked(false)).toBe(true);
    });
  });

  describe('reveals on press', () => {
    it('first tap reveals: open eye icon, no longer masked', () => {
      const visible = toggleVisible(false);
      expect(visible).toBe(true);
      expect(eyeIcon(visible)).toBe('eye');
      expect(isMasked(visible)).toBe(false);
    });
  });

  describe('re-masks on second press', () => {
    it('second tap masks again', () => {
      expect(toggleVisible(toggleVisible(false))).toBe(false);
      expect(eyeIcon(false)).toBe('eye-off');
      expect(isMasked(false)).toBe(true);
    });
  });

  describe('icon swaps', () => {
    it('maps visibility to open eye / slashed eye-off', () => {
      expect(eyeIcon(true)).toBe('eye');
      expect(eyeIcon(false)).toBe('eye-off');
    });
  });

  describe('accessibility label reflects the action', () => {
    it('says Show when masked and Hide when revealed, per field noun', () => {
      expect(secureA11yLabel(false, 'PIN')).toBe('Show PIN');
      expect(secureA11yLabel(true, 'PIN')).toBe('Hide PIN');
      expect(secureA11yLabel(false, 'password')).toBe('Show password');
      expect(secureA11yLabel(true, 'password')).toBe('Hide password');
      expect(secureA11yLabel(false)).toBe('Show password'); // defaults to password
    });
  });
});
