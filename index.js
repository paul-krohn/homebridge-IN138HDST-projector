'use strict';

const net    = require('net');
const axios  = require('axios');
const crypto = require('crypto');
const qs     = require('querystring');

const PLUGIN_NAME  = 'homebridge-IN138HDST-projector';
const POWER_NAME   = 'IN138HDST Projector';
const REBOOT_NAME  = 'IN138HDST Projector Reboot';

// The real admin page is ~20 KB; the unauthenticated frameset is ~1 KB.
const MIN_CONTROL_PAGE_BYTES = 5000;

// Telnet port — unauthenticated, used for power commands only.
const TELNET_PORT = 23;
const TELNET_CMD_ON  = '(PWR1)';
const TELNET_CMD_OFF = '(PWR0)';

var Service, Characteristic;

module.exports = function (homebridge) {
    console.log(`[${PLUGIN_NAME}] plugin loaded, registering "${POWER_NAME}" and "${REBOOT_NAME}"`);
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(PLUGIN_NAME, POWER_NAME,  IN138HDSTProjector);
    homebridge.registerAccessory(PLUGIN_NAME, REBOOT_NAME, IN138HDSTReboot);
};

// ── HTML helpers ──────────────────────────────────────────────────────────────

function parseInputValue(html, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`<input[^>]+name=\\s*["']?${esc}["']?[^>]*value=\\s*["']?([^"'\\s>]*)`, 'i'),
        new RegExp(`<input[^>]+value=\\s*["']?([^"'\\s>]*)[^>]*name=\\s*["']?${esc}["']?`, 'i'),
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
    }
    return null;
}

function parseHiddenInputs(html) {
    const fields = {};
    const tagRe = /<input[^>]+type=\s*["']?hidden["']?[^>]*/gi;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const tag    = m[0];
        const nameM  = tag.match(/name=\s*["']?([^"'\s>]+)/i);
        const valueM = tag.match(/value=\s*["']([^"']*)/i);
        if (nameM && nameM[1]) {
            fields[nameM[1]] = valueM ? valueM[1] : '';
        }
    }
    return fields;
}

// ── Telnet helper ─────────────────────────────────────────────────────────────

function telnetCommand(host, command, timeout) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(TELNET_PORT, host);
        client.setTimeout(timeout);
        client.on('connect', () => {
            client.write(command);
            // Brief pause to let the projector receive it before we close
            setTimeout(() => { client.destroy(); resolve(); }, 300);
        });
        client.on('error', reject);
        client.on('timeout', () => {
            client.destroy();
            reject(new Error(`Telnet connection to ${host}:${TELNET_PORT} timed out`));
        });
    });
}

// ── Session mixin (shared login logic) ───────────────────────────────────────

function SessionMixin(ipAddress, username, password, timeout, log) {
    this.ipAddress = ipAddress;
    this.username  = username;
    this.password  = password;
    this.timeout   = timeout;
    this.log       = log;
    this.cookie    = null;
    this.http      = axios.create({
        timeout,
        headers: { 'User-Agent': PLUGIN_NAME },
    });
}

SessionMixin.prototype.login = async function () {
    this.log('Logging in to', this.ipAddress);
    const base = `http://${this.ipAddress}`;

    const loginPage = await this.http.get(`${base}/login.htm`);
    const challenge = parseInputValue(loginPage.data, 'Challenge');
    if (!challenge) throw new Error('No Challenge field found in login page');

    const response = crypto.createHash('md5')
        .update(this.username + this.password + challenge)
        .digest('hex');

    const postData = qs.stringify({
        user: '0', User_ID: this.username, Password: '',
        Username: '1', Challenge: '', Response: response, sned: '',
    });

    const resp = await this.http.post(`${base}/tgi/login.tgi`, postData, {
        maxRedirects: 0,
        validateStatus: s => s < 400,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const rawCookies = resp.headers['set-cookie'] || [];
    const cookieStr  = Array.isArray(rawCookies) ? rawCookies.join('; ') : rawCookies;
    const match      = cookieStr.match(/ATOP=([^;]+)/);
    if (!match) throw new Error(`Login failed: no ATOP cookie. Headers: ${JSON.stringify(resp.headers)}`);

    this.cookie = match[1];
    this.log(`Session established (ATOP=${this.cookie})`);
};

SessionMixin.prototype.fetchPage = async function (path) {
    if (!this.cookie) await this.login();

    const fetch = async () => this.http.get(
        `http://${this.ipAddress}${path}`,
        { headers: { Cookie: `ATOP=${this.cookie}` } }
    );

    let resp = await fetch();
    if (resp.data.length < MIN_CONTROL_PAGE_BYTES) {
        this.log('Session expired, re-logging in...');
        this.cookie = null;
        await this.login();
        resp = await fetch();
    }
    return resp.data;
};

// ── Power accessory ───────────────────────────────────────────────────────────

function IN138HDSTProjector(log, config) {
    this.log             = log;
    this.name            = config['name'];
    this.ipAddress       = config['ipAddress'];
    this.username        = config['username'] || 'admin';
    this.password        = config['password'];
    this.timeout         = (config['timeout']         || 10) * 1000;
    this.refreshInterval = (config['refreshInterval'] || 15) * 1000;
    this.debug           = config['debug'] || false;

    SessionMixin.call(this, this.ipAddress, this.username, this.password, this.timeout, log);

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
                const html = await this.fetchPage('/control.htm');
                const pwr  = parseInputValue(html, 'pwr');
                if (pwr === null) {
                    this.log.warn('Could not parse pwr field');
                } else {
                    const newState = pwr === '1';
                    if (this.debug) this.log.debug(`Poll: pwr=${pwr}`);
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
            await telnetCommand(this.ipAddress, powerOn ? TELNET_CMD_ON : TELNET_CMD_OFF, this.timeout);
            this.log(`Power ${powerOn ? 'ON' : 'OFF'} sent`);
            this.state = powerOn;

            // Suppress status polls during hardware transition
            const cooldown = powerOn ? 60_000 : 300_000;
            if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
            this.cooldownTimer = setTimeout(() => {
                this.cooldownTimer = null;
                this.log('Cooldown complete, resuming status polls');
            }, cooldown);
        } catch (err) {
            this.log.error('setPowerState error:', err.message);
        }
    },

    getServices: function () {
        return [this.informationService, this.switchService];
    },
};

Object.assign(IN138HDSTProjector.prototype, SessionMixin.prototype);

// ── Reboot accessory ──────────────────────────────────────────────────────────

function IN138HDSTReboot(log, config) {
    this.log       = log;
    this.name      = config['name'];
    this.ipAddress = config['ipAddress'];
    this.username  = config['username'] || 'admin';
    this.password  = config['password'];
    this.timeout   = (config['timeout'] || 10) * 1000;
    this.debug     = config['debug'] || false;

    SessionMixin.call(this, this.ipAddress, this.username, this.password, this.timeout, log);

    this.informationService = new Service.AccessoryInformation();
    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, 'InFocus')
        .setCharacteristic(Characteristic.Model, 'IN138HDST Reboot');

    this.switchService = new Service.Switch(this.name);
    this.switchService
        .getCharacteristic(Characteristic.On)
        .on('set', this.triggerReboot.bind(this));
}

IN138HDSTReboot.prototype = {

    triggerReboot: async function (value, callback) {
        callback(null);
        if (!value) return;  // only act on the on→off edge

        this.log('Fetching RebootSystem page...');
        try {
            const html = await this.fetchPage('/RebootSystem.htm');

            // Find the form action and submit the Apply button
            const actionMatch = html.match(/<form[^>]+action=\s*["']?([^"'\s>]+)/i);
            const action = actionMatch
                ? actionMatch[1]
                : '/tgi/RebootSystem.tgi';
            const url = action.startsWith('http')
                ? action
                : `http://${this.ipAddress}${action.startsWith('/') ? '' : '/'}${action}`;

            const fields = parseHiddenInputs(html);
            // Find the Apply button and include it
            const applyMatch = html.match(/<input[^>]+value=\s*["']?Apply["']?[^>]*/i);
            if (applyMatch) {
                const nameM = applyMatch[0].match(/name=\s*["']?([^"'\s>]+)/i);
                if (nameM) fields[nameM[1]] = 'Apply';
            }

            if (this.debug) this.log.debug('Reboot POST:', url, fields);

            await this.http.post(url, qs.stringify(fields), {
                headers: {
                    Cookie: `ATOP=${this.cookie}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            this.log('Reboot command sent');
        } catch (err) {
            this.log.error('Reboot error:', err.message);
        }

        // Auto-reset the switch to off after 2 s
        setTimeout(() => {
            this.switchService
                .getCharacteristic(Characteristic.On)
                .updateValue(false);
        }, 2000);
    },

    getServices: function () {
        return [this.informationService, this.switchService];
    },
};

Object.assign(IN138HDSTReboot.prototype, SessionMixin.prototype);
