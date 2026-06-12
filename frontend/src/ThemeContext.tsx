import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';
import { COLORS, ColorScheme, Mode } from './theme';

type Ctx = {
  mode: Mode;
  colors: ColorScheme;
  toggle: () => void;
  setMode: (m: Mode) => void;
};

const ThemeCtx = createContext<Ctx>({
  mode: 'light',
  colors: COLORS.light,
  toggle: () => {},
  setMode: () => {},
});

const KEY = 'theme_mode';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<Mode>((system as Mode) || 'light');

  useEffect(() => {
    AsyncStorage.getItem(KEY).then(v => {
      if (v === 'light' || v === 'dark') setModeState(v);
    });
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    AsyncStorage.setItem(KEY, m);
  }, []);

  const toggle = useCallback(() => {
    setModeState(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      AsyncStorage.setItem(KEY, next);
      return next;
    });
  }, []);

  return (
    <ThemeCtx.Provider value={{ mode, colors: COLORS[mode], toggle, setMode }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);
