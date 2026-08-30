import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as NavigationBar from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import { useTheme } from './ThemeContext';
import { themedNavigationStyle, type SystemBarIconStyle } from './systemBars';

type Override = { id: number; status: SystemBarIconStyle; navigation: SystemBarIconStyle };
type SystemBarsContextValue = {
  register: (entry: Override) => void;
  unregister: (id: number) => void;
};

const SystemBarsContext = createContext<SystemBarsContextValue | null>(null);
let nextOverrideId = 1;

export default function AppSystemBars({ children }: { children: React.ReactNode }) {
  const { colors, mode } = useTheme();
  const [overrides, setOverrides] = useState<Override[]>([]);
  const register = useCallback((entry: Override) => {
    setOverrides((current) => [...current.filter((item) => item.id !== entry.id), entry]);
  }, []);
  const unregister = useCallback((id: number) => {
    setOverrides((current) => current.filter((item) => item.id !== id));
  }, []);
  const contextValue = useMemo(() => ({ register, unregister }), [register, unregister]);

  const themeStyle: Override = {
    id: 0,
    status: mode === 'dark' ? 'light' : 'dark',
    navigation: themedNavigationStyle(mode, Platform.OS, Platform.Version),
  };
  const effective = overrides[overrides.length - 1] ?? themeStyle;

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void NavigationBar.setButtonStyleAsync(effective.navigation).catch(() => {});
  }, [effective.navigation]);

  return (
    <SystemBarsContext.Provider value={contextValue}>
      <StatusBar animated style={effective.status} />
      {children}
    </SystemBarsContext.Provider>
  );
}

export function useSystemBarsOverride(
  active: boolean,
  style: { status: SystemBarIconStyle; navigation: SystemBarIconStyle },
) {
  const context = useContext(SystemBarsContext);
  const id = useRef(nextOverrideId++).current;
  const { status, navigation } = style;

  useEffect(() => {
    if (!active || !context) return;
    context.register({ id, status, navigation });
    return () => context.unregister(id);
  }, [active, context, id, navigation, status]);
}
