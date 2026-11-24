// The few chat messages the editor answers itself, without the harness: undo, and apply or discard a staged
// proposal. The game always runs, so there is nothing to start or stop.
export function chatControl(text: string) {
  const clean = text.toLowerCase().trim().replace(/[.!?]+$/, '').replace(/^please\s+|\s+please$/g, '');
  if (/^(?:undo|revert)(?:\s+(?:(?:the |my )?last (?:change|edit)|that|it))?$/.test(clean)) return { action: 'undo' as const };
  const option = clean.match(/\b(?:option|proposal)\s+([a-c1-3])\b/)?.[1];
  const index = option ? 'abc'.includes(option) ? 'abc'.indexOf(option) : Number(option) - 1 : undefined;
  const adjustment = clean.match(/^(?:can you\s+)?(apply|accept|discard|reject)(?:\s+(?:this|that|it|the change|(?:option|proposal)\s+[a-c1-3]))?$/);
  if (adjustment) return { action: adjustment[1] === 'apply' || adjustment[1] === 'accept' ? 'apply' as const : 'discard' as const, index };
}
