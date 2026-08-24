'use strict';

const assert = require('assert');

const { devtoolsServerStatus, ensureServers } = require('../src/cli');

const OPTIONS = {
  ingestPort: 18950,
  panelPort: 18951,
  host: '127.0.0.1',
  adb: false,
};

async function run() {
  let status = await devtoolsServerStatus(OPTIONS);
  assert.deepStrictEqual(status, { ingest: false, panel: false });

  const first = await ensureServers(OPTIONS);
  assert.strictEqual(first.started, true, 'the first build must start both DevTools services');
  assert.ok(first.servers);

  const servers = first.servers;
  try {
    status = await devtoolsServerStatus(OPTIONS);
    assert.deepStrictEqual(status, { ingest: true, panel: true });

    const ensured = await ensureServers(OPTIONS);
    assert.strictEqual(ensured.started, false, 'an already running DevTools pair must be reused');
    assert.strictEqual(ensured.servers, null);
  } finally {
    await servers.close();
  }

  status = await devtoolsServerStatus(OPTIONS);
  assert.deepStrictEqual(status, { ingest: false, panel: false });
}

run()
  .then(() => process.stdout.write('cli server reuse passed\n'))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
