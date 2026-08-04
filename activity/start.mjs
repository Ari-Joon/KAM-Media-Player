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
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

/** ANSI colours, skipped when the output is not a terminal. */
const colour = process.stdout.isTTY
  ? { bold: '\u001b[1m', gold: '\u001b[33m', dim: '\u001b[2m', off: '\u001b[0m' }
  : { bold: '', gold: '', dim: '', off: '' };

/** Everything started here, so they can be shut down together. */
const children = [];

/**
 * Set when the tunnel reports a failure.
 *
 * Declared up here rather than beside the announcer because `start` closes over
 * it and is called before that point in the file.
 *
 * The timed announcements below exist because an agent does not always print a
 * line worth matching on. Without this they fire regardless - so a run whose
 * tunnel failed authentication still ended with a gold banner saying the URL
 * was ready, which sends you looking for the fault everywhere except where it
 * actually is.
 */
let tunnelFailed = false;

/**
 * Start a child process and prefix its output.
 *
 * @param {string} label Shown before each line.
 * @param {string} command
 * @param {string[]} args
 * @param {(line: string) => void} [onLine] Called for each output line.
 * @returns {import('node:child_process').ChildProcess}
 */
function start(label, command, args, onLine, { shell } = {}) {
  // The shell is only wanted for the tunnel agents, which are found on PATH and
  // may be .cmd shims on Windows. It is actively harmful for the server: with
  // `shell: true` the arguments are concatenated rather than escaped, so
  // `process.execPath` - normally `C:\Program Files\nodejs\node.exe` - is split
  // at the space and cmd reports `'C:\Program' is not recognized`. The server
  // then never starts at all, while the tunnel carries on as though it had.
  const useShell = shell ?? false;
  // Quoted anyway, so a tunnel binary installed under a path with a space in it
  // fails no differently.
  const safeCommand = useShell && /\s/.test(command) ? `"${command}"` : command;
  const child = spawn(safeCommand, args, { shell: useShell });
  children.push(child);

  const emit = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      // A tunnel that has reported an error is not going to serve traffic, so
      // the success banner must not be printed over the top of it.
      if (label === 'tunnel' && /\bERROR\b|ERR_NGROK|authentication failed/i.test(line)) {
        tunnelFailed = true;
      }
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
  if (announced || tunnelFailed) return;
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
    // Checked after the banner rather than before it, so the address is on
    // screen either way and any warning lands directly beneath it.
    verifyServesToBrowser(host);
  }, 1200);
}

/**
 * Check that the tunnel actually serves the app to a *browser*.
 *
 * Discord loads an Activity in an embedded browser, and some tunnels answer
 * browsers differently from anything else. ngrok's free tier is the case that
 * cost hours: it serves a "You are about to visit..." interstitial to any
 * request with a browser User-Agent, so the Activity received a warning page
 * and rendered white while every other check looked perfect - the server was
 * healthy, the tunnel was up, and `curl` fetched the real page, because curl is
 * not a browser and so was never shown the interstitial.
 *
 * Hence the User-Agent here. Checking with the default one reproduces exactly
 * the blind spot that made the fault so hard to see.
 *
 * @param {string} host Hostname, without a scheme.
 */
async function verifyServesToBrowser(host) {
  const browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  let body;
  try {
    const response = await fetch(`https://${host}/`, {
      headers: { 'User-Agent': browserAgent, Accept: 'text/html' },
      redirect: 'follow',
    });
    body = await response.text();
  } catch {
    // The tunnel may simply not be ready yet. Not worth alarming anyone over.
    return;
  }

  if (body.includes('KAM Media Player')) return;

  const interstitial = /ngrok|you are about to visit|tunnel not found/i.test(body);
  console.error(`
${colour.bold}WARNING: that address does not serve the Activity to a browser.${colour.off}

  A browser request returned ${body.length} bytes without the app in it${
  interstitial ? ',\n  and it looks like a tunnel interstitial page' : ''}.

  Discord loads the Activity in an embedded browser, so it will see the same
  thing and show a white screen. The server itself is fine - this is the
  tunnel answering browsers differently.
${provider === 'ngrok' ? `
  ngrok's free tier does this and cannot be configured out of it. Set
  TUNNEL_PROVIDER=quick in .env to use a Cloudflare tunnel instead.` : ''}
`);
}

/**
 * Which flag this ngrok build wants for a static domain.
 *
 * Asked rather than assumed, because the answer has changed twice and the agent
 * updates itself. Measured on two builds of the same major version:
 *
 *   3.3.1    --domain, and --url is not recognised
 *   3.39.10  --url, and --domain is gone
 *
 * Hardcoding either one breaks on the other, and the failure is a wall of usage
 * text that never says which flag it wanted. One extra process at startup is a
 * cheap price for never being wrong about it again.
 *
 * @returns {Promise<string>}
 */
function ngrokDomainFlag() {
  return new Promise((resolve) => {
    execFile('ngrok', ['http', '--help'], { shell: true }, (error, stdout, stderr) => {
      const help = `${stdout ?? ''}${stderr ?? ''}`;
      // `--url` first: it is the current spelling, and `--domain` is the one
      // being retired. If neither is found - an agent too broken to run - the
      // current spelling is the better guess.
      if (help.includes('--domain') && !help.includes('--url')) return resolve('--domain');
      resolve('--url');
    });
  });
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

setTimeout(async () => {
  if (provider === 'ngrok') {
    if (!tunnelDomain) {
      console.error(`${colour.bold}TUNNEL_PROVIDER=ngrok needs TUNNEL_DOMAIN.${colour.off}`);
      console.error('Claim your free static domain at https://dashboard.ngrok.com/domains');
      console.error('then put it in .env, for example:');
      console.error('  TUNNEL_DOMAIN=kam-media-player.ngrok-free.app');
      shutdown(1);
    }
    const flag = await ngrokDomainFlag();
    start('tunnel', 'ngrok', ['http', `${flag}=${tunnelDomain}`, String(port)], (line) => {
      if (/unknown flag|unknown shorthand|flag provided but not defined/i.test(line)) {
        console.error(`\n${colour.bold}ngrok rejected ${flag}.${colour.off}`);
        console.error('The flag was chosen from `ngrok http --help`, so this build'
          + ' reports one spelling and accepts another. Please report it.');
      }
      // ngrok states the required version rather than making you guess, so the
      // message is worth surfacing above its own wall of usage text.
      if (/ERR_NGROK_121|too old/i.test(line)) {
        console.error(`\n${colour.bold}The ngrok agent is too old for your account.${colour.off}`);
        console.error('Update it, then run this again:  ngrok update');
      }
      if (/started tunnel|url=https:\/\//i.test(line)) announce(tunnelDomain, true);
    }, { shell: true });
    // ngrok's terminal UI does not always print a parseable line, so the
    // address is announced once it has had time to connect - it is known in
    // advance, which is the entire point of a static domain. Suppressed if the
    // agent has reported a failure: announcing a working URL over the top of an
    // authentication error is worse than saying nothing, because it sends you
    // looking for the fault everywhere except where it is.
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
    }, { shell: true });
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
