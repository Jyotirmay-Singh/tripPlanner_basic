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
    // Semantic aliases so call-sites read by intent (danger/success) rather than
    // by domain term (owing/owed). Same hues — one source of truth.
    danger: '#E05D3D',
    success: '#6B8E6B',
    // Subtle translucent fill for chips sitting on the (dark) primary card.
    overlayOnPrimary: 'rgba(255,255,255,0.15)',
    // Scrim behind modals / bottom sheets.
    scrim: 'rgba(18,26,24,0.45)',
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
    danger: '#FF8A66',
    success: '#8FC98F',
    // Dark primary card is light teal, so a dark overlay keeps the chip legible.
    overlayOnPrimary: 'rgba(0,0,0,0.12)',
    scrim: 'rgba(0,0,0,0.6)',
  },
} as const;

// Use string (not the per-mode literal hex) so light and dark share one structural type
// and `COLORS[mode]` is assignable to it.
export type ColorScheme = { [K in keyof typeof COLORS.light]: string };

export const SPACING = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

// Shared layout metrics. `scrollBottomInset` clears the floating tab bar at the
// bottom of every scroll screen; `screenPadding` is the standard screen gutter.
export const LAYOUT = { screenPadding: SPACING.lg, scrollBottomInset: 120 } as const;

// Shared metrics for text-input controls, so every form renders identically.
export const CONTROL = { paddingY: 14, fontSize: 16, radius: RADIUS.md } as const;

// ---------- Typography tokens ----------
// Font families loaded from @expo-google-fonts in app/_layout.tsx. Headings + numbers
// use Outfit (geometric punch); body copy uses Figtree. The weight is baked into the
// family name, so styles set `fontFamily` and do NOT also set `fontWeight` (which would
// trigger faux-bold on some platforms). See design_guidelines.json.
export const FONTS = {
  heading: 'Outfit_600SemiBold',
  headingBold: 'Outfit_700Bold',
  headingMedium: 'Outfit_500Medium',
  body: 'Figtree_400Regular',
  bodyMedium: 'Figtree_500Medium',
  bodySemibold: 'Figtree_600SemiBold',
  bodyBold: 'Figtree_700Bold',
  number: 'Outfit_600SemiBold',
  numberBold: 'Outfit_700Bold',
} as const;

// The only font sizes allowed in the app. Pick from these — no ad-hoc values.
export const TYPESCALE = {
  xs: 12,
  sm: 13,
  base: 14,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  display: 40,
} as const;

// Subtle elevation. Flat 1px-bordered surfaces remain the default (per spec); this is
// the ceiling, reserved for floating elements (sheets, the FAB, raised CTAs).
export const SHADOW = {
  none: {},
  card: {
    shadowColor: '#0A0D0C',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  sheet: {
    shadowColor: '#0A0D0C',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
} as const;

// Motion tokens. Durations in ms; PRESS_SCALE is the tactile button squeeze.
export const MOTION = { fast: 150, base: 200, slow: 320 } as const;
export const PRESS_SCALE = 0.97;

// Default stroke width for lucide icons (design_guidelines.json: 1.5).
export const ICON_STROKE = 1.5;

// Max content width on wide (web/tablet) viewports so layouts stay readable.
export const CONTENT_MAX_WIDTH = 640;

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
