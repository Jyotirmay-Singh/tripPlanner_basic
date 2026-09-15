import {
  canonicalMobileNumber,
  countryFromLocale,
  formatMobileDraft,
  formatMobileForDisplay,
  MOBILE_INVALID_MESSAGE,
  searchMobileCountries,
} from '../mobileNumber';

describe('international mobile-number helpers', () => {
  it('uses a supported locale region and falls back to India', () => {
    expect(countryFromLocale('en-US')).toBe('US');
    expect(countryFromLocale('hi_IN')).toBe('IN');
    expect(countryFromLocale('not-a-locale')).toBe('IN');
  });

  it('searches countries by name, ISO code, and dial code', () => {
    expect(searchMobileCountries('India').some((country) => country.code === 'IN')).toBe(true);
    expect(searchMobileCountries('jp').some((country) => country.code === 'JP')).toBe(true);
    expect(searchMobileCountries('+91').some((country) => country.code === 'IN')).toBe(true);
    expect(searchMobileCountries('no-country-has-this-name')).toEqual([]);
  });

  it('adopts the country from pasted E.164 input and formats a national draft', () => {
    const pasted = formatMobileDraft('+1 415 555 2671', 'IN');
    expect(pasted.country).toBe('US');
    expect(pasted.display).toBe('(415) 555-2671');

    expect(formatMobileDraft('9876543210', 'IN')).toEqual({
      country: 'IN',
      display: '98765 43210',
    });
  });

  it('submits canonical E.164 and rejects incomplete input', () => {
    expect(canonicalMobileNumber('98765 43210', 'IN')).toBe('+919876543210');
    expect(() => canonicalMobileNumber('123', 'IN')).toThrow(MOBILE_INVALID_MESSAGE);
  });

  it('formats saved values for contact rows', () => {
    expect(formatMobileForDisplay('+919876543210')).toBe('+91 98765 43210');
    expect(formatMobileForDisplay(null)).toBe('');
  });
});
