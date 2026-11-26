#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves the install-time activation (`patchd.js activate` / `deactivate`, the
 * deploy tool's hooks) against the unit's carplay binary (CARPLAY_BIN), with
 * CarPlay's patch in memory (PATCH.md "In memory"). A fresh install leaves
 * carplay on disk as it ships, keeps the plan and its record (enabled, on
 * trial) and arms carplay's next start; the running carplay's memory is not
 * patched, so the change is pending for the next head-unit start. carplay is
 * never stopped, killed or restarted, even where recmgr would allow it. A
 * second run changes nothing; after that start the patch is left as it is
 * and a user's Remove patch is kept. An earlier release's patch on disk with
 * our backup is reverted from the backup, which goes, in the step that arms
 * the plan: nothing is pending when the running carplay's memory holds the
 * plan's bytes (that patch, current), else the apply is (an older patch, the
 * patches 0.9.11-0.10.3 wrote, 0.10.6's safe area), and its proven record
 * does not prove the plan; a new plan starts boot recovery's count afresh.
 * An earlier patch beside another tool's change (foreign) is left as it is,
 * a conflict. A plan that cannot be made (an I/O error) leaves carplay
 * stock, the error in patchd's status, until the watcher plans it at the
 * next head-unit start. On a car coded otherwise an earlier release's patch
 * is put back as it ships; CarPlay's Patch button's patch is planned in
 * memory as that button plans it. A stock build outside the proven list is left as
 * a conflict. Removal (deactivate) disarms the next start, deletes the plan
 * and its record, reverts an earlier release's patch left on disk and drops
 * our backup: a revert is pending only while the running carplay's memory
 * holds the patch; changes another tool made elsewhere in the binary stay;
 * an install after a removal plans again. patchd removes a link of carplay's
 * running file once nothing runs it and keeps one carplay runs (boot
 * recovery's). A binary with an edit site not found, one modified by
 * something else and a carplay.service that starts another program are left
 * untouched (a conflict, exit 0); a remount failure before any write exits
 * non-zero. On a head unit that refuses our parts the install plans nothing,
 * patchd refuses CarPlay's Patch button and the removal turns the patch
 * off; MID and HIGH F plan as HIGH. The first install on HIGH F applies the
 * patch again to an original 0.8.2's boot recovery restored. The cluster
 * coding: an install plans only on a car coded KI_KOMBI_VARIANT 7. The
 * pending marker is the world-readable JSON patchd and the app read. Runs
 * the real patchd.js and carplay_patch.js on a temporary copy, with a fake
 * /proc (carplay's process: its exe, maps and mem, carplay_proc.js), a fake
 * mount that, like the kernel, refuses read-only while a file a process runs
 * is unlinked, a systemctl that answers what patchd reads and records every
 * call, and a recording kill and reboot. Without CARPLAY_BIN it skips.
 *
 *   node patchd_activate_test.js
 */
'use strict';

var headUnit = require('./head_unit_env.js');   /* a HIGH head unit, coded KI_KOMBI_VARIANT 7, for every patcher and patchd this runs */
var carplayProc = require('./carplay_proc.js');
var earlier = require('./earlier_patcher.js');

var fs = require('fs');
var net = require('net');
var path = require('path');
var tmp = require('./tmp.js');
var cp = require('child_process');
var crypto = require('crypto');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var PATCHER = path.join(__dirname, '..', 'carplay_patch.js');
var SRC = process.env.CARPLAY_BIN || '';
var SLOT = 0x2ba4f0, SINK = 0x2a20b0;

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}

if (!fs.existsSync(SRC)) { process.stdout.write('SKIP: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n'); process.exit(0); }
var SRCBUF = fs.readFileSync(SRC);

var dir = tmp.dir();

var TGT = path.join(dir, 'carplay');
var BAK = TGT + '.woc-orig';
var RUNNING = TGT + '.woc-running';
var SOCKDIR = path.join(dir, 'shm');
var PENDING = path.join(SOCKDIR, 'activation-pending');
var CALLS = path.join(dir, 'systemctl.calls');
var MOUNTS = path.join(dir, 'mounts');
var MOUNT_CALLS = path.join(dir, 'mount.calls');
var RW_FAILS = path.join(dir, 'rw-fails');
var RECMGR = path.join(dir, 'recmgr-restartlist.conf');
var PROC_STAT = path.join(dir, 'stat');
var PROC = path.join(dir, 'proc');
var UNITS = path.join(dir, 'etc-systemd');
var STATE = path.join(dir, 'var');
var RUN = path.join(dir, 'run');   /* WOC_PRELOAD_DIR: this boot's arming of carplay */
var LIB = path.join(dir, 'libwocpatch.so');
var PASSWD = path.join(dir, 'passwd');
var BOOT_S = Math.floor(Date.now() / 1000) - 60;
fs.writeFileSync(PROC_STAT, 'cpu  1 2 3\nbtime ' + BOOT_S + '\n');
/* carplay in both restart lists as loaded at boot: patchd itself would
 * restart carplay; the install must not. */
fs.writeFileSync(RECMGR, '[Whitelist]\ncarplay\n[WhitelistExitSuccess]\ncarplay\n');
fs.utimesSync(RECMGR, BOOT_S - 3600, BOOT_S - 3600);
fs.writeFileSync(CALLS, '');
fs.writeFileSync(MOUNT_CALLS, '');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
fs.writeFileSync(LIB, 'a stand-in for libwocpatch.so\n');
fs.writeFileSync(PASSWD, 'root:x:0:0::/:/bin/sh\ncia_13002:x:13002:13002::/:/bin/false\n');
fs.mkdirSync(UNITS);
fs.mkdirSync(PROC);
fs.mkdirSync(STATE);

/* inmem.js in this process reads the same record, plan and arming. */
Object.assign(process.env, { WOC_STATE_DIR: STATE, WOC_PRELOAD_DIR: RUN, WOC_PRELOAD_LIB: LIB, WOC_PASSWD: PASSWD, WOC_CARPLAY: TGT, WOC_PROC: PROC });
var inmem = require('../inmem.js');
var IP = inmem.paths('carplay');

var BIN = path.join(dir, 'bin');
fs.mkdirSync(BIN);
/* Every systemctl, kill or reboot is recorded. systemctl answers what
 * patchd reads: carplay's main PID (4242 while it runs), the unit's
 * environment (BMW's preload) and user, and no drop-in loaded. */
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!' + process.execPath + '\n' + [
    "var fs = require('fs'), path = require('path'), a = process.argv.slice(2);",
    "fs.appendFileSync(" + JSON.stringify(CALLS) + ", 'systemctl ' + a.join(' ') + '\\n');",
    "if (a[0] !== 'show') process.exit(0);",
    "if (a.indexOf('Environment') >= 0) process.stdout.write('Environment=LD_PRELOAD=/usr/lib/libschedconfig.so.1\\n');",
    "else if (a.indexOf('User') >= 0) process.stdout.write('User=cia_13002\\n');",
    "else if (a.indexOf('DropInPaths') >= 0) process.stdout.write('DropInPaths=\\n');",
    "else if (a.indexOf('MainPID') >= 0) { var p = fs.existsSync(path.join(" + JSON.stringify(PROC) + ", '4242')) ? 4242 : 0;",
    "    process.stdout.write('MainPID=' + p + '\\nInvocationID=inv-' + p + '\\nExecMainStartTimestampMonotonic=5\\n'); }",
].join('\n') + '\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
['kill', 'reboot'].forEach(function (n) {
    fs.writeFileSync(path.join(BIN, n), '#!/bin/sh\necho "' + n + ' $*" >> "' + CALLS + '"\n');
    fs.chmodSync(path.join(BIN, n), 0o755);
});
/* Each call recorded; remount,ro fails while a process runs a file no name
 * links any more (its fake /proc exe is the inode's only link), as the
 * kernel refuses it. */
var MOUNT = path.join(dir, 'mount');
fs.writeFileSync(MOUNT, '#!' + process.execPath + '\n' + [
    "var fs = require('fs'), path = require('path');",
    "var a = process.argv.slice(2).join(' '), P = " + JSON.stringify(PROC) + ", M = " + JSON.stringify(MOUNTS) + ";",
    "fs.appendFileSync(" + JSON.stringify(MOUNT_CALLS) + ", a + '\\n');",
    "if (/remount,rw/.test(a)) {",
    "    if (fs.existsSync(" + JSON.stringify(RW_FAILS) + ")) { process.stderr.write('mount: / is busy\\n'); process.exit(32); }",
    "    fs.writeFileSync(M, '/dev/root / ext4 rw 0 0\\n');",
    "} else if (/remount,ro/.test(a)) {",
    "    var open = fs.readdirSync(P).some(function (p) { try { return fs.statSync(path.join(P, p, 'exe')).nlink <= 1; } catch (e) { return false; } });",
    "    if (open) { process.stderr.write('mount: / is busy\\n'); process.exit(32); }",
    "    fs.writeFileSync(M, '/dev/root / ext4 ro 0 0\\n');",
    "}",
].join('\n') + '\n');
fs.chmodSync(MOUNT, 0o755);

var ENV = Object.assign({}, process.env, {
    PATH: BIN + path.delimiter + process.env.PATH,
    WOC_PATCH_SOCK: path.join(SOCKDIR, 'patch.sock'),
    WOC_MOUNT: MOUNT,
    WOC_PROC_MOUNTS: MOUNTS,
    WOC_RECMGR_CONF: RECMGR,
    WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_PROC_STAT: PROC_STAT,
    WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
    WOC_UNIT_DIRS: UNITS,
    WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
    WOC_DLT_RETRY_MS: '600000',
    WOC_REBOOT_CMD: path.join(BIN, 'reboot'),
    WOC_REMOUNT_LOCK: path.join(SOCKDIR, 'remount.lock'),
});

/* One hook run: { code, result (the last stdout line as JSON), out }. */
function hook(which) {
    var r = cp.spawnSync(process.execPath, [PATCHD, which], { env: ENV, encoding: 'utf8', timeout: 60000 });
    var lines = (r.stdout || '').split('\n').filter(function (l) { return l.trim(); });
    var result = null;
    try { result = JSON.parse(lines[lines.length - 1]); } catch (e) {}
    return { code: r.status, result: result || {}, out: (r.stdout || '') + (r.stderr || '') };
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function disk() { return sha(fs.readFileSync(TGT)); }
function ino(f) { try { return fs.statSync(f).ino; } catch (e) { return null; } }
function marker() { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch (e) { return null; } }
function ro() { return /\bro\b/.test(fs.readFileSync(MOUNTS, 'utf8')); }
function calls() { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean); }
/* What would stop, start or kill carplay, or reboot: every call but the
 * reads of systemctl (show, and the watcher's is-system-running). */
function changes() { return calls().filter(function (l) { return !/^systemctl (show |is-system-running$)/.test(l); }); }
var mountSeen = 0;
/* The remounts since the last call. */
function remounts() { var all = fs.readFileSync(MOUNT_CALLS, 'utf8').split('\n').filter(Boolean), n = all.slice(mountSeen); mountSeen = all.length; return n; }
function verify() {
    return cp.spawnSync(process.execPath, [PATCHER, 'verify', '--target', TGT], { encoding: 'utf8' }).stdout;
}
/* `apply`: an earlier release's patch of the file (this version has none). */
function patcher(args) { return cp.execFileSync(process.execPath, [earlier.scriptFor(args, PATCHER)].concat(args), { encoding: 'utf8' }); }
/* The patch in memory: its record (null without one), the plan, and
 * whether carplay's next start this boot is armed. */
function rec() { return inmem.readRecord('carplay'); }
function planText() { try { return fs.readFileSync(IP.plan, 'utf8'); } catch (e) { return null; } }
function armed() { return fs.existsSync(IP.env); }
function noInmem() {
    [IP.record, IP.plan].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    cp.execFileSync('rm', ['-rf', RUN]);
}
/* What the running carplay's memory holds at the plan's sites. */
function mem() { return inmem.memState('carplay', 4242); }
/* carplay's process runs file (4242): armed when this boot's env file is there. */
function runs(file) { return carplayProc.start(PROC, 4242, file, RUN); }
function stops() { carplayProc.stop(PROC); }
/* The next head-unit start: /dev/shm and /run are empty again, boot
 * recovery arms an enabled patch whose record describes carplay, and
 * carplay runs what is on disk. */
function headUnitStart() {
    try { fs.unlinkSync(PENDING); } catch (e) {}
    if (!inmem.current('carplay')) cp.execFileSync('rm', ['-rf', RUN]);
    return runs(TGT);
}
function fresh(buf) {
    stops();
    [PENDING, RUNNING, RUNNING + '.1', RUNNING + '.2', BAK, TGT + '.woc-orig.json', TGT + '.woc-patch.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    noInmem();
    fs.writeFileSync(TGT, buf, { mode: 0o755 });
    runs(TGT);
    remounts();
}
/* The patch an earlier release's install wrote to the file (IC_HIGH, the
 * stock AVB sink), with our backup and its record. */
function earlierPatch() { patcher(['apply', '--target', TGT, '--panel', 'high', '--coding', headUnit.CODING, '--yes']); }

/* patchd started (as at a head-unit start), and its first status. */
function daemonStatus() { return daemonCommand(null, function (m) { return m.ev === 'status'; }); }

/* patchd started, msg sent once its first status is in (none when null),
 * and the first event after that done(event) accepts. */
function daemonCommand(msg, done) {
    return new Promise(function (resolve, reject) {
        var d = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
        var sock = path.join(SOCKDIR, 'patch.sock');
        var tries = 0;
        (function connect() {
            var c = net.connect(sock), buf = '';
            c.setEncoding('utf8');
            c.on('error', function () { if (++tries > 200) { d.kill(); reject(new Error('no patchd socket')); } else setTimeout(connect, 25); });
            c.on('data', function (chunk) {
                buf += chunk;
                var i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    var m = JSON.parse(buf.slice(0, i));
                    buf = buf.slice(i + 1);
                    if (msg && m.ev === 'status') { c.write(JSON.stringify(msg) + '\n'); msg = null; continue; }
                    /* Resolved once it is gone, so the next patchd's socket is the only one. */
                    if (done(m)) { c.destroy(); d.on('exit', function () { resolve(m); }); d.kill('SIGKILL'); return; }
                }
            });
        })();
    });
}
/* CarPlay's Patch or Remove patch button: its outcome (patchd may not
 * restart carplay here: no drop-in loaded). */
function button(msg) {
    return daemonCommand(msg, function (m) { return m.ev === 'refused' || (m.ev === 'status' && (m.state === 'error' || m.carplay === 'deferred' || (m.state !== 'busy' && !m.carplay))); });
}

async function main() {
    var r, before, m, st, patchedIno;

    /* A fresh install: the pristine build, no backup of ours, carplay running it. */
    fresh(SRCBUF);
    r = hook('activate');
    m = marker();
    ok('fresh: activate exits 0', r.code === 0, r.out);
    ok('fresh: carplay on disk as it ships, nothing of ours beside it', disk() === sha(SRCBUF) && !fs.existsSync(BAK) && !fs.existsSync(RUNNING));
    ok('fresh: the plan and its record, enabled, on trial', !!rec() && rec().enabled === true && rec().trial === true && rec().proven === false &&
        /^wocplan 1\n/.test(planText() || '') && planText().indexOf('edit variant 2ba4f0 ecf2f7ff bcf2f7ff\n') > 0, JSON.stringify(rec()));
    ok('fresh: carplay\'s next start armed, the unit\'s preload first', armed() &&
        fs.readFileSync(IP.env, 'utf8').indexOf('LD_PRELOAD=/usr/lib/libschedconfig.so.1 ' + LIB + '\n') === 0);
    ok('fresh: the running carplay\'s memory is stock', mem() === 'stock', mem());
    ok('fresh: the result asks for a head-unit start', /next head-unit start/.test(r.result.reboot || '') && /armed in memory/.test(r.result.status || ''), JSON.stringify(r.result));
    ok('fresh: the marker says apply', m && m.action === 'apply' && !m.by && /next head-unit start/.test(m.reason), JSON.stringify(m));
    ok('fresh: the marker is world-readable, its folder traversable',
        (fs.statSync(PENDING).mode & 0o777) === 0o644 && (fs.statSync(SOCKDIR).mode & 0o755) === 0o755);
    ok('fresh: / never remounted', remounts().length === 0 && ro());
    ok('fresh: nothing started, stopped, killed or rebooted', changes().length === 0, changes().join('; '));
    st = await daemonStatus();
    ok('fresh: patchd reports the pending apply', st.state === 'unknown' && st.pending === 'apply' &&
        st.carplay === 'deferred' && !st.conflict && st.res === '1088x480' && st.mapurl === 'eta', JSON.stringify(st));

    /* The install run again (a reinstall or a rollback's activate): nothing changes. */
    before = disk();
    var planBefore = planText();
    r = hook('activate');
    ok('pending: a second activate changes nothing', r.code === 0 && disk() === before && planText() === planBefore && marker().action === 'apply' && armed(), r.out);
    ok('pending: it still reports the head-unit start', /next head-unit start/.test(r.result.reboot || ''), JSON.stringify(r.result));

    /* The head-unit start: carplay's start is armed, its memory holds the plan. */
    ok('patched: the head-unit start runs the patch in memory', headUnitStart() === 'patched' && mem() === 'patched');
    st = await daemonStatus();
    ok('patched: patchd reports patched, avb, high, the map URL with ETA, nothing pending', st.state === 'patched' && st.mode === 'avb' && st.panel === 'high' &&
        st.mapurl === 'eta' && !st.pending && !st.carplay, JSON.stringify(st));
    before = disk();
    r = hook('activate');
    ok('patched: activate changes nothing, asks for nothing', r.code === 0 && disk() === before && !r.result.reboot && marker() === null && armed(), JSON.stringify(r.result));

    /* Removal while carplay runs the patch: the next start disarmed, the
     * plan and its record gone, a revert pending. */
    r = hook('deactivate');
    m = marker();
    ok('removal while running the patch: exit 0, carplay on disk as it ships', r.code === 0 && disk() === sha(SRCBUF), r.out);
    ok('removal while running the patch: the next start disarmed, the plan and its record gone', !armed() && rec() === null && planText() === null);
    ok('removal while running the patch: the marker is the removal\'s revert, a start is asked for',
        m && m.action === 'revert' && m.by === 'removal' && /next head-unit start/.test(r.result.reboot || ''), JSON.stringify([m, r.result]));
    ok('removal while running the patch: nothing handed to the deploy tool, / never remounted', !r.result.removeWhenUnused && remounts().length === 0 && ro(),
        JSON.stringify(r.result));
    st = await daemonStatus();
    ok('removal while running the patch: patchd reports the pending revert', st.pending === 'revert' && st.carplay === 'deferred', JSON.stringify(st));

    /* Installed again before that start: carplay's memory holds the plan
     * again, so the removal is undone and nothing is pending. */
    r = hook('activate');
    ok('reinstall before the start: planned and armed, the running patch is the plan, nothing pending',
        r.code === 0 && armed() && !!rec() && rec().enabled === true && marker() === null && !r.result.reboot && /runs it already/.test(r.result.status || ''), JSON.stringify(r.result));

    /* Removed, then the start, then installed again: a fresh install. */
    r = hook('deactivate');
    ok('removal again: pending', r.code === 0 && marker() && marker().by === 'removal', JSON.stringify(r.result));
    ok('after the start carplay runs as it ships', headUnitStart() === 'stock' && !armed());
    r = hook('activate');
    ok('reinstall after the start: planned and armed again, pending', r.code === 0 && marker() && marker().action === 'apply' && armed() &&
        disk() === sha(SRCBUF), JSON.stringify(r.result));

    /* Installed and removed before the head-unit start: carplay's memory is
     * stock, so nothing is pending. */
    fresh(SRCBUF);
    r = hook('activate');
    ok('undo: activate leaves an apply pending', r.code === 0 && marker().action === 'apply');
    r = hook('deactivate');
    ok('undo: deactivate disarms, nothing pending', r.code === 0 && disk() === sha(SRCBUF) && !armed() && rec() === null &&
        marker() === null && !r.result.reboot && !r.result.removeWhenUnused, JSON.stringify([r.result, marker()]));

    /* Removal with carplay not running: nothing to wait for. */
    fresh(SRCBUF);
    hook('activate');
    headUnitStart();
    stops();
    r = hook('deactivate');
    ok('removal, carplay not running: disarmed, nothing pending', r.code === 0 && disk() === sha(SRCBUF) && !armed() && rec() === null &&
        marker() === null && !r.result.reboot, JSON.stringify(r.result));

    /* CarPlay's Remove patch button pressed (the record kept, turned off by
     * the user), taken effect: an update leaves it off, a removal deletes it. */
    fresh(SRCBUF);
    hook('activate');
    headUnitStart();
    m = await button({ cmd: 'revert' });
    ok('Remove patch: the record turned off by the user, the next start disarmed, the revert pending', !!rec() && rec().enabled === false && rec().by === 'user' &&
        !armed() && m.pending === 'revert' && m.carplay === 'deferred', JSON.stringify([m, rec()]));
    headUnitStart();
    ok('Remove patch: the next start runs carplay as it ships', mem() === 'stock');
    r = hook('activate');
    ok('reverted: activate leaves it off', r.code === 0 && disk() === sha(SRCBUF) && !r.result.reboot && !armed() && rec().enabled === false &&
        /turned off/.test(r.result.status), JSON.stringify(r.result));
    r = hook('deactivate');
    ok('reverted: deactivate deletes the record, nothing to restart', r.code === 0 && disk() === sha(SRCBUF) && !r.result.reboot &&
        rec() === null && marker() === null && ro(), JSON.stringify(r.result));
    r = hook('deactivate');
    ok('original: deactivate has nothing to do', r.code === 0 && disk() === sha(SRCBUF) && !r.result.reboot, JSON.stringify(r.result));

    /* CarPlay's Remove patch button's revert still pending when the tool is
     * removed: the revert becomes the removal's, so an install before the
     * start applies again. */
    fresh(SRCBUF);
    hook('activate');
    headUnitStart();
    await button({ cmd: 'revert' });
    r = hook('deactivate');
    ok('pending Remove patch, then removal: the revert is the removal\'s', r.code === 0 && rec() === null && marker() && marker().action === 'revert' &&
        marker().by === 'removal' && /next head-unit start/.test(r.result.reboot || '') && disk() === sha(SRCBUF), JSON.stringify(r.result));
    r = hook('activate');
    ok('pending Remove patch, then removal: an install before the start arms the plan the running carplay holds, nothing pending',
        r.code === 0 && armed() && marker() === null && !r.result.reboot, JSON.stringify(r.result));

    /* Another tool's edit elsewhere in the binary, made after our patch:
     * removal leaves the file as it is. */
    fresh(SRCBUF);
    hook('activate');
    headUnitStart();
    var theirs = Buffer.from(fs.readFileSync(TGT));
    Buffer.from('e900000000', 'hex').copy(theirs, 0x9f9a0);
    fs.writeFileSync(TGT + '.theirs', theirs, { mode: 0o755 });
    fs.renameSync(TGT + '.theirs', TGT);
    ok('another tool\'s edit: the plan does not describe the changed file', inmem.current('carplay') === null);
    headUnitStart();
    r = hook('deactivate');
    ok('another tool\'s edit: removal keeps theirs, deletes the plan, / never remounted',
        r.code === 0 && disk() === sha(theirs) && rec() === null && remounts().length === 0 && ro(), JSON.stringify(r.result) + ' ' + verify());
    headUnitStart();
    before = disk();
    r = hook('activate');
    ok('another tool\'s edit away from the sites: a later install arms the patch in memory, the file untouched', r.code === 0 && disk() === before &&
        !!rec() && rec().sha256 === before && !r.result.conflict, JSON.stringify(r.result));

    /* An earlier release's patch on disk, with our backup, carplay running
     * it: the file reverted from the backup, the backup dropped, the plan
     * armed; the running carplay's memory holds the plan's bytes, so
     * nothing is pending. */
    fresh(SRCBUF);
    earlierPatch();
    headUnitStart();
    patchedIno = ino(TGT);
    r = hook('activate');
    ok('earlier release\'s patch: reverted from our backup, the backup dropped, the plan armed, nothing pending', r.code === 0 && disk() === sha(SRCBUF) &&
        !fs.existsSync(BAK) && !fs.existsSync(TGT + '.woc-orig.json') && armed() && rec().enabled === true && marker() === null && !r.result.reboot,
        JSON.stringify(r.result));
    ok('earlier release\'s patch: carplay\'s running file stays linked while it runs, / read-only', ino(RUNNING) === patchedIno && mem() === 'patched' && ro());
    st = await daemonStatus();
    ok('earlier release\'s patch: patchd reports patched, nothing pending', st.state === 'patched' && st.mode === 'avb' && !st.pending, JSON.stringify(st));
    headUnitStart();
    st = await daemonStatus();
    ok('earlier release\'s patch: after the start patchd removed the unused link, carplay runs the plan', !fs.existsSync(RUNNING) && mem() === 'patched' &&
        st.state === 'patched' && ro(), JSON.stringify(st));

    /* An older patch of ours (before the resolution edit), with our backup:
     * reverted, the plan armed; its memory lacks the resolution edit, so
     * the apply is pending. */
    fresh(SRCBUF);
    earlierPatch();
    var older = Buffer.from(SRCBUF);
    older.writeUInt32LE(0xfff7f2bc >>> 0, SLOT);
    Buffer.from('e89f000000', 'hex').copy(older, 0x18176c);
    fs.writeFileSync(TGT, older);
    headUnitStart();
    r = hook('activate');
    ok('older patch: reverted from our backup, the plan armed, pending', r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) && armed() &&
        mem() === 'mixed' && marker() && marker().action === 'apply' && /next head-unit start/.test(r.result.reboot || ''), JSON.stringify([r.result, mem()]));

    /* The patches 0.9.11-0.10.1 (the map URL alone) and 0.10.2-0.10.3 (the
     * URL with ETA alone) wrote, running: patchd reports each as needing the
     * Patch button; an update's activate reverts the file and arms the plan,
     * pending, after which patchd reports the URLs with ETA; a removal
     * reverts each to the original. */
    var FULL = path.join(dir, 'full', 'carplay');
    fs.mkdirSync(path.dirname(FULL));
    fs.writeFileSync(FULL, SRCBUF);
    patcher(['apply', '--target', FULL, '--panel', 'high', '--coding', headUnit.CODING, '--yes']);
    var full = fs.readFileSync(FULL), loc0 = require('../carplay_locate.js').locate(full), mu = loc0.mapurl, su = loc0.showui;
    function release(form) {
        var b = Buffer.from(full), f = mu.forms.filter(function (x) { return x.name === form; })[0];
        Buffer.from(f.slotBytes, 'hex').copy(b, mu.slot); Buffer.from(f.leaBytes, 'hex').copy(b, mu.lea);
        SRCBUF.copy(b, su.str, su.str, su.str + su.len); SRCBUF.copy(b, su.call, su.call, su.call + su.callLen);
        return b;
    }
    for (var rf = 0; rf < 2; rf++) {
        var form = ['current', 'eta'][rf], what = ['0.9.11\'s patch', '0.10.2\'s patch'][rf], relBuf = release(form);
        fresh(SRCBUF);
        earlierPatch();
        fs.writeFileSync(TGT, relBuf);
        headUnitStart();
        st = await daemonStatus();
        ok(what + ': patchd reports patched, the URLs needing the Patch button', st.state === 'patched' && st.mapurl === 'no-eta' && !st.pending, JSON.stringify(st));
        r = hook('activate');
        ok(what + ': activate reverts the file and arms the plan, pending', r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) && armed() &&
            marker() && marker().action === 'apply', JSON.stringify(r.result));
        headUnitStart();
        st = await daemonStatus();
        ok(what + ': after the start patchd reports the URLs with ETA', st.state === 'patched' && st.mapurl === 'eta' && !st.pending, JSON.stringify(st));
        fresh(SRCBUF);
        earlierPatch();
        fs.writeFileSync(TGT, relBuf);
        headUnitStart();
        r = hook('deactivate');
        ok(what + ': removal reverts to the original, drops our backup', r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK), r.out);
    }

    /* The patcher fails after replacing the binary in a removal (here: the
     * backup's record cannot be dropped): the removal is refused, so the
     * tool stays; carplay's file stays linked and / goes read-only. */
    fresh(SRCBUF);
    earlierPatch();
    headUnitStart();
    patchedIno = ino(TGT);
    fs.unlinkSync(TGT + '.woc-orig.json');
    fs.mkdirSync(TGT + '.woc-orig.json');
    r = hook('deactivate');
    ok('failure after the write: the removal refused, exit 1, the file reverted, carplay\'s file still linked, / read-only',
        r.code === 1 && /^CarPlay not undone \([\s\S]*dropping [\s\S]*woc-orig\.json/.test(r.result.status || '') && disk() === sha(SRCBUF) &&
        ino(RUNNING) === patchedIno && ro(), JSON.stringify(r.result));
    fs.rmdirSync(TGT + '.woc-orig.json');

    /* Boot recovery restored the original of an earlier release's patch
     * while carplay runs it (it keeps the running file linked and clears the
     * marker): patchd starting keeps that link while carplay runs it and
     * removes it after the start. */
    fresh(SRCBUF);
    earlierPatch();
    headUnitStart();
    patchedIno = ino(TGT);
    fs.linkSync(TGT, RUNNING);
    patcher(['revert', '--target', TGT, '--yes']);
    await daemonStatus();
    ok('recovery\'s link: kept by patchd while carplay runs it', ino(RUNNING) === patchedIno && ro());
    headUnitStart();
    await daemonStatus();
    ok('recovery\'s link: removed by patchd once nothing runs it, / read-only', !fs.existsSync(RUNNING) && ro());

    /* Boot recovery's own restore of an earlier release's patch at its
     * threshold (the boot step's, nothing running): patchd reports it, and
     * an install leaves the patch off. */
    fresh(SRCBUF);
    earlierPatch();
    headUnitStart();
    stops();
    r = cp.spawnSync(process.execPath, ['-e', 'var r = require(process.argv[1]); r.restoreTarget(r.TARGETS.carplay, true, 2, function (e, o) { process.stdout.write(String(e || o)); });',
        path.join(__dirname, '..', 'recovery.js')], { env: ENV, encoding: 'utf8' });
    ok('boot recovery\'s restore: the original, / read-only', r.stdout === 'restored' && disk() === sha(SRCBUF) && ro(), r.stdout + r.stderr);
    st = await daemonStatus();
    ok('boot recovery\'s restore: patchd reports the original and the failed starts it was made at', st.state === 'original' && st.recovered === 2 && !st.pending, JSON.stringify(st));
    before = disk();
    r = hook('activate');
    ok('boot recovery\'s restore: an install leaves the patch off, and says why', r.code === 0 && disk() === before && marker() === null && rec() === null &&
        /boot recovery removed the patch after 2 failed head-unit starts/.test(r.result.status || ''), JSON.stringify(r.result));

    /* Boot recovery turned the patch in memory off at its threshold: patchd
     * reports it, and an install leaves it off. */
    fresh(SRCBUF);
    hook('activate');
    headUnitStart();
    inmem.disarm('carplay');
    inmem.disable('carplay', { by: 'recovery', fails: 2, why: 'boot' });
    headUnitStart();
    st = await daemonStatus();
    ok('boot recovery turned it off: patchd reports the original and the failed starts', st.state === 'original' && st.recovered === 2 && !st.pending, JSON.stringify(st));
    r = hook('activate');
    ok('boot recovery turned it off: an install leaves it off, and says why', r.code === 0 && !armed() && rec().enabled === false && marker() === null &&
        /boot recovery turned the patch off after 2 failed head-unit starts/.test(r.result.status || ''), JSON.stringify(r.result));

    /* A firmware update replaces carplay (another inode and modification
     * time) after the patch was turned off: Remove patch's choice holds for
     * the new carplay too; boot recovery's held only for the file it turned
     * off, so the new one is planned again, on trial. */
    function newCarplay() {
        fs.writeFileSync(TGT + '.fw', SRCBUF, { mode: 0o755 });
        var t = new Date(Date.now() + 3600000);
        fs.utimesSync(TGT + '.fw', t, t);
        fs.renameSync(TGT + '.fw', TGT);
    }
    [['user', function (x) { return x.code === 0 && !armed() && rec().enabled === false && rec().by === 'user' && /the patch was turned off/.test(x.result.status || ''); }],
     ['recovery', function (x) { return x.code === 0 && rec().enabled === true && rec().trial === true && !x.result.conflict && /map patch armed/.test(x.result.status || ''); }]].forEach(function (c) {
        fresh(SRCBUF);
        hook('activate');
        headUnitStart();
        inmem.disarm('carplay');
        inmem.disable('carplay', c[0] === 'user' ? { by: 'user' } : { by: 'recovery', fails: 2, why: 'boot' });
        var oldIno = ino(TGT);
        newCarplay();
        r = hook('activate');
        ok('turned off by ' + c[0] + ', then a firmware update replaced carplay: an install ' + (c[0] === 'user' ? 'leaves it off' : 'plans it again on trial'),
            ino(TGT) !== oldIno && c[1](r), JSON.stringify([r.result, rec()]));
    });

    /* A write window cut short between keeping the link and the patcher's
     * rename leaves a link that is carplay's own file: patchd removes it as
     * it starts, carplay running or not. */
    fresh(SRCBUF);
    fs.linkSync(TGT, RUNNING);
    var ownIno = ino(TGT);
    await daemonStatus();
    ok('a link that is carplay\'s own file: removed by patchd\'s start, carplay\'s file intact, / read-only',
        !fs.existsSync(RUNNING) && ino(TGT) === ownIno && ro());

    /* The same leftover when the tool is removed with nothing to revert: the
     * removal drops it itself and hands nothing over. */
    fresh(SRCBUF);
    fs.linkSync(TGT, RUNNING);
    r = hook('deactivate');
    ok('a link that is carplay\'s own file at removal: dropped, nothing handed over, / read-only',
        r.code === 0 && !fs.existsSync(RUNNING) && !r.result.removeWhenUnused && disk() === sha(SRCBUF) && ro(), JSON.stringify(r.result));

    /* An unused link the removal cannot drop itself (/ will not remount
     * read-write) goes to the deploy tool rather than staying behind. */
    fresh(SRCBUF);
    fs.writeFileSync(RUNNING, 'an older binary\n');
    fs.writeFileSync(RW_FAILS, '');
    r = hook('deactivate');
    fs.unlinkSync(RW_FAILS);
    ok('an unused link the removal cannot drop: handed to the deploy tool', r.code === 0 && fs.existsSync(RUNNING) &&
        JSON.stringify(r.result.removeWhenUnused) === JSON.stringify([RUNNING]), JSON.stringify(r.result));

    /* A binary the patcher cannot patch (an edit site not found): left
     * alone, a conflict naming the site, exit 0. */
    var unknown = Buffer.from(SRCBUF);
    unknown.writeUInt32LE(0x11223344, 0x2ba4d4);   /* the converter table's slot 0 */
    fresh(unknown);
    r = hook('activate');
    ok('unpatchable binary: activate leaves it, conflict names the site, exit 0', r.code === 0 && disk() === sha(unknown) && rec() === null &&
        /variant: slot 0 handler not a store$/.test(r.result.conflict || '') && !r.result.reboot, JSON.stringify(r.result));
    r = hook('deactivate');
    ok('unpatchable binary: deactivate leaves it, exit 0', r.code === 0 && disk() === sha(unknown), JSON.stringify(r.result));

    /* What an older release patched where the locator now refuses a site
     * (with its backup and record): activate leaves it, a conflict; the
     * removal restores the original whole and drops the backup. */
    if (sha(SRCBUF) === 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50') {
        var locate = require('../carplay_locate.js');
        require('./carplay_mutations.js')(SRCBUF).oldRelease().forEach(function (f) {
            fresh(f.patched);
            fs.writeFileSync(BAK, f.original, { mode: 0o600 });
            fs.writeFileSync(TGT + '.woc-orig.json', JSON.stringify({ buildId: locate.buildId(f.original), sha256_original: sha(f.original) }));
            r = hook('activate');
            ok(f.name + ': activate leaves it, conflict, exit 0', r.code === 0 && fs.readFileSync(TGT).equals(f.patched) && rec() === null &&
                /not patchable|first edit|in memory needs/.test(r.result.conflict || '') && !r.result.reboot && ro(), JSON.stringify(r.result));
            fs.writeFileSync(TGT, f.patched);
            fs.writeFileSync(BAK, f.original, { mode: 0o600 });
            fs.writeFileSync(TGT + '.woc-orig.json', JSON.stringify({ buildId: locate.buildId(f.original), sha256_original: sha(f.original) }));
            runs(TGT);
            r = hook('deactivate');
            ok(f.name + ': deactivate restores the original, drops the backup, pending', r.code === 0 && fs.readFileSync(TGT).equals(f.original) &&
                !fs.existsSync(BAK) && !fs.existsSync(TGT + '.woc-orig.json') && marker() && marker().action === 'revert' && ro(), JSON.stringify(r.result));
        });
    }

    /* A build no list names, with every site stock: a fresh install arms it
     * as any other, on trial, no conflict; Remove patch keeps it off across
     * an install; CarPlay's Patch button plans it again, and an install
     * keeps that plan armed. An earlier release's Patch button patch of it
     * on disk, with our backup, stays the patch: an install neither loses
     * it nor leaves it unarmed. */
    var other = Buffer.from(SRCBUF);
    other[other.indexOf(Buffer.from('5de62156575d737391ea42254e778a97dbbb51f8', 'hex'))] ^= 0xff;
    Buffer.from('e900000000', 'hex').copy(other, 0x9f9a0);
    fresh(other);
    r = hook('activate');
    ok('another build: activate arms it on trial, no conflict, pending, exit 0', r.code === 0 && disk() === sha(other) && marker() && marker().action === 'apply' &&
        !!rec() && rec().enabled === true && rec().trial === true && rec().proven === false && rec().args.indexOf('--unproven') < 0 && armed() &&
        !r.result.conflict && /map patch armed in memory/.test(r.result.status) && ro(), JSON.stringify([r.result, rec()]));
    m = await button({ cmd: 'revert' });
    ok('another build: Remove patch turns it off', !!rec() && rec().enabled === false && rec().by === 'user' && !armed(), JSON.stringify([m, rec()]));
    headUnitStart();
    r = hook('activate');
    ok('another build: an install keeps a patch the user turned off off', r.code === 0 && /the patch was turned off/.test(r.result.status) &&
        rec().enabled === false && !armed() && disk() === sha(other), JSON.stringify(r.result));
    m = await button({ cmd: 'apply', panel: 'mid', mode: 'avb' });
    ok('another build: CarPlay\'s Patch button plans it again, pending', m.pending === 'apply' && !!rec() && rec().enabled === true && rec().proven === false &&
        armed(), JSON.stringify([m, rec()]));
    headUnitStart();
    r = hook('activate');
    ok('another build CarPlay\'s Patch button planned: an install keeps it armed, nothing pending', r.code === 0 && armed() && !!inmem.current('carplay') &&
        marker() === null && disk() === sha(other), JSON.stringify(r.result));
    r = hook('deactivate');
    ok('another build: deactivate deletes the plan, carplay as it was', r.code === 0 && disk() === sha(other) && rec() === null && !armed(), JSON.stringify(r.result));
    fresh(other);
    patcher(['apply', '--target', TGT, '--panel', 'high', '--unproven', '--yes']);
    var otherPatched = disk();
    headUnitStart();
    r = hook('activate');
    ok('another build an earlier release\'s Patch button patched on disk: an install keeps a patch of it', r.code === 0 &&
        ((disk() === otherPatched && fs.existsSync(BAK)) || (disk() === sha(other) && armed())), JSON.stringify(r.result));
    fresh(other);
    patcher(['apply', '--target', TGT, '--panel', 'mid', '--unproven', '--yes']);
    headUnitStart();
    r = hook('deactivate');
    ok('another build: deactivate restores it byte-exact', r.code === 0 && disk() === sha(other) && !fs.existsSync(BAK), JSON.stringify(r.result));

    /* No backup of ours left: the proven build is rebuilt from its own bytes
     * and the removal passes; another build cannot be, and the removal is
     * refused while our edits read in it. */
    fresh(SRCBUF);
    earlierPatch();
    headUnitStart();
    [BAK, TGT + '.woc-orig.json'].forEach(function (f) { fs.unlinkSync(f); });
    r = hook('deactivate');
    ok('the proven build patched, no backup: deactivate restores it byte-exact, exit 0', r.code === 0 && disk() === sha(SRCBUF), JSON.stringify(r.result));
    fresh(other);
    patcher(['apply', '--target', TGT, '--panel', 'high', '--unproven', '--yes']);
    headUnitStart();
    [BAK, TGT + '.woc-orig.json'].forEach(function (f) { fs.unlinkSync(f); });
    var stillPatched = disk();
    r = hook('deactivate');
    ok('another build patched, no backup: deactivate refused, exit 1, the reason named, nothing written', r.code === 1 && disk() === stillPatched &&
        /^CarPlay not undone \([\s\S]*cannot revert/.test(r.result.status || '') && /the tool stays to guard it$/.test(r.result.status), JSON.stringify(r.result));

    /* carplay 22.28.3 with another tool's in-place code edit away from the
     * sites, or other bytes no segment loads (another firmware image's
     * .gnu_debuglink), and no backup of ours: every site verifies, so the
     * install arms the patch in memory, on trial, the file untouched. */
    [['a code edit away from the sites', function (b) { Buffer.from('e900000000', 'hex').copy(b, 0x9f9a0); }],
     ['another .gnu_debuglink CRC', function (b) { b[0x352448] ^= 0x5a; }]].forEach(function (m) {
        var elsewhere = Buffer.from(SRCBUF);
        m[1](elsewhere);
        fresh(elsewhere);
        r = hook('activate');
        ok(m[0] + ': armed in memory on trial, the file untouched, exit 0', r.code === 0 && disk() === sha(elsewhere) && !!rec() &&
            rec().sha256 === sha(elsewhere) && rec().trial === true && !r.result.conflict, JSON.stringify(r.result));
    });

    /* Geometry immediates the classifier reads as stock holding other bytes
     * than the shipped file: this tool's safe area over a stock geometry (the
     * file reported in #245, another tool's restore of its own backup), and
     * another physical size. The locator's checks decide: armed in memory on
     * trial, the file untouched, no conflict. */
    [['this tool\'s safe area over a stock geometry', function (b) {
        Buffer.from('00000000f8010000', 'hex').copy(b, 0x20ca66); Buffer.from('700100001e014800', 'hex').copy(b, 0x20ca74); }],
     ['another physical size', function (b) { b[0x20ca36] ^= 0x01; }]].forEach(function (m) {
        var atSite = Buffer.from(SRCBUF);
        m[1](atSite);
        fresh(atSite);
        r = hook('activate');
        ok(m[0] + ': armed in memory on trial, the file untouched, no conflict, exit 0', r.code === 0 && disk() === sha(atSite) && !!rec() &&
            rec().sha256 === sha(atSite) && rec().trial === true && !r.result.conflict, JSON.stringify(r.result));
    });

    /* carplay.service started through another program (another tool's
     * drop-in): the install does not plan the patch; an environment-only
     * drop-in is fine. */
    fresh(SRCBUF);
    fs.mkdirSync(path.join(UNITS, 'carplay.service.d'));
    var dropin = path.join(UNITS, 'carplay.service.d', '60-other.conf');
    fs.writeFileSync(dropin, '[Service]\nExecStart=\nExecStart=/bin/sh -c \'exec /var/opt/other/carplay "$$@"\' -- -c /etc/cinemo/cinemo_options.xml\n');
    r = hook('activate');
    ok('foreign start: activate plans nothing, conflict names the drop-in', r.code === 0 && disk() === sha(SRCBUF) && rec() === null && !armed() &&
        /carplay\.service starts \/bin\/sh/.test(r.result.conflict || '') && r.result.conflict.indexOf('60-other.conf') >= 0 && !r.result.reboot,
        JSON.stringify(r.result));
    st = await daemonStatus();
    ok('foreign start: patchd reports the conflict', st.state === 'original' && /60-other\.conf/.test(st.conflict || ''), JSON.stringify(st));
    fs.writeFileSync(dropin, '[Service]\nEnvironment=LD_PRELOAD=/usr/lib/libschedconfig.so\nExecStart=\nExecStart=' + TGT + ' -c /etc/cinemo/cinemo_options.xml\n');
    r = hook('activate');
    ok('own start: an environment drop-in that still starts carplay is fine', r.code === 0 && marker().action === 'apply' && armed() && !r.result.conflict, JSON.stringify(r.result));
    fs.unlinkSync(dropin);

    /* / cannot be remounted read-write: a fresh install needs no remount; an
     * earlier release's patch that cannot be reverted is left as it is,
     * nothing armed, exit non-zero. */
    fresh(SRCBUF);
    fs.writeFileSync(RW_FAILS, '');
    r = hook('activate');
    ok('remount fails, the pristine build: the plan armed all the same, / never remounted', r.code === 0 && disk() === sha(SRCBUF) && armed() &&
        remounts().length === 0, JSON.stringify(r.result));
    fs.unlinkSync(RW_FAILS);
    fresh(SRCBUF);
    earlierPatch();
    headUnitStart();
    before = disk();
    fs.writeFileSync(RW_FAILS, '');
    r = hook('activate');
    ok('remount fails, an earlier release\'s patch: activate exits non-zero, nothing written or armed, no marker', r.code !== 0 && disk() === before &&
        fs.existsSync(BAK) && !armed() && marker() === null && /remount rw/.test(r.result.status || ''), JSON.stringify(r.result));
    fs.unlinkSync(RW_FAILS);

    /* A head unit that refuses our parts; a patch of ours from before is
     * left to boot recovery. */
    var NOT = 'not supported on this car (' + headUnit.REFUSED + ')';
    [['no kernel command line', null, 'not supported on this car (head unit: unknown variant is not supported (kernel command line unreadable))'],
     ['no hwvariant=', headUnit.NONE, NOT]].forEach(function (c) {
        fresh(SRCBUF);
        headUnit.set(c[1]);
        r = hook('activate');
        ok(c[0] + ': activate plans nothing, no backup, no marker, conflict', r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) &&
            rec() === null && !armed() && marker() === null && !r.result.reboot && r.result.conflict === c[2] && ro(), JSON.stringify(r.result));
        headUnit.set(headUnit.HIGH);
    });
    [['MID', headUnit.MID], ['HIGH F', headUnit.HIGHF]].forEach(function (v) {
        fresh(SRCBUF);
        headUnit.set(v[1]);
        r = hook('activate');
        ok(v[0] + ': activate plans as on HIGH, pending', r.code === 0 && !r.result.conflict && marker() && marker().action === 'apply' && armed() &&
            (planText() || '').indexOf('edit variant 2ba4f0 ecf2f7ff bcf2f7ff\n') > 0, JSON.stringify(r.result));
        headUnit.set(headUnit.HIGH);
    });
    fresh(SRCBUF);
    headUnit.set(headUnit.NONE);
    st = await daemonStatus();
    ok('no hwvariant=: patchd reports the original and the conflict', st.state === 'original' && st.conflict === NOT, JSON.stringify(st));
    m = await daemonCommand({ cmd: 'apply', panel: 'high', mode: 'avb' }, function (x) { return x.ev === 'refused'; });
    ok('no hwvariant=: patchd refuses CarPlay\'s Patch button, nothing planned', m.reason === headUnit.REFUSED &&
        disk() === sha(SRCBUF) && rec() === null && marker() === null && ro(), JSON.stringify(m));
    headUnit.set(headUnit.HIGH);
    hook('activate');
    headUnitStart();
    headUnit.set(headUnit.NONE);
    r = hook('activate');
    ok('no hwvariant=, patched before: activate leaves it, conflict, nothing pending', r.code === 0 && mem() === 'patched' && marker() === null &&
        r.result.conflict === NOT, JSON.stringify(r.result));
    r = hook('deactivate');
    ok('no hwvariant=, patched before: deactivate turns it off, the revert pending', r.code === 0 && disk() === sha(SRCBUF) && rec() === null && !armed() &&
        marker() && marker().action === 'revert' && ro(), JSON.stringify(r.result));
    headUnit.set(headUnit.HIGH);

    /* A car 0.8.2's boot recovery restored on HIGH F: the original with our
     * trusted backup. The first install on HIGH F applies the patch again,
     * pending, and marks CarPlay done; none after it, nor on HIGH, nor over
     * an untrusted backup, which stays unmarked for the next install. */
    var MARK = path.join(STATE, 'highf-repatched');
    function restored(unit) {
        try { fs.unlinkSync(MARK); } catch (e) {}
        headUnit.set(headUnit.HIGH);
        fresh(SRCBUF);
        earlierPatch();
        headUnitStart();
        patcher(['revert', '--target', TGT, '--yes']);
        headUnitStart();
        headUnit.set(unit);
    }
    restored(headUnit.HIGHF);
    r = hook('activate');
    m = marker();
    var mark = null;
    try { mark = JSON.parse(fs.readFileSync(MARK, 'utf8')); } catch (e) {}
    ok('HIGH F restored by 0.8.2: the install applies the patch again, pending, and marks it done', r.code === 0 && m && m.action === 'apply' &&
        armed() && r.result.reset === true && mark && mark.carplay === 'applied', JSON.stringify([r.result, mark]));
    st = await daemonStatus();
    ok('HIGH F restored by 0.8.2: patchd reports the pending apply', st.pending === 'apply' && !st.conflict, JSON.stringify(st));
    headUnitStart();
    await button({ cmd: 'revert' });
    headUnitStart();
    r = hook('activate');
    ok('HIGH F, marker present: a Remove patch since stays', r.code === 0 && disk() === sha(SRCBUF) && marker() === null && !armed() && /turned off/.test(r.result.status),
        JSON.stringify(r.result));
    restored(headUnit.HIGH);
    r = hook('activate');
    ok('HIGH: an original with our backup stays off, no marker', r.code === 0 && disk() === sha(SRCBUF) && marker() === null && !armed() &&
        /turned off/.test(r.result.status) && !fs.existsSync(MARK), JSON.stringify(r.result));
    restored(headUnit.HIGHF);
    fs.writeFileSync(TGT + '.woc-orig.json', JSON.stringify({ sha256_original: '0'.repeat(64) }));
    r = hook('activate');
    ok('HIGH F, untrusted backup: nothing planned, CarPlay left for the next install', r.code === 0 && disk() === sha(SRCBUF) && marker() === null &&
        !armed() && !fs.existsSync(MARK), JSON.stringify(r.result));
    restored(headUnit.HIGHF);
    fs.unlinkSync(TGT + '.woc-orig.json');
    r = hook('activate');
    ok('HIGH F, a backup without its record: nothing planned', r.code === 0 && disk() === sha(SRCBUF) && marker() === null && !armed(), JSON.stringify(r.result));
    try { fs.unlinkSync(MARK); } catch (e) {}
    headUnit.set(headUnit.HIGH);

    /* The cluster coding. An install plans only on a car coded
     * KI_KOMBI_VARIANT 7, and its first patch there is on trial (unproven
     * until boot recovery's watcher sees it run healthy). An earlier
     * release's patch it migrates is on trial too, whatever that release
     * recorded: the plan has not run here. On another coding, or one that
     * cannot be read, it plans nothing and reports the conflict the app
     * shows, also on HIGH F over 0.8.2's restore; a patch CarPlay's Patch
     * button planned there is left as it is. */
    var record = require('../patch_record.js');
    function trial() { var x = rec(); return x ? { enabled: x.enabled, proven: x.proven, trial: x.trial } : null; }
    var TRIAL = JSON.stringify({ enabled: true, proven: false, trial: true });
    fresh(SRCBUF);
    r = hook('activate');
    ok('coding 7: the install plans, pending, the record on trial', r.code === 0 && !r.result.conflict && marker() && marker().action === 'apply' &&
        JSON.stringify(trial()) === TRIAL, JSON.stringify([r.result, trial()]));
    headUnitStart();
    r = hook('activate');
    ok('coding 7: the next install leaves the trial as it is', r.code === 0 && !r.result.reboot && JSON.stringify(trial()) === TRIAL, JSON.stringify([r.result, trial()]));
    inmem.update('carplay', { proven: true, trial: false });
    r = hook('activate');
    ok('coding 7: an install keeps a proven plan proven', r.code === 0 && !r.result.reboot &&
        JSON.stringify(trial()) === JSON.stringify({ enabled: true, proven: true, trial: false }), JSON.stringify([r.result, trial()]));
    var current = Buffer.from(full);
    /* An earlier release's patch recorded proven, its file as given. */
    function earlierRelease(buf) {
        fresh(SRCBUF);
        earlierPatch();
        fs.writeFileSync(TGT + '.older', buf, { mode: 0o755 });
        fs.renameSync(TGT + '.older', TGT);
        record.write(TGT, { patched: true, proven: true });
        headUnitStart();
        return hook('activate');
    }
    function olderRelease(edits) {
        var b = Buffer.from(SRCBUF);
        b.writeUInt32LE(0xfff7f2bc >>> 0, SLOT);
        Buffer.from('e89f000000', 'hex').copy(b, 0x18176c);
        edits.forEach(function (e) { current.copy(b, e[0], e[0], e[0] + e[1]); });
        return earlierRelease(b);
    }
    r = earlierRelease(current);
    ok('migration: this version\'s patch recorded proven by an earlier release: reverted, the plan proven (the car ran these bytes healthy), nothing pending',
        r.code === 0 && !r.result.reboot && disk() === sha(SRCBUF) && JSON.stringify(trial()) === JSON.stringify({ enabled: true, proven: true, trial: false }) &&
        marker() === null, JSON.stringify([r.result, trial()]));
    /* Another tool's change besides our earlier patch (status: foreign
     * yes): carplay, the earlier patch and our backup untouched, nothing
     * planned or armed, a conflict. */
    var other = Buffer.from(current);
    other[other.length - 1] ^= 0xff;
    r = earlierRelease(other);
    ok('migration: another change in carplay besides our earlier patch: untouched, nothing armed, a conflict',
        r.code === 0 && /another change/.test(r.result.conflict || '') && disk() === sha(other) && fs.existsSync(TGT + '.woc-orig') &&
        trial() === null && !armed() && marker() === null && ro(), JSON.stringify([r.result, trial()]));
    var RES = [[0x20ca32, 8], [0x20ca54, 8], [0x20ca66, 8], [0x20ca74, 8]], URLS = [[0x257838, 55], [0x7b533, 7], [0x2908a0, 64], [0x18188a, 11]];
    /* A patch whose bytes are not the plan's: put back to stock, the new
     * plan on trial, and boot recovery's count of the patch it replaces
     * (a failure counted) starts again at nothing, so the plan is armed. */
    (function () {
        var st = require('../recovery.js').TARGETS.carplay.state, b = Buffer.from(current);
        Buffer.from('00000000dc010000', 'hex').copy(b, 0x20ca66); Buffer.from('3201000032014800', 'hex').copy(b, 0x20ca74);
        fresh(SRCBUF);
        earlierPatch();
        fs.writeFileSync(TGT + '.older', b, { mode: 0o755 });
        fs.renameSync(TGT + '.older', TGT);
        record.write(TGT, { patched: true, proven: true });
        headUnitStart();
        fs.writeFileSync(st, JSON.stringify({ fails: 1, unknown: 0, arm: null, prev: null, starts: null, ended: null }) + '\n');
        r = hook('activate');
        var counted = null; try { counted = JSON.parse(fs.readFileSync(st, 'utf8')); } catch (e) {}
        ok('migration: a new plan while boot recovery counts a failure: carplay stock, the plan on trial and armed, the count reset',
            r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) && JSON.stringify(trial()) === TRIAL && armed() && marker() && marker().action === 'apply' &&
            !!counted && counted.fails === 0, JSON.stringify([r.result, trial(), counted]));
        try { fs.unlinkSync(st); } catch (e) {}
    })();
    /* The safe area 0.10.6 wrote (476x306 at 306,72), in place of this version's. */
    function safe0106(b) { Buffer.from('00000000dc010000', 'hex').copy(b, 0x20ca66); Buffer.from('3201000032014800', 'hex').copy(b, 0x20ca74); return b; }
    var olderPatches = [['an older patch with the URL edits and the stock geometry', function () { return olderRelease(URLS); }],
        ['0.10.6\'s patch', function () { return earlierRelease(safe0106(Buffer.from(current))); }],
        ['a patch without the URL edits', function () { return olderRelease(RES); }],
        ['0.9.11\'s patch', function () { return olderRelease(RES.concat(URLS.slice(0, 2))); }]];
    var olderMu = require('../carplay_locate.js').locate(current).mapurl, etaForm = olderMu.forms.filter(function (f) { return f.name === 'eta'; })[0];
    olderPatches.push(['0.10.2\'s patch', function () {
        var withEta = Buffer.from(current);
        Buffer.from(etaForm.slotBytes, 'hex').copy(withEta, olderMu.slot); Buffer.from(etaForm.leaBytes, 'hex').copy(withEta, olderMu.lea);
        SRCBUF.copy(withEta, 0x2908a0, 0x2908a0, 0x2908a0 + 64); SRCBUF.copy(withEta, 0x18188a, 0x18188a, 0x18188a + 11);
        return earlierRelease(withEta);
    }]);
    olderPatches.forEach(function (o) {
        r = o[1]();
        ok('migration: ' + o[0] + ' recorded proven: reverted, the plan on trial, pending', r.code === 0 && marker() && marker().action === 'apply' &&
            disk() === sha(SRCBUF) && !fs.existsSync(BAK) && armed() && mem() === 'mixed' && JSON.stringify(trial()) === TRIAL, JSON.stringify([r.result, trial(), mem()]));
    });

    /* The plan cannot be made (an I/O error, not a refusal) once an earlier
     * release's patch is put back: carplay stock on disk, our backup gone,
     * nothing armed, the record waiting for a plan with the error, and
     * patchd's status an error with the reason. The watcher's start at the
     * next head-unit start plans it, with its count started afresh, and boot
     * recovery's next decision arms it. */
    var blocked = IP.plan;
    fresh(SRCBUF);
    earlierPatch();
    record.write(TGT, { patched: true, proven: true });
    headUnitStart();
    fs.writeFileSync(require('../recovery.js').TARGETS.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }) + '\n');
    fs.mkdirSync(blocked);   /* the plan's file cannot be written: a folder holds its name */
    fs.writeFileSync(path.join(blocked, 'keep'), '');
    r = hook('activate');
    var waiting = rec();
    ok('plan failure: carplay put back as it ships, our backup gone, nothing armed, the record waits for a plan with the error',
        r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) && !armed() && (!fs.existsSync(IP.plan) || fs.statSync(IP.plan).isDirectory()) && !!waiting && waiting.enabled === true &&
        waiting.needsPlan === true && /EISDIR|directory/i.test(waiting.error || '') && ro(), JSON.stringify([r.result, waiting]));
    ok('plan failure: the install says carplay runs as it ships and why, no conflict', /could not be planned/.test(r.result.status || '') && !r.result.conflict,
        JSON.stringify(r.result));
    st = await daemonStatus();
    ok('plan failure: patchd reports state error with the reason', st.state === 'error' && /could not be planned/.test(st.reason || '') && /EISDIR|directory/i.test(st.reason || ''),
        JSON.stringify(st));
    fs.unlinkSync(path.join(blocked, 'keep'));
    fs.rmdirSync(blocked);
    headUnitStart();
    var watcherProc = cp.spawn(process.execPath, [path.join(__dirname, '..', 'recovery.js')], { env: Object.assign({}, ENV, { WOC_RECOVERY_TICK_MS: '100' }), stdio: 'ignore' });
    /* Planned, and its count started afresh (the watcher resets it once the plan is written). */
    function replanned() {
        var x = rec(), c = null;
        try { c = JSON.parse(fs.readFileSync(require('../recovery.js').TARGETS.carplay.state, 'utf8')); } catch (e) {}
        return !!x && x.enabled === true && !x.needsPlan && !!x.planSha256 && !!c && c.fails === 0;
    }
    for (var wt = Date.now(); Date.now() - wt < 20000 && !replanned();) await new Promise(function (res) { setTimeout(res, 50); });
    watcherProc.kill('SIGTERM');
    await new Promise(function (res) { if (watcherProc.exitCode !== null || watcherProc.signalCode !== null) res(); else watcherProc.on('exit', res); });
    var planned = rec(), counted = null;
    try { counted = JSON.parse(fs.readFileSync(require('../recovery.js').TARGETS.carplay.state, 'utf8')); } catch (e) {}
    ok('plan failure: the watcher\'s start plans it again, the record describes the stock file, its count afresh', !!planned && planned.enabled === true &&
        !planned.needsPlan && !!inmem.current('carplay') && disk() === sha(SRCBUF) && !!counted && counted.fails === 0, JSON.stringify([planned, counted]));
    inmem.disarm('carplay');
    var decided = await new Promise(function (res) {
        var R = require('../recovery.js');
        new R.Recovery({ target: R.TARGETS.carplay, arm: function (n) { return inmem.arm(n, { preload: '', user: 'cia_13002' }); }, log: function () {} })._decide(res);
    });
    ok('plan failure: boot recovery\'s next decision arms it', decided.action === 'armed' && decided.inmem === true && armed(), JSON.stringify(decided));
    noInmem();

    /* An earlier release's patch in carplay's file at a head-unit start (an
     * install whose activate did not get to it): the boot step puts it back
     * before carplay starts, plans it and arms that very start; the
     * watcher's start finds nothing left to plan. */
    fresh(SRCBUF);
    earlierPatch();
    stops();
    cp.execFileSync('rm', ['-rf', RUN]);
    var bootStep = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'recovery.js'), 'boot', 'carplay'], { env: ENV, encoding: 'utf8', timeout: 60000 });
    var toPlan = rec();
    ok('a patch in carplay\'s file at the boot step: put back as it ships before carplay starts, planned there and that start armed',
        bootStep.status === 0 && /in-memory patch planned/.test(bootStep.stdout) && /carplay boot check: armed/.test(bootStep.stdout) && disk() === sha(SRCBUF) &&
        armed() && !!toPlan && toPlan.enabled === true && !toPlan.needsPlan && !!inmem.current('carplay') &&
        JSON.stringify(toPlan.args) === JSON.stringify(['--panel', 'high', '--coding', headUnit.CODING]) && ro(),
        JSON.stringify([bootStep.stdout.slice(-600), toPlan]));
    runs(TGT);
    var watcher2 = cp.spawn(process.execPath, [path.join(__dirname, '..', 'recovery.js')], { env: Object.assign({}, ENV, { WOC_RECOVERY_TICK_MS: '100' }), stdio: 'ignore' });
    for (var wt2 = Date.now(); Date.now() - wt2 < 20000 && !(replanned() && armed());) await new Promise(function (res) { setTimeout(res, 50); });
    watcher2.kill('SIGTERM');
    await new Promise(function (res) { if (watcher2.exitCode !== null || watcher2.signalCode !== null) res(); else watcher2.on('exit', res); });
    ok('a patch in carplay\'s file at the boot step: the watcher keeps the plan armed, the file as it ships',
        replanned() && !!inmem.current('carplay') && armed() && disk() === sha(SRCBUF), JSON.stringify(rec()));
    noInmem();

    var CODINGS = [['coding 9', 9, undefined, 'not supported on this car (KI_KOMBI_VARIANT 9)'],
        ['invalid coding flags', 7, 0x0b, 'cluster coding unreadable'], ['no coding', null, undefined, 'cluster coding unreadable']];
    for (var k = 0; k < CODINGS.length; k++) {
        var c = CODINGS[k];
        fresh(SRCBUF);
        headUnit.coding(c[1], c[2]);
        r = hook('activate');
        ok(c[0] + ': the install plans nothing, no marker, the conflict', r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) &&
            marker() === null && !r.result.reboot && r.result.conflict === c[3] && rec() === null && !armed() && ro(), JSON.stringify(r.result));
        st = await daemonStatus();
        ok(c[0] + ': patchd reports the original and the conflict', st.state === 'original' && st.conflict === c[3], JSON.stringify(st));
        /* CarPlay's Patch button (patchd plans with --unproven). */
        await button({ cmd: 'apply', panel: 'high', mode: 'avb' });
        headUnitStart();
        var buttonRec = JSON.stringify(c[1] === 9 ? { enabled: true, proven: false, trial: false } : { enabled: true, proven: false, trial: true });
        ok(c[0] + ': CarPlay\'s Patch button plans it (' + (c[1] === 9 ? 'unproven' : 'on trial') + ')', JSON.stringify(trial()) === buttonRec && mem() === 'patched',
            JSON.stringify(trial()));
        before = fs.readFileSync(IP.record, 'utf8');
        r = hook('activate');
        ok(c[0] + ': the install leaves the Patch button\'s plan and its record', r.code === 0 && fs.readFileSync(IP.record, 'utf8') === before && armed() &&
            marker() === null && r.result.conflict === c[3], JSON.stringify([r.result, trial()]));
        r = hook('deactivate');
        ok(c[0] + ': the removal turns it off as ever', r.code === 0 && disk() === sha(SRCBUF) && rec() === null && !armed() && marker() && marker().action === 'revert' && ro(),
            JSON.stringify(r.result));
        headUnit.coding(7);
        restored(headUnit.HIGHF);
        ok(c[0] + ', HIGH F restored by 0.8.2: the original with our trusted backup', disk() === sha(SRCBUF) && fs.existsSync(BAK) && marker() === null);
        headUnit.coding(c[1], c[2]);
        r = hook('activate');
        ok(c[0] + ', HIGH F restored by 0.8.2: the re-apply plans nothing, the conflict, left for the next install', r.code === 0 && disk() === sha(SRCBUF) &&
            marker() === null && !armed() && !r.result.reset && r.result.conflict === c[3] && !fs.existsSync(MARK), JSON.stringify(r.result));
        headUnit.coding(7);
        r = hook('activate');
        ok(c[0] + ', HIGH F restored by 0.8.2: coded 7 again, the next install applies it, on trial', r.code === 0 && r.result.reset === true &&
            marker() && marker().action === 'apply' && JSON.stringify(trial()) === TRIAL, JSON.stringify([r.result, trial()]));
        try { fs.unlinkSync(MARK); } catch (e) {}
        headUnit.set(headUnit.HIGH);
    }

    /* A car coded otherwise on which an earlier release's install wrote the
     * patch to the file: an install puts carplay back as it ships, drops our
     * backup and plans nothing (the conflict), whether that patch has
     * started or not; / read-only after. A remount that fails leaves carplay
     * as it was and exits non-zero. */
    function drec() { var x = record.current(TGT); return x ? { patched: x.patched, proven: x.proven, trial: x.trial } : null; }
    function earlierOnDisk(started, pending) {
        headUnit.coding(7);
        fresh(SRCBUF);
        fs.linkSync(TGT, RUNNING);
        earlierPatch();
        if (pending) fs.writeFileSync(PENDING, JSON.stringify({ action: 'apply' }) + '\n', { mode: 0o644 });
        else if (!started) runs(RUNNING);
        record.write(TGT, { patched: true, proven: true });
        if (started) headUnitStart();
    }
    [['its apply pending', false, true], ['carplay running the file it replaced, no marker', false, false], ['started', true, false]].forEach(function (c) {
        earlierOnDisk(c[1], c[2]);
        headUnit.coding(9);
        r = hook('activate');
        ok('coding 9, an earlier release\'s patch on disk (' + c[0] + '): put back as it ships, the backup dropped, nothing armed, the conflict, / read-only',
            r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) && rec() === null && !armed() &&
            r.result.conflict === 'not supported on this car (KI_KOMBI_VARIANT 9)' && /put back as it ships/.test(r.result.status || '') && ro(), JSON.stringify([r.result, drec()]));
    });
    /* CarPlay's Patch button's patch an earlier release wrote to the file
     * on a car coded otherwise (its record: patched, unproven): the install
     * plans it in memory as that button plans it (--unproven), the file put
     * back as it ships and our backup dropped, the coding conflict in the
     * result as for a plan the button made; started or not. */
    var CODED9 = 'not supported on this car (KI_KOMBI_VARIANT 9)';
    [['started', true, false], ['its apply pending', false, true], ['carplay running the file it replaced, no marker', false, false]].forEach(function (c) {
        earlierOnDisk(c[1], c[2]);
        record.write(TGT, { patched: true, proven: false });
        headUnit.coding(9);
        r = hook('activate');
        var m = rec();
        ok('coding 9, CarPlay\'s Patch button\'s patch on disk (' + c[0] + '): planned in memory as that button plans it (unproven), the file as it ships, the backup dropped, / read-only',
            r.code === 0 && r.result.conflict === CODED9 && /map patch armed in memory/.test(r.result.status || '') && disk() === sha(SRCBUF) && !fs.existsSync(BAK) &&
            drec() === null && armed() && JSON.stringify(trial()) === JSON.stringify({ enabled: true, proven: false, trial: false }) && m.args.indexOf('--unproven') >= 0 && ro(),
            JSON.stringify([r.result, trial(), m && m.args]));
        r = hook('deactivate');
        ok('coding 9, CarPlay\'s Patch button\'s patch moved into memory (' + c[0] + '): the removal turns it off', r.code === 0 && rec() === null && !armed() && disk() === sha(SRCBUF),
            JSON.stringify(r.result));
    });
    /* An earlier install's patch on trial, and the Patch button's patch
     * beside a carplay.service that starts another program: put back,
     * nothing armed. */
    earlierOnDisk(true, false);
    record.write(TGT, { patched: true, proven: false, trial: true });
    headUnit.coding(9);
    r = hook('activate');
    ok('coding 9, an earlier install\'s patch on trial: put back as it ships, nothing armed, the conflict', r.code === 0 && disk() === sha(SRCBUF) && !fs.existsSync(BAK) &&
        rec() === null && !armed() && r.result.conflict === CODED9 && /put back as it ships/.test(r.result.status || ''), JSON.stringify([r.result, drec()]));
    earlierOnDisk(true, false);
    record.write(TGT, { patched: true, proven: false });
    headUnit.coding(9);
    fs.mkdirSync(path.join(UNITS, 'carplay.service.d'), { recursive: true });
    fs.writeFileSync(dropin, '[Service]\nExecStart=\nExecStart=/bin/sh -c \'exec /var/opt/other/carplay "$$@"\' -- -c /etc/cinemo/cinemo_options.xml\n');
    r = hook('activate');
    fs.unlinkSync(dropin);
    ok('coding 9, the Patch button\'s patch, carplay.service starting another program: put back as it ships, nothing armed, the conflict', r.code === 0 &&
        disk() === sha(SRCBUF) && rec() === null && !armed() && r.result.conflict === CODED9 && /put back as it ships/.test(r.result.status || ''), JSON.stringify([r.result, drec()]));
    earlierOnDisk(false, true);
    before = disk();
    headUnit.coding(9);
    fs.writeFileSync(RW_FAILS, '');
    r = hook('activate');
    fs.unlinkSync(RW_FAILS);
    ok('coding 9, / cannot be remounted: carplay and our backup as they were, exit 1, the reason named', r.code === 1 && disk() === before && fs.existsSync(BAK) &&
        /putting carplay back failed/.test(r.result.status || ''), JSON.stringify([r.result, drec()]));
    headUnit.coding(7);

    ok('never a systemctl start, stop or restart, a kill or a reboot', changes().length === 0, changes().join('; '));
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
