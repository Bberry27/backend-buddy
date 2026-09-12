#!/usr/bin/env node
/**
 * One command to run the stack locally.
 *
 *   npm run up        build if needed, start, wait until healthy, print the URL
 *   npm run down      stop and remove the containers
 *   npm run restart   down then up
 *   npm run rebuild   rebuild the images from scratch, then up
 *   npm run logs      follow the logs
 *   npm run status    what is running, and on which port
 *
 * Pass extra arguments through after `--`, for example:
 *   npm run up -- --schema fixtures/schemas/small.json
 *   npm run logs -- viewer
 *
 * The compose project is `backend-buddy` and the port is bound to 127.0.0.1 only.
 * Override the port with BB_VIEWER_PORT and the rendered fixture with BB_SCHEMA.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'deploy/compose.yml');
const port = process.env.BB_PORT || process.env.BB_VIEWER_PORT || '8080';
const url = `http://127.0.0.1:${port}/`;

const [, , command = 'up', ...rest] = process.argv;

function fail(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** Run docker compose, inheriting stdio so the user sees progress as it happens. */
function compose(args, { quiet = false } = {}) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    // Without an encoding, stdout comes back as a Buffer and the callers that parse it
    // fail on .trim(). Only the quiet path reads it, but set it unconditionally.
    encoding: 'utf8',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') {
    fail('docker is not on PATH.', 'Install Docker Desktop, or start it if it is installed.');
  }
  return result;
}

function requireDaemon() {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', shell: false });
  if (probe.error?.code === 'ENOENT') {
    fail('docker is not on PATH.', 'Install Docker Desktop, or start it if it is installed.');
  }
  if (probe.status !== 0) {
    fail('The Docker daemon is not responding.', 'Start Docker Desktop and wait for it to report Running, then try again.');
  }
}

/**
 * Poll the health status compose reports, rather than sleeping a fixed time.
 * Returns 'healthy', 'unhealthy', or 'unknown' when the service reports no health state.
 */
async function waitHealthy(seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const out = compose(['ps', '--format', '{{.Service}} {{.Health}} {{.State}}'], { quiet: true });
    const lines = (out.stdout || '').trim().split('\n').filter(Boolean);
    if (lines.length) {
      const states = lines.map((line) => line.trim().split(/\s+/));
      if (states.every(([, health, state]) => health === 'healthy' || (!health && state === 'running'))) {
        return states.some(([, health]) => health === 'healthy') ? 'healthy' : 'unknown';
      }
      if (states.some(([, , state]) => state === 'exited' || state === 'dead')) return 'unhealthy';
      const summary = states.map(([service, health, state]) => `${service}=${health || state}`).join(' ');
      if (summary !== last) {
        process.stdout.write(`  waiting: ${summary}\n`);
        last = summary;
      }
    }
    await new Promise((done) => setTimeout(done, 1500));
  }
  return 'unhealthy';
}

/** Confirm the artifact is actually served, not merely that the container is up. */
async function verify() {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    const body = await response.text();
    const csp = /content="(default-src 'none';[^"]*)"/.exec(body);
    return {
      ok: response.ok && body.length > 1000,
      status: response.status,
      bytes: body.length,
      offlinePolicy: csp ? csp[1].includes("connect-src 'none'") : false,
      title: (/<title>([^<]*)<\/title>/.exec(body) || [, 'unknown'])[1],
      isAdmin: body.includes('Add a connection') || body.includes('Connections'),
    };
  } catch (error) {
    return { ok: false, status: 0, bytes: 0, offlinePolicy: false, error: error.message };
  }
}

async function up({ rebuild = false } = {}) {
  requireDaemon();
  if (!existsSync(composeFile)) fail(`Missing ${composeFile}.`);

  const schemaFlag = rest.indexOf('--schema');
  if (schemaFlag > -1 && rest[schemaFlag + 1]) {
    process.env.BB_SCHEMA = rest[schemaFlag + 1];
    console.log(`  rendering ${process.env.BB_SCHEMA}`);
  }

  if (rebuild) {
    console.log('  rebuilding images without cache');
    const built = compose(['build', '--no-cache']);
    if (built.status !== 0) fail('Image build failed. The output above says why.');
  }

  const started = compose(['up', '--build', '-d']);
  if (started.status !== 0) fail('docker compose up failed. The output above says why.');

  const health = await waitHealthy();
  const check = await verify();

  console.log('');
  compose(['ps', '--format', 'table {{.Service}}\t{{.Status}}\t{{.Ports}}']);
  console.log('');

  if (check.ok) {
    console.log(`  Ready: ${url}`);
    console.log('  (the port matters: a bare 127.0.0.1 goes to port 80 and nothing serves that)');
    if (check.isAdmin) {
      console.log('  Add a database connection there to see your own schema.');
    } else {
      console.log(`  Serving "${check.title}" (${(check.bytes / 1048576).toFixed(2)} MB)`);
      console.log(`  Offline policy intact: ${check.offlinePolicy ? 'yes' : 'NO — investigate'}`);
    }
    console.log('');
    console.log('  npm run logs     follow output      npm run down   stop');
    console.log('  npm run status   what is running    npm run rebuild  rebuild from scratch');
    if (!check.isAdmin && !check.offlinePolicy) process.exitCode = 1;
    return;
  }

  console.error(`  Containers reported ${health}, but ${url} did not serve the artifact`);
  if (check.error) console.error(`  ${check.error}`);
  console.error('  Recent output:');
  compose(['logs', '--tail', '40']);
  process.exit(1);
}

switch (command) {
  case 'up':
    await up();
    break;
  case 'rebuild':
    await up({ rebuild: true });
    break;
  case 'down': {
    requireDaemon();
    const result = compose(['down', '--remove-orphans', ...rest]);
    if (result.status === 0) console.log('\n  Stopped.');
    process.exit(result.status ?? 0);
    break;
  }
  case 'restart':
    requireDaemon();
    compose(['down', '--remove-orphans']);
    await up();
    break;
  case 'logs': {
    requireDaemon();
    // Hand the terminal over so Ctrl+C stops following without killing the container.
    const child = spawn('docker', ['compose', '-f', composeFile, 'logs', '-f', '--tail', '80', ...rest], {
      cwd: root, stdio: 'inherit', shell: false,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'open': {
    // Save the user from remembering the port. Start it first if it is not already up.
    requireDaemon();
    let check = await verify();
    if (!check.ok) {
      console.log('  Not running yet, starting it first.');
      await up();
      check = await verify();
      if (!check.ok) process.exit(1);
    }
    const opener = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
    const opened = spawnSync(opener[0], opener[1], { stdio: 'ignore', shell: false });
    console.log(opened.status === 0 ? `  Opened ${url}` : `  Could not launch a browser. Open ${url} yourself.`);
    break;
  }
  case 'status': {
    requireDaemon();
    compose(['ps', '--format', 'table {{.Service}}\t{{.Status}}\t{{.Ports}}']);
    const check = await verify();
    console.log('');
    console.log(check.ok ? `  ${url} is serving "${check.title}"` : `  ${url} is not responding`);
    break;
  }
  default:
    fail(`Unknown command "${command}".`, 'Use up, down, restart, rebuild, logs, or status.');
}
