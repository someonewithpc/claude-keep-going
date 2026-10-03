// Weekly-limit model fallback: when the session hits a limit scoped to one model ("You've
// hit your Opus limit · resets Oct 9, 10am"), switch to another model and continue instead
// of waiting days, then switch back once that limit resets.
//
// The banner names the model through Claude Code's limit labels: "Opus limit", "Sonnet
// limit", and so on. "session limit", "weekly limit" and the spend limits cover every
// model, so switching wouldn't help and the normal usage wait applies.

const ACCOUNT_WIDE = new Set(['session', 'weekly', 'monthly', 'usage', 'fast', 'spend', 'credit', 'channel', 'team']);

export function scopedModelFromBanner(message) {
  const m = /hit your ([A-Za-z][\w.-]*) limit/i.exec(message || '');
  if (!m || ACCOUNT_WIDE.has(m[1].toLowerCase())) return null;
  return m[1];
}

// The model to switch to for a banner model, from modelFallback.map (keys match without
// regard to case), or null.
export function fallbackTarget(config, model) {
  const mf = config.modelFallback;
  if (!mf || !mf.enabled || !model) return null;
  const key = Object.keys(mf.map).find((k) => k.toLowerCase() === model.toLowerCase());
  return key ? mf.map[key] : null;
}
