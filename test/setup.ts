// Every test process (`node --test --import ./test/setup.ts`, and each file's process it starts) runs in UTC, whatever
// the computer's own zone, so a date in a test reads the same everywhere. test/determinism.test.ts holds it.
process.env.TZ = 'UTC';

// Node 26 gives each process one sessionStorage and one localStorage, where a browser gives each tab its own. The tests
// open several screens and pads in one process, each meant as a tab of its own, so they run without Web Storage, as on
// Node 24 and as a page whose storage is off (pads-client.ts keeps a screen's and a pad's tokens in memory then).
Reflect.deleteProperty(globalThis, 'sessionStorage');
Reflect.deleteProperty(globalThis, 'localStorage');
