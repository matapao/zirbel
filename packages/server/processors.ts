import { z } from 'zod';
import type { RunSpec } from 'celler/harness';
import type { ChatUpdate } from '../sdk/chat-stream.ts';
import type { ModelSelection, ModelSettings } from '../sdk/model-settings.ts';

export const processorId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const modelId = z.string().min(1).max(240);
export const modelSelection = z.strictObject({ model: modelId.optional(), effort: modelId.optional() });

export type Processor = { id: string; name: string; ready?: boolean; signIn?: boolean; detail?: string; activity?: 'zirbel' | 'host'; modelSettings?: boolean };
type ProcessorReply = { name: string; task: string; stopReason: string; text?: string; usage?: { totalTokens: number } };
export type SignInStatus = { status: 'pending' | 'complete' | 'failed'; url?: string };
export type ProcessorRun = {
  signal?: AbortSignal;
  update?: (event: ChatUpdate) => void;
  ask?: RunSpec['ask'];
  selection?: ModelSelection;
};

export interface Processors {
  list(): Promise<Processor[]>;
  start(id: string, prompt: string, run?: ProcessorRun): Promise<ProcessorReply>;
  settings?(id: string, model?: string, signal?: AbortSignal): Promise<ModelSettings>;
  beginSignIn?(id: string): Promise<SignInStatus>;
  signInStatus?(id: string): SignInStatus;
  submitSignInCode?(id: string, code: string): SignInStatus;
}
