// Every test process (`node --test --import ./test/setup.ts`, and each file's process it starts) runs in UTC, whatever
// the computer's own zone, so a date in a test reads the same everywhere. test/determinism.test.ts holds it.
process.env.TZ = 'UTC';
