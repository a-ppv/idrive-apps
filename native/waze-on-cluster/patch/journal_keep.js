#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* journal_keep — the tools' part of the journal, kept on /var/opt, where it
 * outlives the unit's volatile journal (about four minutes on the car) and
 * its reboots. waze-on-cluster-journal.service runs it as a dynamic user in
 * the systemd-journal group.
 *
 * It reads this boot's entries of UNITS, systemd's lines and the kernel's,
 * then follows them. Each becomes one line of at most LINE_MAX bytes,
 *   2026-11-03T06:58:54.365447Z cluster-render.service cluster-render[1152]: <message>
 * appended to DIR/journal.log every FLUSH_MS, the file opened only for the
 * write. In the boot's first EARLY_S seconds of uptime each append is also
 * synced to disk (fdatasync, through a read-only descriptor, so a remount
 * read-only never finds the file open for writing): a start the head unit
 * resets without a shutdown keeps its lines up to the last append. Later,
 * the file system's own commit makes them durable within seconds.
 * A file that would pass FILE_MAX becomes journal.log.1, the older
 * ones move up and journal.log.<FILES-1> is dropped. The tools' lines
 * (waze-on-cluster, cluster-render) and the others (carplay, aapd, recmgr,
 * crashhandler, systemd, the kernel) each have RATE / 2 bytes a minute, with a
 * minute's worth in reserve, so a flood of one kind never pushes out the
 * other; what comes faster is dropped and counted in one line per flush.
 * The read of what this boot logged before the start is not limited: it is
 * written whole, the files' caps keeping its newest lines.
 *
 * Only lines that can explain a failure are kept (Filter):
 *   - the units' own lines, but for NOISE (high-volume lines that explain
 *     nothing: carplay's scheduling shim, the crash handler's IPC chatter)
 *   - systemd's lines about the units, and its SYSTEMD_KEEP lines about any
 *     other unit (started, stopped, killed, failed, watchdog)
 *   - the kernel's, but for KERNEL_NOISE (the firewall's log of each blocked
 *     packet, the Wi-Fi driver's scans and ring chatter, audit records); a
 *     line no pattern names is kept. Of the kernel's log of the boot's first
 *     BOOT_S seconds only the version, the command line's hardware fields,
 *     its first and last lines and those that look like a failure
 *     (BOOT_KEEP, or priority err and worse) are kept, then a line saying
 *     how many were left out.
 *
 * Every LOAD_MS it logs a load line (to the journal, which brings it back
 * here): the load averages, MemAvailable, the processes in D state and the
 * TOP processes by CPU over the interval, from /proc/<pid>/stat (name and
 * pid, never a command line), and the time the sample took.
 *
 * The caps hold the last 10 minutes whatever the units log: every rotated
 * file holds more than FILE_MAX - LINE_MAX bytes, so the files keep at least
 * (FILES - 1) * (FILE_MAX - LINE_MAX) = 3447 KiB, and in any 10 minutes the
 * limit lets through at most 11 * RATE = 2816 KiB.
 *
 * A start reads this boot's entries so far (journalctl without -f) and
 * writes those after the newest line the files hold, or all of them when
 * this boot has no such line; it then follows from the last entry's cursor,
 * as does a journalctl started again. Nothing depends on the clock.
 *
 *   node journal_keep.js prepare   (root) makes DIR, group systemd-journal,
 *                                  mode 2770
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var DIR = process.env.WOC_JOURNAL_DIR || '/var/opt/waze-on-cluster/journal';
var JOURNALCTL = process.env.WOC_JOURNALCTL || 'journalctl';
var FILE = 'journal.log';
var FILES = 10;
var FILE_MAX = 384 * 1024;
var LINE_MAX = 1024;
var RATE = 256 * 1024;
var FLUSH_MS = Number(process.env.WOC_JOURNAL_FLUSH_MS) || 2000;
var RESPAWN_MS = Number(process.env.WOC_JOURNAL_RESPAWN_MS) || 10000;
var EARLY_S = 120;
var PENDING_MAX = 256 * 1024;
var BOOT_S = 10;
var LOAD_MS = Number(process.env.WOC_JOURNAL_LOAD_MS) || 30000;
var PROC = process.env.WOC_PROC || '/proc';
var TOP = 5;
var PIDS_MAX = 4096;
var CLK_TCK = 100;

var UNITS = ['waze-on-cluster.service', 'waze-on-cluster-patchd.service', 'waze-on-cluster-boot.service',
    'waze-on-cluster-recovery.service', 'waze-on-cluster-capture.service', 'waze-on-cluster-journal.service',
    'waze-on-cluster-logs.service', 'waze-on-cluster-logs-fw.service', 'waze-on-cluster-aa-boot.service', 'cluster-render.service', 'carplay.service',
    'aapd.service', 'recmgr.service', 'crashhandler.service'];
/* units with no process of their own: only systemd's lines about them */
var QUIET = ['waze-on-cluster.socket', 'waze-on-cluster-logs.socket', 'cluster-render.socket', 'waze-on-cluster-journal.timer'];

/* journalctl's arguments: the units' own entries, systemd's, and the
 * kernel's. follow: null reads this boot so far and ends; a cursor (or ''
 * for none) follows after it. */
function journalArgs(follow) {
    var args = ['-b', '--no-pager', '-o', 'json',
        '--output-fields=MESSAGE,_SYSTEMD_UNIT,UNIT,SYSLOG_IDENTIFIER,_PID,_TRANSPORT,PRIORITY,_SOURCE_MONOTONIC_TIMESTAMP'];
    if (follow !== null) args.push('-f', follow ? '--after-cursor=' + follow : '--no-tail');
    UNITS.forEach(function (u) { args.push('_SYSTEMD_UNIT=' + u); });
    args.push('+', '_PID=1', '+', '_TRANSPORT=kernel');
    return args;
}

/* Lines of the units that explain nothing, by message. */
var NOISE = [
    /^\[\w+\] (Intercepting function|Blocked function|Notice in function: findThreadByName)/,   // carplay's and aapd's libschedconfig
    /^Coding base: Shm object data is available/,
    /^\s*ipcLib:/,                                                                           // the crash handler's IPC
    /^DLT ~(FIFO .* cannot be opened|Logging \(re-\)enabled|Buffer: )/,
];
/* The kernel's lines that explain nothing, by message: the firewall's log of
 * every blocked packet, the Wi-Fi driver's scans, flow rings, ioctls and
 * hex dumps, module signature and secure-boot notes, audit records of
 * syscalls, paths, IPsec and links. */
var KERNEL_NOISE = [
    /^Blocking unknown connection\b/,
    /^CFG80211-ERROR\) wl_run_escan :/, /LEGACY_SCAN sync ID|LEGACY E-SCAN START/,
    /^dhd_prot_(flow_ring_|ioctl: status ret value)/, /^dhd_bus_cmn_writeshared:/, /^dhd_flow_rings_delete_for_peer:/,
    /^WLC_E_IF: NO_IF set, event Ignored/, /^ignore event \d+, not interested/, /^Previous IW IE is equals to current IE/,
    /^(Set|Clean) : op_mode=/, /^Set AC=\d+, txop=/, /^Can not set data rate in disconnected state/,
    /^DHD-MON: dhd_del_monitor IF not found/, /^netdev_ifidx\(\d+\), chan_type/,
    /^\s*([0-9a-f]{4}: )?([0-9a-f]{2} ?)+$/, /^\s*$/, /^ring_info_raw:/,
    /^PKCS7: Unknown OID/, /^keystore: Ignoring secure boot status/, /^HTB: quantum of class \d+ is big/,
    /^audit: type=(1300|1302|1307|1325|1327|1415|1702) /, /^kauditd_printk_skb: \d+ callbacks suppressed/,
];
var SYSTEMD_KEEP = /Failed with result|Main process exited|^Started |^Stopped |^Failed to start |Killing|[Ww]atchdog/;
/* The boot's kernel lines kept: failures */
var BOOT_KEEP = /\b(errors?|fail(s|ed|ure)?|faults?|oom|out of memory|killed|segfault|panic|BUG|call trace|timed out|timeout|hung|corrupt(ed|ion)?|denied)\b|RDONLY-ALERT|^Linux version /i;
/* The command line's fields kept: the hardware's, no serial or key */
var CMDLINE_KEEP = ['bootmode', 'hwtype', 'hwrevision', 'hwvariant', 'config_version', 'ifwi', 'ABL.version', 'ABL.hwver', 'ABL.reset', 'ABL.boot', 'ABL.status'];

function any(list, s) {
    for (var i = 0; i < list.length; i++) if (list[i].test(s)) return true;
    return false;
}

function isoUs(us) {
    return new Date(Math.floor(us / 1000)).toISOString().slice(0, 19) + '.' + String(us % 1e6).padStart(6, '0') + 'Z';
}

function text(v) {
    if (Array.isArray(v)) return Buffer.from(v).toString('utf8');
    return v === null || v === undefined ? '' : String(v);
}

function unitOf(entry) {
    return entry._TRANSPORT === 'kernel' ? '' :
        entry._SYSTEMD_UNIT && entry._SYSTEMD_UNIT !== 'init.scope' ? entry._SYSTEMD_UNIT : text(entry.UNIT) || '-';
}

/* One journal entry (journalctl -o json) as { us, line, tool } with its
 * newline (tool: a line of waze-on-cluster or cluster-render), or null.
 * msg replaces the entry's message. */
function format(entry, msg) {
    var us = Number(entry.__REALTIME_TIMESTAMP);
    if (!(us > 0)) return null;
    if (msg === undefined) msg = text(entry.MESSAGE).replace(/[\r\n]+/g, ' ');
    var unit = unitOf(entry);
    var head = unit ? unit + ' ' + text(entry.SYSLOG_IDENTIFIER || '?') + (entry._PID ? '[' + text(entry._PID) + ']' : '') + ':' :
        'kernel:';
    var b = Buffer.from(isoUs(us) + ' ' + head + ' ' + msg, 'utf8');
    if (b.length > LINE_MAX - 1) b = b.slice(0, LINE_MAX - 1);
    return { us: us, line: Buffer.concat([b, Buffer.from('\n')]), tool: /^(waze-on-cluster|cluster-render)[.-]/.test(unit) };
}

function cmdline(msg) {
    var m = /^((?:Kernel )?[Cc]ommand line: )(.*)$/.exec(msg);
    if (!m) return msg;
    return m[1] + m[2].split(/\s+/).filter(function (f) { return CMDLINE_KEEP.indexOf(f.split('=')[0]) >= 0; }).join(' ');
}

/* Which entries are kept and how (see the top): lines(entry) gives the
 * lines for an entry, none to several (the boot's kernel lines left out are
 * counted and said once their window has passed). */
function Filter() {
    this.boot = null;   // { left, bytes, last } while kernel lines of the boot's start are left out
}
Filter.prototype.lines = function (entry) {
    var out = [], self = this;
    function add(f) { if (f) out.push(f); }
    var msg = text(entry.MESSAGE).replace(/[\r\n]+/g, ' ');
    var kernel = entry._TRANSPORT === 'kernel', src = Number(entry._SOURCE_MONOTONIC_TIMESTAMP);
    var inBoot = kernel && src >= 0 && src < BOOT_S * 1e6;
    if (this.boot && !inBoot && Number(entry.__MONOTONIC_TIMESTAMP) >= BOOT_S * 1e6) this.endBoot(out);
    if (kernel) {
        if (any(KERNEL_NOISE, msg)) return out;
        if (!inBoot) { add(format(entry, msg)); return out; }
        var first = !this.boot;
        if (first) this.boot = { left: 0, bytes: 0, last: null };
        if (/^Kernel command line: /.test(msg)) return out;
        var prio = entry.PRIORITY === undefined ? 6 : Number(entry.PRIORITY);
        if (first || prio <= 3 || BOOT_KEEP.test(msg) || /^Command line: /.test(msg)) {
            add(format(entry, cmdline(msg)));
            this.boot.last = null;
        } else {
            var f = format(entry, msg);
            if (f) { this.boot.left++; this.boot.bytes += f.line.length; this.boot.last = f; }
        }
        return out;
    }
    var unit = unitOf(entry);
    if (text(entry._PID) === '1' && UNITS.concat(QUIET).indexOf(unit) < 0) {
        if (SYSTEMD_KEEP.test(msg)) add(format(entry, msg));
        return out;
    }
    if (!/^(waze-on-cluster|cluster-render)[.-]/.test(unit) && any(NOISE, msg)) return out;
    add(format(entry, msg));
    return out;
};
/* The boot's last kernel line left out, then how many were. */
Filter.prototype.endBoot = function (out) {
    var b = this.boot;
    this.boot = null;
    if (!b.last) return;
    b.left--;
    b.bytes -= b.last.line.length;
    out.push(b.last);
    if (b.left > 0) {
        out.push({ us: b.last.us, tool: false, line: Buffer.from(isoUs(b.last.us) + ' journal-keep: the kernel\'s first ' + BOOT_S +
            ' s: ' + b.left + ' lines (' + Math.ceil(b.bytes / 1024) + ' KiB) left out\n') });
    }
};

/* A token bucket of rate bytes a minute holding at most a minute's worth.
 * now() in ms. */
function Limiter(rate, now) {
    this.rate = rate;
    this.now = now || Date.now;
    this.tokens = rate;
    this.at = this.now();
    this.droppedLines = 0;
    this.droppedBytes = 0;
}
Limiter.prototype.take = function (n) {
    var t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + (t - this.at) * this.rate / 60000);
    this.at = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    this.droppedLines++;
    this.droppedBytes += n;
    return false;
};
/* The line saying what of kind was dropped since the last call, or null. */
Limiter.prototype.summary = function (us, kind) {
    if (!this.droppedLines) return null;
    var line = isoUs(us) + ' journal-keep: dropped ' + this.droppedLines + ' ' + kind + ' lines (' +
        Math.ceil(this.droppedBytes / 1024) + ' KiB) over the rate limit\n';
    this.droppedLines = this.droppedBytes = 0;
    return Buffer.from(line);
};

/* The files: dir/journal.log and its rotations .1 .. .<files-1>. */
function Ring(dir, opts) {
    var o = opts || {};
    this.dir = dir;
    this.files = o.files || FILES;
    this.fileMax = o.fileMax || FILE_MAX;
    this.size = null;
}
Ring.prototype.name = function (i) { return path.join(this.dir, FILE + (i ? '.' + i : '')); };
Ring.prototype.rotate = function () {
    for (var i = this.files - 1; i > 0; i--) {
        try { fs.renameSync(this.name(i - 1), this.name(i)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    this.size = 0;
};
/* Drops rotations past the cap, and rotates a file already past it. */
Ring.prototype.trim = function () {
    var self = this;
    fs.readdirSync(this.dir).forEach(function (n) {
        var m = /^journal\.log\.(\d+)$/.exec(n);
        if (m && Number(m[1]) >= self.files) fs.unlinkSync(path.join(self.dir, n));
    });
    try { this.size = fs.statSync(this.name(0)).size; } catch (e) { this.size = 0; }
    if (this.size > this.fileMax) this.rotate();
};
/* Appends lines (Buffers, each at most fileMax bytes), rotating between
 * lines so no file passes fileMax. sync: each write is on disk before the
 * next (fdatasync through a read-only descriptor, the write's closed). */
Ring.prototype.append = function (lines, sync) {
    if (this.size === null) this.trim();
    var batch = [], bytes = 0, self = this;
    function write() {
        if (!batch.length) return;
        var fd = fs.openSync(self.name(0), 'a', 0o660);
        try { fs.writeSync(fd, Buffer.concat(batch)); } finally { fs.closeSync(fd); }
        if (sync) {
            fd = fs.openSync(self.name(0), 'r');
            try { fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
        }
        self.size += bytes;
        batch = [];
        bytes = 0;
    }
    lines.forEach(function (b) {
        if (self.size + bytes + b.length > self.fileMax) { write(); self.rotate(); }
        batch.push(b);
        bytes += b.length;
    });
    write();
};
/* The newest journal line the files hold (with its newline), or null. */
Ring.prototype.newest = function () {
    for (var i = 0; i < this.files; i++) {
        var fd;
        try { fd = fs.openSync(this.name(i), 'r'); } catch (e) { continue; }
        try {
            var size = fs.fstatSync(fd).size, n = Math.min(size, 2 * LINE_MAX), b = Buffer.alloc(n);
            fs.readSync(fd, b, 0, n, size - n);
            var lines = b.toString('utf8').split('\n').filter(Boolean);
            for (var j = lines.length - 1; j >= 0; j--) {
                if (/^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(lines[j]) && !/^\S+ journal-keep: /.test(lines[j])) return lines[j] + '\n';
            }
        } finally { fs.closeSync(fd); }
    }
    return null;
};

function readSmall(file, buf) {
    var fd = fs.openSync(file, 'r');
    try { return buf.toString('latin1', 0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); }
}

/* The load line's sampler over proc (see the top). line() takes a sample
 * and gives the line for the interval since the last, or null (the first,
 * or /proc unreadable). now(): a clock in ms that the wall clock's steps
 * leave alone. */
function LoadSampler(proc, now) {
    this.proc = proc;
    this.now = now || function () { var t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };
    this.prev = null;
    this.buf = Buffer.alloc(1024);
}
LoadSampler.prototype.sample = function () {
    var names = fs.readdirSync(this.proc), procs = {}, d = 0, n = 0;
    for (var i = 0; i < names.length && n < PIDS_MAX; i++) {
        if (!/^\d+$/.test(names[i])) continue;
        var s;
        try { s = readSmall(this.proc + '/' + names[i] + '/stat', this.buf); } catch (e) { continue; }
        var open = s.indexOf('('), close = s.lastIndexOf(')');
        if (open < 0 || close < open) continue;
        /* the fields after the name: [0] state, [11] utime, [12] stime, [19] starttime */
        var f = s.slice(close + 2).split(' ', 20);
        n++;
        if (f[0] === 'D') d++;
        procs[names[i] + '/' + f[19]] = { name: s.slice(open + 1, close).replace(/[^\x21-\x7e]/g, '_'), pid: names[i],
            ticks: Number(f[11]) + Number(f[12]) };
    }
    return { at: this.now(), procs: procs, d: d };
};
LoadSampler.prototype.line = function () {
    var t0 = this.now(), cur;
    try { cur = this.sample(); } catch (e) { return null; }
    var prev = this.prev;
    this.prev = cur;
    if (!prev || cur.at <= prev.at) return null;
    var secs = (cur.at - prev.at) / 1000, top = [];
    Object.keys(cur.procs).forEach(function (k) {
        var p = cur.procs[k], was = prev.procs[k], dt = p.ticks - (was ? was.ticks : 0);
        if (dt > 0) top.push({ p: p, pct: dt / CLK_TCK / secs * 100 });
    });
    top.sort(function (a, b) { return b.pct - a.pct; });
    var load = '?', avail = '?';
    try { load = fs.readFileSync(this.proc + '/loadavg', 'utf8').split(' ').slice(0, 3).join(' '); } catch (e) { /* none */ }
    try { avail = Math.round(Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync(this.proc + '/meminfo', 'utf8'))[1]) / 1024) + ' MiB'; } catch (e) { /* none */ }
    return 'load ' + load + '; MemAvailable ' + avail + '; D state ' + cur.d + '; CPU over ' + Math.round(secs) + ' s: ' +
        (top.slice(0, TOP).map(function (x) { return x.p.name + '[' + x.p.pid + '] ' + x.pct.toFixed(1) + '%'; }).join(', ') || 'none') +
        '; sampled in ' + Math.round(this.now() - t0) + ' ms';
};

function main() {
    var ring = new Ring(DIR), limit = { tool: new Limiter(RATE / 2), other: new Limiter(RATE / 2) }, filter = new Filter();
    var pending = [], pendingBytes = 0, cursor = null, child = null, quitting = false, warned = '';
    function warn(msg) { if (msg !== warned) { warned = msg; console.error('journal-keep: ' + msg); } }
    try { ring.trim(); } catch (e) { warn(e.message); }

    function flush() {
        ['tool', 'other'].forEach(function (k) {
            var s = limit[k].summary(Date.now() * 1000, k);
            if (s) pending.push(s);
        });
        if (!pending.length) return;
        var lines = pending;
        pending = [];
        pendingBytes = 0;
        try { ring.append(lines, os.uptime() < EARLY_S); warned = ''; } catch (e) { ring.size = null; warn('cannot write ' + DIR + ': ' + e.message); }
    }
    function take(entry) {
        if (entry.__CURSOR) cursor = String(entry.__CURSOR);
        filter.lines(entry).forEach(function (f) {
            if (!limit[f.tool ? 'tool' : 'other'].take(f.line.length)) return;
            pending.push(f.line);
            pendingBytes += f.line.length;
        });
        if (pendingBytes > PENDING_MAX) flush();
    }
    /* This boot so far: the lines after the files' newest one, the newest
     * FILES * FILE_MAX bytes of them at most. A read that ends early still
     * writes what it read once it is past the files' newest line, and the
     * follow goes on from there; before that it writes nothing. */
    function backlog(done) {
        var newest = null, lines = [], bytes = 0, read = null, past = false;
        try { newest = ring.newest(); } catch (e) { warn(e.message); }
        past = !newest;
        filter = new Filter();
        run(null, function (entry) {
            if (entry.__CURSOR) read = String(entry.__CURSOR);
            /* the newest line as a version that kept every line wrote it */
            var whole = newest && !past && format(entry);
            if (whole && whole.line.toString() === newest) { lines = []; bytes = 0; past = true; }
            filter.lines(entry).forEach(function (f) {
                if (newest && f.line.toString() === newest) { lines = []; bytes = 0; past = true; return; }
                lines.push(f.line);
                bytes += f.line.length;
                while (bytes > FILES * FILE_MAX) bytes -= lines.shift().length;
            });
        }, function (ok) {
            if (ok || past) {
                pending = pending.concat(lines);
                flush();
                if (read !== null) cursor = read;
            }
            done(ok || (past && read !== null));
        });
    }
    function start() {
        if (quitting) return;
        if (cursor === null) {
            backlog(function (ok) {
                if (ok) return run(cursor || '', take, again);
                again();
            });
        } else {
            run(cursor, take, again);
        }
    }
    function again() {
        if (quitting) return;
        warn('journalctl ended; again in ' + RESPAWN_MS / 1000 + ' s');
        setTimeout(start, RESPAWN_MS);
    }
    /* journalctl with journalArgs(follow), each entry to onEntry; ended(ok) */
    function run(follow, onEntry, ended) {
        var buf = '';
        child = cp.spawn(JOURNALCTL, journalArgs(follow), { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                var entry = null;
                try { entry = JSON.parse(line); } catch (e) { /* not an entry */ }
                if (entry) onEntry(entry);
            }
            if (buf.length > 64 * LINE_MAX) buf = '';
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', function (d) { warn('journalctl: ' + d.trim().slice(0, 200)); });
        child.on('error', function (e) { warn('journalctl: ' + e.message); });
        child.on('close', function (code) {
            child = null;
            if (!quitting) ended(code === 0);
        });
    }
    var timer = setInterval(flush, FLUSH_MS);
    /* the journal's stream gone (journald restarting) is no reason to stop */
    process.stdout.on('error', function () {});
    process.stderr.on('error', function () {});
    var sampler = new LoadSampler(PROC), loadTimer = setInterval(function () {
        try {
            var l = sampler.line();
            if (l) console.log(l);
        } catch (e) { warn('load line: ' + e.message); }
    }, LOAD_MS);
    console.log('journal-keep: boot ' + require('./boot_id.js').bootId().slice(0, 8) + ', up ' + Math.round(os.uptime()) + ' s');
    try { sampler.line(); } catch (e) { warn('load line: ' + e.message); }
    function quit() {
        quitting = true;
        clearInterval(timer);
        clearInterval(loadTimer);
        if (child) child.kill('SIGTERM');
        flush();
        process.exit(0);
    }
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    start();
}

if (require.main === module) {
    if (process.argv[2] === 'prepare') require('./group_dir.js').groupDir(DIR, 'systemd-journal');
    else main();
}

module.exports = { journalArgs: journalArgs, format: format, Filter: Filter, LoadSampler: LoadSampler, Limiter: Limiter, Ring: Ring,
    FILES: FILES, FILE_MAX: FILE_MAX, LINE_MAX: LINE_MAX, RATE: RATE, UNITS: UNITS, BOOT_S: BOOT_S };
