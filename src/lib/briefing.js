import { scoreBadge } from './discord.js';

/** Current date parts in Europe/London (DST-proof). */
export function londonNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour'), 10),
  };
}

/**
 * If it's past the briefing hour in London and today's briefing hasn't gone out, return
 * { payload, date }. The caller stamps state.lastBriefingDate only once Discord has
 * accepted the post — stamping it here would mark an undelivered briefing as sent and
 * suppress every retry for the rest of the day.
 */
export function briefingIfDue(state, cfg, now = Date.now()) {
  const { date, hour } = londonNow(new Date(now));
  if (hour < cfg.briefing.hourLondon || state.lastBriefingDate === date) return null;

  const dayAgo = now - 86400000;
  const top = Object.values(state.clusters)
    .filter((c) => !c.ghost && c.links.length > 0 && c.lastUpdate > dayAgo && c.score >= cfg.thresholds.normal)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.briefing.topN);

  if (top.length === 0) {
    state.lastBriefingDate = date; // nothing to say today, and no post to fail — safe here
    return null;
  }

  const lines = top.map((c, i) => {
    const primary = [...c.links].sort((x, y) => y.weight - x.weight)[0];
    return `**${i + 1}.** [${c.title.slice(0, 120)}](${primary.link}) — ${scoreBadge(c.score)} · ${c.brands.length} outlet(s)`;
  });

  const payload = {
    embeds: [{
      title: `☕ Daily briefing — ${new Date(now).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' })}`,
      description: lines.join('\n').slice(0, 4000),
      color: parseInt(cfg.colors.briefing, 16),
      footer: { text: 'Top stories of the last 24h · BritAsia news desk' },
      timestamp: new Date(now).toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
  return { payload, date };
}
