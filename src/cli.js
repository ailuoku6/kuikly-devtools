'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  startServers,
  paths,
  primaryLanIp,
  listLanIps,
  DEFAULT_INGEST_PORT,
  DEFAULT_PANEL_PORT,
} = require('./index');

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function info(message) {
  log(`${COLORS.cyan}[kuikly-devtools]${COLORS.reset} ${message}`);
}

function warn(message) {
  log(`${COLORS.yellow}[kuikly-devtools]${COLORS.reset} ${message}`);
}

function fail(message) {
  log(`${COLORS.red}[kuikly-devtools]${COLORS.reset} ${message}`);
}

// ------------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const options = {
    command: argv[0] || 'help',
    host: null,
    ingestPort: DEFAULT_INGEST_PORT,
    panelPort: DEFAULT_PANEL_PORT,
    sampleMs: 500,
    project: null,
    modules: null,
    task: null,
    instrument: 'full',
    adb: true,
    debug: false,
    open: false,
    pagerId: null,
    query: null,
    limit: null,
    offset: null,
    level: null,
    tag: null,
    status: null,
    kind: null,
    id: null,
    inspectSubject: null,
    force: false,
    passthrough: [],
  };

  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') {
      options.passthrough = rest.slice(i + 1);
      break;
    }
    const next = () => rest[++i];
    switch (arg) {
      case '--host': options.host = next(); break;
      case '--port': options.ingestPort = Number(next()); break;
      case '--panel-port': options.panelPort = Number(next()); break;
      case '--sample': options.sampleMs = Number(next()); break;
      case '--project': options.project = path.resolve(next()); break;
      case '--modules': options.modules = next(); break;
      case '--task': options.task = next(); break;
      case '--instrument': options.instrument = next(); break;
      case '--debug': options.debug = true; break;
      case '--pager': options.pagerId = next(); break;
      case '--query':
      case '--q': options.query = next(); break;
      case '--limit': options.limit = Number(next()); break;
      case '--offset': options.offset = Number(next()); break;
      case '--level': options.level = next(); break;
      case '--tag': options.tag = next(); break;
      case '--status': options.status = next(); break;
      case '--kind': options.kind = next(); break;
      case '--id': options.id = next(); break;
      case '--force': options.force = true; break;
      case '--no-adb': options.adb = false; break;
      case '--copy-only': options.instrument = 'copy'; break;
      default:
        if (options.command === 'inspect' && !arg.startsWith('-') && !options.inspectSubject) {
          options.inspectSubject = arg;
        } else if (arg.startsWith('-')) {
          warn(`unknown flag ignored: ${arg}`);
        }
    }
  }
  return options;
}

function findProjectRoot(start) {
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, 'gradlew'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectTempDir(options) {
  return path.join(options.project || findProjectRoot(process.cwd()) || process.cwd(), '.kuiklyPageTemp');
}

function projectRoot(options) {
  return options.project || findProjectRoot(process.cwd()) || process.cwd();
}

// ---------------------------------------------------------------------- commands

async function commandServe(options) {
  const servers = await startServers({
    ingestPort: options.ingestPort,
    panelPort: options.panelPort,
    onEvent: ({ level, message }) => (level === 'error' ? fail(message) : warn(message)),
  });

  if (options.debug) {
    let lastSummaryKey = '';
    servers.hub.on('delta', (delta) => {
      const key = `${delta.pagerId}|${delta.meta.nodeCount}`;
      if (key === lastSummaryKey) return;
      lastSummaryKey = key;
      info(
        `${delta.meta.page || delta.pagerId} (${delta.meta.platform || '?'}) ` +
          `nodes=${delta.meta.nodeCount} logs=${delta.meta.logCount} net=${delta.meta.networkCount}`
      );
    });
  }

  if (!options.quiet) {
    log('');
    log(`${COLORS.bold}Kuikly DevTools${COLORS.reset}`);
    log(`  panel   ${COLORS.green}http://localhost:${servers.panelPort}${COLORS.reset}`);
    if (!fs.existsSync(paths.uiDist)) {
      warn('panel bundle not built yet - run `npm run build:ui` inside the kuikly-devtools package');
    }
    log('');
  }
  if (options.debug) logDebugConnectionDetails(options, servers.ingestPort);

  if (options.adb) {
    setupAdbReverse(servers.ingestPort, options);
  }

  return servers;
}

function logDebugConnectionDetails(options, ingestPort) {
  const host = options.host || primaryLanIp();
  log(`  ingest  http://${host}:${ingestPort}  ${COLORS.dim}(device -> host)${COLORS.reset}`);
  log('');
  log(`${COLORS.dim}Other reachable addresses:${COLORS.reset}`);
  for (const candidate of listLanIps()) {
    log(`${COLORS.dim}  ${candidate.name.padEnd(10)} ${candidate.ip}${COLORS.reset}`);
  }
  log('');
}

/**
 * A build needs both services, not merely two occupied ports. Checking their lightweight HTTP
 * endpoints lets a later CLI invocation reuse a running DevTools instance without mistaking an
 * unrelated local process for one.
 */
function getJson(port, requestPath) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: requestPath, timeout: 750 },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(null));
  });
}

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: requestPath, timeout: 5000 },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body;
          try {
            body = JSON.parse(text);
          } catch (_) {
            reject(new Error(`invalid response from DevTools panel (HTTP ${response.statusCode})`));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(body.error || `DevTools panel returned HTTP ${response.statusCode}`));
            return;
          }
          resolve(body);
        });
      }
    );
    request.once('timeout', () => request.destroy(new Error('DevTools panel request timed out')));
    request.once('error', (error) => reject(error));
  });
}

async function devtoolsServerStatus(options) {
  const [ingest, panel] = await Promise.all([
    getJson(options.ingestPort, '/__kuikly_devtools/ping'),
    getJson(options.panelPort, '/api/sessions'),
  ]);
  return {
    ingest: Boolean(ingest && ingest.status === 200 && ingest.body && ingest.body.service === 'kuikly-devtools-ingest'),
    panel: Boolean(panel && panel.status === 200 && panel.body && Array.isArray(panel.body.sessions)),
  };
}

async function ensureServers(options) {
  const status = await devtoolsServerStatus(options);
  if (status.ingest && status.panel) {
    info(options.debug
      ? `reusing running server (ingest :${options.ingestPort}, panel :${options.panelPort})`
      : 'reusing running DevTools server');
    if (options.debug) {
      logDebugConnectionDetails(options, options.ingestPort);
      if (options.adb) setupAdbReverse(options.ingestPort, options);
    }
    return { started: false, servers: null };
  }

  if (status.ingest || status.panel) {
    throw new Error('incomplete kuikly-devtools server: one of the required services is unavailable');
  }

  return { started: true, servers: await commandServe(options) };
}

function setupAdbReverse(port, options = {}) {
  const probe = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (probe.error) {
    if (options.debug) log(`${COLORS.dim}  adb not found, skipping reverse tunnel (iOS/HarmonyOS use the LAN address)${COLORS.reset}`);
    return;
  }
  const attached = (probe.stdout || '')
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() && !line.includes('offline'));
  if (attached.length === 0) {
    if (options.debug) log(`${COLORS.dim}  no adb device attached, skipping reverse tunnel${COLORS.reset}`);
    return;
  }
  const result = spawnSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], { encoding: 'utf8' });
  if (result.status === 0) {
    if (options.debug) info(`adb reverse tcp:${port} -> host:${port} ready (device reports to 127.0.0.1)`);
  } else if (options.debug) {
    warn(`adb reverse failed: ${(result.stderr || '').trim()}`);
  }
}

function gradleArgs(options, tasks) {
  const host = options.host || primaryLanIp();
  return [
    ...tasks,
    '--init-script',
    paths.initScript,
    '-Pkuikly.devtools=true',
    `-Pkuikly.devtools.home=${paths.packageRoot}`,
    `-Pkuikly.devtools.host=${host}`,
    `-Pkuikly.devtools.port=${options.ingestPort}`,
    `-Pkuikly.devtools.sampleMs=${options.sampleMs}`,
    `-Pkuikly.devtools.instrument=${options.instrument}`,
    ...(options.modules ? [`-Pkuikly.devtools.modules=${options.modules}`] : []),
    ...options.passthrough,
  ];
}

function runGradle(options, tasks) {
  const root = options.project || findProjectRoot(process.cwd());
  if (!root) {
    fail('no gradlew found - run inside a Kuikly project or pass --project <dir>');
    process.exitCode = 1;
    return Promise.resolve(1);
  }
  if (options.instrument === 'full' && !fs.existsSync(paths.instrumentorJar)) {
    fail(
      'instrumentor jar missing. Build it with `npm run build:instrumentor`, ' +
        'or pass --copy-only to compile without instrumentation.'
    );
    process.exitCode = 1;
    return Promise.resolve(1);
  }

  const args = gradleArgs(options, tasks);
  info(`${root}/gradlew ${tasks.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(path.join(root, 'gradlew'), args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        fail(`gradle exited with ${code}`);
        process.exitCode = code || 1;
      }
      resolve(code || 0);
    });
  });
}

async function commandBuildJs(options) {
  return runGradle(options, [options.task || 'packLocalJSBundleDebug']);
}

async function commandBuildApk(options) {
  return runGradle(options, [
    options.task || ':kuikly-dynamic-apk-builder:buildAndPublishHotReloadDebugApk',
  ]);
}

async function commandGradle(options) {
  if (options.passthrough.length === 0) {
    fail('usage: kuikly-devtools gradle -- <gradle tasks and flags>');
    process.exitCode = 1;
    return 1;
  }
  const tasks = options.passthrough;
  options.passthrough = [];
  return runGradle(options, tasks);
}

async function commandBuildWithServer(options, build) {
  const { started, servers } = await ensureServers({ ...options, quiet: true });
  const code = await build(options);
  if (code !== 0 && started) {
    warn('build failed, servers stay up so you can retry the build');
  } else if (code === 0) {
    info(`构建成功 - 请打开调试面板：http://localhost:${options.panelPort}`);
    info('请在设备上重新加载页面以连接调试面板');
  }
  // A server that this process started intentionally keeps the CLI alive. A reused instance belongs
  // to the earlier process, so this invocation exits immediately after Gradle completes.
  return started ? servers : code;
}

// Keep ordinary search/detail results in the model context; spill only larger payloads to disk.
const INSPECT_INLINE_MAX_BYTES = 15 * 1024;

function inspectEndpoint(options, subject) {
  const query = new URLSearchParams();
  if (options.pagerId) query.set('pagerId', options.pagerId);
  if (options.query) query.set('q', options.query);
  if (Number.isFinite(options.limit)) query.set('limit', String(options.limit));
  if (Number.isFinite(options.offset)) query.set('offset', String(options.offset));
  if (options.level) query.set('level', options.level);
  if (options.tag) query.set('tag', options.tag);
  if (options.status) query.set('status', options.status);
  if (options.kind) query.set('kind', options.kind);

  let endpoint;
  switch (subject) {
    case 'sessions': endpoint = '/api/inspect/sessions'; break;
    case 'logs': endpoint = '/api/inspect/logs'; break;
    case 'network': endpoint = '/api/inspect/network'; break;
    case 'nodes': endpoint = '/api/inspect/nodes'; break;
    case 'network-detail':
      if (!options.id) throw new Error('usage: inspect network-detail --pager <id> --id <request-id>');
      endpoint = `/api/inspect/network/${encodeURIComponent(options.id)}`;
      break;
    case 'log-detail':
      if (!options.id) throw new Error('usage: inspect log-detail --pager <id> --id <log-seq>');
      endpoint = `/api/inspect/logs/${encodeURIComponent(options.id)}`;
      break;
    case 'node-detail':
      if (!options.id) throw new Error('usage: inspect node-detail --pager <id> --id <node-id>');
      endpoint = `/api/inspect/nodes/${encodeURIComponent(options.id)}`;
      break;
    default:
      throw new Error(`unknown inspect subject: ${subject}`);
  }
  if (subject !== 'sessions' && !options.pagerId) {
    throw new Error(`usage: inspect ${subject} --pager <pager-id> [filters]`);
  }
  const suffix = query.toString();
  return suffix ? `${endpoint}?${suffix}` : endpoint;
}

function inspectTempFile(options, subject, body) {
  const dir = projectTempDir(options);
  fs.mkdirSync(dir, { recursive: true });
  const safeSubject = subject.replace(/[^a-z0-9-]/gi, '-');
  const safePager = String(options.pagerId || 'all').replace(/[^a-z0-9-]/gi, '-');
  const target = path.join(dir, `${safeSubject}-${safePager}-${Date.now()}.json`);
  fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);
  return target;
}

async function commandInspect(options) {
  const subject = options.inspectSubject || options.passthrough[0];
  if (subject === 'clean-temp') {
    const dir = projectTempDir(options);
    if (!fs.existsSync(dir)) {
      log(JSON.stringify({ tempDir: dir, removed: 0 }));
      return 0;
    }
    const files = fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'));
    for (const entry of files) fs.unlinkSync(path.join(dir, entry));
    log(JSON.stringify({ tempDir: dir, removed: files.length }));
    return 0;
  }
  if (!subject) {
    fail('usage: kuikly-devtools inspect <sessions|logs|network|nodes|log-detail|network-detail|node-detail> [options]');
    process.exitCode = 1;
    return 1;
  }
  const endpoint = inspectEndpoint(options, subject);
  const body = await requestJson(options.panelPort, endpoint);
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) <= INSPECT_INLINE_MAX_BYTES) {
    log(text);
    return 0;
  }
  const target = inspectTempFile(options, subject, body);
  log(JSON.stringify({
    savedTo: target,
    bytes: Buffer.byteLength(text),
    message: 'Result exceeds 15 KiB. Read this JSON file selectively; it can be deleted from .kuiklyPageTemp when no longer needed.',
  }));
  return 0;
}

function commandInitSkill(options) {
  const source = path.join(paths.packageRoot, 'skills', 'kuikly-page-inspect', 'SKILL.md');
  if (!fs.existsSync(source)) {
    fail(`bundled skill missing: ${source}`);
    process.exitCode = 1;
    return 1;
  }
  const root = projectRoot(options);
  const destinations = [
    '.codex/skills/kuikly-page-inspect/SKILL.md',
    '.claude/skills/kuikly-page-inspect/SKILL.md',
    '.cursor/skills/kuikly-page-inspect/SKILL.md',
  ].map((relative) => path.join(root, relative));
  const installed = [];
  const skipped = [];
  for (const target of destinations) {
    if (fs.existsSync(target) && !options.force) {
      skipped.push(target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    installed.push(target);
  }
  log(JSON.stringify({ root, installed, skipped }));
  return 0;
}

async function commandDev(options) {
  return commandBuildWithServer(options, commandBuildJs);
}

function commandDoctor(options) {
  const root = options.project || findProjectRoot(process.cwd());
  log('');
  log(`${COLORS.bold}kuikly-devtools doctor${COLORS.reset}`);
  log(`  package root      ${paths.packageRoot}`);
  log(`  project root      ${root || `${COLORS.red}not found${COLORS.reset}`}`);
  log(`  init script       ${exists(paths.initScript)}`);
  log(`  runtime sources   ${exists(paths.runtimeDir)}`);
  log(`  instrumentor jar  ${exists(paths.instrumentorJar)}`);
  log(`  panel bundle      ${exists(paths.uiDist)}`);
  log(`  ingest port       ${options.ingestPort}`);
  log(`  panel port        ${options.panelPort}`);
  log(`  primary LAN ip    ${primaryLanIp()}`);
  for (const candidate of listLanIps()) {
    log(`${COLORS.dim}    ${candidate.name.padEnd(10)} ${candidate.ip}${COLORS.reset}`);
  }
  const adb = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  log(`  adb               ${adb.error ? `${COLORS.dim}not installed${COLORS.reset}` : 'available'}`);
  log('');
  return 0;
}

function exists(target) {
  return fs.existsSync(target)
    ? `${COLORS.green}ok${COLORS.reset} ${COLORS.dim}${target}${COLORS.reset}`
    : `${COLORS.red}missing${COLORS.reset} ${COLORS.dim}${target}${COLORS.reset}`;
}

function commandHelp() {
  log(`
${COLORS.bold}kuikly-devtools${COLORS.reset} - Chrome-DevTools-style inspector for Kuikly pages

Usage
  kuikly-devtools <command> [options] [-- <extra gradle args>]

Commands
  serve        Start the ingest server and the browser panel
  dev          Build the instrumented JS debug artifact (iOS) and start DevTools
  build-js     Start or reuse DevTools, then build the instrumented JS debug artifact
  build-apk    Build the instrumented hot-reload debug APK (Android) and start DevTools
  gradle       Start or reuse DevTools, then run arbitrary instrumented Gradle tasks
  inspect      Search live page sessions, logs, network records, and nodes for AI-assisted debugging
  init-skill   Install the page-inspection Skill for Codex, Claude Code, and Cursor in this project
  doctor       Print resolved paths, ports and network addresses
  help         Show this message

Options
  --host <ip>          LAN address baked into the build (default: auto-detected)
  --port <n>           Ingest port, device -> host (default: ${DEFAULT_INGEST_PORT})
  --panel-port <n>     Browser panel port (default: ${DEFAULT_PANEL_PORT})
  --sample <ms>        Sampling interval on the device (default: 500)
  --project <dir>      Gradle project root (default: nearest ancestor with gradlew)
  --modules <paths>    Comma separated Gradle project paths to instrument
  --task <name>        Override the gradle task for build-js / build-apk
  --debug              Print ingest, LAN address and adb reverse connection details
  --copy-only          Skip instrumentation, only reroute sources (plumbing check)
  --no-adb             Do not attempt \`adb reverse\`
  --pager <id>          Target page for \`inspect\` searches
  --query, --q <text>   Text filter for \`inspect\` searches
  --limit <n>           Maximum \`inspect\` results per page (default: 50, maximum: 200)
  --offset <n>          \`inspect\` result offset for pagination
  --force              Replace existing files when running \`init-skill\`

Examples
  npx kuikly-devtools dev
  npx kuikly-devtools serve --port 8089 --panel-port 8090
  npx kuikly-devtools gradle -- :app:assembleDebug
  npx kuikly-devtools inspect logs --pager 7 --query timeout
  npx kuikly-devtools inspect network-detail --pager 7 --id cb_42
  npx kuikly-devtools init-skill --project .
`);
  return 0;
}

// ------------------------------------------------------------------------- entry

async function main(argv) {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'serve': return commandServe(options);
    case 'dev': return commandDev(options);
    case 'build-js': return commandBuildWithServer(options, commandBuildJs);
    case 'build-apk': return commandBuildWithServer(options, commandBuildApk);
    // Validate the required task list before starting long-lived services.
    case 'gradle':
      return options.passthrough.length === 0
        ? commandGradle(options)
        : commandBuildWithServer(options, commandGradle);
    case 'inspect': return commandInspect(options);
    case 'init-skill': return commandInitSkill(options);
    case 'doctor': return commandDoctor(options);
    case 'help':
    case '--help':
    case '-h':
      return commandHelp();
    default:
      fail(`unknown command: ${options.command}`);
      commandHelp();
      process.exitCode = 1;
      return 1;
  }
}

module.exports = {
  main, parseArgs, findProjectRoot, devtoolsServerStatus, ensureServers,
  commandInspect, commandInitSkill, inspectEndpoint, projectTempDir,
};
