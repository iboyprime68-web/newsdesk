// One-time (idempotent) server builder. Creates roles, categories, channels and
// permissions from setup/blueprint.json, then writes config/discord.json.
//   Needs .env: DISCORD_BOT_TOKEN, GUILD_ID.  Run: npm run setup:server
import { readFileSync, writeFileSync } from 'node:fs';
import { api } from '../src/lib/discord.js';

const GUILD_ID = process.env.GUILD_ID;
if (!GUILD_ID) {
  console.error('GUILD_ID missing from environment (.env)');
  process.exit(1);
}

const P = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  ADD_REACTIONS: 1n << 6n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
};
const bits = (...names) => names.reduce((acc, n) => acc | P[n], 0n).toString();

const blueprint = JSON.parse(readFileSync('setup/blueprint.json', 'utf8'));

const guild = await api(`/guilds/${GUILD_ID}`);
console.log(`Building server: ${guild.name} (${GUILD_ID})`);

// ── Roles ───────────────────────────────────────────────────────────────────
const existingRoles = await api(`/guilds/${GUILD_ID}/roles`);
const roleIds = {};
for (const spec of blueprint.roles) {
  let role = existingRoles.find((r) => r.name === spec.name);
  const body = {
    name: spec.name,
    color: parseInt(spec.color, 16),
    hoist: spec.hoist,
    mentionable: spec.mentionable,
    permissions: bits(...(spec.permissionNames.map((n) => ({
      ManageMessages: 'MANAGE_MESSAGES', ManageThreads: 'MANAGE_THREADS',
    }[n] || n)))),
  };
  if (role) {
    await api(`/guilds/${GUILD_ID}/roles/${role.id}`, { method: 'PATCH', body });
    console.log(`  role ok: ${spec.name}`);
  } else {
    role = await api(`/guilds/${GUILD_ID}/roles`, { method: 'POST', body });
    console.log(`  role created: ${spec.name}`);
  }
  roleIds[spec.key] = role.id;
}

// ── Channels ────────────────────────────────────────────────────────────────
const existing = await api(`/guilds/${GUILD_ID}/channels`);
const findCategory = (name) => existing.find((c) => c.type === 4 && c.name === name);
const findChannel = (name, parentId) => existing.find((c) => c.type === 0 && c.name === name && c.parent_id === parentId);

function overwritesFor(mode, staffOnly) {
  const everyone = { id: GUILD_ID, type: 0, allow: '0', deny: '0' };
  const ows = [everyone];
  if (staffOnly) {
    everyone.deny = bits('VIEW_CHANNEL');
    ows.push({ id: roleIds.staff, type: 0, allow: bits('VIEW_CHANNEL'), deny: '0' });
  }
  if (mode === 'broadcast') {
    everyone.deny = (BigInt(everyone.deny) | BigInt(bits('SEND_MESSAGES'))).toString();
    everyone.allow = bits('ADD_REACTIONS', 'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS');
  }
  return ows;
}

const channelIds = {};
let catPos = 0;
for (const cat of blueprint.categories) {
  let category = findCategory(cat.name);
  const catOws = cat.staffOnly ? overwritesFor('open', true) : [];
  const catBody = { name: cat.name, type: 4, position: catPos++, permission_overwrites: catOws };
  if (category) {
    await api(`/channels/${category.id}`, { method: 'PATCH', body: catBody });
    console.log(`  category ok: ${cat.name}`);
  } else {
    category = await api(`/guilds/${GUILD_ID}/channels`, { method: 'POST', body: catBody });
    console.log(`  category created: ${cat.name}`);
  }

  for (const ch of cat.channels) {
    const body = {
      name: ch.name,
      type: 0,
      parent_id: category.id,
      topic: ch.topic || '',
      permission_overwrites: overwritesFor(ch.mode, cat.staffOnly),
    };
    let channel = findChannel(ch.name, category.id);
    if (channel) {
      await api(`/channels/${channel.id}`, { method: 'PATCH', body });
      console.log(`    channel ok: #${ch.name}`);
    } else {
      channel = await api(`/guilds/${GUILD_ID}/channels`, { method: 'POST', body });
      console.log(`    channel created: #${ch.name}`);
    }
    channelIds[ch.name] = channel.id;
  }
}

// ── Guild settings ──────────────────────────────────────────────────────────
await api(`/guilds/${GUILD_ID}`, {
  method: 'PATCH',
  body: {
    default_message_notifications: 1, // only-mentions: news posts don't buzz phones, role pings do
    system_channel_id: channelIds['writers-chat'] || null,
  },
});
console.log('  guild defaults set (notifications = mentions only)');

// ── Write config ────────────────────────────────────────────────────────────
const cfg = {
  guildId: GUILD_ID,
  roles: roleIds,
  channels: channelIds,
  componentsEnabled: false,
};
writeFileSync('config/discord.json', JSON.stringify(cfg, null, 2));
console.log('config/discord.json written. Now run: npm run setup:welcome');
