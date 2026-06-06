#!/usr/bin/env node
'use strict';

// Quick local test — no homebridge needed.
// Run: node test.js
// Or:  node test.js off

const axios  = require('axios');
const crypto = require('crypto');
const qs     = require('querystring');

const IP       = '192.168.1.57';
const USERNAME = 'admin';
const PASSWORD = 'bRjhhh48V';

const http = axios.create({ timeout: 10000, headers: { 'User-Agent': 'projector-test' } });

function parseInputValue(html, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`<input[^>]+name=["']?${esc}["']?[^>]*value=\\s*["']?([^"'\\s>]*)`, 'i'),
        new RegExp(`<input[^>]+value=\\s*["']?([^"'\\s>]*)[^>]*name=["']?${esc}["']?`, 'i'),
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
    }
    return null;
}

function parseHiddenInputs(html) {
    const fields = {};
    const tagRe = /<input[^>]+type=["']?hidden["']?[^>]*/gi;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const tag    = m[0];
        const nameM  = tag.match(/name=["']?([^"'\s>]+)/i);
        const valueM = tag.match(/value=["']([^"']*)/i);
        if (nameM && nameM[1]) fields[nameM[1]] = valueM ? valueM[1] : '';
    }
    return fields;
}

async function login() {
    console.log('\n── Fetching /login.htm ──');
    const page = await http.get(`http://${IP}/login.htm`);
    console.log(`  ${page.data.length} bytes received`);

    const challenge = parseInputValue(page.data, 'Challenge');
    console.log('  Challenge:', challenge);
    if (!challenge) {
        console.error('\n  RAW HTML:\n', page.data);
        throw new Error('No Challenge field found');
    }

    const response = crypto.createHash('md5')
        .update(USERNAME + PASSWORD + challenge)
        .digest('hex');
    console.log('  MD5 response:', response);

    console.log('\n── POST /tgi/login.tgi ──');
    const postData = qs.stringify({ user:'0', User_ID:USERNAME, Password:'',
        Username:'1', Challenge:'', Response:response, sned:'' });

    const resp = await http.post(`http://${IP}/tgi/login.tgi`, postData, {
        maxRedirects: 0,
        validateStatus: s => s < 400,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log(`  HTTP ${resp.status}`);
    console.log('  set-cookie:', resp.headers['set-cookie']);
    console.log('  location:  ', resp.headers['location']);

    const rawCookies = resp.headers['set-cookie'] || [];
    const cookieStr  = Array.isArray(rawCookies) ? rawCookies.join('; ') : rawCookies;
    const match      = cookieStr.match(/ATOP=([^;]+)/);
    if (!match) throw new Error('No ATOP cookie in response');

    const cookie = match[1];
    console.log(`  Cookie: ATOP=${cookie}`);
    return cookie;
}

async function status(cookie) {
    console.log('\n── GET /control.htm ──');
    const resp = await http.get(`http://${IP}/control.htm`,
        { headers: { Cookie: `ATOP=${cookie}` } });
    console.log(`  ${resp.data.length} bytes`);
    const pwr = parseInputValue(resp.data, 'pwr');
    console.log(`  pwr field: ${pwr}  →  ${pwr === '1' ? 'ON' : pwr === '0' ? 'OFF' : 'unknown'}`);
    return { html: resp.data, pwr };
}

async function power(cookie, html, turnOn) {
    const fields = parseHiddenInputs(html);
    fields[turnOn ? 'btn_powon' : 'btn_powoff'] = '';
    console.log(`\n── POST /tgi/control.tgi (power ${turnOn ? 'ON' : 'OFF'}) ──`);
    console.log('  fields:', fields);
    const resp = await http.post(`http://${IP}/tgi/control.tgi`, qs.stringify(fields), {
        headers: { Cookie: `ATOP=${cookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log(`  HTTP ${resp.status}`);
}

(async () => {
    try {
        const cmd = process.argv[2];  // 'on', 'off', or undefined (status only)
        const cookie = await login();
        const { html, pwr } = await status(cookie);
        if (cmd === 'on')  await power(cookie, html, true);
        if (cmd === 'off') await power(cookie, html, false);
    } catch (err) {
        console.error('\nError:', err.message);
        process.exit(1);
    }
})();
