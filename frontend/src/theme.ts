// Theme + Design tokens
export type Mode = 'light' | 'dark';

export const COLORS = {
  light: {
    background: '#F7F5F0',
    surface: '#FFFFFF',
    surfaceMuted: '#EDEBE3',
    primary: '#1C3F39',
    primaryText: '#F7F5F0',
    textMain: '#121A18',
    textMuted: '#5C6B67',
    border: '#DCD9CE',
    owing: '#E05D3D',
    owed: '#6B8E6B',
    warning: '#D4A373',
  },
  dark: {
    background: '#0A0D0C',
    surface: '#121715',
    surfaceMuted: '#1A221F',
    primary: '#87C0B2',
    primaryText: '#0A0D0C',
    textMain: '#F7F5F0',
    textMuted: '#8EA39D',
    border: '#24302C',
    owing: '#FF8A66',
    owed: '#8FC98F',
    warning: '#F5C28F',
  },
} as const;

export type ColorScheme = typeof COLORS.light;

export const SPACING = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

export const CATEGORIES = [
  'Travel',
  'Accommodation',
  'Local Transportation',
  'Local Sightseeing',
  'Food',
  'Shopping',
  'Other',
] as const;

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'JPY', 'SGD', 'AUD'];
