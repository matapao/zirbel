// The editor for test/browser.mjs, with a harness that relays each run to the test's HTTP fixture at
// FIXTURE_HARNESS_URL: GET /access lists its processors, and POST /runs answers one run.
import { resolve } from 'node:path';
import { ZirbelError } from '../packages/core/projects.ts';
import { main } from '../packages/server/main.ts';
import { fakeHarnesses } from './fake-harnesses.ts';

const fixture = process.env.FIXTURE_HARNESS_URL ?? '';
const { processors } = await (await fetch(fixture + '/access')).json() as { processors: { id: string; name: string }[] };

await main({
  webRoot: resolve('dist/web'),
  harnesses: () => fakeHarnesses(processors, async (processor, prompt, { signal }) => {
    try {
      const response = await fetch(fixture + '/runs', { method: 'POST', body: JSON.stringify({ processor, prompt }), signal });
      if (!response.ok) throw new ZirbelError(response.status, 'The harness connection could not complete the request.');
      return await response.json() as { task: string; stopReason: string; text?: string };
    } catch (error) {
      signal?.throwIfAborted(); // a stopped turn ends with its own reason
      throw error;
    }
  }),
});
