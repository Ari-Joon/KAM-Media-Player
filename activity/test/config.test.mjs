import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

const discordOnly = {
  DISCORD_CLIENT_ID: 'client',
  DISCORD_CLIENT_SECRET: 'secret',
  DISCORD_BOT_TOKEN: 'token',
};

const config = loadConfig(discordOnly);
assert.equal(config.YOUTUBE_API_KEY, undefined, 'YouTube key must remain optional');
assert.equal(config.PORT, 3000, 'default port changed');

assert.throws(
  () => loadConfig({ ...discordOnly, DISCORD_BOT_TOKEN: '' }),
  /DISCORD_BOT_TOKEN/,
  'Discord bot token must remain required',
);

console.log('server configuration: 3/3 pass');
