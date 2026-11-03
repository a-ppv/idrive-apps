#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd's driver profiles ({"cmd":"profile"}): a profile seen first keeps the
 * current display choice and HUD size, changes are kept for the profile current
 * then, and a profile seen again gets its own back (in the reply and in
 * waze-on-cluster.local.conf). */
'use strict';
var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-profile-'));
var SOCK = path.join(dir, 'sock', 'patch.sock');
var CONF = path.join(dir, 'waze-on-cluster.local.conf');
var PROFILES = path.join(dir, 'profiles.json');
fs.writeFileSync(CONF, 'upload_kb_per_s = 3000\ntarget = map\ntarget_fps = 15\n');

var p = cp.spawn(process.execPath, [PATCHD], {
    env: Object.assign({}, process.env, {
        WOC_PATCH_SOCK: SOCK,
        WOC_PATCH_GROUP: '',
        WOC_LOCAL_CONF: CONF,
        WOC_PROFILES: PROFILES,
        WOC_CARPLAY: path.join(dir, 'no-carplay'),
        WOC_STREAM_STATE: path.join(dir, 'no-stream.json'),
        WOC_RESYNC_FILE: path.join(dir, 'resync.json'),
        WOC_RECMGR_CONF: path.join(dir, 'no-recmgr'),
        WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: path.join(dir, 'no-stat'),
        WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
        WOC_MOUNT: path.join(dir, 'no-mount'),
        WOC_PROC_MOUNTS: path.join(dir, 'no-mounts'),
        WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
        WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
        WOC_DLT_RETRY_MS: '600000',
        WOC_REMOUNT_LOCK: path.join(dir, 'remount.lock'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
});
var out = '';
p.stdout.on('data', function (d) { out += d; });
p.stderr.on('data', function (d) { out += d; });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* One request on a fresh connection; resolves to the first reply. */
function ask(obj) {
    return new Promise(function (resolve, reject) {
        var s = net.connect(SOCK), buf = '';
        s.setEncoding('utf8');
        s.on('connect', function () { s.write(JSON.stringify(obj) + '\n'); });
        s.on('data', function (d) {
            buf += d;
            buf.split('\n').forEach(function (l) {
                var m = null;
                try { m = JSON.parse(l); } catch (e) {}
                if (m && (m.ev === 'target-reply' || m.ev === 'hud-size-reply' || m.ev === 'hud-pos-reply' || m.ev === 'profile-reply')) { s.end(); resolve(m); }
            });
        });
        s.on('error', reject);
        setTimeout(function () { reject(new Error('no reply')); }, 5000);
    });
}

var passed = 0, total = 0;
function ok(name, cond) {
    total++;
    if (cond) passed++;
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + '\n');
}

(async function () {
    for (var i = 0; i < 50 && !fs.existsSync(SOCK); i++) await sleep(100);
    var r = await ask({ cmd: 'profile', id: 'driverA' });
    ok('a first profile keeps the current settings', r.ok && !r.known && r.target === 'map' && r.hud_width_pct === 0);
    r = await ask({ cmd: 'target', target: 'hud' });
    r = await ask({ cmd: 'hud-size', hud_width_pct: 70 });
    r = await ask({ cmd: 'hud-pos', hud_x: 60, hud_y: -30 });
    ok('changes are kept for it', JSON.parse(fs.readFileSync(PROFILES, 'utf8')).driverA.target === 'hud' &&
        JSON.parse(fs.readFileSync(PROFILES, 'utf8')).driverA.hud_width_pct === 70);
    r = await ask({ cmd: 'profile', id: 'driverB' });
    ok('a second profile, first seen, keeps what is set now', r.ok && !r.known && r.target === 'hud' && r.hud_width_pct === 70);
    r = await ask({ cmd: 'target', target: 'map' });
    ok('its change is its own', JSON.parse(fs.readFileSync(PROFILES, 'utf8')).driverB.target === 'map' &&
        JSON.parse(fs.readFileSync(PROFILES, 'utf8')).driverA.target === 'hud');
    r = await ask({ cmd: 'profile', id: 'driverA' });
    ok('back to the first: its HUD at 70 % in the reply', r.ok && r.known && r.target === 'hud' && r.hud_width_pct === 70);
    ok('and its HUD position', r.hud_x === 60 && r.hud_y === -30);
    await sleep(100);
    ok('and saved for the next start', /target = hud/.test(fs.readFileSync(CONF, 'utf8')) && /hud_width_pct = 70/.test(fs.readFileSync(CONF, 'utf8')) &&
        /upload_kb_per_s = 3000/.test(fs.readFileSync(CONF, 'utf8')));
    r = await ask({ cmd: 'profile', id: 'driverB' });
    ok('the second again: the cluster', r.ok && r.known && r.target === 'map');
    r = await ask({ cmd: 'hud-pos', hud_x: -100, hud_y: 0 });
    r = await ask({ cmd: 'profile', id: 'driverA' });
    ok('a position kept per profile: the first keeps its own', r.hud_x === 60 && r.hud_y === -30);
    await sleep(100);
    ok('saved for the next start too', /hud_offset_x = 60/.test(fs.readFileSync(CONF, 'utf8')) && /hud_offset_y = -30/.test(fs.readFileSync(CONF, 'utf8')));
    r = await ask({ cmd: 'profile' });
    ok('no id: refused', !r.ok);
})().catch(function (e) {
    ok('no error: ' + e.message, false);
}).then(function () {
    p.kill();
    try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) {}
    process.stdout.write(passed + '/' + total + ' passed\n');
    if (passed !== total) { process.stdout.write(out); process.exitCode = 1; }
});
