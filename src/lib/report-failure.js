// Posts a workflow-failure notice to #bot-status. Called by CI on job failure:
//   node src/lib/report-failure.js "$GITHUB_RUN_ID"
import { readFileSync } from 'node:fs';
import { postMessage } from './discord.js';

const runId = process.argv[2] || '';
try {
  const discordCfg = JSON.parse(readFileSync('config/discord.json', 'utf8'));
  const chan = discordCfg.channels?.['bot-status'];
  if (!chan) process.exit(0);
  const url = runId ? `https://github.com/${process.env.GITHUB_REPOSITORY || 'safasites/newsdesk'}/actions/runs/${runId}` : '';
  await postMessage(chan, {
    embeds: [{
      description: `❌ Newsdesk run failed.${url ? ` [View logs](${url})` : ''}`,
      color: 0xed4245,
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  });
} catch (err) {
  console.error(`report-failure: ${err.message}`);
}
