export function chatControl(text: string) {
  const clean = text.toLowerCase().trim().replace(/[.!?]+$/, '').replace(/^please\s+|\s+please$/g, '');
  if (/^(?:undo|revert)(?:\s+(?:(?:the |my )?last (?:change|edit)|that|it))?$/.test(clean)) return { action: 'undo' as const };
  const option = clean.match(/\b(?:option|proposal)\s+([a-c1-3])\b/)?.[1];
  const index = option ? 'abc'.includes(option) ? 'abc'.indexOf(option) : Number(option) - 1 : undefined;
  // "this" is only a word, not also a determiner: matching it both ways let "run this it this it …" backtrack exponentially.
  if (/^(?:can (?:i|we|you)\s+)?(?:play|start|run|launch|test)(?:\s+(?:(?:the|my|current)\s+)?(?:game|playtest|preview|it|this|now))*$/.test(clean))
    return { action: 'play' as const };
  if (/^(?:please )?(?:stop|end|close)(?:\s+(?:the\s+|this\s+)?(?:game|playtest|preview|playing|it))?$|^(?:go back to|return to) (?:the )?editor$/.test(clean))
    return { action: 'stop' as const };
  const adjustment = clean.match(/^(?:can you\s+)?(apply|accept|preview|review|discard|reject)(?:\s+(?:this|that|it|the change|(?:option|proposal)\s+[a-c1-3]))?(?:\s+and\s+(?:play|start|run)(?:\s+it)?)?$/);
  if (adjustment) {
    const action = adjustment[1] === 'accept' ? 'apply' : adjustment[1] === 'review' ? 'preview' : adjustment[1] === 'reject' ? 'discard' : adjustment[1];
    return { action: action as 'apply' | 'preview' | 'discard', index, play: /\band\s+(?:play|start|run)\b/.test(clean) };
  }
}

export function requestsPlay(text: string) {
  return /\b(?:and then|and|then)\s+(?:play|run|launch|start)(?:\s+(?:it|the game|the draft|a playtest))?\s*[.!]?$/i.test(text);
}
