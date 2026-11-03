// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * profile_sync against a stand-in patch daemon that keeps a choice per
 * profile, as patchd does, and a fake render: a change of driver profile is
 * told to the daemon, a known profile's choice reaches the render (through
 * a short connection while the page is closed, through the page's own while
 * it is open), and a reconnecting daemon is told the profile again.
 *
 *   node tools/test_profiles.js
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const { ProfileSync } = require('../src/profile_sync.js');
const { WazeClusterControl } = require('../src/waze_cluster_control.js');
const { FakeRender } = require('./fakes.js');

const RSOCK = `/tmp/woc-pr-${process.pid}.sock`;
const PSOCK = `/tmp/woc-pp-${process.pid}.sock`;

function until(what, check, ms) {
    const deadline = Date.now() + (ms || 2000);
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
            else setTimeout(poll, 10);
        };
        poll();
    });
}

/* patchd's profile command, as patch/patchd.js answers it */
function patchDaemon() {
    const d = { received: [], saved: {}, current: { target: 'map', hud_width_pct: 0 }, sockets: new Set() };
    d.server = net.createServer((s) => {
        d.sockets.add(s);
        s.on('close', () => d.sockets.delete(s));
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const msg = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                d.received.push(msg);
                if (msg.cmd === 'profile') {
                    const known = !!d.saved[msg.id];
                    if (known) d.current = Object.assign({}, d.saved[msg.id]);
                    else d.saved[msg.id] = Object.assign({}, d.current);
                    d.profile = msg.id;
                    s.write(JSON.stringify(Object.assign({ ev: 'profile-reply', ok: true, id: msg.id, known }, d.current)) + '\n');
                }
            }
        });
    });
    return new Promise((resolve) => d.server.listen(PSOCK, () => resolve(d)));
}

async function main() {
    [RSOCK, PSOCK].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* none */ } });
    const render = new FakeRender(RSOCK);
    await render.listen();
    const patch = await patchDaemon();
    let profile = 'driverA';
    const sync = new ProfileSync({ readProfile: () => Promise.resolve(profile), patchPath: PSOCK, renderPath: RSOCK, pollMs: 50, retryMs: 50 });
    sync.start();
    let ok = 0;
    const check = async (name, fn) => { await fn(); ok++; console.log(`ok   ${name}`); };

    await check('the first profile is told to the daemon; nothing sent to the render', async () => {
        await until('profile A', () => patch.received.some((m) => m.cmd === 'profile' && m.id === 'driverA'));
        await new Promise((r) => setTimeout(r, 200));
        assert(!render.received.some((m) => m.cmd === 'start'));
    });
    /* driver A picks the HUD at 70 % (the page's presses, which patchd keeps for A) */
    patch.saved.driverA = { target: 'hud', hud_width_pct: 70 };
    profile = 'driverB';
    await check('a new profile, first seen: it keeps what is set, the render is left alone', async () => {
        await until('profile B', () => patch.profile === 'driverB');
        await new Promise((r) => setTimeout(r, 200));
        assert(!render.received.some((m) => m.cmd === 'start'));
    });
    profile = 'driverA';
    await check('back to A with the page closed: the render moves to the HUD at 70 % over a short connection', async () => {
        await until('render on the HUD', () => render.target === 'hud' && render.hudWidth === 70);
    });
    const c = new WazeClusterControl({ renderPath: RSOCK, patchPath: `/tmp/woc-none-${process.pid}.sock`, retryMs: 50 });
    await until('short connection gone', () => true);
    await new Promise((r) => setTimeout(r, 900));
    c.open();
    await until('page connected', () => c.render.connected());
    const sync2 = new ProfileSync({ control: c, readProfile: () => Promise.resolve(profile), patchPath: PSOCK, renderPath: `/tmp/woc-nowhere-${process.pid}.sock`, pollMs: 50, retryMs: 50 });
    sync.stop();
    profile = 'driverB';
    sync2.start();
    await check('with the page open: through its own render connection', async () => {
        await until('render on the cluster', () => render.target === 'map' && render.hudWidth === 0);
    });
    await check('a restarted daemon is told the profile again', async () => {
        const before = patch.received.filter((m) => m.cmd === 'profile').length;
        patch.sockets.forEach((s) => s.destroy());
        await until('told again', () => patch.received.filter((m) => m.cmd === 'profile').length > before);
    });
    sync2.stop();
    c.close();
    await render.close();
    patch.server.close();
    [RSOCK, PSOCK].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* gone */ } });
    console.log(`${ok}/5 passed`);
    process.exit(0);
}

main().catch((e) => {
    console.log(`FAIL ${e && e.stack}`);
    process.exit(1);
});
