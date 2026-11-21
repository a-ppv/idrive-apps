#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_extra — the parts of the Save logs archive (collect-logs.sh) that
 * are read with care: only read, each file at most CAP bytes, and every text
 * passed through scrub(), which replaces anything shaped like a VIN (17
 * characters) or a short VIN (7) with <VIN>.
 *
 *   node logs_extra.js report <dir>
 *       as the logs service's user, into dir:
 *       patch-record-carplay.json, patch-record-aapd.json
 *                          the patchers' records (patch_record.js)
 *       aa-boot-recovery.json
 *                          the aapd boot recovery's state (recovery.js)
 *       inmem-carplay.json, inmem-aapd.json
 *                          the records of the patches in memory (inmem.js)
 *       inmem-carplay-result.json, inmem-aapd-result.json
 *                          what libwocpatch.so did at the last armed start
 *                          of this boot
 *       restart-record-<n>-<boot id>-<recmgr|crashhandler>.xml
 *                          the restart records the carplay boot step kept
 *                          (recovery.js keepRestartRecords)
 *       coding.txt         the cluster coding's KI_KOMBI_VARIANT, the number
 *                          only (aapd_patch.js readCoding)
 *       deploy.txt         the deploy tool's version; each tool installed
 *                          (/var/opt/<id>/current/component.json: id, kind,
 *                          version); and from the deploy tool's state.json
 *                          the tools' versions and firmware, the apps'
 *                          versions, the restarts pending in this boot and
 *                          the last bounce. Nothing else of it or of the
 *                          updater: not their tokens, credentials, sources,
 *                          config or backups.
 *
 *   node logs_extra.js snapshot [dir]
 *       as root (waze-on-cluster-logs-fw.service before the logs service
 *       starts, or collect-logs.sh run by root): BMW's records under
 *       /var/opt/public, which only root reads, into dir (default SNAPSHOT,
 *       made group systemd-journal, mode 2750; files 0640; written into
 *       SNAPSHOT.new and renamed into place whole):
 *       restartInfo-recmgr.xml, restartInfo-crashhandler.xml
 *                          recmgr's and crashhandler's restart records, when
 *                          there (each deletes its own at its start)
 *       recmgr-crashes.txt recmgr_stats.db's modification time and its Crash
 *                          table's newest ROWS rows: key, the application's
 *                          name, crash id (and Timestamp and LC, which recmgr
 *                          leaves empty and 0). Not its UserID column (7
 *                          characters, the size of a short VIN). The
 *                          firmware's sqlite3 opens the database read-only
 *                          (file:...?mode=ro) and is killed after SQLITE_MS.
 *       core-dumps.txt     the names and modification times (UTC) of what
 *                          the crash handler and the kernel keep of crashes
 *                          (DUMPS, two levels deep, at most ENTRIES each),
 *                          never their contents
 *       aapd-crashes.txt   of the crash handler's records of aapd's newest
 *                          CONTEXTS crashes, where it crashed: signal,
 *                          kernel stack, executable mappings, crash ids and
 *                          summary (aapdCrashesText)
 *
 *   node logs_extra.js patchd <dir>
 *       patchd-logs.json: patchd's carplay, marker and AVB lines, its DLT
 *       reader's health and its own log, asked on its logs socket
 *       (PATCHD_SOCK, the systemd-journal group's), within PATCHD_MS; what
 *       went wrong when it did not answer
 *
 *   node logs_extra.js incidents <dir>
 *       incidents.txt: the INCIDENT lines of the tools' logs in dir
 *       (cluster-render.log*, waze-on-cluster.log*), each boot the kept
 *       journal in dir saw (kept-journal*: journal-keep's "boot" lines) and
 *       this export,
 *       oldest first, at most INCIDENTS lines
 *
 *   node logs_extra.js scrub <from> <to>
 *       every file in from, scrubbed (Scrubber), into to: VINs (any
 *       17-character VIN, and each one found there or in the coding image,
 *       with its last 7 characters, wherever it stands), MAC addresses, IP
 *       addresses outside the car's own ranges, Wi-Fi network names, phone
 *       and device names, USB serial numbers, keys, passwords and tokens; a
 *       .json file's strings one by one. A MAC or IP address becomes a tag the same
 *       within the archive and unlike any other archive's (an HMAC with a
 *       key made for this run). Each file is read up to SCRUB_FILE_MAX; one
 *       that is not text, cannot be read, or is left when SCRUB_MS have
 *       passed is not written, and left-out.txt names it.
 *
 * A source that is absent is left out; one that cannot be read says why in
 * its file. A file cut short of its source says so in its last line. WOC_LOGS_ROOT
 * prefixes every path read (tests).
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var net = require('net');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = process.env.WOC_LOGS_ROOT || '';
var SNAPSHOT = '/run/waze-on-cluster-logs';
var CAP = 64 * 1024;
/* Read past CAP by this much, so a VIN that crosses CAP is whole when
 * scrubbed; cut to CAP - CUT_NOTE after it, with a note saying so. */
var OVERREAD = 128;
var CUT_NOTE = 64;
var ROWS = 200;
var ENTRIES = 100;
var SQLITE_MS = 2000;
var SIN = '/var/opt/public/sin';
var PATCHD_SOCK = process.env.WOC_PATCH_LOGS_SOCK || '/dev/shm/waze-on-cluster/patch-logs.sock';
var PATCHD_MS = 3000;
var PATCHD_MAX = 8 * 1024 * 1024;
var INCIDENTS = 2000;
var SCRUB_MS = Number(process.env.WOC_SCRUB_MS) || 60000;
var SCRUB_FILE_MAX = 8 * 1024 * 1024;
var CODING = '/dev/shm/rawcodingdata';
var CONTEXTS = 3;
var CONTEXT_MAX = 4 * 1024 * 1024;
var DUMPS = [SIN + '/crashhandler/coredumps', SIN + '/crashhandler/gpu_hangs', SIN + '/gcd', SIN + '/dlt-cdh', '/var/opt/kerneldump'];

function r(p) { return ROOT + p; }

/* A VIN (17 of A-HJ-NPR-Z0-9, with a letter and a digit) or a short VIN (a
 * letter and 6 digits, or 2 and 5), standing alone: <VIN>. */
var VIN = /(^|[^A-Za-z0-9])([A-HJ-NPR-Z0-9]{17}|[A-Z][0-9]{6}|[A-Z]{2}[0-9]{5})(?![A-Za-z0-9])/gi;
function scrub(text) {
    return String(text).replace(VIN, function (m, pre, tok) {
        if (tok.length === 17 && !(/[0-9]/.test(tok) && /[A-Z]/i.test(tok))) return m;
        return pre + '<VIN>';
    });
}

/* A regular file's first cap + OVERREAD bytes as { text, more } (more: the
 * file holds more than that), never through a link; null when absent;
 * throws when it cannot be read. */
function readSource(file, cap) {
    var st;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!st.isFile()) return null;
    var fd = fs.openSync(file, 'r');
    try {
        var b = Buffer.alloc(Math.min(st.size, cap + OVERREAD)), n = fs.readSync(fd, b, 0, b.length, 0);
        return { text: b.slice(0, n).toString('utf8'), more: st.size > n };
    } finally { fs.closeSync(fd); }
}

/* text scrubbed, then cut to cap bytes with a note when it is longer or
 * its source was (more), as a Buffer. */
function redact(text, cap, more) {
    var b = Buffer.from(scrub(text), 'utf8');
    if (b.length <= cap && !more) return b;
    var keep = Math.min(b.length, cap - CUT_NOTE);
    return Buffer.concat([b.slice(0, keep), Buffer.from('\n... (cut at ' + keep + ' bytes)\n')]);
}

function put(dir, name, part) {
    var src = typeof part === 'string' ? { text: part, more: false } : part;
    fs.writeFileSync(path.join(dir, name), redact(src.text, CAP, src.more), { mode: 0o640 });
}

/* Each part [name, text()] into dir: text() (a string or readSource's
 * result) null leaves it out, a throw writes why. */
function writeParts(dir, parts) {
    parts.forEach(function (p) {
        var text;
        try { text = p[1](); } catch (e) { text = '(failed: ' + (e.code || e.message) + ')\n'; }
        if (text !== null) put(dir, p[0], text);
    });
}

function fileText(file) { return function () { return readSource(file, CAP); }; }

function readJson(file) {
    var src = readSource(file, CAP);
    return src === null ? null : JSON.parse(src.text);
}

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }
function str(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : '?'; }

/* ---- report ---------------------------------------------------------------- */

function codingText() {
    var cd = require('./aapd_patch.js').readCoding(r(CODING));
    return (cd.err ? 'unreadable (' + cd.err + ')' : 'KI_KOMBI_VARIANT ' + cd.variant) + '\n';
}

function deployText() {
    var out = [], varOpt = r('/var/opt'), v = null;
    try { v = fs.readlinkSync(path.join(varOpt, 'mgu-deploy', 'current')); } catch (e) { /* not installed */ }
    out.push('mgu-deploy ' + (v ? path.basename(v) : 'absent'));
    out.push('tools installed (/var/opt/<id>/current):');
    var names = [];
    try { names = fs.readdirSync(varOpt).sort(); } catch (e) { out.push('  (' + e.code + ')'); }
    names.forEach(function (n) {
        var cur = path.join(varOpt, n, 'current');
        try { if (!fs.lstatSync(cur).isSymbolicLink()) return; } catch (e) { return; }
        var c = null;
        try { c = readJson(path.join(cur, 'component.json')); } catch (e) { out.push('  ' + n + ' (component.json: ' + (e.code || 'not JSON') + ')'); return; }
        if (c && typeof c === 'object') out.push('  ' + str(c.kind) + ' ' + str(c.id) + ' ' + str(c.version));
    });
    var s = null;
    try { s = readJson(path.join(varOpt, 'mgu-deploy', 'state.json')); } catch (e) { out.push('state.json: ' + (e.code || 'not JSON')); }
    if (s && typeof s === 'object') {
        out.push('state.json:');
        var tools = s.tools && typeof s.tools === 'object' ? s.tools : {};
        Object.keys(tools).sort().forEach(function (id) {
            var t = tools[id] || {};
            out.push('  tool ' + id + ' ' + str(t.version) + (t.firmware ? ' firmware ' + str(t.firmware) : '') +
                (t.needsSetup ? ' (needs setup: ' + str(t.needsSetup) + ')' : '') + (t.afterFirmware ? ' (after a firmware update)' : ''));
        });
        var apps = s.apps && typeof s.apps === 'object' ? s.apps : {};
        Object.keys(apps).sort().forEach(function (id) { out.push('  app ' + id + ' ' + str((apps[id] || {}).version)); });
        var boot = require('./boot_id.js').bootId();
        (Array.isArray(s.pending_reboot) ? s.pending_reboot : []).forEach(function (p) {
            if (p && typeof p === 'object' && boot && p.boot === boot) out.push('  pending restart: ' + str(p.id) + ' - ' + str(p.reason));
        });
        if (typeof s.lastBounceAt === 'number' && s.lastBounceAt > 0) out.push('  last bounce: ' + iso(s.lastBounceAt * 1000));
    }
    return out.join('\n') + '\n';
}

function report(dir) {
    var records = r('/var/opt/waze-on-cluster/restart-records'), names = [];
    try { names = fs.readdirSync(records).filter(function (n) { return /\.xml$/.test(n); }).sort(); } catch (e) { /* none kept */ }
    writeParts(dir, [
        ['patch-record-carplay.json', fileText(r('/usr/bin/carplay.woc-patch.json'))],
        ['patch-record-aapd.json', fileText(r('/usr/bin/aapd.woc-patch.json'))],
        ['aa-boot-recovery.json', fileText(r('/var/opt/waze-on-cluster/aa-boot-recovery.json'))],
        ['inmem-carplay.json', fileText(r('/var/opt/waze-on-cluster/inmem-carplay.json'))],
        ['inmem-aapd.json', fileText(r('/var/opt/waze-on-cluster/inmem-aapd.json'))],
        ['inmem-carplay-result.json', fileText(r('/run/woc-preload/carplay.result'))],
        ['inmem-aapd-result.json', fileText(r('/run/woc-preload/aapd.result'))],
        ['coding.txt', codingText],
        ['deploy.txt', deployText],
    ].concat(names.map(function (n) { return ['restart-record-' + n, fileText(path.join(records, n))]; })));
}

/* ---- snapshot -------------------------------------------------------------- */

function crashesText() {
    var db = r(SIN + '/recmgr/recmgr_stats.db'), st;
    try { st = fs.lstatSync(db); } catch (e) { return null; }
    if (!st.isFile()) return null;
    var sql = 'SELECT c.CrashKey, c.Timestamp, a.Name, c.CrashID, c.LC FROM Crash c LEFT JOIN Appl a ON a.ID = c.AppID ' +
        'ORDER BY c.CrashKey DESC LIMIT ' + ROWS + ';';
    var res = cp.spawnSync('sqlite3', ['-header', 'file:' + db + '?mode=ro', sql],
        { cwd: '/', encoding: 'utf8', timeout: SQLITE_MS, killSignal: 'SIGKILL', maxBuffer: 4 * CAP, stdio: ['ignore', 'pipe', 'pipe'] });
    var head = '-- ' + SIN + '/recmgr/recmgr_stats.db, modified ' + iso(st.mtime.getTime()) + '\n' +
        '-- Crash, newest first (at most ' + ROWS + ')\n';
    if (res.error) return head + '(' + (res.error.code === 'ETIMEDOUT' ? 'sqlite3 killed after ' + SQLITE_MS + ' ms' : 'sqlite3: ' + res.error.code) + ')\n';
    return head + (res.stdout || '') + (res.status ? '(sqlite3 exit ' + res.status + ': ' + String(res.stderr || '').trim().slice(0, 300) + ')\n' :
        res.stdout ? '' : '(no rows)\n');
}

function dumpsText() {
    var out = [];
    DUMPS.forEach(function (base) {
        var lines = [];
        function walk(rel, depth) {
            var names;
            try { names = fs.readdirSync(r(base) + rel); } catch (e) {
                if (!rel) { if (e.code !== 'ENOENT') out.push('-- ' + base + '\n(' + e.code + ')'); return; }
                lines.push({ t: 0, s: '(' + e.code + ') ' + rel.slice(1) + '/' });
                return;
            }
            names.forEach(function (n) {
                var st;
                try { st = fs.lstatSync(r(base) + rel + '/' + n); } catch (e) { return; }
                lines.push({ t: st.mtime.getTime(), s: iso(st.mtime.getTime()) + '  ' + (rel + '/' + n).slice(1) + (st.isDirectory() ? '/' : '') });
                if (st.isDirectory() && depth < 2) walk(rel + '/' + n, depth + 1);
            });
            if (!rel) {
                lines.sort(function (a, b) { return b.t - a.t; });
                out.push('-- ' + base + (lines.length > ENTRIES ? ' (the newest ' + ENTRIES + ' of ' + lines.length + ')' : ''));
                lines.slice(0, ENTRIES).forEach(function (l) { out.push(l.s); });
                if (!lines.length) out.push('(empty)');
            }
        }
        walk('', 1);
    });
    return out.join('\n') + '\n';
}

/* The crash handler's record of aapd's newest CONTEXTS crashes
 * (dlt-cdh/context.<time>.aapd.<pid>.txt), only what tells where it
 * crashed: its first lines (process, thread, signal), the kernel stack,
 * the executable mappings (where each module was loaded), the crash ids
 * and the summary (the instruction and return addresses, their modules and
 * file offsets). Never its environment, open files, other mappings, memory
 * use or the core dump. */
function aapdCrashesText() {
    var d = r(SIN + '/dlt-cdh'), names, re = /^context\.(\d+)\.aapd\.\d+\.txt$/;
    try { names = fs.readdirSync(d); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    var ctx = names.filter(function (n) { return re.test(n); })
        .sort(function (a, b) { return Number(re.exec(b)[1]) - Number(re.exec(a)[1]); });
    if (!ctx.length) return null;
    return (ctx.length > CONTEXTS ? '-- the newest ' + CONTEXTS + ' of ' + ctx.length + '\n' : '') + ctx.slice(0, CONTEXTS).map(function (n) {
        return '-- ' + n + ' (' + iso(Number(re.exec(n)[1]) * 1000) + ')\n' + contextParts(readSource(path.join(d, n), CONTEXT_MAX));
    }).join('\n');
}
function contextParts(src) {
    if (!src) return '(unreadable)\n';
    var out = [], sect = null, keep = true;
    src.text.split('\n').forEach(function (l) {
        var m = /^==== (.*) ====$/.exec(l);
        if (m) {
            sect = m[1];
            keep = /\/stack>$|\/maps>$|^Crash (Coarse )?ID$|^Summary$/.test(sect);
            if (keep) out.push(l);
        } else if (/^=+$/.test(l)) keep = false;
        else if (sect === null || (keep && (!/\/maps>$/.test(sect) || / r-xp /.test(l)))) out.push(l);
    });
    return out.join('\n') + (src.more ? '(cut at ' + CONTEXT_MAX + ' bytes)\n' : '');
}

function snapshot(dir) {
    writeParts(dir, [
        ['restartInfo-recmgr.xml', fileText(r(SIN + '/recmgr/restartInfo.xml'))],
        ['restartInfo-crashhandler.xml', fileText(r(SIN + '/crashhandler/restartInfo.xml'))],
        ['recmgr-crashes.txt', crashesText],
        ['core-dumps.txt', dumpsText],
        ['aapd-crashes.txt', aapdCrashesText],
    ]);
}

/* The snapshot into SNAPSHOT.new, then renamed into place whole: a copy
 * from SNAPSHOT under way never reads a file half written or emptied. */
function snapshotInPlace() {
    var next = SNAPSHOT + '.new', old = SNAPSHOT + '.old';
    cp.execFileSync('rm', ['-rf', next, old]);
    fs.mkdirSync(next, 0o750);
    fs.chownSync(next, 0, require('./group_dir.js').gid('systemd-journal'));
    fs.chmodSync(next, 0o2750);
    snapshot(next);
    try { fs.renameSync(SNAPSHOT, old); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.renameSync(next, SNAPSHOT);
    cp.execFileSync('rm', ['-rf', old]);
}

/* ---- patchd ---------------------------------------------------------------- */

/* patchd's answer to {"cmd":"logs"} on sock within ms, into file:
 * cb(null) once written. */
function patchdLogs(sock, file, ms, cb) {
    var buf = '', done = false, c = net.connect(sock);
    function finish(why, obj) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        c.destroy();
        var text = obj ? JSON.stringify(obj, null, 1) + '\n' : JSON.stringify({ error: why }) + '\n';
        try { fs.writeFileSync(file, text, { mode: 0o640 }); } catch (e) { return cb(e); }
        cb(null);
    }
    var timer = setTimeout(function () { finish('patchd did not answer in ' + ms + ' ms'); }, ms);
    c.setEncoding('utf8');
    c.on('connect', function () { c.write(JSON.stringify({ cmd: 'logs' }) + '\n'); });
    c.on('data', function (d) {
        buf += d;
        if (buf.length > PATCHD_MAX) return finish('answer past ' + PATCHD_MAX + ' bytes');
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var msg = null;
            try { msg = JSON.parse(buf.slice(0, i)); } catch (e) { /* not a message */ }
            buf = buf.slice(i + 1);
            if (msg && msg.ev === 'logs') return finish(null, msg);
        }
    });
    c.on('error', function (e) { finish('patchd: ' + (e.code || e.message)); });
    c.on('close', function () { finish('patchd closed without an answer'); });
}

/* ---- incidents --------------------------------------------------------------- */

/* "2026-11-15 06:37:23.000" from ms */
function stamp(ms) { return new Date(ms).toISOString().replace('T', ' ').replace(/Z$/, ''); }

function incidentsText(dir, now) {
    var names = [];
    try { names = fs.readdirSync(dir).sort(); } catch (e) { /* none */ }
    var rows = [], boots = {};
    function each(name, fn) {
        var src = null;
        try { src = readSource(path.join(dir, name), SCRUB_FILE_MAX); } catch (e) { return; }
        if (src) src.text.split('\n').forEach(fn);
    }
    names.forEach(function (n) {
        var tool = /^(cluster-render|waze-on-cluster)\.log(\.\d+)?$/.exec(n);
        if (tool) {
            each(n, function (l) {
                if (!/\bINCIDENT\b/.test(l)) return;
                var m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(\.\d+)?)Z? ?(.*)$/.exec(l);
                rows.push(m ? { t: m[1] + ' ' + (m[2] + (m[3] ? '' : '.000')).slice(0, 12), s: tool[1] + ': ' + m[4] } : { t: '~', s: tool[1] + ': ' + l });
            });
        } else if (/^kept-journal(\.log(\.\d+)?|-[\w-]+\.log)$/.test(n)) {
            each(n, function (l) {
                var m = /^(\S+Z) (?:.* )?journal-keep: boot (\w+), up (\d+) s$/.exec(l), t = m && Date.parse(m[1]);
                if (!t) return;
                var at = t - Number(m[3]) * 1000;
                if (!boots[m[2]] || at < boots[m[2]]) boots[m[2]] = at;
            });
        }
    });
    Object.keys(boots).forEach(function (id) { rows.push({ t: stamp(boots[id]), s: '-- boot ' + id }); });
    rows.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
    rows = rows.slice(-INCIDENTS);
    rows.push({ t: stamp(now), s: '-- this export' });
    return '-- INCIDENT lines of cluster-render.log* and waze-on-cluster.log*, the boots the kept journal saw and this export; ' +
        'oldest first, UTC' + (rows.some(function (r) { return r.t === '~'; }) ? ' (~: no time)' : '') + '\n' +
        rows.map(function (r) { return r.t + ' ' + r.s; }).join('\n') + '\n';
}

/* ---- scrub ------------------------------------------------------------------- */

var SECRET_KEY = 'token|secret|password|passwd|passphrase|psk|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session[_-]?id';
var SECRET = new RegExp('((?:' + SECRET_KEY + ')["\']?\\s*[:=]\\s*)(?!(?:Bearer|Basic) <)("[^"\\n]*"?|\'[^\'\\n]*\'?|[^\\s"\',;&<>]{4,})', 'gi');
var BEARER = /\b(Bearer|Basic) [A-Za-z0-9._~+\/=-]{8,}/g;
var PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
var TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
var LONG = /(^|[^A-Za-z0-9+_-])([A-Za-z0-9+_-]{32,}={0,2})(?![A-Za-z0-9+_=-])/g;
var MAC = /(?:[0-9A-Fa-fXx]{2}:){5,}[0-9A-Fa-fXx]{2}|(^|[^0-9A-Za-z-])((?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2})(?![0-9A-Za-z-])/g;
var IP4 = /(^|[^0-9A-Za-z.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9A-Za-z]|\.\d)/g;
var IP6 = /(^|[^0-9A-Za-z.])([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7})(?![0-9A-Za-z:])/g;
var SSID = /(\b(?:ssid|network name)\b["']?\s*[:=]?\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;"'<>]+)/gi;
var DEVICE_KEY = '(?:device ?name|friendly ?name|phone ?name|bt ?name|bluetooth ?name|local ?name|remote ?name|owner ?name|user ?name)';
var DEVICE_FIELD = new RegExp('(\\b' + DEVICE_KEY + '\\b["\']?\\s*[:=]\\s*)("[^"\\n]*"|\'[^\'\\n]*\'|[^,;\\n]+)', 'gi');
var DEVICE_OWNED = /[^\s"',;:()\[\]<>]{1,40}['\u2019]s\s+(?:iPhone|iPad|Galaxy|Pixel|Phone|phone|Android|Xperia|OnePlus|Xiaomi|Redmi|Huawei|Honor|Nokia|Motorola)\b[^\s,;"'()\]\\]{0,40}/g;
var DEVICE_OF = /\b(?:iPhone|iPad|Galaxy|Pixel)\s+(?:de la|de|von|di|van|da|du|of|od)\s+[^\s,;"'()\]<>\\]{1,40}/g;
var SERIAL = /(\bSerial ?(?:Number|No)?\s*[:=]\s*)[^\s,;"'<>]+/gi;
/* JSON keys whose string value is a name or a secret as a whole */
var KEY_SSID = /^(ssid|network ?name)$/i, KEY_DEVICE = new RegExp('^' + DEVICE_KEY + '$', 'i'), KEY_SECRET = new RegExp('(?:' + SECRET_KEY + ')$', 'i');
var VIN_UPPER = /(^|[^A-Za-z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])/g;
/* as scrub()'s VIN, in upper case only: a log's lower-case words of a
 * letter and 6 digits are no VIN */
var VIN_LOG = /(^|[^A-Za-z0-9])([A-HJ-NPR-Z0-9]{17}|[A-Z][0-9]{6}|[A-Z]{2}[0-9]{5})(?![A-Za-z0-9])/g;

function internal4(a, b) {
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 160 && b >= 48 && b <= 51);
}

/* Shaped like a random key: upper and lower case and digits, the kind
 * changing between most neighbours (a name's words change it seldom). */
function random(tok) {
    if (!/[A-Z]/.test(tok) || !/[a-z]/.test(tok) || !/[0-9]/.test(tok)) return false;
    function kind(c) { return /[A-Z]/.test(c) ? 1 : /[a-z]/.test(c) ? 2 : /[0-9]/.test(c) ? 3 : 4; }
    var changes = 0;
    for (var i = 1; i < tok.length; i++) if (kind(tok[i]) !== kind(tok[i - 1])) changes++;
    return changes / (tok.length - 1) >= 0.45;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* Scrubs texts with a key of its own (or key, tests). */
function Scrubber(key) {
    this.key = key || crypto.randomBytes(16);
    this.vins = [];
    this.known = null;
}
Scrubber.prototype.tag = function (kind, value) {
    return '<' + kind + '-' + crypto.createHmac('sha256', this.key).update(kind + ' ' + value.toLowerCase()).digest('hex').slice(0, 6) + '>';
};
/* Remembers the VINs text holds (a letter and a digit among 17 of
 * A-HJ-NPR-Z0-9, upper case), at most 16. */
Scrubber.prototype.learn = function (text) {
    var m, self = this;
    VIN_UPPER.lastIndex = 0;
    while ((m = VIN_UPPER.exec(text)) && self.vins.length < 16) {
        var v = m[2];
        if (/[0-9]/.test(v) && /[A-Z]/.test(v) && self.vins.indexOf(v) < 0) self.vins.push(v);
    }
    this.known = null;
};
Scrubber.prototype.text = function (t) {
    var self = this;
    if (this.vins.length && !this.known) {
        this.known = new RegExp(this.vins.map(function (v) { return escapeRe(v) + '|' + escapeRe(v.slice(-7)); }).join('|'), 'gi');
    }
    t = String(t);
    if (this.known) t = t.replace(this.known, '<VIN>');
    t = t.replace(PEM, '<PRIVATE KEY>').replace(BEARER, '$1 <SECRET>').replace(TOKEN, '<TOKEN>').replace(SECRET, function (m, pre, v) {
        return pre + (v[0] === '"' ? '"<SECRET>"' : v[0] === "'" ? "'<SECRET>'" : '<SECRET>');
    }).replace(SERIAL, '$1<SERIAL>');
    t = t.replace(VIN_LOG, function (m, pre, tok) {
        return tok.length === 17 && !(/[0-9]/.test(tok) && /[A-Z]/.test(tok)) ? m : pre + '<VIN>';
    });
    t = t.replace(MAC, function (m, pre, mac) { return mac ? pre + self.tag('MAC', mac) : self.tag('MAC', m); });
    t = t.replace(IP4, function (m, pre, a, b, c, d, at, all) {
        a = Number(a); b = Number(b);
        if (a > 255 || b > 255 || Number(c) > 255 || Number(d) > 255 || internal4(a, b)) return m;
        if (/(^|[^A-Za-z])(version|ver|v)[\s=:]*$/i.test(all.slice(Math.max(0, at - 12), at + pre.length))) return m;
        return pre + self.tag('IP', [a, b, c, d].join('.'));
    });
    t = t.replace(IP6, function (m, pre, ip) {
        var groups = ip.split(':');
        if (ip.indexOf('::') < 0 && groups.length !== 8) return m;
        if (ip.indexOf(':::') >= 0 || groups.some(function (g) { return g.length > 4; })) return m;
        if (/^ff/i.test(ip) || ip === '::1' || ip === '::' || !/[0-9a-f]/i.test(ip)) return m;
        return pre + self.tag('IP', ip);
    });
    t = t.replace(SSID, function (m, pre, v) { return pre + (v[0] === '"' ? '"<SSID>"' : v[0] === "'" ? "'<SSID>'" : '<SSID>'); });
    t = t.replace(DEVICE_FIELD, function (m, pre, v) {
        return /^<[A-Z]+(-[0-9a-f]+)?>$/.test(v.trim()) ? m : pre + (v[0] === '"' ? '"<DEVICE>"' : v[0] === "'" ? "'<DEVICE>'" : '<DEVICE>');
    });
    t = t.replace(DEVICE_OWNED, '<DEVICE>').replace(DEVICE_OF, '<DEVICE>');
    t = t.replace(LONG, function (m, pre, tok) { return random(tok) ? pre + '<TOKEN>' : m; });
    return t;
};

/* JSON text with each string scrubbed on its own (escaped quotes would
 * hide a value from the text's patterns), a name or secret field's value
 * replaced whole; null when text is not JSON. */
Scrubber.prototype.json = function (text) {
    var self = this, v;
    try { v = JSON.parse(text); } catch (e) { return null; }
    function walk(x, key) {
        if (typeof x === 'string') {
            return KEY_SSID.test(key) ? '<SSID>' : KEY_DEVICE.test(key) ? '<DEVICE>' : KEY_SECRET.test(key) ? '<SECRET>' : self.text(x);
        }
        if (Array.isArray(x)) return x.map(function (y) { return walk(y, key); });
        if (x && typeof x === 'object') {
            var o = {};
            Object.keys(x).forEach(function (k) { o[self.text(k)] = walk(x[k], k); });
            return o;
        }
        return x;
    }
    return JSON.stringify(walk(v, ''), null, /\n/.test(text.trim()) ? 1 : 0) + '\n';
};

/* Every file in from, scrubbed, into to (see the top). */
function scrubDir(from, to, budgetMs) {
    var t0 = Date.now(), left = [], s = new Scrubber(), names = [];
    try { names = fs.readdirSync(from).sort(); } catch (e) { /* nothing */ }
    var texts = {};
    try { s.learn(fs.readFileSync(r(CODING), 'latin1')); } catch (e) { /* no coding image */ }
    function read(n) {
        var st = fs.lstatSync(path.join(from, n));
        if (!st.isFile()) return null;
        var fd = fs.openSync(path.join(from, n), 'r');
        try {
            var b = Buffer.alloc(Math.min(st.size, SCRUB_FILE_MAX)), got = fs.readSync(fd, b, 0, b.length, 0);
            b = b.slice(0, got);
            if (b.indexOf(0) >= 0) throw new Error('not text');
            return { text: b.toString('utf8'), more: st.size > got };
        } finally { fs.closeSync(fd); }
    }
    names.forEach(function (n) {
        if (Date.now() - t0 > budgetMs) return;
        try { texts[n] = read(n); if (texts[n]) s.learn(texts[n].text); } catch (e) { texts[n] = { error: e.code || e.message }; }
    });
    names.forEach(function (n) {
        var src = texts[n];
        if (src === null) return;
        if (!src) { left.push(n + ': not scrubbed within ' + budgetMs / 1000 + ' s'); return; }
        if (src.error) { left.push(n + ': ' + src.error); return; }
        if (Date.now() - t0 > budgetMs) { left.push(n + ': not scrubbed within ' + budgetMs / 1000 + ' s'); return; }
        try {
            var out = /\.json$/.test(n) && !src.more ? s.json(src.text) : null;
            if (out === null) out = s.text(src.text) + (src.more ? '\n... (cut at ' + SCRUB_FILE_MAX + ' bytes)\n' : '');
            fs.writeFileSync(path.join(to, n), out, { mode: 0o640 });
        } catch (e) {
            try { fs.unlinkSync(path.join(to, n)); } catch (e2) { /* none */ }
            left.push(n + ': ' + (e.code || e.message));
        }
    });
    if (left.length) fs.writeFileSync(path.join(to, 'left-out.txt'), '-- left out of the archive, not scrubbed\n' + left.join('\n') + '\n', { mode: 0o640 });
}

if (require.main === module) {
    var cmd = process.argv[2], dir = process.argv[3];
    if (cmd === 'report' && dir) report(dir);
    else if (cmd === 'snapshot' && dir) snapshot(dir);
    else if (cmd === 'snapshot') snapshotInPlace();
    else if (cmd === 'patchd' && dir) patchdLogs(PATCHD_SOCK, path.join(dir, 'patchd-logs.json'), PATCHD_MS, function (e) { if (e) process.exit(1); });
    else if (cmd === 'incidents' && dir) fs.writeFileSync(path.join(dir, 'incidents.txt'), incidentsText(dir, Date.now()), { mode: 0o640 });
    else if (cmd === 'scrub' && dir && process.argv[4]) scrubDir(dir, process.argv[4], SCRUB_MS);
    else {
        process.stderr.write('usage: logs_extra.js report <dir> | snapshot [dir] | patchd <dir> | incidents <dir> | scrub <from> <to>\n');
        process.exit(2);
    }
}

module.exports = { scrub: scrub, readSource: readSource, redact: redact, report: report, snapshot: snapshot, CAP: CAP, ROWS: ROWS, ENTRIES: ENTRIES, SQLITE_MS: SQLITE_MS,
    Scrubber: Scrubber, scrubDir: scrubDir, incidentsText: incidentsText, patchdLogs: patchdLogs, PATCHD_MS: PATCHD_MS };
