// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* journal_keep.js: the files' caps, the rate limit that keeps 10 minutes in
 * them under a flood, the lines it writes and leaves out, the load line, and
 * a restart resuming after the newest line with a fake journalctl. */
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var jk = require('../journal_keep.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjk-'));
function fresh(name) { var d = path.join(tmp, name); fs.mkdirSync(d); return d; }
function files(dir) { return fs.readdirSync(dir).filter(function (n) { return /^journal\.log/.test(n); }).sort(); }
function line(n, len) { var s = 'line ' + n + ' '; return Buffer.from(s + 'x'.repeat(len - s.length - 1) + '\n'); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(what, fn) {
    for (var i = 0; i < 300; i++) { if (fn()) return; await delay(20); }
    throw new Error('timed out waiting for ' + what);
}

/* rotation: never more than `files` files, none past fileMax, oldest dropped */
(function () {
    var dir = fresh('caps'), ring = new jk.Ring(dir, { files: 4, fileMax: 1000 });
    for (var i = 0; i < 200; i++) ring.append([line(i, 90)]);
    assert.deepStrictEqual(files(dir), ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3']);
    files(dir).forEach(function (n) { assert(fs.statSync(path.join(dir, n)).size <= 1000, n); });
    var all = [3, 2, 1, 0].map(function (i) { return fs.readFileSync(ring.name(i), 'utf8'); }).join('');
    var nums = all.split('\n').filter(Boolean).map(function (l) { return Number(l.split(' ')[1]); });
    assert.strictEqual(nums[nums.length - 1], 199, 'the newest line is last in journal.log');
    nums.forEach(function (n, k) { if (k) assert.strictEqual(n, nums[k - 1] + 1, 'contiguous, oldest first'); });
    /* a batch rotates between its lines */
    ring.append([200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211].map(function (n) { return line(n, 90); }));
    files(dir).forEach(function (n) { assert(fs.statSync(path.join(dir, n)).size <= 1000, n); });
    /* a stray rotation past the cap is dropped and an oversize file rotated */
    fs.writeFileSync(path.join(dir, 'journal.log.7'), 'old\n');
    fs.writeFileSync(path.join(dir, 'journal.log'), 'y'.repeat(1500));
    var again = new jk.Ring(dir, { files: 4, fileMax: 1000 });
    again.append([line(300, 90)]);
    assert.deepStrictEqual(files(dir), ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3']);
    assert.strictEqual(fs.statSync(again.name(1)).size, 1500, 'the oversize file moved to .1, not written to');
    console.log('ok   rotation: at most FILES files, none past FILE_MAX, oldest dropped, stray rotations removed');
})();

/* sync (the boot's first minutes): every write is followed by an
 * fdatasync of a read-only descriptor, the write's own closed by then; the
 * files only grow by appends, and the caps and rotation hold. */
(function () {
    var dir = fresh('sync'), ring = new jk.Ring(dir, { files: 4, fileMax: 1000 });
    var realOpen = fs.openSync, realSync = fs.fdatasyncSync, realClose = fs.closeSync, open = {}, events = [];
    fs.openSync = function (p, flags) {
        var fd = realOpen.apply(fs, arguments);
        open[fd] = flags;
        if (flags === 'a') events.push('write');
        return fd;
    };
    fs.closeSync = function (fd) { delete open[fd]; return realClose.apply(fs, arguments); };
    fs.fdatasyncSync = function (fd) {
        assert.strictEqual(open[fd], 'r', 'synced through a read-only descriptor');
        assert(!Object.keys(open).some(function (k) { return open[k] !== 'r'; }), 'no descriptor open for writing while it syncs');
        events.push('sync');
        return realSync.apply(fs, arguments);
    };
    try {
        ring.append([line(0, 90), line(1, 90)], true);
        var ino = fs.statSync(ring.name(0)).ino, before = fs.readFileSync(ring.name(0));
        ring.append([line(2, 90)], true);
        var after = fs.readFileSync(ring.name(0));
        assert.strictEqual(fs.statSync(ring.name(0)).ino, ino, 'the same file');
        assert(after.slice(0, before.length).equals(before) && after.length === before.length + 90, 'appended, nothing rewritten');
        for (var i = 3; i < 200; i += 3) ring.append([line(i, 90), line(i + 1, 90), line(i + 2, 90)], true);
        var plain = events.length;
        ring.append([line(300, 90)]);
    } finally {
        fs.openSync = realOpen; fs.fdatasyncSync = realSync; fs.closeSync = realClose;
    }
    var writes = events.slice(0, plain).filter(function (e) { return e === 'write'; }).length;
    assert(writes > 67, 'a batch that rotates is written in two');
    assert.strictEqual(events.slice(0, plain).join(' '), new Array(writes + 1).join('write sync ').trim(), 'each write synced before the next');
    assert.deepStrictEqual(events.slice(plain), ['write'], 'without sync: the write alone');
    assert.deepStrictEqual(files(dir), ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3']);
    files(dir).forEach(function (n) { assert(fs.statSync(path.join(dir, n)).size <= 1000, n); });
    console.log('ok   sync: each write fdatasynced through a read-only descriptor, appended only, the caps hold');
})();

/* The shipped caps under a flood: lines of LINE_MAX from both kinds, each
 * ten times its rate, for half an hour. The files stay within 10 files and
 * 4 MB and keep every line let through in the last 10 minutes. */
(function () {
    var dir = fresh('flood'), t = 0, now = function () { return t; };
    var ring = new jk.Ring(dir), limits = [new jk.Limiter(jk.RATE / 2, now), new jk.Limiter(jk.RATE / 2, now)];
    assert(jk.FILES <= 10 && jk.FILES * jk.FILE_MAX <= 4e6, 'caps: 10 files, 4 MB');
    var kept = [], perStep = Math.ceil(10 * jk.RATE / 2 / jk.LINE_MAX / 60), n = 0;
    for (t = 0; t <= 30 * 60000; t += 2000) {
        var batch = [];
        limits.forEach(function (limiter) {
            for (var k = 0; k < 2 * perStep; k++, n++) {
                var b = line(n, jk.LINE_MAX);
                if (limiter.take(b.length)) { batch.push(b); kept.push({ n: n, t: t }); }
            }
        });
        limits.forEach(function (limiter) {
            var s = limiter.summary(t * 1000, 'some');
            if (s) batch.push(s);
        });
        ring.append(batch);
    }
    assert(files(dir).length <= jk.FILES);
    var total = files(dir).reduce(function (a, f) { return a + fs.statSync(path.join(dir, f)).size; }, 0);
    assert(total <= jk.FILES * jk.FILE_MAX, 'total ' + total);
    var held = {};
    files(dir).forEach(function (f) {
        fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach(function (l) {
            var m = /^line (\d+) /.exec(l);
            if (m) held[m[1]] = true;
        });
    });
    var recent = kept.filter(function (x) { return x.t >= 20 * 60000; });
    assert(recent.length > 0 && kept.length < n, 'the flood was limited');
    recent.forEach(function (x) { assert(held[x.n], 'line ' + x.n + ' of the last 10 minutes is held'); });
    assert(/dropped \d+ some lines \(\d+ KiB\) over the rate limit/.test(fs.readFileSync(path.join(dir, 'journal.log'), 'utf8')));
    console.log('ok   a 30-minute flood at 10x the rate: ' + files(dir).length + ' files, ' + total + ' B, the last 10 minutes held');
})();

/* the line format and journalctl's arguments */
(function () {
    var us = Date.UTC(2026, 10, 3, 6, 58, 54) * 1000 + 365447;
    assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'cluster-render.service',
        SYSLOG_IDENTIFIER: 'cluster-render', _PID: '1152', MESSAGE: 'two\nlines' }).line.toString(),
        '2026-11-03T06:58:54.365447Z cluster-render.service cluster-render[1152]: two lines\n');
    var k = jk.format({ __REALTIME_TIMESTAMP: String(us), _TRANSPORT: 'kernel', SYSLOG_IDENTIFIER: 'kernel', MESSAGE: [104, 105] });
    assert.strictEqual(k.line.toString(), '2026-11-03T06:58:54.365447Z kernel: hi\n');
    assert.strictEqual(k.tool, false);
    ['waze-on-cluster.service', 'waze-on-cluster-logs.service', 'cluster-render.service'].forEach(function (u) {
        assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: u, MESSAGE: 'x' }).tool, true, u);
        assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'init.scope', UNIT: u, MESSAGE: 'x' }).tool, true, u);
    });
    ['carplay.service', 'recmgr.service', 'crashhandler.service'].forEach(function (u) {
        assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: u, MESSAGE: 'x' }).tool, false, u);
    });
    assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'init.scope', UNIT: 'carplay.service',
        SYSLOG_IDENTIFIER: 'systemd', _PID: '1', MESSAGE: 'Started carplay.' }).line.toString(),
        '2026-11-03T06:58:54.365447Z carplay.service systemd[1]: Started carplay.\n');
    var long = jk.format({ __REALTIME_TIMESTAMP: String(us), MESSAGE: 'z'.repeat(5000) }).line;
    assert.strictEqual(long.length, jk.LINE_MAX);
    assert.strictEqual(jk.format({ MESSAGE: 'no time' }), null);

    var args = jk.journalArgs('s=1;i=2');
    assert(args.indexOf('-f') >= 0 && args.indexOf('--after-cursor=s=1;i=2') >= 0, args.join(' '));
    assert(jk.journalArgs(null).indexOf('-f') < 0, 'the read of this boot so far ends');
    assert(jk.journalArgs('').indexOf('--no-tail') >= 0, 'with no entry yet, the follow starts at the boot');
    assert(jk.journalArgs(null).concat(args).every(function (a) { return !/^--since|^--until/.test(a); }), 'no clock');
    var groups = args.slice(args.indexOf('_SYSTEMD_UNIT=' + jk.UNITS[0])).join(' ').split(' + ');
    assert.strictEqual(groups.length, 3, 'three alternatives: the units, systemd, the kernel');
    assert(/^(_SYSTEMD_UNIT=\S+ ?)+$/.test(groups[0]));
    assert.strictEqual(groups[1], '_PID=1', 'systemd about any unit (the filter keeps what explains a failure)');
    assert(groups[0].indexOf('_SYSTEMD_UNIT=waze-on-cluster-logs-fw.service') >= 0);
    assert.strictEqual(groups[2], '_TRANSPORT=kernel');
    assert(/PRIORITY/.test(args.join(' ')) && /_SOURCE_MONOTONIC_TIMESTAMP/.test(args.join(' ')), 'the kernel line\'s priority and time since boot');
    ['waze-on-cluster.service', 'waze-on-cluster-patchd.service', 'waze-on-cluster-boot.service',
        'waze-on-cluster-recovery.service', 'cluster-render.service', 'carplay.service', 'recmgr.service',
        'crashhandler.service', 'aapd.service', 'waze-on-cluster-aa-boot.service'].forEach(function (u) { assert(jk.UNITS.indexOf(u) >= 0, u); });
    console.log('ok   lines: time, unit, identifier[pid]; kernel; systemd\'s about a unit; LINE_MAX; three match groups');
})();

/* What is kept, from lines shaped as the car logs them (synthesized: no
 * real addresses or names). */
var T = Date.UTC(2026, 10, 14, 11, 0) * 1000;
function kern(msg, extra) {
    return Object.assign({ __REALTIME_TIMESTAMP: String(T), __MONOTONIC_TIMESTAMP: '600000000', _TRANSPORT: 'kernel',
        SYSLOG_IDENTIFIER: 'kernel', PRIORITY: '6', _SOURCE_MONOTONIC_TIMESTAMP: '600000000', MESSAGE: msg }, extra || {});
}
function unitLine(unit, ident, msg, pid) {
    return { __REALTIME_TIMESTAMP: String(T), __MONOTONIC_TIMESTAMP: '600000000', _SYSTEMD_UNIT: unit, SYSLOG_IDENTIFIER: ident,
        _PID: pid || '812', MESSAGE: msg };
}
function systemd(unit, msg) {
    return { __REALTIME_TIMESTAMP: String(T), __MONOTONIC_TIMESTAMP: '600000000', _SYSTEMD_UNIT: 'init.scope', UNIT: unit,
        SYSLOG_IDENTIFIER: 'systemd', _PID: '1', MESSAGE: msg };
}
function kept(f, e) { return f.lines(e).map(function (x) { return x.line.toString().replace(/^\S+ /, '').trim(); }); }
var NOISE = [
    kern('Blocking unknown connection - no IPSec: IN= OUT=vlan73 SRC=10.1.2.3 DST=10.1.2.4 LEN=52 TOS=0x00 PROTO=TCP SPT=32967 DPT=32506'),
    kern('Blocking unknown connection: IN= OUT=wlan_bridge SRC=172.16.0.9 DST=224.0.0.22 LEN=40 TOS=0x00 PREC=0xC0 TTL=1 ID=0 DF PROTO=2'),
    kern('CFG80211-ERROR) wl_run_escan : '), kern('LEGACY_SCAN sync ID: 4660, bssidx: 0'), kern(' LEGACY E-SCAN START'),
    kern('dhd_prot_flow_ring_create: Send Flow Create Req flow ID 40 for peer 02:00:00:00:00:01 prio 7 ifindex 1'),
    kern('dhd_prot_ioctl: status ret value is -23 '), kern('dhd_bus_cmn_writeshared:'), kern('  0000: 00 90 74 5c 00 00 00 00 '),
    kern('8c '), kern(''), kern('ring_info_raw: 56 '), kern('WLC_E_IF: NO_IF set, event Ignored '),
    kern('PKCS7: Unknown OID: [159] 0.9.2342.19200300.100.1.25'), kern('keystore: Ignoring secure boot status!'),
    kern('audit: type=1300 audit(1794681672.403:32): arch=c000003e syscall=257 success=yes exit=3'),
    kern('audit: type=1327 audit(1794681672.403:32): proctitle=2F7573722F62696E2F6E6F6465'),
    kern('HTB: quantum of class 10003 is big. Consider r2q change.'), kern('Set AC=3, txop=47 cwmin=3, cwmax=7 aifs=1'),
    unitLine('carplay.service', 'libschedconfig', '[carplay] Intercepting function: prctl. Called with option 15'),
    unitLine('carplay.service', 'libschedconfig', '[carplay] Blocked function: pthread_setschedparam. Called with: thread 0x7f'),
    unitLine('carplay.service', 'libschedconfig', '[carplay] Notice in function: findThreadByName, Reason: Could not find thread'),
    unitLine('carplay.service', 'carplay', 'Coding base: Shm object data is available'),
    unitLine('crashhandler.service', 'crashhandler', ' ipcLib:ipc_open: Opening new socket for channel:3'),
    systemd('dbus.service', 'Reloading.'), systemd('foo.service', 'Stopping Foo...'), systemd('sound.target', 'Reached target Sound Card.'),
];
var USEFUL = [
    kern('Out of memory: Killed process 1152 (cluster-render) total-vm:812345kB', { PRIORITY: '3' }),
    kern('carplay[912]: segfault at 0 ip 00007f sp 00007ffd error 4 in libfoo.so', { PRIORITY: '6' }),
    kern('RDONLY-ALERT[4167] DatabaseEngineW: attempt to open file for writing: /mnt/dataro/data/x.db'),
    kern('EXT4-fs error (device mmcblk0p12): ext4_lookup:1234: inode #2: comm node: deleted inode referenced: 12'),
    kern('EXT4-fs (mmcblk0p12): re-mounted. Opts: user_xattr,discard'),
    kern('usb 1-3: new high-speed USB device number 2 using xhci_hcd'), kern('sd 0:0:0:0: [sda] Attached SCSI removable disk'),
    kern('PM: suspend entry (deep)'), kern('PM: resume of devices complete after 812.345 msecs'),
    kern('wlan_bridge: port 2(p2p-wlan0-0) entered forwarding state'), kern('wlan_bridge: port 2(p2p-wlan0-0) entered disabled state'),
    kern('DHCP[p2p-wlan0-0] - REQUEST [TX]'), kern('a line no pattern names, from a driver never seen'),
    unitLine('carplay.service', 'carplay', 'iAP2 session ended'),
    unitLine('cluster-render.service', 'cluster-render', 'I cluster-render: [carplay] Intercepting function: a tool line is never left out'),
    unitLine('recmgr.service', 'recmgr', 'restarting carplay after its crash'),
    systemd('carplay.service', 'Stopping carplay...'),
    systemd('hmi-display.service', 'hmi-display.service: Main process exited, code=killed, status=9/KILL'),
    systemd('hmi-display.service', 'hmi-display.service: Failed with result \'signal\'.'),
    systemd('hud.service', 'Started HUD service.'), systemd('hud.service', 'Stopped HUD service.'),
    systemd('hud.service', 'hud.service: Killing process 812 (hud) with signal SIGKILL.'),
    systemd('nav.service', 'nav.service: Watchdog timeout (limit 3min)!'), systemd('nav.service', 'Failed to start Navigation.'),
];
(function () {
    var f = new jk.Filter();
    NOISE.forEach(function (e) { assert.deepStrictEqual(kept(f, e), [], 'left out: ' + e.MESSAGE); });
    USEFUL.forEach(function (e) { assert.strictEqual(kept(f, e).length, 1, 'kept: ' + e.MESSAGE); });
    assert.deepStrictEqual(kept(f, systemd('hmi-display.service', 'hmi-display.service: Failed with result \'signal\'.')),
        ['hmi-display.service systemd[1]: hmi-display.service: Failed with result \'signal\'.']);
    console.log('ok   left out: the firewall\'s packets, Wi-Fi scans and rings, hex dumps, audit records, carplay\'s scheduling shim, ' +
        'systemd\'s routine; kept: failures, storage, USB, suspend, CarPlay\'s Wi-Fi, unknown lines, the tools, units failing');

    /* the boot's start: the version, the command line's hardware fields,
     * failures, the last line and a count; nothing until a line past it */
    var boot = function (msg, us, extra) {
        return kern(msg, Object.assign({ _SOURCE_MONOTONIC_TIMESTAMP: String(us), __MONOTONIC_TIMESTAMP: '1500000' }, extra || {}));
    };
    f = new jk.Filter();
    var out = [];
    [boot('Linux version 4.14.198-apl (oe-user@oe-host) (gcc version 7.5.0 (GCC)) #1 SMP PREEMPT', 0),
        boot('Command line: ro rootwait loglevel=4 bootmode=APP1 hwtype=MGU hwrevision=D1 hwvariant=HIGH ABL.memser=0x0012345678 ' +
            'ABL.seed=d42e00112233 ABL.oemkm=1bc@0x0 ABL.version=2121', 1),
        boot('Kernel command line: ro rootwait ABL.memser=0x0012345678', 2),
        boot('BIOS-e820: [mem 0x0000000000000000-0x0000000000097fff] usable', 3),
        boot('pci 0000:00:00.0: [8086:5af0] type 00 class 0x060000', 4),
        boot('ttyS2 - failed to request DMA', 5),
        boot('some driver: complains at priority err', 6, { PRIORITY: '3' }),
        boot('PKCS7: Unknown OID: [159] 0.9.2342.19200300.100.1.25', 7),
        boot('usb 1-3: new high-speed USB device number 2 using xhci_hcd', 9000000),
        Object.assign(unitLine('waze-on-cluster.service', 'waze-on-cluster', 'I waze-on-cluster: started'), { __MONOTONIC_TIMESTAMP: '2000000' }),
    ].forEach(function (e) { out = out.concat(kept(f, e)); });
    assert.deepStrictEqual(out, ['kernel: Linux version 4.14.198-apl (oe-user@oe-host) (gcc version 7.5.0 (GCC)) #1 SMP PREEMPT',
        'kernel: Command line: bootmode=APP1 hwtype=MGU hwrevision=D1 hwvariant=HIGH ABL.version=2121',
        'kernel: ttyS2 - failed to request DMA', 'kernel: some driver: complains at priority err',
        'waze-on-cluster.service waze-on-cluster[812]: I waze-on-cluster: started'], out.join('\n'));
    out = kept(f, kern('the first kernel line past the boot\'s start'));
    assert.deepStrictEqual(out, ['kernel: usb 1-3: new high-speed USB device number 2 using xhci_hcd',
        'journal-keep: the kernel\'s first ' + jk.BOOT_S + ' s: 2 lines (1 KiB) left out', 'kernel: the first kernel line past the boot\'s start']);
    console.log('ok   the boot\'s kernel log: version, the command line\'s hardware fields (no serial), failures, its last line and a count');

    /* the gain on a stream shaped like a car's (its kinds of lines in the
     * proportions one customer archive held) */
    var mix = [[NOISE[0], 23], [NOISE[1], 4], [NOISE[2], 10], [NOISE[3], 5], [NOISE[4], 4], [NOISE[5], 2], [NOISE[14], 6], [NOISE[15], 2],
        [NOISE[19], 6], [NOISE[21], 3], [NOISE[20], 1], [USEFUL[2], 1], [USEFUL[9], 1], [USEFUL[13], 1], [USEFUL[14], 30]];
    var inB = 0, outB = 0;
    f = new jk.Filter();
    mix.forEach(function (m) {
        for (var i = 0; i < m[1] * 20; i++) {
            inB += jk.format(m[0]).line.length;
            f.lines(m[0]).forEach(function (x) { outB += x.line.length; });
        }
    });
    assert(outB < inB * 0.45, 'kept ' + outB + ' of ' + inB + ' B');
    console.log('ok   a car-shaped stream: ' + Math.round(100 - outB * 100 / inB) + '% of its bytes left out');
})();

/* The load line from a stand-in /proc: the load averages, MemAvailable, the
 * processes in D state, the top 5 by CPU over the interval (name[pid] and
 * percent of one CPU), no command line; a process that ended or started
 * meanwhile, a pid reused (its start time differs) counted right. */
(function () {
    var proc = fresh('proc');
    function stat(pid, name, state, ticks, start) {
        fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
        var f = [state, '1', pid, pid, '0', '-1', '4194560', '1', '0', '0', '0', String(ticks), '0', '0', '0', '20', '0', '1', '0',
            String(start || 100), '1000', '10'];
        fs.writeFileSync(path.join(proc, String(pid), 'stat'), pid + ' (' + name + ') ' + f.join(' ') + '\n');
        fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), name + '\0--token\0SECRET-ARG\0');
    }
    fs.writeFileSync(path.join(proc, 'loadavg'), '28.14 25.39 19.08 3/412 9999\n');
    fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal:        7900000 kB\nMemFree:          100000 kB\nMemAvailable:     831488 kB\n');
    fs.writeFileSync(path.join(proc, 'uptime'), '1.0 1.0\n');
    stat(1, 'systemd', 'S', 50); stat(812, 'carplay', 'S', 1000); stat(1152, 'cluster-render', 'R', 2000); stat(77, 'gone', 'S', 5);
    stat(400, 'reused', 'S', 9000, 100); stat(901, 'Main Thread', 'D', 10);
    var now = 1000000, s = new jk.LoadSampler(proc, function () { return now; });
    assert.strictEqual(s.line(), null, 'the first sample has no interval');
    now += 30000;
    stat(812, 'carplay', 'D', 1000 + 900); stat(1152, 'cluster-render', 'R', 2000 + 2400); fs.rmSync(path.join(proc, '77'), { recursive: true });
    stat(500, 'newcomer', 'S', 300); stat(400, 'reused', 'S', 30, 2000); stat(1, 'systemd', 'S', 53); stat(902, 'idle', 'S', 0);
    var l = s.line();
    assert(/^load 28\.14 25\.39 19\.08; MemAvailable 812 MiB; D state 2; CPU over 30 s: cluster-render\[1152\] 80\.0%, carplay\[812\] 30\.0%, newcomer\[500\] 10\.0%, reused\[400\] 1\.0%, systemd\[1\] 0\.1%; sampled in \d+ ms$/.test(l), l);
    assert(l.indexOf('SECRET') < 0 && l.indexOf('--token') < 0, 'no command line');
    assert(l.length < jk.LINE_MAX, 'one short line');
    /* the cost on this machine's /proc, where there is one */
    if (fs.existsSync('/proc/self/stat')) {
        var real = new jk.LoadSampler('/proc');
        real.line();
        var t0 = Date.now(), line = null;
        while (!line) line = real.line();
        var ms = Date.now() - t0, n = fs.readdirSync('/proc').filter(function (x) { return /^\d+$/.test(x); }).length;
        assert(/^load [\d.]+ [\d.]+ [\d.]+; MemAvailable \d+ MiB; D state \d+; CPU over 0 s: /.test(line), line);
        console.log('ok   the load line: /proc sampled in ' + ms + ' ms over ' + n + ' processes');
    }
    console.log('ok   the load line: load, MemAvailable, D state, the top 5 by CPU over the interval, names and pids only');
})();

/* The service with a stand-in journalctl: without -f it prints `backlog`
 * and ends, with -f it prints `live` and stays. */
(async function () {
    var dir = fresh('run'), argsLog = path.join(tmp, 'args'), fake = path.join(tmp, 'journalctl');
    var backlogFile = path.join(tmp, 'backlog'), liveFile = path.join(tmp, 'live'), codeFile = path.join(tmp, 'code');
    var t0 = Date.UTC(2026, 10, 3, 7) * 1000;
    function entry(i, extra) {
        return JSON.stringify(Object.assign({ __CURSOR: 'c' + i, __REALTIME_TIMESTAMP: String(t0 + i),
            _SYSTEMD_UNIT: 'waze-on-cluster.service', SYSLOG_IDENTIFIER: 'waze-on-cluster', _PID: '7', MESSAGE: 'm' + i }, extra || {}));
    }
    function put(file, list) { fs.writeFileSync(file, list.join('\n') + (list.length ? '\n' : '')); }
    fs.writeFileSync(fake, '#!/bin/sh\necho "$@" >> ' + argsLog + '\ncase " $* " in *" -f "*) cat ' + liveFile +
        '; exec sleep 30;; *) cat ' + backlogFile + '; exit $(cat ' + codeFile + ' 2>/dev/null || echo 0);; esac\n');
    fs.chmodSync(fake, 0o755);
    var env = Object.assign({}, process.env, { WOC_JOURNAL_DIR: dir, WOC_JOURNALCTL: fake, WOC_JOURNAL_FLUSH_MS: '50',
        WOC_JOURNAL_RESPAWN_MS: '100' });
    function run() { return cp.spawn(process.execPath, [path.join(__dirname, '..', 'journal_keep.js')], { env: env, stdio: 'ignore' }); }
    function all(d) {
        return fs.readdirSync(d || dir).filter(function (n) { return /^journal\.log/.test(n); }).sort().reverse()
            .map(function (f) {
                try { return fs.readFileSync(path.join(d || dir, f), 'utf8'); } catch (e) { return ''; } // rotated meanwhile
            }).join('').split('\n').filter(Boolean);
    }
    function msgs() { return all().map(function (l) { return l.replace(/^.*: /, ''); }); }
    function calls() { return fs.readFileSync(argsLog, 'utf8').trim().split('\n'); }
    async function stop(c) { var done = new Promise(function (r) { c.on('exit', r); }); c.kill('SIGTERM'); return done; }

    put(backlogFile, [1, 2, 3].map(function (i) { return entry(i); }));
    put(liveFile, [entry(4)]);
    var c = run();
    await until('four lines', function () { return msgs().length === 4; });
    assert(/^2026-11-03T07:00:00\.000001Z waze-on-cluster\.service waze-on-cluster\[7\]: m1$/.test(all()[0]), all()[0]);
    assert.strictEqual(await stop(c), 0, 'SIGTERM: a clean exit');
    assert.deepStrictEqual(calls().map(function (l) { return / -f /.test(' ' + l + ' ') ? l.split(' ').filter(function (a) { return /^--after-cursor/.test(a); })[0] : 'backlog'; }),
        ['backlog', '--after-cursor=c3'], 'this boot so far, then followed from its last cursor');
    console.log('ok   the service writes this boot so far, then follows from the last entry\'s cursor');

    /* At the shipped flush interval: this boot so far is on disk as soon as
     * it is read, a line logged later within FLUSH_MS of it, each appended
     * after what the file holds (the same file, its bytes unchanged). */
    var edir = fresh('early'), early = path.join(tmp, 'journalctl-early'), live2 = path.join(tmp, 'live2');
    put(backlogFile, [1, 2, 3].map(function (i) { return entry(i); }));
    put(liveFile, [entry(4)]);
    put(live2, [entry(5)]);
    fs.writeFileSync(early, '#!/bin/sh\ncase " $* " in *" -f "*) cat ' + liveFile + '; sleep 1; cat ' + live2 +
        '; exec sleep 30;; *) cat ' + backlogFile + ';; esac\n');
    fs.chmodSync(early, 0o755);
    var t = Date.now();
    c = cp.spawn(process.execPath, [path.join(__dirname, '..', 'journal_keep.js')], { stdio: 'ignore',
        env: Object.assign({}, process.env, { WOC_JOURNAL_DIR: edir, WOC_JOURNALCTL: early }) });
    await until('this boot so far', function () { return all(edir).length >= 3; });
    var backlogMs = Date.now() - t, file = path.join(edir, 'journal.log'), ino = fs.statSync(file).ino, first = fs.readFileSync(file);
    assert(backlogMs < 3000, 'this boot so far written ' + backlogMs + ' ms after the start');
    await until('the line logged a second later', function () { return all(edir).length === 5; });
    var liveMs = Date.now() - t, now = fs.readFileSync(file);
    await stop(c);
    assert(liveMs < 1000 + 2000 + 2000, 'the later line written ' + liveMs + ' ms after the start');
    assert.strictEqual(fs.statSync(file).ino, ino, 'the same file');
    assert(now.length > first.length && now.slice(0, first.length).equals(first), 'appended after what the file held');
    console.log('ok   at the shipped interval: this boot so far written ' + backlogMs + ' ms after the start, a later line ' +
        liveMs + ' ms, appended');

    /* a restart: the backlog holds what the files have and more; only the newer is written */
    put(backlogFile, [1, 2, 3, 4, 5, 6].map(function (i) { return entry(i); }));
    put(liveFile, []);
    c = run();
    await until('six lines', function () { return msgs().length === 6; });
    await delay(200);
    assert.deepStrictEqual(msgs(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], 'no line twice, none missed');
    await stop(c);

    /* a new boot whose clock is behind the files' newest line: all of it written */
    put(backlogFile, [entry(-3600000000 + 1, { MESSAGE: 'n1' }), entry(-3600000000 + 2, { MESSAGE: 'n2' })]);
    c = run();
    await until('the new boot', function () { return msgs().length === 8; });
    assert.deepStrictEqual(msgs().slice(-2), ['n1', 'n2']);
    await stop(c);
    console.log('ok   a restart writes only what follows the newest kept line; a boot behind the clock is written whole');

    /* a read of this boot that fails partway: what it read past the files'
     * newest line is written and followed from; before that line, nothing */
    var pdir = fresh('partial');
    env.WOC_JOURNAL_DIR = pdir;
    fs.writeFileSync(argsLog, '');
    fs.writeFileSync(codeFile, '1');
    put(backlogFile, [1, 2, 3].map(function (i) { return entry(i); }));
    put(liveFile, [entry(4)]);
    c = run();
    await until('partial read kept', function () { return all(pdir).length === 4; });
    await stop(c);
    assert.deepStrictEqual(all(pdir).map(function (l) { return l.replace(/^.*: /, ''); }), ['m1', 'm2', 'm3', 'm4']);
    assert(calls().some(function (l) { return / --after-cursor=c3/.test(' ' + l); }), 'followed from the last line read');
    fs.writeFileSync(argsLog, '');
    put(backlogFile, [1, 2].map(function (i) { return entry(i); }));
    c = run();
    await until('retried', function () { return calls().length >= 3; });
    await stop(c);
    assert.strictEqual(all(pdir).length, 4, 'a failed read short of the newest line writes nothing');
    assert(!calls().some(function (l) { return / -f /.test(' ' + l + ' '); }), 'and is read again, not followed');
    fs.writeFileSync(codeFile, '0');
    put(liveFile, []);
    console.log('ok   a read that fails partway: kept and followed from past the newest line, read again short of it');

    /* the backfill is not limited: a flood before the start is kept (its newest, within the caps) */
    var flood = [], fdir = fresh('backfill');
    for (var i = 1; i <= 2000; i++) flood.push(entry(1000 + i, { _SYSTEMD_UNIT: 'recmgr.service', SYSLOG_IDENTIFIER: 'recmgr', MESSAGE: 'r' + i + ' ' + 'x'.repeat(800) }));
    put(backlogFile, flood);
    env.WOC_JOURNAL_DIR = fdir;
    c = run();
    await until('backfill written', function () { return all(fdir).some(function (l) { return / r2000 /.test(l); }); });
    await stop(c);
    var kept = all(fdir);
    assert(!kept.some(function (l) { return /dropped/.test(l); }), 'nothing dropped from the backfill');
    assert(kept.length > 1500 && / r2000 /.test(kept[kept.length - 1]), kept.length + ' lines, the newest last');
    console.log('ok   the backfill of this boot is written whole, newest kept, nothing rate-dropped');

    /* a live kernel flood past its share: the tools' lines all kept, the kernel's cut and counted */
    var live = [], kdir = fresh('fair');
    for (i = 1; i <= 2000; i++) {
        live.push(entry(5000 + 2 * i, { _TRANSPORT: 'kernel', MESSAGE: 'k'.repeat(900) }));
        if (i % 100 === 0) live.push(entry(5001 + 2 * i, { MESSAGE: 'tool ' + i }));
    }
    put(backlogFile, []);
    put(liveFile, live);
    env.WOC_JOURNAL_DIR = kdir;
    c = run();
    await until('the flood summarised', function () { return all(kdir).some(function (l) { return /dropped \d+ other lines/.test(l); }); });
    await stop(c);
    var k = all(kdir);
    assert.strictEqual(k.filter(function (l) { return / tool \d+$/.test(l); }).length, 20, 'every tool line kept');
    assert(!k.some(function (l) { return /dropped \d+ tool lines/.test(l); }));
    var kernel = k.filter(function (l) { return / kernel: k+$/.test(l); }).length;
    assert(kernel > 0 && kernel < 2000, kernel + ' kernel lines kept');
    console.log('ok   a live kernel flood past its share is cut and counted; every tool line is kept');

    /* the boot's kernel log across a restart: its summary and last line
     * written once, the lines after them followed */
    var bdir = fresh('bootlog'), bootLog = [];
    function bk(i, msg, mono) {
        return entry(i, { _TRANSPORT: 'kernel', _SYSTEMD_UNIT: undefined, SYSLOG_IDENTIFIER: 'kernel', PRIORITY: '6', MESSAGE: msg,
            _SOURCE_MONOTONIC_TIMESTAMP: String(mono), __MONOTONIC_TIMESTAMP: '1500000' });
    }
    bootLog.push(bk(1, 'Linux version 4.14.198-apl', 0));
    for (i = 2; i < 50; i++) bootLog.push(bk(i, 'pci 0000:00:' + i + '.0: [8086:5af0] type 00 class 0x060000', 1000 * i));
    bootLog.push(entry(60, { MESSAGE: 'after the boot', __MONOTONIC_TIMESTAMP: '20000000' }));
    put(backlogFile, bootLog);
    put(liveFile, []);
    env.WOC_JOURNAL_DIR = bdir;
    c = run();
    await until('the boot written', function () { return all(bdir).some(function (l) { return / after the boot$/.test(l); }); });
    await stop(c);
    var first = all(bdir).map(function (l) { return l.replace(/^\S+ /, ''); });
    assert.deepStrictEqual(first, ['kernel: Linux version 4.14.198-apl', 'kernel: pci 0000:00:49.0: [8086:5af0] type 00 class 0x060000',
        'journal-keep: the kernel\'s first ' + jk.BOOT_S + ' s: 47 lines (5 KiB) left out',
        'waze-on-cluster.service waze-on-cluster[7]: after the boot'], first.join('\n'));
    put(backlogFile, bootLog.concat([entry(61, { MESSAGE: 'later', __MONOTONIC_TIMESTAMP: '30000000' })]));
    c = run();
    await until('the later line', function () { return all(bdir).some(function (l) { return / later$/.test(l); }); });
    await delay(200);
    await stop(c);
    assert.deepStrictEqual(all(bdir).map(function (l) { return l.replace(/^\S+ /, ''); }), first.concat(['waze-on-cluster.service waze-on-cluster[7]: later']));
    console.log('ok   the boot\'s kernel log is summarised once; a restart writes only what follows it');

    /* an upgrade during a boot: the files' newest line is one an older
     * version kept and this one leaves out; only what follows it is written */
    var udir = fresh('upgrade'), fw = entry(70, { _TRANSPORT: 'kernel', _SYSTEMD_UNIT: undefined, SYSLOG_IDENTIFIER: 'kernel',
        MESSAGE: 'Blocking unknown connection: IN= OUT=wlan_bridge SRC=172.16.0.9 DST=224.0.0.22 LEN=40' });
    fs.writeFileSync(path.join(udir, 'journal.log'), jk.format(JSON.parse(entry(69))).line.toString() + jk.format(JSON.parse(fw)).line.toString());
    put(backlogFile, [entry(69), fw, entry(71, { MESSAGE: 'after the upgrade' })]);
    env.WOC_JOURNAL_DIR = udir;
    c = run();
    await until('the line after the upgrade', function () { return all(udir).some(function (l) { return / after the upgrade$/.test(l); }); });
    await delay(200);
    await stop(c);
    assert.deepStrictEqual(all(udir).map(function (l) { return l.replace(/^\S+ [^:]*: /, ''); }),
        ['m69', 'Blocking unknown connection: IN= OUT=wlan_bridge SRC=172.16.0.9 DST=224.0.0.22 LEN=40', 'after the upgrade']);
    console.log('ok   after an upgrade during a boot: written from past the older version\'s newest line, nothing twice');

    /* the load line every LOAD_MS and the boot line at the start, on stdout
     * (the journal brings them back) */
    var lproc = fresh('lproc');
    fs.mkdirSync(path.join(lproc, '42'));
    fs.writeFileSync(path.join(lproc, '42', 'stat'), '42 (busy) R 1 42 42 0 -1 0 0 0 0 0 100 0 0 0 20 0 1 0 100 1000 10\n');
    fs.writeFileSync(path.join(lproc, 'loadavg'), '1.00 0.50 0.25 1/100 42\n');
    fs.writeFileSync(path.join(lproc, 'meminfo'), 'MemAvailable:     102400 kB\n');
    fs.writeFileSync(path.join(lproc, 'boot_id'), '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d\n');
    put(backlogFile, []);
    var outText = '';
    c = cp.spawn(process.execPath, [path.join(__dirname, '..', 'journal_keep.js')], { stdio: ['ignore', 'pipe', 'ignore'],
        env: Object.assign({}, env, { WOC_JOURNAL_DIR: fresh('loadrun'), WOC_JOURNAL_LOAD_MS: '150', WOC_PROC: lproc,
            WOC_BOOT_ID: path.join(lproc, 'boot_id') }) });
    c.stdout.on('data', function (d) { outText += d; });
    await until('two load lines', function () { return (outText.match(/^load /mg) || []).length >= 2; });
    await stop(c);
    assert(/^journal-keep: boot 0a1b2c3d, up \d+ s$/m.test(outText), outText);
    assert(/^load 1\.00 0\.50 0\.25; MemAvailable 100 MiB; D state 0; CPU over 0 s: none; sampled in \d+ ms$/m.test(outText), outText);
    console.log('ok   the service logs a boot line at its start and a load line every LOAD_MS');

    /* prepare: the folder, the group's, 2770 (as root only) */
    if (process.getuid && process.getuid() === 0) {
        var pdir = path.join(tmp, 'prepared');
        var r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'journal_keep.js'), 'prepare'],
            { env: Object.assign({}, env, { WOC_JOURNAL_DIR: pdir }), encoding: 'utf8' });
        if (/no group systemd-journal/.test(r.stderr)) {
            console.log('ok   prepare: (no systemd-journal group here)');
        } else {
            assert.strictEqual(r.status, 0, r.stderr);
            assert.strictEqual(fs.statSync(pdir).mode & 0o7777, 0o2770);
            console.log('ok   prepare: the folder made, mode 2770');
        }
    }
    cp.execFileSync('rm', ['-rf', tmp]);
    console.log('journal_keep: all passed');
})().catch(function (e) { console.error('FAIL', e && e.stack); process.exit(1); });
