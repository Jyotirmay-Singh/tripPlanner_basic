/* global jest */

// Use the library's official host-component mock so unit tests never initialize native keyboard
// bindings. Native behavior is covered by TypeScript/config validation and release builds.
jest.mock('react-native-keyboard-controller', () => (
  require('react-native-keyboard-controller/jest')
));
