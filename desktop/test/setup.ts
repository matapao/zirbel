// Every test process (`node --test --import ./dist/test/setup.js`, and each file's process it starts) runs in UTC,
// whatever the computer's own zone. routes.test.ts holds it.
process.env.TZ = 'UTC';
