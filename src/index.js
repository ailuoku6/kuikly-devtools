'use strict';

const path = require('path');

const { Hub } = require('./server/hub');
const { createIngestServer, INGEST_PATH } = require('./server/ingest');
const { createPanelServer } = require('./server/panel');
const { primaryLanIp, listLanIps, assertPortsFree } = require('./util/net');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INGEST_PORT = 8089;
const DEFAULT_PANEL_PORT = 8090;

const paths = {
  packageRoot: PACKAGE_ROOT,
  runtimeDir: path.join(PACKAGE_ROOT, 'runtime', 'kotlin'),
  initScript: path.join(PACKAGE_ROOT, 'gradle', 'devtools.init.gradle'),
  instrumentorJar: path.join(PACKAGE_ROOT, 'gradle', 'libs', 'kuikly-devtools-instrumentor.jar'),
  uiDist: path.join(PACKAGE_ROOT, 'ui', 'dist'),
};

async function startServers({
  ingestPort = DEFAULT_INGEST_PORT,
  panelPort = DEFAULT_PANEL_PORT,
  onEvent = () => {},
} = {}) {
  await assertPortsFree([
    { port: ingestPort, label: 'ingest' },
    { port: panelPort, label: 'panel' },
  ]);

  const hub = new Hub();
  const ingest = await createIngestServer({ hub, port: ingestPort, onEvent });
  const panel = await createPanelServer({ hub, port: panelPort, uiDir: paths.uiDist, onEvent });

  return {
    hub,
    ingestPort,
    panelPort,
    close: () =>
      Promise.all([
        new Promise((resolve) => { hub.close(); resolve(); }),
        new Promise((resolve) => ingest.close(resolve)),
        new Promise((resolve) => panel.server.close(resolve)),
      ]),
  };
}

module.exports = {
  Hub,
  startServers,
  paths,
  primaryLanIp,
  listLanIps,
  INGEST_PATH,
  DEFAULT_INGEST_PORT,
  DEFAULT_PANEL_PORT,
};
