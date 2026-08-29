/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../ProfileAvatarButton', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ProfileAvatarButton', props) };
});

import TabPageHeader, { shouldUseCompactHeaderAction } from '../TabPageHeader';

describe('TabPageHeader', () => {
  it('uses the compact action on narrow screens and at accessibility font scales', () => {
    expect(shouldUseCompactHeaderAction(320, 1)).toBe(true);
    expect(shouldUseCompactHeaderAction(360, 1)).toBe(true);
    expect(shouldUseCompactHeaderAction(393, 1)).toBe(false);
    expect(shouldUseCompactHeaderAction(412, 1.3)).toBe(true);
    expect(shouldUseCompactHeaderAction(480, 1)).toBe(false);
  });

  it('renders its title, eyebrow, action, and inline profile shortcut', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TabPageHeader
          title="Trips"
          eyebrow="Welcome"
          action={<View testID="header-action" />}
        />,
      );
    });

    const root = renderer!.root;
    expect(root.findAllByType('T' as any).map((node: any) => node.props.children)).toEqual(['Welcome', 'Trips']);
    expect(root.findByType('ProfileAvatarButton' as any)).toBeTruthy();
    expect(root.findByProps({ testID: 'header-action' })).toBeTruthy();
  });
});
