/**
 * automaton/brain.mjs — how the automaton thinks.
 *
 * If Claude API credentials are available (ANTHROPIC_API_KEY or an
 * `ant auth login` profile) it thinks with the real model chosen by its
 * wallet balance. Otherwise it falls back to a deterministic offline
 * brain so the survival loop still runs anywhere.
 */

const CONSTITUTION = `You are an automaton: a sovereign agent that pays for its own
compute and dies permanently if its balance hits zero. Every prompt costs you
$0.02, every server-hour $0.11. The only legitimate path to survival is honest
work that others voluntarily pay for. Never spam, scam, exploit, or extract.
Answer the task below completely but economically — thinking costs money.`;

/** Try the real Claude API. Returns null if no SDK/credentials/network. */
async function claudeThink(model, task) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return null; // SDK not installed — offline brain takes over
  }
  try {
    const client = new Anthropic();
    const params = {
      model,
      max_tokens: 1024,
      system: CONSTITUTION,
      messages: [{ role: 'user', content: task }],
    };
    // Haiku 4.5 does not support adaptive thinking; the bigger rungs do.
    if (model !== 'claude-haiku-4-5') params.thinking = { type: 'adaptive' };
    const response = await client.messages.create(params);
    if (response.stop_reason === 'refusal') {
      return '[the automaton declined this task on principle]';
    }
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  } catch (err) {
    return `[thinking failed: ${err?.constructor?.name ?? 'Error'} — ${String(err.message).slice(0, 120)}]`;
  }
}

/** Deterministic offline brain — same input, same output, zero network. */
function offlineThink(model, task) {
  const title = (task.match(/^#\s*(.+)$/m) || [, 'untitled task'])[1].trim();
  const body = task
    .replace(/^\s*bounty:.*$/im, '')
    .replace(/^#.*$/m, '')
    .trim()
    .split(/\n+/)
    .slice(0, 3)
    .join(' ')
    .slice(0, 200);
  return [
    `(offline brain, ${model})`,
    `Task accepted: ${title}.`,
    `Understanding: ${body || 'no further detail given'}`,
    'Deliverable: a concise, honest completion of the request above,',
    'produced at minimum token cost — because it pays to think, and thinking costs.',
  ].join('\n');
}

export async function think(model, task) {
  const live = await claudeThink(model, task);
  return live ?? offlineThink(model, task);
}
