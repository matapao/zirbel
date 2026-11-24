// A harness provider for tests: it offers fixed processors and answers each run with reply.
import { ZirbelError } from '../packages/core/projects.ts';
import type { Processor, ProcessorRun, Processors } from '../packages/server/processors.ts';

type Reply = Omit<Awaited<ReturnType<Processors['start']>>, 'name'>;

export function fakeHarnesses(processors: Processor[],
  reply: (processor: string, prompt: string, run: ProcessorRun) => Promise<Reply>): Processors {
  return {
    list: () => Promise.resolve(processors),
    async start(id, prompt, run = {}) {
      const choice = processors.find((processor) => processor.id === id);
      if (!choice) throw new ZirbelError(403, 'This connection does not offer that harness.');
      run.update?.({ type: 'progress', phase: 'running' });
      return { name: choice.name, ...(await reply(id, prompt, run)) };
    },
  };
}
