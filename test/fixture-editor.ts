// The editor for the browser tests, with a harness that relays each run to the test's HTTP fixture at
// FIXTURE_HARNESS_URL: GET /access lists its processors, and POST /runs answers one run. An answer may list steps to
// show (activity) and requests to put to the person (asks) before its reply; each ask waits for the person's answer.
import { resolve } from 'node:path';
import type { AgentAsk } from 'celler/harness';
import { ZirbelError } from '../packages/core/projects.ts';
import { main } from '../packages/server/main.ts';
import type { ActivityEntry } from '../packages/sdk/chat-stream.ts';
import { fakeHarnesses } from './fake-harnesses.ts';

const fixture = process.env.FIXTURE_HARNESS_URL ?? '';
const { processors } = await (await fetch(fixture + '/access')).json() as { processors: { id: string; name: string }[] };
/** The working folder the fixture's requests name, as a real turn's would be. */
const FIXTURE_FOLDER = '/work/zirbel/turn-fixture';

type FixtureReply = { task: string; stopReason: string; text?: string; activity?: ActivityEntry[]; asks?: AgentAsk[] };

await main({
  webRoot: resolve('dist/web'),
  harnesses: () => fakeHarnesses(processors, async (processor, prompt, { signal, update, ask }) => {
    let reply: FixtureReply;
    try {
      const response = await fetch(fixture + '/runs', { method: 'POST', body: JSON.stringify({ processor, prompt }), signal });
      if (!response.ok) throw new ZirbelError(response.status, 'The harness connection could not complete the request.');
      reply = await response.json() as FixtureReply;
    } catch (error) {
      signal?.throwIfAborted(); // a stopped turn ends with its own reason
      throw error;
    }
    for (const entry of reply.activity ?? []) update?.({ type: 'activity', entry });
    const name = processors.find(({ id }) => id === processor)?.name;
    for (const question of reply.asks ?? []) await ask?.(question, signal ?? new AbortController().signal, { folder: FIXTURE_FOLDER, harness: name });
    signal?.throwIfAborted();
    return { task: reply.task, stopReason: reply.stopReason, text: reply.text };
  }),
});
