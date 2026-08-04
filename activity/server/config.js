/** Resolve and validate server configuration without starting Discord or HTTP. */
export function loadConfig(environment = process.env) {
  const config = {
    DISCORD_CLIENT_ID: environment.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: environment.DISCORD_CLIENT_SECRET,
    DISCORD_BOT_TOKEN: environment.DISCORD_BOT_TOKEN,
    // YouTube is deliberately absent from the required set. Providers choose
    // SoundCloud for free-text lookup when the optional key is not configured.
    YOUTUBE_API_KEY: environment.YOUTUBE_API_KEY || undefined,
    PORT: environment.PORT || 3000,
    CACHE_DIR: environment.CACHE_DIR || './cache',
    PYTHON_BIN: environment.PYTHON_BIN || 'python3',
    VISUALCORE_PATH: environment.VISUALCORE_PATH || '../visualcore/src',
    CLIENT_DIR: environment.CLIENT_DIR || 'client/dist',
  };

  for (const name of [
    'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN',
  ]) {
    if (!config[name]) throw new Error(`Missing required environment variable: ${name}`);
  }

  return config;
}
