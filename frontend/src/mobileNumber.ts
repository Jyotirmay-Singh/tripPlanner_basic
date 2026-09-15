// Use the browser entry explicitly. The package's Node entry dynamically
// requires every locale, which Metro cannot resolve during static web export.
import countries from 'i18n-iso-countries/index';
import en from 'i18n-iso-countries/langs/en.json';
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

countries.registerLocale(en);

export const MOBILE_INVALID_MESSAGE = 'Enter a valid mobile number for the selected country';

export type MobileCountry = {
  code: CountryCode;
  name: string;
  dialCode: string;
  flag: string;
  searchText: string;
};

function flagForCountry(code: CountryCode): string {
  return [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

export const MOBILE_COUNTRIES: MobileCountry[] = getCountries()
  .map((code) => {
    const name = countries.getName(code, 'en', { select: 'official' }) || code;
    const dialCode = `+${getCountryCallingCode(code)}`;
    return {
      code,
      name,
      dialCode,
      flag: flagForCountry(code),
      searchText: `${name} ${code} ${dialCode}`.toLocaleLowerCase(),
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const COUNTRY_SET = new Set<CountryCode>(MOBILE_COUNTRIES.map((country) => country.code));

export function countryFromLocale(locale?: string | null): CountryCode {
  const candidate = locale || (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; }
  })();
  try {
    const region = typeof Intl.Locale === 'function' ? new Intl.Locale(candidate).region : undefined;
    if (region && COUNTRY_SET.has(region as CountryCode)) return region as CountryCode;
  } catch {
    // Older Android JavaScript runtimes may not implement Intl.Locale.
  }
  const match = candidate.match(/[-_]([A-Za-z]{2})(?:[-_]|$)/);
  const region = match?.[1]?.toUpperCase() as CountryCode | undefined;
  return region && COUNTRY_SET.has(region) ? region : 'IN';
}

export function countryOption(code: CountryCode): MobileCountry {
  return MOBILE_COUNTRIES.find((country) => country.code === code)
    || MOBILE_COUNTRIES.find((country) => country.code === 'IN')!;
}

export function searchMobileCountries(query: string): MobileCountry[] {
  const normalized = query.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return MOBILE_COUNTRIES;
  const withoutPlus = normalized.replace(/^\+/, '');
  return MOBILE_COUNTRIES.filter((country) => (
    country.searchText.includes(normalized)
    || country.code.toLocaleLowerCase().includes(normalized)
    || country.dialCode.slice(1).startsWith(withoutPlus)
  ));
}

export function formatMobileDraft(
  input: string,
  selectedCountry: CountryCode,
): { country: CountryCode; display: string } {
  const trimmed = input.trimStart();
  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (parsed?.country) {
      return {
        country: parsed.country,
        display: new AsYouType(parsed.country).input(parsed.nationalNumber),
      };
    }
    const formatter = new AsYouType();
    formatter.input(trimmed);
    const inferred = formatter.getCountry();
    if (inferred) {
      const number = formatter.getNumber();
      return {
        country: inferred,
        display: number
          ? new AsYouType(inferred).input(number.nationalNumber)
          : trimmed.replace(/^\+\d{1,3}/, ''),
      };
    }
  }
  return { country: selectedCountry, display: new AsYouType(selectedCountry).input(input) };
}

export function canonicalMobileNumber(input: string, country: CountryCode): string {
  const parsed = parsePhoneNumberFromString(input, country);
  if (!parsed?.isValid()) throw new Error(MOBILE_INVALID_MESSAGE);
  return parsed.number;
}

export function formatMobileForDisplay(value?: string | null): string {
  if (!value) return '';
  return parsePhoneNumberFromString(value)?.formatInternational() || value;
}
