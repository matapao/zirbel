// Harness turns, owned by the editor rather than by the request that started them: a turn runs until it ends or Stop
// ends it, and any number of requests stream it, from its first steps or from where it is when they attach. A turn
// that ended stays here for a while, so a page that comes back just after it ended still gets its result. What the
// harness asks during a turn waits here for one answer.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentAsk, AskAnswer } from '@matapao/celler/harness';
import { z } from 'zod';
import { newId, ZirbelError } from '../core/projects.ts';
import { boundEntry, TurnLog } from '../sdk/activity.ts';
import { chatStreamType, type ActionValue, type ActivityEntry, type ChatEvent, type ChatUpdate, type HarnessAction } from '../sdk/chat-stream.ts';
import type { Note } from '../sdk/contracts.ts';
import { describeAsk, type AskPlace } from './ask-summary.ts';
import { fail, failure, reply } from './http.ts';
import type { ProcessorRun } from './processors.ts';

/** How long an ended turn can still be attached to. */
const KEEP_ENDED = 10 * 60 * 1000;

const replySchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('dismiss') }),
  z.strictObject({ choice: z.literal('decline') }),
  z.strictObject({ choice: z.literal('option'), option: z.string().min(1).max(160) }),
  z.strictObject({ choice: z.literal('submit'), values: z.record(z.string().max(160),
    z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(400)).max(40)])) }),
]);

// The harness's options, by short names: its own when short, else what the option does.
const optionTitle = (name: string, kind: string) => name.length <= 24 ? name : kind.startsWith('allow') ? 'Allow once' : 'Reject';

function actionOf(question: AgentAsk, place: AskPlace = {}): HarnessAction {
  const id = newId();
  const title = question.title.slice(0, 2000);
  const { form } = question;
  if (form?.url) {
    const url = URL.parse(form.url);
    if (!url || url.protocol !== 'https:' || url.username || url.password)
      throw new ZirbelError(422, 'The harness requested an unsupported link.');
    return { id, title, kind: 'link', url: url.href, scope: 'outside', reach: 'Opens a web page' };
  }
  if (form) {
    const fields = form.fields ?? [];
    if (fields.length > 20 || fields.some(({ name, choices }) => name.length > 160 ||
        (choices?.length ?? 0) > 40 || choices?.some(({ value }) => value.length > 400)))
      throw new ZirbelError(422, 'The harness requested a form that exceeds the input limits.');
    return { id, title, kind: 'form', scope: 'outside', reach: 'Sends what you enter to ' + (place.harness ?? 'the harness'),
      fields: fields.map((field) => ({ ...field, title: field.title.slice(0, 400),
        description: field.description?.slice(0, 800), choices: field.choices?.map(({ value, label }) => ({ value, label: label.slice(0, 400) })),
      })) };
  }
  const input = JSON.stringify(question.input, null, 2);
  const detail = input && input.length <= 12_000 ? input : undefined;
  const options = question.options.filter(({ optionId, kind }) => optionId.length <= 160 &&
    (kind === 'reject_once' || (kind === 'allow_once' && detail)))
    .slice(0, 12).map(({ optionId, name, kind }) => ({ id: optionId, title: optionTitle(name.slice(0, 200), kind) }));
  return { id, title, kind: 'permission', ...describeAsk(question, place),
    detail: detail ?? 'The harness did not provide action details for approval.', options };
}

/** A request as a step of the turn: its headline, and once it closes, the answer it got. */
function requestEntry(action: HarnessAction, answer?: string): ActivityEntry {
  const headline = action.kind === 'permission' ? action.summary : action.kind === 'link' ? 'Open a web page' : action.title || 'Fill in a form';
  const parts = [answer, action.kind === 'permission' ? action.reason : undefined, action.reach,
    action.kind === 'permission' ? action.command ?? action.file : action.kind === 'link' ? action.url : action.title];
  return { id: 'request:' + action.id, kind: 'request', title: headline, detail: parts.filter(Boolean).join('\n\n'),
    state: answer === undefined ? 'waiting' : 'completed', ...(action.kind === 'permission' && action.diff ? { diff: action.diff } : {}) };
}

function answerText(action: HarnessAction, answer: AskAnswer | null) {
  if (!answer) return 'Not answered';
  if ('option' in answer) {
    const chosen = action.kind === 'permission' ? action.options.find(({ id }) => id === answer.option)?.title : undefined;
    return 'Answered: ' + (chosen ?? answer.option);
  }
  return answer.accept ? (action.kind === 'link' ? 'Continued' : 'Sent') : 'Declined';
}

function formValue(field: Extract<HarnessAction, { kind: 'form' }>['fields'][number], value: ActionValue) {
  const { type, choices } = field;
  if (type === 'array') return Array.isArray(value) && value.every((item) => !choices || choices.some(({ value }) => value === item));
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === type && (!choices || choices.some((choice) => choice.value === value));
}

/** Why a turn's signal aborts when the editor stops: the turn is interrupted, not stopped by the person. */
export class EditorStopping extends ZirbelError {
  constructor() { super(503, 'The editor stopped while the turn was running.'); }
}

type PendingAction = { action: HarnessAction; answer: (answer: AskAnswer | null) => void };
type Outcome = { result: unknown } | { error: unknown };
type Listener = (event: ChatEvent<unknown>) => void;

/** One turn: what it has shown so far, what it waits on, and once it ends, its outcome. */
export class ActiveTurn {
  readonly id = newId();
  readonly startedAt = new Date().toISOString();
  readonly log = new TurnLog();
  readonly actions = new Map<string, PendingAction>();
  readonly controller = new AbortController();
  readonly listeners = new Set<Listener>();
  phase?: Extract<ChatUpdate, { type: 'progress' }>['phase'];
  outcome?: Outcome;
  finished!: Promise<Outcome>;

  constructor(readonly thread: string, readonly name: string, readonly text: string, public note?: Note) {}

  /** What a request that attaches now is sent first: the turn as it stands. */
  snapshot(): ChatEvent<unknown>[] {
    return [
      { type: 'run', id: this.id },
      ...(this.note ? [{ type: 'note' as const, note: this.note }] : []),
      ...(this.phase ? [{ type: 'progress' as const, phase: this.phase }] : []),
      ...[...this.log.entries.values()].map((entry) => ({ type: 'activity' as const, entry })),
      ...[...this.actions.values()].map(({ action }) => ({ type: 'action' as const, action })),
    ];
  }

  get running() { return !this.outcome; }
}

export class ChatRuns {
  /** Turns by id, running or ended a little while ago; and the running one of each thread. */
  private turns = new Map<string, ActiveTurn>();
  private threads = new Map<string, ActiveTurn>();

  /** Starts a turn in a thread that has none running. The handler runs it to its end, whoever streams it. */
  start(thread: string, meta: { name: string; text: string; note?: Note },
    handler: (run: ProcessorRun, turn: ActiveTurn) => Promise<unknown>) {
    if (this.threads.has(thread)) throw new ZirbelError(409, 'A turn is already running in this thread. Stop it, or wait for it to end.');
    const turn = new ActiveTurn(thread, meta.name, meta.text, meta.note);
    this.turns.set(turn.id, turn);
    this.threads.set(thread, turn);
    const { signal } = turn.controller;
    const send = (event: ChatEvent<unknown>) => { for (const listener of turn.listeners) listener(event); };
    const update = (event: ChatUpdate) => {
      if (event.type === 'activity') {
        const entry = boundEntry(event.entry);
        turn.log.add(entry);
        send({ type: 'activity', entry });
        return;
      }
      if (event.type === 'progress') turn.phase = event.phase;
      if (event.type === 'note') turn.note = event.note;
      send(event);
    };
    const ask = async (question: AgentAsk, withdrawn: AbortSignal, place?: AskPlace) => {
      const waiting = AbortSignal.any([signal, withdrawn]);
      if (waiting.aborted) return null;
      let action: HarnessAction;
      try { action = actionOf(question, place); }
      catch (error) {
        update({ type: 'activity', entry: { id: newId(), kind: 'notice', title: (error as Error).message } });
        return null;
      }
      const pending = Promise.withResolvers<AskAnswer | null>();
      const cancel = () => pending.resolve(null);
      waiting.addEventListener('abort', cancel, { once: true });
      turn.actions.set(action.id, { action, answer: pending.resolve });
      update({ type: 'activity', entry: requestEntry(action) });
      update({ type: 'action', action });
      let answer: AskAnswer | null = null;
      try { answer = await pending.promise; return answer; }
      finally {
        waiting.removeEventListener('abort', cancel);
        turn.actions.delete(action.id);
        update({ type: 'activity', entry: requestEntry(action, answerText(action, answer)) });
        update({ type: 'action-closed', id: action.id });
      }
    };
    turn.finished = Promise.resolve()
      .then(() => handler({ signal, update, ask }, turn))
      .then((result) => ({ result }), (error: unknown) => ({ error }))
      .then((outcome: Outcome) => {
        turn.outcome = outcome;
        turn.controller.abort(new ZirbelError(409, 'This turn has already ended.'));
        this.threads.delete(thread);
        setTimeout(() => this.turns.delete(turn.id), KEEP_ENDED).unref();
        return outcome;
      });
    return turn;
  }

  /** The turn running in a thread, if one is. */
  running(thread: string) { return this.threads.get(thread); }

  get(id: string) {
    const turn = this.turns.get(id);
    if (!turn) throw new ZirbelError(404, 'This turn has already ended.');
    return turn;
  }

  /** How many turns are running. */
  get count() { return this.threads.size; }

  stop(id: string) {
    const turn = this.turns.get(id);
    if (!turn?.running) throw new ZirbelError(404, 'This turn has already ended.');
    turn.controller.abort(new ZirbelError(409, 'Turn stopped.'));
  }

  /** Stops the turns running in the threads that match, and waits for them to end. */
  async stopThreads(matches: (thread: string) => boolean) {
    const stopping = [...this.threads.values()].filter(({ thread }) => matches(thread));
    for (const turn of stopping) turn.controller.abort(new ZirbelError(409, 'Turn stopped.'));
    await Promise.all(stopping.map(({ finished }) => finished));
  }

  /** As the editor stops: every running turn is interrupted, to be continued later. */
  async close() {
    const running = [...this.threads.values()];
    for (const turn of running) turn.controller.abort(new EditorStopping());
    await Promise.all(running.map(({ finished }) => finished));
  }

  answer(id: string, actionId: string, input: unknown) {
    const turn = this.turns.get(id);
    const pending = turn?.actions.get(actionId);
    if (!pending || !turn?.running) throw new ZirbelError(404, 'This request is no longer open.');
    const { action } = pending;
    const reply = replySchema.parse(input);
    let answer: AskAnswer | null = null;
    if (reply.choice === 'option') {
      if (action.kind !== 'permission' || !action.options.some(({ id }) => id === reply.option))
        throw new ZirbelError(422, 'Choose an option offered by the harness.');
      answer = { option: reply.option };
    } else if (reply.choice === 'decline' && action.kind !== 'permission') {
      answer = { accept: false };
    } else if (reply.choice === 'submit') {
      if (action.kind === 'permission') throw new ZirbelError(422, 'Choose an option offered by the harness.');
      const fields = action.kind === 'form' ? action.fields : [];
      for (const field of fields) {
        const value = Object.hasOwn(reply.values, field.name) ? reply.values[field.name] : undefined;
        if (value === undefined ? field.required : !formValue(field, value))
          throw new ZirbelError(422, 'Check the value for ' + field.title + '.');
      }
      answer = { accept: true, content: Object.fromEntries(fields.flatMap(({ name }) =>
        Object.hasOwn(reply.values, name) ? [[name, reply.values[name]]] : [])) };
    }
    turn.actions.delete(actionId);
    pending.answer(answer);
  }
}

const outcomeEvent = (outcome: Outcome): ChatEvent<unknown> =>
  'error' in outcome ? { type: 'error', error: failure(outcome.error).message } : { type: 'result', result: outcome.result };

/** Streams a turn to one request: as it stands, then each step as it comes, then its outcome. The request closing
 *  only stops the stream. A request that doesn't ask for the stream gets the outcome as JSON, once the turn ends. */
export async function streamTurn(request: IncomingMessage, response: ServerResponse, turn: ActiveTurn, status = 200) {
  if (response.destroyed) return;
  if (request.headers.accept !== chatStreamType) {
    const outcome = await turn.finished;
    if (response.destroyed) return;
    if ('error' in outcome) fail(response, outcome.error);
    else reply(response, outcome.result, status);
    return;
  }
  response.writeHead(status, { 'content-type': chatStreamType + '; charset=utf-8', 'cache-control': 'no-store' });
  response.flushHeaders();
  const write = (event: ChatEvent<unknown>) => {
    if (response.destroyed) return;
    if (response.writableLength > 2_000_000) { response.destroy(); return; }
    response.write(JSON.stringify(event) + '\n');
  };
  for (const event of turn.snapshot()) write(event);
  if (turn.outcome) { write(outcomeEvent(turn.outcome)); response.end(); return; }
  const closed = Promise.withResolvers<undefined>();
  const close = () => closed.resolve(undefined);
  response.once('close', close);
  turn.listeners.add(write);
  const heartbeat = setInterval(() => write({ type: 'heartbeat' }), 15_000).unref();
  try {
    const outcome = await Promise.race([turn.finished, closed.promise]);
    if (outcome) write(outcomeEvent(outcome));
  } finally {
    clearInterval(heartbeat);
    turn.listeners.delete(write);
    response.removeListener('close', close);
    response.end();
  }
}
