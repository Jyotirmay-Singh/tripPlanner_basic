/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';

const mockColors = {
  primary: '#123456',
  danger: '#ff0000',
  surfaceMuted: '#eeeeee',
};

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: mockColors }),
}));

import ProgressBar from '../ui/ProgressBar';

function renderProgress(progress: number, extra: Record<string, unknown> = {}) {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <ProgressBar testID="progress" progress={progress} {...extra} />,
    );
  });
  const track = renderer.root.findAllByProps({ testID: 'progress' })
    .find((node: any) => node.props.accessibilityRole === 'progressbar');
  if (!track) throw new Error('Accessible progress track was not rendered');
  const fill = track.findAllByType(View).at(-1);
  if (!fill || fill === track) throw new Error('Progress fill was not rendered');
  return { renderer, track, fill, fillStyle: StyleSheet.flatten(fill.props.style) };
}

describe('ProgressBar', () => {
  it.each([
    [0, '0%', 0],
    [0.5, '50%', 50],
    [1, '100%', 100],
    [-2, '0%', 0],
    [Number.NaN, '0%', 0],
  ])('clamps %p to a safe visual and accessible value', (progress, width, now) => {
    const { track, fillStyle } = renderProgress(progress);
    expect(fillStyle.width).toBe(width);
    expect(track.props.accessibilityRole).toBe('progressbar');
    expect(track.props.accessibilityValue).toEqual({ min: 0, max: 100, now });
  });

  it.each([1.5, Number.POSITIVE_INFINITY])(
    'caps %p at the end of the track and retains the danger state',
    (progress) => {
      const { track, fillStyle } = renderProgress(progress);
      expect(fillStyle.width).toBe('100%');
      expect(fillStyle.backgroundColor).toBe(mockColors.danger);
      expect(track.props.accessibilityValue.now).toBe(100);
    },
  );

  it('forwards an exact contextual accessibility description', () => {
    const description = 'INR 152,899.00 of INR 100,000.00; INR 52,899.00 over budget';
    const { track } = renderProgress(1.52899, {
      accessibilityLabel: 'Budget used',
      accessibilityValueText: description,
    });

    expect(track.props.accessibilityLabel).toBe('Budget used');
    expect(track.props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 100,
      text: description,
    });
  });

  it('honours an explicit fill colour without allowing overflow', () => {
    const { fillStyle } = renderProgress(2, { color: '#abcdef' });
    expect(fillStyle).toEqual(expect.objectContaining({
      width: '100%',
      backgroundColor: '#abcdef',
    }));
  });
});
