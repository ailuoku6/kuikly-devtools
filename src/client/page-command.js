'use strict';

const WebSocket = require('ws');

/** Submit once and wait for the device. Queue acceptance alone is not a successful edit. */
function pageCommand({ port, pagerId, command, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let sent = false;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(
      'Timed out waiting for device confirmation; the command may still apply. Read the node before retrying.'
    )), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('DevTools connection closed before device confirmation; read the node before retrying.')));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'hello' && !sent) {
          const session = message.sessions.find((item) => item.pagerId === pagerId);
          if (!session || session.stale) return finish(new Error('Target page is not attached'));
          sent = true;
          socket.send(JSON.stringify({ type: 'command', pagerId, command }));
        } else if (message.type === 'error' &&
            (!message.requestId || message.requestId === command.requestId)) {
          finish(new Error(message.message));
        } else if (message.type === 'session-removed' && message.pagerId === pagerId) {
          finish(new Error('Target page closed before device confirmation'));
        } else if (message.type === 'delta' && message.pagerId === pagerId) {
          if (command.type === 'edit') {
            const result = message.editResults?.find((item) => item.requestId === command.requestId);
            if (!result) return;
            if (!result.ok) return finish(new Error(result.error || 'Device rejected edit'));
            const node = message.nodes?.find((item) => item.id === command.id);
            finish(null, {
              pagerId, requestId: command.requestId, ok: true, id: command.id,
              target: command.target, key: command.key,
              // A setter may normalize the input or remove its node. Report actual readback only.
              ...(node?.[command.target] && Object.prototype.hasOwnProperty.call(node[command.target], command.key)
                ? { value: node[command.target][command.key] } : { readbackUnavailable: true }),
            });
          } else if (command.type === 'state') {
            const node = message.nodes?.find((item) => item.id === command.ids[0]);
            if (node && (node.s || node.as || !node.hs)) finish(null, { pagerId, node });
          }
        }
      } catch (error) { finish(error); }
    });
  });
}

module.exports = { pageCommand };
