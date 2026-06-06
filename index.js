'use strict';

const net = require('net');

const PLUGIN_NAME = 'homebridge-IN138HDST-projector';
const POWER_NAME  = 'IN138HDST Projector';

const TELNET_PORT    = 23;
const TELNET_CMD_ON  = '(PWR1)';
const TELNET_CMD_OFF = '(PWR0)';
const TELNET_CMD_PWR = '(PWR?)';

// Response format: (min-max,current)  e.g. "(0-1,1)"
function parseTelnetValue(data) {
    const m = data.match(/\(\d[\d-]*,(\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
}

var Service, Characteristic;

module.exports = function (homebridge) {
    console.log(`[${PLUGIN_NAME}] plugin loaded, registering "${POWER_NAME}"`);
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(PLUGIN_NAME, POWER_NAME, IN138HDSTProjector);
};

// ── Telnet helpers ────────────────────────────────────────────────────────────

// Wait for the projector prompt, send a command, collect the response.
function telnetQuery(host, command, timeout) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(TELNET_PORT, host);
        client.setTimeout(timeout);
        let prompted = false;
        let buf = '';

        client.on('data', chunk => {
            const text = chunk.toString('ascii');
            if (!prompted) {
                // Prompt received — send the command
                prompted = true;
                client.write(command);
                // Close after 500 ms to collect the response
                setTimeout(() => client.destroy(), 500);
            } else {
                buf += text;
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

// Wait for prompt, send a fire-and-forget command (no response needed).
function telnetSend(host, command, timeout) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(TELNET_PORT, host);
        client.setTimeout(timeout);

        client.once('data', () => {
            client.write(command);
            setTimeout(() => { client.destroy(); resolve(); }, 300);
        });

        client.on('error', reject);
        client.on('timeout', () => {
            client.destroy();
            reject(new Error(`Telnet timeout connecting to ${host}:${TELNET_PORT}`));
        });
    });
}

// ── Power accessory ───────────────────────────────────────────────────────────

function IN138HDSTProjector(log, config) {
    this.log             = log;
    this.name            = config['name'];
    this.ipAddress       = config['ipAddress'];
    this.timeout         = (config['timeout']         || 10) * 1000;
    this.refreshInterval = (config['refreshInterval'] || 15) * 1000;
    this.debug           = config['debug'] || false;

    this.state         = false;
    this.pollTimer     = null;
    this.cooldownTimer = null;

    this.informationService = new Service.AccessoryInformation();
    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, 'InFocus')
        .setCharacteristic(Characteristic.Model, 'IN138HDST');

    this.switchService = new Service.Switch(this.name);
    this.switchService
        .getCharacteristic(Characteristic.On)
        .on('set', this.setPowerState.bind(this));

    this.poll();
}

IN138HDSTProjector.prototype = {

    poll: async function () {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;

        if (!this.cooldownTimer) {
            try {
                const raw = await telnetQuery(this.ipAddress, TELNET_CMD_PWR, this.timeout);
                const pwr = parseTelnetValue(raw);
                if (pwr === null) {
                    this.log.warn('Could not parse PWR response:', raw.trim());
                } else {
                    const newState = pwr === 1;
                    if (this.debug) this.log.debug(`Poll: PWR=${pwr}`);
                    if (newState !== this.state) {
                        this.state = newState;
                        this.switchService
                            .getCharacteristic(Characteristic.On)
                            .updateValue(this.state);
                        this.log(`Power state: ${this.state ? 'ON' : 'OFF'}`);
                    }
                }
            } catch (err) {
                this.log.error('Poll error:', err.message);
            }
        }

        this.pollTimer = setTimeout(this.poll.bind(this), this.refreshInterval);
    },

    setPowerState: async function (powerOn, callback) {
        callback(null);
        this.log(`Sending power ${powerOn ? 'ON' : 'OFF'} via telnet`);
        try {
            await telnetSend(this.ipAddress, powerOn ? TELNET_CMD_ON : TELNET_CMD_OFF, this.timeout);
            this.log(`Power ${powerOn ? 'ON' : 'OFF'} sent`);
            this.state = powerOn;

            // Suppress polls during hardware transition
            const cooldown = powerOn ? 60_000 : 300_000;
            if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
            this.cooldownTimer = setTimeout(() => {
                this.cooldownTimer = null;
                this.log('Cooldown complete, resuming polls');
            }, cooldown);
        } catch (err) {
            this.log.error('setPowerState error:', err.message);
        }
    },

    getServices: function () {
        return [this.informationService, this.switchService];
    },
};
