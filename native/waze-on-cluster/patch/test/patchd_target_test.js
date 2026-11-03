#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd's display choice ({"cmd":"target"}): a known choice is saved as the
 * render's target in waze-on-cluster.local.conf, replacing an earlier one and
 * keeping the other lines; an unknown one is refused and nothing written. */
'use strict';
var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-target-'));
var SOCK = path.join(dir, 'sock', 'patch.sock');
var CONF = path.join(dir, 'waze-on-cluster.local.conf');
fs.writeFileSync(CONF, 'upload_kb_per_s = 3000\ntarget = map\ntarget_fps = 15\n');

var p = cp.spawn(process.execPath, [PATCHD], {
    env: Object.assign({}, process.env, {
        WOC_PATCH_SOCK: SOCK,
        WOC_PATCH_GROUP: '',
        WOC_LOCAL_CONF: CONF,
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
                if (m && (m.ev === 'target-reply' || m.ev === 'hud-size-reply' || m.ev === 'hud-pos-reply')) { s.end(); resolve(m); }
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
    for (var t = 0; t < 5000 && !fs.existsSync(SOCK); t += 50) await sleep(50);
    var r = await ask({ cmd: 'target', target: 'map+hud' });
    var conf = fs.readFileSync(CONF, 'utf8');
    ok('map+hud (both) is refused: one or the other', !r.ok && conf === 'upload_kb_per_s = 3000\ntarget = map\ntarget_fps = 15\n');
    r = await ask({ cmd: 'target', target: 'hud' });
    conf = fs.readFileSync(CONF, 'utf8');
    ok('hud is saved, replacing the earlier target, the other lines kept',
       r.ok && r.target === 'hud' && conf === 'upload_kb_per_s = 3000\ntarget_fps = 15\ntarget = hud\n');
    r = await ask({ cmd: 'target', target: 'hud' });
    conf = fs.readFileSync(CONF, 'utf8');
    ok('hud replaces it: one target line', r.ok && (conf.match(/^target =/mg) || []).length === 1 && /target = hud\n$/.test(conf));
    r = await ask({ cmd: 'target', target: 'dashboard' });
    ok('an unknown choice is refused and nothing written', !r.ok && fs.readFileSync(CONF, 'utf8') === conf);
    fs.unlinkSync(CONF);
    r = await ask({ cmd: 'target', target: 'map' });
    ok('no local conf yet: it is created with the target', r.ok && fs.readFileSync(CONF, 'utf8') === 'target = map\n');
    r = await ask({ cmd: 'hud-size', hud_width_pct: 70 });
    ok('the HUD size is saved next to the target', r.ok && fs.readFileSync(CONF, 'utf8') === 'target = map\nhud_width_pct = 70\n');
    r = await ask({ cmd: 'hud-size', hud_width_pct: 85 });
    ok('a new size replaces it', r.ok && fs.readFileSync(CONF, 'utf8') === 'target = map\nhud_width_pct = 85\n');
    r = await ask({ cmd: 'hud-size', hud_width_pct: 100 });
    ok('100 % (an older app) is saved as the widest, 85 %', r.ok && r.hud_width_pct === 85 && fs.readFileSync(CONF, 'utf8') === 'target = map\nhud_width_pct = 85\n');
    r = await ask({ cmd: 'hud-size', hud_width_pct: 10 });
    ok('an out-of-range size is refused, nothing written', !r.ok && /hud_width_pct = 85\n$/.test(fs.readFileSync(CONF, 'utf8')));
    r = await ask({ cmd: 'hud-pos', hud_x: 40, hud_y: -20 });
    ok('the HUD position is saved next to the size', r.ok && r.hud_x === 40 && r.hud_y === -20 &&
        fs.readFileSync(CONF, 'utf8') === 'target = map\nhud_width_pct = 85\nhud_offset_x = 40\nhud_offset_y = -20\n');
    r = await ask({ cmd: 'hud-pos', hud_x: 0, hud_y: 0 });
    ok('centred again: both replaced', r.ok && /hud_offset_x = 0\nhud_offset_y = 0\n$/.test(fs.readFileSync(CONF, 'utf8')));
    r = await ask({ cmd: 'hud-pos', hud_x: 900, hud_y: 0 });
    ok('an out-of-range position is refused, nothing written', !r.ok && /hud_offset_x = 0\n/.test(fs.readFileSync(CONF, 'utf8')));
    r = await ask({ cmd: 'hud-pos', hud_x: 1.5, hud_y: 0 });
    ok('a position that is not whole pixels is refused', !r.ok);
})().catch(function (e) {
    ok('no error: ' + e.message, false);
}).then(function () {
    p.kill();
    try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) {}
    process.stdout.write(passed + '/' + total + ' passed\n');
    if (passed !== total) { process.stdout.write(out); process.exitCode = 1; }
});
