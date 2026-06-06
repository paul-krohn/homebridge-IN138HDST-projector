'use strict';

const net = require('net');

const TELNET_PORT = 23;

// Response format: (min-max,current)  e.g. "(0-1,1)"
function parseTelnetValue(data) {
    const m = data.match(/\(\d[\d-]*,(\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
}

// Send a query command on an already-prompted socket, retrying if needed.
function queryWithRetry(client, command, retryMs, maxRetries, debug) {
    return new Promise((resolve, reject) => {
        let buf = '';
        let attempts = 0;
        let retryTimer = null;

        function trySend() {
            attempts++;
            buf = '';
            if (debug) process.stderr.write(`  [telnet] sending ${command}\\r (attempt ${attempts})\n`);
            client.write(command + '\r');
            retryTimer = setTimeout(() => {
                if (attempts < maxRetries) {
                    trySend();
                } else {
                    reject(new Error(`No response to ${command} after ${maxRetries} attempts`));
                }
            }, retryMs);
        }

        client.on('data', chunk => {
            const text = chunk.toString('ascii');
            if (debug) process.stderr.write(`  [telnet] data: ${JSON.stringify(text)}\n`);
            buf += text;
            if (/\(\d[\d-]*,\d+\)/.test(buf)) {
                clearTimeout(retryTimer);
                resolve(buf);
            }
        });

        trySend();
    });
}

// Wait for the projector prompt, send a query command, return the response.
// Retries if the projector doesn't reply (observed behaviour with busy/slow unit).
function telnetQuery(host, command, timeout, { maxRetries = 3, debug = false } = {}) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(TELNET_PORT, host);
        client.setTimeout(timeout);

        client.once('data', chunk => {
            if (debug) process.stderr.write(`  [telnet] prompt: ${JSON.stringify(chunk.toString('ascii'))}\n`);
            const retryMs = Math.floor(timeout / (maxRetries + 1));
            queryWithRetry(client, command, retryMs, maxRetries, debug)
                .then(buf => { client.destroy(); resolve(buf); })
                .catch(err => { client.destroy(); reject(err); });
        });

        client.on('error', reject);
        client.on('timeout', () => {
            client.destroy();
            reject(new Error(`Telnet timeout connecting to ${host}:${TELNET_PORT}`));
        });
    });
}

// Wait for the projector prompt, send a fire-and-forget command.
function telnetSend(host, command, timeout) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(TELNET_PORT, host);
        client.setTimeout(timeout);

        client.once('data', () => {
            client.write(command + '\r');
            setTimeout(() => { client.destroy(); resolve(); }, 300);
        });

        client.on('error', reject);
        client.on('timeout', () => {
            client.destroy();
            reject(new Error(`Telnet timeout connecting to ${host}:${TELNET_PORT}`));
        });
    });
}

module.exports = { telnetQuery, telnetSend, parseTelnetValue, TELNET_PORT };
