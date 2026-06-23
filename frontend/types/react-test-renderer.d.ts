// Minimal ambient types for react-test-renderer (used only by the component tests under
// src/__tests__/screens). react-test-renderer@19 ships no bundled types and there is no matching
// @types package for v19, so this shim declares just the surface the tests touch. Kept outside
// src/__tests__ so jest never tries to collect a .d.ts as a test suite.
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export interface ReactTestInstance {
    type: unknown;
    props: { [key: string]: any };
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    unmount(): void;
    toJSON(): unknown;
  }

  export function create(element: ReactElement, options?: unknown): ReactTestRenderer;
  export function act(callback: () => void | Promise<void>): Promise<void> | void;

  const TestRenderer: { create: typeof create; act: typeof act };
  export default TestRenderer;
}
