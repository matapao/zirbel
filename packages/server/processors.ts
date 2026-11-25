import { z } from 'zod';
import type { AgentAsk, AskAnswer, McpServerSpec, RunResult } from '@matapao/celler/harness';
import { ZirbelError } from '../core/projects.ts';
import type { ChatUpdate } from '../sdk/chat-stream.ts';
import type { AskPlace } from './ask-summary.ts';
import type { ModelSelection, ModelSettings } from '../sdk/model-settings.ts';

export const processorId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const modelId = z.string().min(1).max(240);
export const modelSelection = z.strictObject({ model: modelId.optional(), effort: modelId.optional() });

export type Processor = { id: string; name: string; ready?: boolean; signIn?: boolean; detail?: string; modelSettings?: boolean };
/** Why a harness's turn ended without its reply, where that is known for certain. */
export type TurnEnded = NonNullable<RunResult['ended']>;
type ProcessorReply = {
  name: string; task: string; stopReason: string; text?: string; usage?: { totalTokens: number };
  /** The session the turn ran in, which a later turn of the thread resumes. */
  sessionId?: string;
};

/** A turn's end in plain words, for the thread. */
function endedText(name: string, ended: TurnEnded) {
  switch (ended) {
    case 'timed-out': return name + ' ran out of time for this turn.';
    case 'usage-limit': return name + ' reached its account’s usage limit. Send the message again once the limit resets.';
    case 'max-turns': return name + ' stopped at the most steps it takes in one turn. Send a message to continue.';
    case 'session-not-found': return name + ' no longer has this thread’s session.';
  }
}

/** A turn that ended without its reply for a reason the harness knows for certain. */
export class TurnEndedError extends ZirbelError {
  constructor(name: string, readonly ended: TurnEnded) { super(502, endedText(name, ended)); }
}

export type SignInStatus = { status: 'pending' | 'complete' | 'failed'; url?: string };
/** Where a turn works: its thread's folder, the session it continues, its MCP servers and what else it may read. */
type TurnPlace = { cwd: string; sessionId?: string; resume: boolean; mcpServers?: McpServerSpec[]; readable?: string[] };
export type ProcessorRun = {
  signal?: AbortSignal;
  update?: (event: ChatUpdate) => void;
  /** Puts a request to the person: place says which harness asks, and from which working folder. */
  ask?: (question: AgentAsk, withdrawn: AbortSignal, place?: AskPlace) => Promise<AskAnswer | null>;
  selection?: ModelSelection;
  /** The thread's folder and session. Without one, the turn works in a folder of its own that goes after it. */
  place?: TurnPlace;
  /** Hears the session's id as soon as the harness names it. */
  session?: (sessionId: string) => void;
};

export interface Processors {
  list(): Promise<Processor[]>;
  start(id: string, prompt: string, run?: ProcessorRun): Promise<ProcessorReply>;
  settings?(id: string, model?: string, signal?: AbortSignal): Promise<ModelSettings>;
  beginSignIn?(id: string): Promise<SignInStatus>;
  signInStatus?(id: string): SignInStatus;
  submitSignInCode?(id: string, code: string): SignInStatus;
  /** Removes what the harness keeps of a session that ran in cwd: once the thread it belonged to is gone. */
  removeSession?(id: string, session: { cwd: string; sessionId: string }): Promise<void>;
  /** Stops the turns still running and waits until what they left is gone. */
  close?(): Promise<void>;
}
