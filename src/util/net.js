'use strict';

const os = require('os');
const net = require('net');

/**
 * Ranks the machine's IPv4 addresses by how likely a phone on the same Wi-Fi can reach them.
 *
 * On a typical dev Mac the interface list also contains Docker bridges, VPN tunnels and
 * `bridge*`/`utun*` devices, none of which a device can route to.
 */
function listLanIps() {
  const interfaces = os.networkInterfaces();
  const found = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      found.push({ name, ip: address.address, score: scoreInterface(name, address.address) });
    }
  }

  return found.sort((a, b) => b.score - a.score);
}

function scoreInterface(name, ip) {
  let score = 0;
  if (/^en\d/.test(name)) score += 100; // macOS ethernet / Wi-Fi
  if (/^(eth|wlan|wlp|enp)/.test(name)) score += 100; // Linux
  if (/^(bridge|utun|tun|tap|docker|vmnet|vboxnet|awdl|llw)/.test(name)) score -= 100;
  if (ip.startsWith('192.168.')) score += 20;
  if (ip.startsWith('10.')) score += 15;
  if (ip.startsWith('172.')) score += 5;
  if (ip.startsWith('169.254.')) score -= 100; // link-local, no DHCP
  return score;
}

function primaryLanIp() {
  const candidates = listLanIps();
  return candidates.length > 0 ? candidates[0].ip : '127.0.0.1';
}

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function assertPortsFree(ports) {
  const busy = [];
  for (const { port, label } of ports) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isPortFree(port))) busy.push(`${label} (${port})`);
  }
  if (busy.length > 0) {
    throw new Error(`port already in use: ${busy.join(', ')}`);
  }
}

module.exports = { listLanIps, primaryLanIp, isPortFree, assertPortsFree };
