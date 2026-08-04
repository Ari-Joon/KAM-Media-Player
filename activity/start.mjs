/**
 * One-command local launcher.
 *
 * Running KAM locally needs two long-lived processes: the server, and a tunnel
 * giving it a public HTTPS address, because Discord will only load an Activity
 * over HTTPS from a domain you have registered. Doing that by hand means two
 * terminals, and remembering to copy a URL that changes every time the tunnel
 * restarts.
 *
 * This starts both, watches the tunnel's output for the address it was assigned,
 * and prints it once, prominently, with the exact next step. It cannot remove
 * the need to paste that address into the Developer Portal - Discord has no API
 * for URL mappings - but it removes everything else.
 *
 * Usage:
 *
 *     npm run tunnel
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

/** ANSI colours, skipped when the output is not a terminal. */
const colour = process.stdout.isTTY
  ? { bold: '\u001b[1m', gold: '\u001b[33m', dim: '\u001b[2m', off: '\u001b[0m' }
  : { bold: '', gold: '', dim: '', off: '' };

/** Everything started here, so they can be shut down together. */
const children = [];

/**
 * Start a child process and prefix its output.
 *
 * @param {string} label Shown before each line.
 * @param {string} command
 * @param {string[]} args
 * @param {(line: string) => void} [onLine] Called for each output line.
 * @returns {import('node:child_process').ChildProcess}
 */
function start(label, command, args, onLine) {
  const child = spawn(command, args, { shell: process.platform === 'win32' });
  children.push(child);

  const emit = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      onLine?.(line);
      console.log(`${colour.dim}[${label}]${colour.off} ${line}`);
    }
  };

  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);

  child.on('error', (error) => {
    console.error(`\n${colour.bold}Could not start ${command}.${colour.off}`);
    if (command === 'cloudflared') {
      console.error('Install it with:  winget install --id Cloudflare.cloudflared');
      console.error('or see https://developers.cloudflare.com/cloudflare-one/'
        + 'connections/connect-networks/downloads/');
    }
    console.error(String(error.message));
    shutdown(1);
  });

  return child;
}

/** Stop everything and exit. @param {number} code */
function shutdown(code) {
  for (const child of children) {
    // The tunnel in particular ignores a plain kill on Windows.
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nShutting down.');
    shutdown(0);
  });
}

// --- Checks before starting anything ----------------------------------------

if (!existsSync('.env')) {
  console.error(`${colour.bold}No .env file found.${colour.off}`);
  console.error('Copy .env.example to .env and fill in your Discord credentials.');
  process.exit(1);
}

if (!existsSync('client/dist/index.html')) {
  console.error(`${colour.bold}The client has not been built.${colour.off}`);
  console.error('Run:  npm run build');
  process.exit(1);
}

const port = process.env.PORT ?? '3000';

console.log(`${colour.bold}Starting KAM Media Player${colour.off}`);
console.log(`${colour.dim}Press Ctrl+C to stop both processes.${colour.off}\n`);

// --- Server ------------------------------------------------------------------

start('server', process.execPath, ['server.js']);

// --- Tunnel ------------------------------------------------------------------
//
// Started a moment later so the server is listening before the tunnel tries to
// reach it; cloudflared logs a confusing connection error otherwise.

let announced = false;

/**
 * Print the address once, with the next step.
 *
 * @param {string} host Hostname, without a scheme.
 * @param {boolean} stable Whether it survives a restart.
 */
function announce(host, stable) {
  if (announced) return;
  announced = true;
  // Delayed so it lands below the tunnel's own banner rather than being
  // scrolled away by it.
  setTimeout(() => {
    console.log(`
${colour.gold}${'='.repeat(68)}
  YOUR ACTIVITY URL IS READY
${'='.repeat(68)}${colour.off}

  ${colour.bold}https://${host}${colour.off}

${stable ? `  ${colour.dim}This address is permanent. If the Developer Portal already points
  at it, there is nothing to do - start playing.${colour.off}

  ${colour.dim}First time only:${colour.off}
` : ''}
    Applications > KAM Media Player > Activities > URL Mappings
    Set the ROOT mapping target to:  ${colour.bold}${host}${colour.off}
${stable ? '' : `
  ${colour.dim}This address changes every time the tunnel restarts, so it has to
  be updated each session. Set TUNNEL_PROVIDER in .env to stop that -
  see DEPLOY.md.${colour.off}`}

${colour.gold}${'='.repeat(68)}${colour.off}
`);
  }, 1200);
}

/**
 * How to get a public HTTPS address.
 *
 * The default costs nothing and needs no account, but Cloudflare assigns a
 * different hostname on every start - which means editing the Developer Portal
 * every session, since Discord has no API for URL mappings. The other two both
 * give a hostname that survives a restart, so the Portal is edited once ever.
 */
const provider = (process.env.TUNNEL_PROVIDER ?? 'quick').toLowerCase();
const tunnelDomain = process.env.TUNNEL_DOMAIN ?? '';
const tunnelName = process.env.TUNNEL_NAME ?? '';

setTimeout(() => {
  if (provider === 'ngrok') {
    if (!tunnelDomain) {
      console.error(`${colour.bold}TUNNEL_PROVIDER=ngrok needs TUNNEL_DOMAIN.${colour.off}`);
      console.error('Claim your free static domain at https://dashboard.ngrok.com/domains');
      console.error('then put it in .env, for example:');
      console.error('  TUNNEL_DOMAIN=kam-media-player.ngrok-free.app');
      shutdown(1);
    }
    // `--url` is the current flag; ngrok before 3.19 spelt it `--domain`. The
    // error handler below names that, because the failure is otherwise just
    // "unknown flag" with no hint about the version.
    start('tunnel', 'ngrok', ['http', `--url=${tunnelDomain}`, String(port)], (line) => {
      if (/unknown flag|unknown shorthand|flag provided but not defined/i.test(line)) {
        console.error(`\n${colour.bold}That ngrok build does not know --url.${colour.off}`);
        console.error('It is older than 3.19; upgrade ngrok, or change the flag in'
          + ' start.mjs to --domain=.');
      }
      if (/started tunnel|url=https:\/\//i.test(line)) announce(tunnelDomain, true);
    });
    // ngrok's terminal UI does not always print a parseable line, so the
    // address is announced regardless once it has had time to connect. It is
    // known in advance here - that is the entire point of a static domain.
    setTimeout(() => announce(tunnelDomain, true), 3000);
    return;
  }

  if (provider === 'cloudflared' || provider === 'named') {
    if (!tunnelName || !tunnelDomain) {
      console.error(`${colour.bold}A named tunnel needs TUNNEL_NAME and TUNNEL_DOMAIN.`
        + `${colour.off}`);
      console.error('See DEPLOY.md - it takes one `cloudflared tunnel create` and one');
      console.error('`cloudflared tunnel route dns`, and needs a domain on Cloudflare.');
      shutdown(1);
    }
    start('tunnel', 'cloudflared', [
      'tunnel', 'run', '--url', `http://localhost:${port}`, tunnelName,
    ], (line) => {
      if (/registered tunnel connection|connection.*registered/i.test(line)) {
        announce(tunnelDomain, true);
      }
    });
    setTimeout(() => announce(tunnelDomain, true), 4000);
    return;
  }

  // Default: a quick tunnel. Free, no account, new hostname every time.
  start('tunnel', 'cloudflared', [
    'tunnel', '--url', `http://localhost:${port}`,
  ], (line) => {
    // The assigned hostname appears once, inside a box of ASCII art.
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) announce(match[0].replace(/^https:\/\//, ''), false);
  });
}, 1500);
