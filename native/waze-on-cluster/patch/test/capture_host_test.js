#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The DLT capture service run inside another daemon (dlt_capture.js host,
 * patchd.js --dlt-capture) against a fake DLT daemon (its control socket,
 * its TCP listener, its /proc entries and iDLT records):
 *   - the same socket protocol and capture lifecycle as the service on its
 *     own; a stop restores a capture it owns before the daemon exits;
 *   - a failure of the service (a start or a restore that throws) restarts
 *     the service, never the daemon, and a capture left open is restored
 *     once it starts again;
 *   - patchd runs it only with --dlt-capture, and not while an earlier
 *     version's waze-on-cluster-capture.service is installed or running,
 *     then takes it over once that is gone; patchd's capture commands reach
 *     it as before, and a SIGTERM restores an open capture before patchd
 *     exits;
 *   - the patchd unit's ExecStopPost restores a capture left open, except
 *     while the earlier unit is installed (its own ExecStopPost does then).
 *
 *   node capture_host_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for the patchd this runs */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');

var HELPER = path.join(__dirname, '..', 'dlt_capture.js');
var PATCHD = path.join(__dirname, '..', 'patchd.js');
var UNIT = path.join(__dirname, '..', '..', 'systemd', 'waze-on-cluster-patchd.service');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-capture-host-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

var CAPTURE_UNIT = path.join(dir, 'units', 'waze-on-cluster-capture.service');
var UNIT_STATE = path.join(dir, 'unit-state');
var dlt = null, ENV = null, STATE = null, CTL = null;   /* the fake DLT daemon, set up first (below) */
var modes, state, command, trace;
function tcpOpen() { return dlt.open(); }

/* ---- helpers ---------------------------------------------------------------- */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms) {
    for (var t = 0; t < (ms || 5000); t += 20) { if (await fn()) return true; await sleep(20); }
    return false;
}
function spawn(args, env) {
    var c = cp.spawn(process.execPath, args, { env: env || ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    c.out = '';
    c.stdout.on('data', function (d) { c.out += d; });
    c.stderr.on('data', function (d) { c.out += d; });
    c.done = new Promise(function (r) { c.on('exit', function (code, sig) { r({ code: code, signal: sig }); }); });
    return c;
}
function alive(c) { return c.exitCode === null && c.signalCode === null; }
/* The service hosted in a daemon of its own: SIGTERM stops it, then exits 0. */
function hostDaemon() {
    return spawn(['-e', 'var h = require(' + JSON.stringify(HELPER) + ').host(function (l) { console.log(l); });' +
        'process.on("SIGTERM", function () { h.stop(function (e) { console.log("stopped: " + (e ? e.message : "ok")); process.exit(0); }); });']);
}
async function openCapture(send) {
    trace(2);
    await send('start');
    return until(function () { return state().state === 'open'; });
}

var PD = path.join(dir, 'patchd'), BIN = path.join(dir, 'bin'), PSOCK = path.join(PD, 'shm', 'patch.sock'), PENV = null;
function patchd(args) { return spawn([PATCHD].concat(args || ['--dlt-capture']), PENV); }
/* One command on patchd's socket: the reply of type ev, or null. */
function pcmd(cmd, ev) {
    return new Promise(function (resolve) {
        var c = net.connect(PSOCK), buf = '';
        var t = setTimeout(function () { c.destroy(); resolve(null); }, 5000);
        c.on('error', function () { clearTimeout(t); resolve(null); });
        c.on('connect', function () { c.write(JSON.stringify({ cmd: cmd }) + '\n'); });
        c.setEncoding('utf8');
        c.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = null, line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                try { m = JSON.parse(line); } catch (e) {}
                if (m && m.ev === ev) { clearTimeout(t); c.destroy(); resolve(m); return; }
            }
        });
    });
}

(async function () {
    dlt = await require('./fake_dlt.js')(path.join(dir, 'dlt'));
    ENV = Object.assign({}, process.env, dlt.env, { WOC_CAPTURE_MS: '60000', WOC_CAPTURE_RETRY_MS: '80', WOC_CAPTURE_RESTART_MS: '100' });
    STATE = path.join(dlt.env.WOC_CAPTURE_DIR, 'state.json');
    CTL = dlt.env.WOC_CAPTURE_SOCK;
    modes = dlt.modes; state = dlt.state; command = dlt.command; trace = dlt.trace;
    /* patchd in a temporary world, its capture's socket at CTL. */
    [PD, path.join(PD, 'state'), BIN, path.dirname(CAPTURE_UNIT)].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
    fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(BIN, 'systemctl'), '#!/bin/sh\ncat ' + JSON.stringify(UNIT_STATE) + ' 2>/dev/null || echo inactive\n', { mode: 0o755 });
    PENV = Object.assign({}, ENV, {
        PATH: BIN + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: PSOCK, WOC_PATCH_GROUP: '', WOC_PATCH_LOGS_GROUP: '',
        WOC_STATE_DIR: path.join(PD, 'state'), WOC_LOCAL_CONF: path.join(PD, 'state', 'local.conf'),
        WOC_CARPLAY: path.join(PD, 'no-carplay'), WOC_AAPD: path.join(PD, 'no-aapd'),
        WOC_RECMGR_CONF: path.join(PD, 'no-recmgr'), WOC_RECMGR_AT_BOOT: path.join(PD, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: path.join(PD, 'no-stat'), WOC_PROC: path.join(PD, 'no-proc'), WOC_BOOT_ID: path.join(PD, 'no-boot-id'),
        WOC_MOUNT: '/usr/bin/false', WOC_PROC_MOUNTS: path.join(PD, 'no-mounts'),
        WOC_DLT_RECEIVE: path.join(PD, 'no-dlt-receive'), WOC_DLT_RETRY_MS: '600000',
        WOC_REMOUNT_LOCK: path.join(PD, 'remount.lock'), WOC_RECOVERY_STATE: path.join(PD, 'recovery.json'),
        WOC_CAPTURE_UNIT: CAPTURE_UNIT, WOC_SYSTEMCTL: path.join(BIN, 'systemctl'),
        WOC_CAPTURE_RECHECK_MS: '200',
    });

    /* 1. Hosted: the same protocol and lifecycle. */
    var h = hostDaemon();
    ok('hosted: the capture socket answers', await until(async function () { return !!(await command('status')); }), h.out);
    ok('hosted: a capture opens and closes, DLT put back as it was', await openCapture(command) && modes.join() === '1' &&
        !!(await command('stop')) && await until(function () { return state().state === 'closed'; }) && modes.join() === '1,2' && !tcpOpen(),
        modes.join() + ' ' + JSON.stringify(state()));

    /* 2. A stop with a capture open restores it before the daemon exits. */
    ok('hosted: a capture open', await openCapture(command));
    h.kill('SIGTERM');
    var r = await h.done;
    ok('hosted: SIGTERM restores the open capture, then the daemon exits 0', r.code === 0 && /stopped: ok/.test(h.out) &&
        state().state === 'closed' && state().owned === false && modes[modes.length - 1] === 2 && !tcpOpen(), JSON.stringify(r) + ' ' + h.out);

    /* 3. A start that fails restarts the service, never the daemon. */
    fs.unlinkSync(STATE);
    fs.mkdirSync(STATE);
    h = hostDaemon();
    await until(function () { return (h.out.match(/starts again/g) || []).length >= 3; });
    ok('hosted: a start that throws: the service starts again, the daemon stays up, nothing answers meanwhile',
        alive(h) && (h.out.match(/starts again/g) || []).length >= 3 && !(await command('status')), h.out.slice(-400));
    fs.rmdirSync(STATE);
    ok('hosted: once it can start, it answers', await until(async function () { return !!(await command('status')); }) && alive(h), h.out.slice(-300));

    /* 4. A restore that throws with a capture open: the service starts
     * again until it can, then restores the capture it left. */
    ok('hosted: a capture open before its restore fails', await openCapture(command));
    var before = (h.out.match(/starts again/g) || []).length;
    fs.mkdirSync(STATE + '.tmp');
    await command('stop');
    await until(function () { return (h.out.match(/starts again/g) || []).length >= before + 2; });
    ok('hosted: a restore that throws: the service starts again, the daemon stays up, DLT still as the capture left it',
        alive(h) && (h.out.match(/starts again/g) || []).length >= before + 2 && state().owned === true && !!tcpOpen(), h.out.slice(-400));
    fs.rmdirSync(STATE + '.tmp');
    ok('hosted: started again, it restores the capture it left', await until(function () { return state().state === 'closed' && !tcpOpen(); }) &&
        modes[modes.length - 1] === 2 && alive(h) && !!(await command('status')), JSON.stringify(state()) + ' ' + h.out.slice(-300));
    h.kill('SIGTERM');
    await h.done;

    /* 5. patchd without --dlt-capture does not run it. */
    var p = patchd([]);
    await until(function () { return fs.existsSync(PSOCK); }, 10000);
    await sleep(600);
    ok('patchd without --dlt-capture: no capture service', alive(p) && !(await command('status')), p.out.slice(-300));
    p.kill('SIGKILL'); await p.done;

    /* 6. Not while an earlier version's capture unit is installed or runs;
     * taken over once it is gone. */
    fs.writeFileSync(CAPTURE_UNIT, '[Service]\n');
    p = patchd();
    await until(function () { return /served by waze-on-cluster-capture\.service \(installed\)/.test(p.out); }, 10000);
    await sleep(500);
    ok('patchd --dlt-capture, the earlier capture unit installed: not served here', alive(p) && !(await command('status')) &&
        /served by waze-on-cluster-capture\.service \(installed\)/.test(p.out), p.out.slice(-300));
    fs.unlinkSync(CAPTURE_UNIT);
    fs.writeFileSync(UNIT_STATE, 'active\n');
    await sleep(700);
    ok('patchd --dlt-capture, the earlier capture unit still running: not served here', alive(p) && !(await command('status')), p.out.slice(-300));
    fs.writeFileSync(UNIT_STATE, 'inactive\n');
    ok('patchd --dlt-capture: served here once the earlier unit is gone',
        await until(async function () { return !!(await command('status')); }) && /DLT capture: served here/.test(p.out), p.out.slice(-300));

    /* 7. patchd's capture commands reach it; SIGTERM restores an open one. */
    var rep = await pcmd('capture-status', 'capture-reply');
    ok('patchd: capture-status answered by the service here', !!rep && rep.capture && rep.capture.state === 'closed', JSON.stringify(rep));
    trace(2);
    rep = await pcmd('capture-start', 'capture-reply');
    ok('patchd: capture-start opens a capture', !!rep && await until(function () { return state().state === 'open'; }) && !!tcpOpen(),
        JSON.stringify(rep) + ' ' + JSON.stringify(state()));
    p.kill('SIGTERM');
    r = await p.done;
    ok('patchd: SIGTERM restores the open capture, then patchd exits 0', r.code === 0 && state().state === 'closed' &&
        modes[modes.length - 1] === 2 && !tcpOpen(), JSON.stringify(r) + ' ' + JSON.stringify(state()) + ' ' + p.out.slice(-300));

    /* 8. The unit's ExecStopPost (its command with this test's paths):
     * restores a capture left open (patchd SIGKILLed), unless the earlier
     * capture unit is installed. */
    var stopPost = (/^ExecStopPost=-\/bin\/sh -c '(.*)'$/m.exec(fs.readFileSync(UNIT, 'utf8')) || [])[1] || '';
    ok('the patchd unit restores in ExecStopPost, guarded by the earlier unit', /dlt_capture\.js restore/.test(stopPost) &&
        stopPost.indexOf('/etc/systemd/system/waze-on-cluster-capture.service') >= 0, stopPost);
    var cmdline = stopPost.split('/etc/systemd/system/waze-on-cluster-capture.service').join(CAPTURE_UNIT)
        .split('/usr/bin/node').join(process.execPath).split('/var/opt/waze-on-cluster/current/').join(path.join(__dirname, '..') + '/');
    p = patchd();
    await until(async function () { return !!(await command('status')); });
    ok('patchd: a capture open before a SIGKILL', await openCapture(command));
    p.kill('SIGKILL'); await p.done;
    /* run without blocking: the fake DLT daemon answers from this process */
    function stopPostRun() {
        var c = cp.spawn('/bin/sh', ['-c', cmdline], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }), out = '';
        c.stdout.on('data', function (d) { out += d; }); c.stderr.on('data', function (d) { out += d; });
        return new Promise(function (resolve) { c.on('exit', function (code) { resolve({ status: code, out: out }); }); });
    }
    fs.writeFileSync(CAPTURE_UNIT, '[Service]\n');
    var sr = await stopPostRun();
    ok('ExecStopPost, the earlier capture unit installed: leaves the capture to it', sr.status === 0 && state().owned === true && !!tcpOpen(),
        sr.status + ' ' + sr.out + ' ' + JSON.stringify(state()));
    fs.unlinkSync(CAPTURE_UNIT);
    sr = await stopPostRun();
    ok('ExecStopPost: restores the capture patchd left open', sr.status === 0 && state().state === 'closed' && !tcpOpen() &&
        modes[modes.length - 1] === 2, sr.status + ' ' + sr.out + ' ' + JSON.stringify(state()));

    process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
    process.exit(fails ? 1 : 0);
})().catch(function (e) { process.stdout.write('FAIL ' + (e.stack || e) + '\n'); process.exit(1); });
