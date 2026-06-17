import { tripComposition, compositionLabel, CompositionMember } from '../composition';

const fam = (n: number): CompositionMember => ({
  kind: 'family',
  family_members: Array.from({ length: n }, (_, i) => `m${i}`),
});
const single = (): CompositionMember => ({ kind: 'individual', family_members: [] });

describe('tripComposition', () => {
  it('counts the Section 5 example (families 4/4/2/1 + 2 singles = 13 humans)', () => {
    const members = [fam(4), fam(4), fam(2), fam(1), single(), single()];
    expect(tripComposition(members)).toEqual({ individuals: 13, families: 4, singles: 2 });
  });

  it('counts a family with an empty roster as one human', () => {
    expect(tripComposition([fam(0)])).toEqual({ individuals: 1, families: 1, singles: 0 });
  });

  it('handles null / undefined members', () => {
    expect(tripComposition(null)).toEqual({ individuals: 0, families: 0, singles: 0 });
    expect(tripComposition(undefined)).toEqual({ individuals: 0, families: 0, singles: 0 });
  });
});

describe('compositionLabel', () => {
  it('renders the Section 5 example string', () => {
    const members = [fam(4), fam(4), fam(2), fam(1), single(), single()];
    expect(compositionLabel(members)).toBe('13 Individuals across 4 Families & 2 Singles');
  });

  it('omits the singles segment when there are none', () => {
    expect(compositionLabel([fam(4), fam(4)])).toBe('8 Individuals across 2 Families');
  });

  it('uses singular forms for families and singles', () => {
    // one family of 2 + one single -> 3 humans, 1 family, 1 single
    expect(compositionLabel([fam(2), single()])).toBe('3 Individuals across 1 Family & 1 Single');
    // one family of 1, no singles -> "1 Individual across 1 Family"
    expect(compositionLabel([fam(1)])).toBe('1 Individual across 1 Family');
  });

  it('shows only the human count when there are no families', () => {
    expect(compositionLabel([single(), single(), single()])).toBe('3 Individuals');
    expect(compositionLabel([single()])).toBe('1 Individual');
  });

  it('renders "0 Individuals" for an empty trip', () => {
    expect(compositionLabel([])).toBe('0 Individuals');
    expect(compositionLabel(null)).toBe('0 Individuals');
    expect(compositionLabel(undefined)).toBe('0 Individuals');
  });
});
