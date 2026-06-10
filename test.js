#!/usr/bin/env node
'use strict';

// Quick local test — no homebridge needed.
// Usage: node test.js [on|off|status] [--debug]

const { telnetQuery, telnetSend, parseTelnetValue } = require('./telnet');

const IP      = '192.168.1.57';
const TIMEOUT = 15000;

const COMMANDS = {
    status: '(PWR?)',
    on:     '(PWR1)',
    off:    '(PWR0)',
};

const args  = process.argv.slice(2);
const cmd   = args.find(a => !a.startsWith('--')) || 'status';
const debug = args.includes('--debug');

const command = COMMANDS[cmd];
if (!command) {
    console.error(`Unknown command: ${cmd}. Use: on, off, status`);
    process.exit(1);
}

(async () => {
    console.log(`\n── Sending ${command} ──`);
    try {
        if (cmd === 'status') {
            const raw = await telnetQuery(IP, command, TIMEOUT, { debug });
            console.log('  Raw response:', JSON.stringify(raw));
            const pwr = parseTelnetValue(raw);
            if (pwr === null) {
                console.log('  Could not parse response');
            } else {
                console.log(`  Power: ${pwr === 1 ? 'ON' : 'OFF'}`);
            }
        } else {
            await telnetSend(IP, command, TIMEOUT);
            console.log('  Sent.');
        }
    } catch (err) {
        console.error('\nError:', err.message);
        process.exit(1);
    }
})();
