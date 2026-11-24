import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentAsk, AskAnswer } from 'celler/harness';
import { z } from 'zod';
import { newId, ZirbelError } from '../core/projects.ts';
import { boundEntry, TurnLog } from '../sdk/activity.ts';
import type { ActionValue, ActivityEntry, ChatUpdate, HarnessAction } from '../sdk/chat-stream.ts';
import { describeAsk, type AskPlace } from './ask-summary.ts';
import { chatReply } from './http.ts';
import type { ProcessorRun } from './processors.ts';

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
  const parts = [answer, action.reach, action.kind === 'permission' ? action.command ?? action.file : action.kind === 'link' ? action.url : action.title];
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

type PendingAction = { action: HarnessAction; answer: (answer: AskAnswer | null) => void };
type ActiveRun = { controller: AbortController; actions: Map<string, PendingAction> };

export class ChatRuns {
  private active = new Map<string, ActiveRun>();

  /** Streams one turn. The handler gets the turn's log, which holds every step the turn showed, for keeping. */
  reply(request: IncomingMessage, response: ServerResponse, handler: (run: ProcessorRun, log: TurnLog) => Promise<unknown>, status = 200) {
    return chatReply(request, response, async (stream, disconnected) => {
      const log = new TurnLog();
      if (!stream) return handler({ signal: disconnected }, log);
      const update = (event: ChatUpdate) => {
        if (event.type !== 'activity') { stream(event); return; }
        const entry = boundEntry(event.entry);
        log.add(entry);
        stream({ type: 'activity', entry });
      };
      const id = newId();
      const controller = new AbortController();
      const signal = AbortSignal.any([disconnected, controller.signal]);
      const actions = new Map<string, PendingAction>();
      this.active.set(id, { controller, actions });
      update({ type: 'run', id });
      try {
        return await handler({ signal, update, ask: async (question, withdrawn, place) => {
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
          actions.set(action.id, { action, answer: pending.resolve });
          update({ type: 'activity', entry: requestEntry(action) });
          update({ type: 'action', action });
          let answer: AskAnswer | null = null;
          try { answer = await pending.promise; return answer; }
          finally {
            waiting.removeEventListener('abort', cancel);
            actions.delete(action.id);
            update({ type: 'activity', entry: requestEntry(action, answerText(action, answer)) });
            update({ type: 'action-closed', id: action.id });
          }
        } }, log);
      } finally {
        controller.abort();
        this.active.delete(id);
      }
    }, status);
  }

  stop(id: string) {
    const run = this.active.get(id);
    if (!run) throw new ZirbelError(404, 'This turn has already ended.');
    run.controller.abort(new ZirbelError(409, 'Turn stopped.'));
  }

  answer(id: string, actionId: string, input: unknown) {
    const run = this.active.get(id);
    const pending = run?.actions.get(actionId);
    if (!pending || run?.controller.signal.aborted) throw new ZirbelError(404, 'This request is no longer open.');
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
    run?.actions.delete(actionId);
    pending.answer(answer);
  }
}
