'use strict';

const net = require('net');

const TELNET_PORT = 23;

// Response format: (min-max,current)  e.g. "(0-1,1)"
function parseTelnetValue(data) {
    const m = data.match(/\(\d[\d-]*,(\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
}

// Wait for the projector prompt, send a query command, return the response.
// The projector can take several seconds to reply — just wait for the timeout.
function telnetQuery(host, command, timeout, { debug = false } = {}) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(TELNET_PORT, host);
        client.setTimeout(timeout);
        let prompted = false;
        let buf = '';

        client.on('data', chunk => {
            const text = chunk.toString('ascii');
            if (debug) process.stderr.write(`  [telnet] data: ${JSON.stringify(text)}\n`);
            if (!prompted) {
                prompted = true;
                if (debug) process.stderr.write(`  [telnet] prompt received, sending ${command}\\r\n`);
                client.write(command + '\r');
            } else {
                buf += text;
                if (/\(\d[\d-]*,\d+\)/.test(buf)) {
                    client.destroy();
                }
            }
        });

        client.on('close', () => resolve(buf));
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
