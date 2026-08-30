import { eyeIcon, toggleVisible, isMasked, secureA11yLabel } from '../secureField';

// The show/hide ("eye") toggle on password fields. Input.tsx holds local reveal state while these
// pure helpers define the icon, masking, and accessibility contract.
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
    it('says Show when masked and Hide when revealed', () => {
      expect(secureA11yLabel(false)).toBe('Show password');
      expect(secureA11yLabel(true)).toBe('Hide password');
    });
  });
});
