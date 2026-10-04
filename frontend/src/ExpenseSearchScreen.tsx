import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import {
  Keyboard, Platform, RefreshControl, ScrollView, StyleSheet, TextInput, View,
} from 'react-native';
import { KeyboardAvoidingView } from './KeyboardController';
import { useTheme } from './ThemeContext';
import { COMPONENT_SIZE, CONTENT_MAX_WIDTH, SPACING } from './theme';
import T from './T';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Input from './ui/Input';

export type ExpenseSearchScreenRef = {
  scrollToResult: (y: number) => void;
};

type Props = React.PropsWithChildren<{
  header: React.ReactNode;
  query: string;
  onChangeQuery: (query: string) => void;
  matchCount: number;
  transactionCount: number;
  refreshing: boolean;
  onRefresh: () => void;
}>;

/** Keep the search and its results together above the keyboard, with room to browse. */
const ExpenseSearchScreen = forwardRef<ExpenseSearchScreenRef, Props>(function ExpenseSearchScreen(
  { header, query, onChangeQuery, matchCount, transactionCount, refreshing, onRefresh, children },
  ref,
) {
  const { colors } = useTheme();
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const searchOpening = useRef(false);
  const toolbarHeight = useRef(0);
  const resultsY = useRef(0);
  const hasQuery = query.trim().length > 0;

  useImperativeHandle(ref, () => ({
    scrollToResult: (y) => scrollRef.current?.scrollTo({
      y: Math.max(0, resultsY.current + y - toolbarHeight.current - SPACING.sm),
      animated: false,
    }),
  }), []);

  const scrollToStart = () => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
  };
  const dismissKeyboard = () => {
    searchOpening.current = false;
    inputRef.current?.blur();
    Keyboard.dismiss();
  };
  const startSearch = () => {
    if (searching) return;
    searchOpening.current = true;
    setSearching(true);
    // Moving the field while its opening tap is being handled can blur it. Restore focus once
    // the compact layout has settled, without remounting the input or interrupting later taps.
    requestAnimationFrame(() => {
      if (!searchOpening.current) return;
      searchOpening.current = false;
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      inputRef.current?.focus();
    });
  };
  const finishSearch = () => {
    dismissKeyboard();
    setSearching(false);
    scrollToStart();
  };
  const changeQuery = (value: string) => {
    onChangeQuery(value);
    if (searching) scrollToStart();
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      style={styles.fill}
      testID="expense-search-screen"
    >
      <ScrollView
        ref={scrollRef}
        style={styles.fill}
        contentContainerStyle={styles.scrollContent}
        stickyHeaderIndices={[1]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive'
          : Platform.OS === 'android' ? 'on-drag' : 'none'}
        refreshControl={(
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        )}
        testID="expense-search-results-scroll"
      >
        <View
          style={[styles.column, styles.overview, searching && styles.hidden]}
          accessibilityElementsHidden={searching}
          importantForAccessibility={searching ? 'no-hide-descendants' : 'auto'}
          testID="expense-search-overview"
        >
          {header}
        </View>
        <View
          style={[styles.column, styles.toolbar, {
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          }]}
          onLayout={(event) => { toolbarHeight.current = event.nativeEvent.layout.height; }}
          testID="expense-search-toolbar"
        >
          <View style={styles.searchRow}>
            <Input
              ref={inputRef}
              value={query}
              onChangeText={changeQuery}
              onFocus={startSearch}
              onSubmitEditing={dismissKeyboard}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === 'Escape') finishSearch();
              }}
              placeholder="Search expense descriptions"
              icon="search"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search expense descriptions"
              accessibilityHint="Results update as you type below the search field"
              testID="expense-search-input"
              containerStyle={styles.input}
            />
            {query.length > 0 ? (
              <IconButton
                name="close"
                variant="surface"
                size={18}
                touchSize={COMPONENT_SIZE.minTouchTarget}
                onPress={() => { changeQuery(''); inputRef.current?.focus(); }}
                accessibilityLabel="Clear expense search"
                testID="expense-search-clear"
              />
            ) : null}
            {searching ? (
              <Button
                label="Done"
                variant="ghost"
                size="sm"
                onPress={finishSearch}
                accessibilityLabel="Finish expense search and hide keyboard"
                testID="expense-search-done"
                style={styles.done}
              />
            ) : null}
          </View>
          {hasQuery || searching ? (
            <T variant="caption" muted accessibilityLiveRegion="polite" testID="expense-search-count">
              {hasQuery
                ? `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`
                : `${transactionCount} ${transactionCount === 1 ? 'transaction' : 'transactions'}`}
            </T>
          ) : null}
        </View>
        <View
          style={[styles.column, styles.results]}
          onLayout={(event) => { resultsY.current = event.nativeEvent.layout.y; }}
          testID="expense-search-results"
        >
          {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
});

export default ExpenseSearchScreen;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  column: {
    width: '100%', maxWidth: CONTENT_MAX_WIDTH + SPACING.lg * 2,
    alignSelf: 'center', paddingHorizontal: SPACING.lg,
  },
  scrollContent: {
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.lg,
  },
  overview: { gap: SPACING.md, marginBottom: SPACING.sm },
  hidden: { display: 'none' },
  toolbar: { gap: SPACING.sm, paddingVertical: SPACING.sm, borderBottomWidth: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  input: { flex: 1, minWidth: 0 },
  done: { minHeight: COMPONENT_SIZE.minTouchTarget, paddingHorizontal: SPACING.sm },
  results: { paddingTop: SPACING.md },
});
