# Handoff prompt for a new chat

Paste everything below the line into a fresh session.

---

I'm continuing work on my BritAsia News Desk Discord bot. It's already built, deployed and running. Working directory: `C:\Users\Osama Asif\Downloads\.Xtras\NewsDiscordServer_Ai`. Read `README.md` and `config/scoring.json` before changing anything.

## What it is

I'm a freelance video editor at BritAsia News, a British-Asian media org in the UK. We're launching an Instagram news page. This bot gives my script writers a live news wire in Discord so they don't have to hunt for stories, and flags which ones are worth a carousel.

## Current state (all working)

- **Repo:** `iboyprime68-web/newsdesk` (public). The old `safasites/newsdesk` is migrated away and its workflow is **disabled** — don't re-enable it, two live copies would double-post.
- **Discord guild:** `1534235876337520671`. Bot app id `1534235966623977635`. Channel and role IDs are in `config/discord.json`.
- **Pipeline:** Node 22, one dependency (`rss-parser`). Reads 26 postable RSS feeds from 15 outlets, clusters the same story across outlets, scores it, posts embeds. BREAKING is 70+ with two outlets confirming and pings `@Breaking-Ping`; TOP is 48+; desks are 22+; below that is dropped.
- **Cadence:** cron is only a relauncher. Each run holds a 50-minute window and polls every 60 seconds from inside the job. The `concurrency` group keeps one window live; cron fires landing during a window queue and start the next one. This is copied from my own `iboyprime68-web/iboyprime-mma-bot`, which does the same with ~20s ticks.
- **AI:** OpenRouter, chain `z-ai/glm-5.2` → `z-ai/glm-4.7` → `deepseek/deepseek-v4-flash`, ordered by price. It scores each top story 0-100 for Instagram potential and writes a hook into `#instagram-ideas`.
- **State:** a single amended commit on the orphan `state` branch, force-pushed. Never let it accumulate history; the file is ~750KB and changes constantly.

## Things that will bite you if you don't know them

1. **Never mark work delivered before Discord accepts it.** Four separate bugs came from stamping a "done" marker (alert cooldowns, `lastBriefingDate`, `lastTrendDigestAt`, `postedBrandCount`) before the post, then persisting it when the post failed. One failed alert silenced 24 hours of warnings; one lost a whole daily briefing. Any `state.*` assignment that gates a retry must sit inside the success path of the try that does the network call.
2. **Failures are silent by construction.** Every Discord write is individually try/caught, so the job used to exit 0 even when all 18 posts failed. `run.js` now counts failures and sets `process.exitCode = 1`. Keep that.
3. **Timeouts must cover the response body**, not just the connection. Awaiting `fetch` resolves on headers; clearing the abort timer there let a stalled body hang a run for 8 minutes. `fetchWithTimeout` in `src/lib/http.js` reads the body inside the same deadline and returns `{ok, status, headers, text}` — it is not a `Response`.
4. **Secrets pick up an invisible BOM** if piped through PowerShell into `gh secret set`. Set them from Bash. `envValue()` in `src/lib/http.js` strips it defensively.
5. **OpenRouter:** the `models` fallback array takes at most 3. Account-level Allowed Providers and data policy at `openrouter.ai/settings/privacy` override anything the request asks for, and once made every model 404. GLM 5.1 is **more** expensive than 5.2 ($0.966/$3.036 vs $0.760/$2.420), so 5.1 is deliberately not in the chain.
6. **Never post test or example content to a content channel.** I found a fabricated story in `#instagram-ideas` that looked exactly like real output. Anything ad-hoc goes to `#bot-status`, or use `npm run dry`, which writes nothing.
7. **`gh` is authenticated as `safasites` by default.** For `iboyprime68-web` you need my PAT or `gh auth login` for that account. Ask me.

## Writing style: this is not optional

All channel topics, the `#welcome` post and both model prompts follow **github.com/realrossmanngroup/no_ai_slop_writing_rules**. Clone it and read `CLAUDE.md` plus `skills/no-ai-slop/references/ai-writing-detection.md` before writing any prose. No em dashes, no intensifiers, no filler openers, no "It's not X, it's Y", no hedging, no invented numbers or quotes. Every claim ends on something checkable. Scan your output against the banned lists before shipping.

## What I care about most

- **Don't spam my writers.** Only `#breaking-news` mentions a role, the guild default is mentions-only, and breaking is capped at 1 per run and 3 per hour so nobody ever gets two pings at once. Keep it that way.
- **Speed.** News should land within a minute or two of an outlet publishing.
- **Accuracy.** Writers publish from this. A wrong hook has my name on it, not the bot's.

## Open items

- `#instagram-ideas` category accuracy: story category comes from the feed, not the content, so Dawn's homepage feed occasionally drops a science or world story into `#south-asia`. Fixable now that the AI layer works.
- Tune `config/scoring.json` after watching a day of real output. Thresholds, keywords and caps are all config; no code changes needed.
- Phase 2, designed but not built: a Vercel interactions endpoint for a self-serve ping toggle, a "Claim story" button so two writers don't write the same story, and a right-click "Draft IG Carousel" command. Plan: `~/.claude/plans/i-run-a-discord-refactored-dragonfly.md`.

## First thing to do

Check the bot is still alive: confirm a window is running on `iboyprime68-web/newsdesk`, and that posts in the desk channels are minutes old rather than hours. If it's stalled, `gh workflow run newsdesk` starts a fresh window.
