'use strict';

const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

const PLUGIN_NAME = 'homebridge-IN138HDST-projector';
const ACCESSORY_NAME = 'IN138HDST Projector';

// The real admin page is ~20 KB; the unauthenticated frameset is ~1 KB.
// Anything below this threshold means the session cookie is stale.
const MIN_CONTROL_PAGE_BYTES = 5000;

var Service, Characteristic;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, IN138HDSTProjector);
};

// ── HTML helpers ──────────────────────────────────────────────────────────────

/**
 * Return the VALUE of the first <input> whose NAME matches `name` (case-insensitive).
 * Handles both NAME-before-VALUE and VALUE-before-NAME attribute orderings.
 */
function parseInputValue(html, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`<input[^>]+name=["']?${esc}["']?[^>]*value=["']?([^"'\\s>]*)`, 'i'),
        new RegExp(`<input[^>]+value=["']?([^"'\\s>]*)[^>]*name=["']?${esc}["']?`, 'i'),
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
    }
    return null;
}

/**
 * Return all hidden <input> fields as { name: value }.
 */
function parseHiddenInputs(html) {
    const fields = {};
    const tagRe = /<input[^>]+type=["']?hidden["']?[^>]*/gi;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const tag    = m[0];
        const nameM  = tag.match(/name=["']?([^"'\s>]+)/i);
        const valueM = tag.match(/value=["']([^"']*)/i);
        if (nameM && nameM[1]) {
            fields[nameM[1]] = valueM ? valueM[1] : '';
        }
    }
    return fields;
}

// ── Accessory ─────────────────────────────────────────────────────────────────

function IN138HDSTProjector(log, config) {
    this.log             = log;
    this.name            = config['name'];
    this.ipAddress       = config['ipAddress'];
    this.username        = config['username'] || 'admin';
    this.password        = config['password'];
    this.timeout         = (config['timeout']          || 10) * 1000;
    this.refreshInterval = (config['refreshInterval']  || 15) * 1000;
    this.debug           = config['debug'] || false;

    this.cookie       = null;   // ATOP session token
    this.state        = false;  // last known power state
    this.pollTimer    = null;
    this.cooldownTimer = null;  // suppresses polls during hardware transitions

    this.http = axios.create({
        timeout: this.timeout,
        headers: { 'User-Agent': PLUGIN_NAME },
    });

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

    // ── Session management ────────────────────────────────────────────────────

    /**
     * MD5 challenge-response login.
     *
     * The login page embeds a server-generated nonce in a hidden 'Challenge'
     * field.  We compute hex_md5(username + password + challenge) and POST it
     * as 'Response'.  The server returns a 302 with Set-Cookie: ATOP=<token>.
     * We use maxRedirects:0 so we can read that header before the redirect.
     */
    login: async function () {
        this.log('Logging in to', this.ipAddress);
        const base = `http://${this.ipAddress}`;

        // 1. Get challenge nonce
        const loginPage = await this.http.get(`${base}/login.htm`);
        const challenge = parseInputValue(loginPage.data, 'Challenge');
        if (!challenge) throw new Error('No Challenge field found in login page');
        if (this.debug) this.log.debug('Challenge:', challenge);

        // 2. Response = hex_md5(username + password + challenge)
        const response = crypto.createHash('md5')
            .update(this.username + this.password + challenge)
            .digest('hex');

        // 3. POST — stop before redirect to capture Set-Cookie
        const postData = querystring.stringify({
            user:      '0',
            User_ID:   this.username,
            Password:  '',       // cleared by browser JS before submit
            Username:  '1',
            Challenge: '',       // cleared by browser JS before submit
            Response:  response,
            sned:      '',
        });

        const resp = await this.http.post(`${base}/tgi/login.tgi`, postData, {
            maxRedirects: 0,
            validateStatus: s => s < 400,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        // 4. Extract ATOP cookie
        const rawCookies = resp.headers['set-cookie'] || [];
        const cookieStr  = Array.isArray(rawCookies) ? rawCookies.join('; ') : rawCookies;
        const match      = cookieStr.match(/ATOP=([^;]+)/);
        if (!match) {
            throw new Error(
                `Login returned HTTP ${resp.status} but no ATOP cookie. ` +
                `Headers: ${JSON.stringify(resp.headers)}`
            );
        }

        this.cookie = match[1];
        this.log(`Session established (ATOP=${this.cookie})`);
    },

    /**
     * Fetch /control.htm with the session cookie.
     * Auto re-logins if the response looks like the unauthenticated frameset.
     */
    fetchControlPage: async function () {
        if (!this.cookie) await this.login();

        const fetch = async () => this.http.get(
            `http://${this.ipAddress}/control.htm`,
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
    },

    // ── Polling ───────────────────────────────────────────────────────────────

    poll: async function () {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;

        if (!this.cooldownTimer) {
            try {
                const html = await this.fetchControlPage();
                const pwr  = parseInputValue(html, 'pwr');

                if (pwr === null) {
                    this.log.warn('Could not parse pwr field from control page');
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

    // ── Power control ─────────────────────────────────────────────────────────

    /**
     * Send a power on/off command.
     *
     * Replicates what control.js pressbtn() does in the browser:
     * collects all hidden fields from formControl_1 and POSTs them to
     * /tgi/control.tgi, with btn_powon='' or btn_powoff='' as the
     * submit button name.
     */
    setPowerState: async function (powerOn, callback) {
        callback(null);  // acknowledge immediately; HomeKit doesn't wait

        if (this.debug) this.log.debug('setPowerState ->', powerOn);

        try {
            const html = await this.fetchControlPage();
            const pwr  = parseInputValue(html, 'pwr');

            if (pwr === (powerOn ? '1' : '0')) {
                this.log(`Already ${powerOn ? 'on' : 'off'}, skipping`);
                return;
            }

            const fields = parseHiddenInputs(html);
            fields[powerOn ? 'btn_powon' : 'btn_powoff'] = '';

            await this.http.post(
                `http://${this.ipAddress}/tgi/control.tgi`,
                querystring.stringify(fields),
                {
                    headers: {
                        Cookie: `ATOP=${this.cookie}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                }
            );

            this.log(`Power ${powerOn ? 'ON' : 'OFF'} sent`);
            this.state = powerOn;

            // Suppress polls while the hardware transitions:
            //   power-on  → ~60 s lamp warm-up
            //   power-off → ~5 min fan cooldown
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

    // ── Homebridge ────────────────────────────────────────────────────────────

    getServices: function () {
        return [this.informationService, this.switchService];
    },
};
