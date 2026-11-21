// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* inmem.js — the carplay and aapd patches applied in memory (PATCH.md "In
 * memory"). /usr/bin/carplay and /usr/bin/aapd stay as they ship;
 * libwocpatch.so, preloaded into a start of the service the boot step
 * armed, applies the same edits to the process before the program's own
 * code runs.
 *
 * Per target <name> (carplay, aapd), on /var/opt (no remount of / for any
 * of it):
 *   inmem-<name>.plan    the plan (the patcher's `plan`): the build-id and,
 *                        per edit region, its address, stock and patched
 *                        bytes
 *   inmem-<name>.<key>   each copy the plan's program reads in place of a
 *                        file of its own (aapd: `conf`, aapd.conf with the
 *                        cluster geometry), written to its place in /run
 *                        when a start is armed
 *   inmem-<name>.json    the record: {v, enabled, target, ino, size, mtime,
 *                        sha256, build, planSha256, edits, args, writes,
 *                        rev, inputs, copies, proven, trial, at, and when
 *                        turned off by: "user" | "recovery" | "refused"
 *                        (recovery also fails, why)}
 *     It describes the target only while its inode, size and modification
 *     time are the recorded ones, those of each input (aapd.conf, which a
 *     copy is made from) too, and the plan and each copy only while their
 *     SHA-256 are. A plan that could not be made: {v, enabled, needsPlan,
 *     args, error}.
 *
 * In /run (gone at every head-unit start), written by arm() before the
 * service starts, only while the record is current and enabled:
 *   /run/woc-preload/<name>.plan    the plan, readable by the service's user
 *   /run/woc-preload/<name>.result  empty, owned by the service's user: the
 *                                   library writes its result there
 *   each copy at its place (aapd: /run/aapd.conf), readable by all
 *   /run/woc-preload/<name>.env     LD_PRELOAD (the unit's own preloads,
 *                                   then this version's library),
 *                                   WOC_PATCH_PLAN, WOC_PATCH_RESULT and
 *                                   WOC_PATCH_ID (the plan and copies it
 *                                   was armed with); written last. The
 *                                   tool's drop-in for the service reads
 *                                   it with EnvironmentFile=-, so without
 *                                   it the service starts stock.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var STATE_DIR = process.env.WOC_STATE_DIR || '/var/opt/waze-on-cluster';
var RUN_DIR = process.env.WOC_PRELOAD_DIR || '/run/woc-preload';
var LIB = process.env.WOC_PRELOAD_LIB || path.join(__dirname, 'libwocpatch.so');
var PROC = process.env.WOC_PROC || '/proc';
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';
var PASSWD = process.env.WOC_PASSWD || '/etc/passwd';

/* Each target: its unit, its program, the patcher that plans it, the files
 * besides the program a plan is made from (inputs), and the copies the
 * planned program reads in their place (copies: {key, run}, the patcher's
 * `--<key>-out`). */
var TARGETS = {
    carplay: { name: 'carplay', unit: 'carplay.service', target: process.env.WOC_CARPLAY || '/usr/bin/carplay', patcher: 'carplay_patch.js',
               inputs: [], copies: [] },
    aapd: { name: 'aapd', unit: 'aapd.service', target: process.env.WOC_AAPD || '/usr/bin/aapd', patcher: 'aapd_patch.js',
            inputs: [process.env.WOC_AAPD_CONF || '/etc/aapd.conf'],
            /* the path the plan's confpath edit names (aapd_locate.js CONF_RUN) */
            copies: [{ key: 'conf', run: process.env.WOC_AAPD_RUN_CONF || '/run/aapd.conf' }] },
};

function paths(name) {
    return {
        record: path.join(STATE_DIR, 'inmem-' + name + '.json'),
        armError: path.join(STATE_DIR, 'inmem-' + name + '.armerror'),
        plan: path.join(STATE_DIR, 'inmem-' + name + '.plan'),
        copies: TARGETS[name].copies.map(function (c) { return { key: c.key, state: path.join(STATE_DIR, 'inmem-' + name + '.' + c.key), run: c.run }; }),
        env: path.join(RUN_DIR, name + '.env'),
        runPlan: path.join(RUN_DIR, name + '.plan'),
        result: path.join(RUN_DIR, name + '.result'),
    };
}

/* What a start armed with rec runs: the plan and each copy, as one id
 * (WOC_PATCH_ID in the env file). */
function patchId(rec) {
    var c = rec.copies || {};
    return sha256(Buffer.from(rec.planSha256 + Object.keys(c).sort().map(function (k) { return ' ' + k + '=' + c[k]; }).join('')));
}

function statOf(f) {
    try { var st = fs.statSync(f); return { file: f, ino: st.ino, size: st.size, mtime: st.mtime.getTime() }; } catch (e) { return null; }
}
function sameStat(a, b) { return !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime; }

/* The folder, made where it is missing (Node 8: no recursive mkdir). */
function ensureDir(d) {
    try { fs.mkdirSync(d, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readOr(f, enc) { try { return fs.readFileSync(f, enc); } catch (e) { return null; } }

function fsyncPath(p) {
    var fd = fs.openSync(p, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/* Writes data to file whole: a temporary file, fsynced, renamed, the folder
 * synced. Throws when it cannot; the previous file then stays. */
function writeWhole(file, data, mode) {
    var tmp = file + '.tmp';
    try {
        fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
        fs.chmodSync(tmp, mode || 0o644);
        fsyncPath(tmp);
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        throw e;
    }
    try { fsyncPath(path.dirname(file)); } catch (e) {}
}

/* The record as written, or null. */
function readRecord(name) {
    var r = null;
    try { r = JSON.parse(fs.readFileSync(paths(name).record, 'utf8')); } catch (e) { return null; }
    return r && typeof r === 'object' && r.v === 1 ? r : null;
}

/* Whether the record describes the target and its inputs as they are now,
 * and the plan and copies on /var/opt are the ones it names. */
function describes(name, rec) {
    var st, t = TARGETS[name], p = paths(name), plan = readOr(p.plan);
    try { st = fs.statSync(t.target); } catch (e) { return false; }
    if (!rec || rec.ino !== st.ino || rec.size !== st.size || rec.mtime !== st.mtime.getTime() || !plan || sha256(plan) !== rec.planSha256) return false;
    var ins = rec.inputs || [];
    if (ins.length !== t.inputs.length || t.inputs.some(function (f, i) { return !ins[i] || ins[i].file !== f || !sameStat(ins[i], statOf(f)); })) return false;
    return p.copies.every(function (c) { var b = readOr(c.state); return !!b && !!rec.copies && sha256(b) === rec.copies[c.key]; });
}

/* The record while it describes the target and is enabled, else null. */
function current(name) {
    var rec = readRecord(name);
    return rec && rec.enabled === true && describes(name, rec) ? rec : null;
}

/* What boot recovery counts the patch as: 'proven', 'unproven' (on trial,
 * or a build outside the proven list or a car coded otherwise), or null
 * when nothing is to be armed. */
function kind(name) {
    var rec = current(name);
    return !rec ? null : rec.proven === true && rec.trial !== true ? 'proven' : 'unproven';
}

/* The record with fields merged in, written whole. Throws. */
function update(name, fields) {
    var rec = readRecord(name);
    if (!rec) throw new Error('no in-memory record for ' + name);
    writeWhole(paths(name).record, JSON.stringify(Object.assign(rec, fields)) + '\n');
    return rec;
}

/* Whether the patcher's error words are a refusal of the file (not
 * patchable, not the pristine build, not a proven build, the head unit, the
 * coding), as opposed to a failure a later try may not meet (the file
 * unreadable, the coding not published yet, a check of the plan itself). */
function refusal(words) {
    return /^refusing: (?!the edited image|the plan does not|the cluster coding cannot be read)/.test(words) ||
        /in memory needs the pristine build|is not a proven build/.test(words);
}

/* Makes the plan for the target as it is on disk (its patcher's `plan`,
 * the same checks as the edits it plans), and on success writes it, with
 * each copy, and a record, enabled. cb(err, rec): err.refused with the
 * patcher's own words when it refuses the file (a conflict, not a
 * failure). */
function makePlan(name, args, timeoutMs, cb) {
    var t = TARGETS[name], p = paths(name), tmp = p.plan + '.new.' + process.pid, st0, from = t.target, in0;
    var copyTmp = p.copies.map(function (c) { return c.state + '.new.' + process.pid; });
    function cleanup() { [tmp].concat(copyTmp).forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} }); }
    try { st0 = fs.statSync(from); ensureDir(STATE_DIR); } catch (e) { cb(e); return; }
    in0 = t.inputs.map(statOf);
    var copyArgs = [];
    p.copies.forEach(function (c, i) { copyArgs.push('--' + c.key + '-out', copyTmp[i]); });
    cp.execFile(process.execPath, [path.join(__dirname, t.patcher), 'plan', '--target', from, '--out', tmp].concat(copyArgs, args),
        { timeout: timeoutMs || 60000 }, function (err, out, errOut) {
        var m = /^error: (.*)$/m.exec((errOut || '') + ''), sum = null;
        if (err) {
            cleanup();
            var e = new Error(m ? m[1] : err.message);
            if (m && refusal(m[1])) e.refused = m[1];
            cb(e);
            return;
        }
        try { sum = JSON.parse(((out || '') + '').trim().split('\n').pop()); } catch (e2) { cleanup(); cb(new Error('plan: no summary')); return; }
        var st1, in1 = t.inputs.map(statOf);
        try { st1 = fs.statSync(from); } catch (e3) { cleanup(); cb(e3); return; }
        if (st1.ino !== st0.ino || st1.size !== st0.size || st1.mtime.getTime() !== st0.mtime.getTime() ||
            in1.some(function (x, i) { return !sameStat(x, in0[i]); })) {
            cleanup();
            cb(new Error(from + (t.inputs.length ? ' or ' + t.inputs.join(', ') : '') + ' changed while the plan was made'));
            return;
        }
        var copies = {}, inputs = in1.map(function (x, i) { return Object.assign(x, { sha256: sum.inputs ? sum.inputs[Object.keys(sum.inputs)[i]] : null }); });
        try { p.copies.forEach(function (c, i) { copies[c.key] = sha256(fs.readFileSync(copyTmp[i])); }); } catch (e5) { cleanup(); cb(e5); return; }
        if (p.copies.some(function (c) { return !sum.copies || sum.copies[c.key] !== copies[c.key]; })) { cleanup(); cb(new Error('plan: a copy does not match its summary')); return; }
        var prior = readRecord(name);
        var same = !!prior && prior.planSha256 === sum.planSha256 && prior.ino === st1.ino && prior.mtime === st1.mtime.getTime() &&
            JSON.stringify(prior.copies || {}) === JSON.stringify(copies);
        /* Proven carries over only from a patch that ran healthy here and is
         * on, or that the user turned off (Remove patch); one boot recovery
         * turned off goes on trial again. */
        var proven = sum.provenBuild && sum.coding === 'ok' && ((same && prior.proven === true && prior.trial !== true &&
            (prior.enabled === true || prior.by === 'user')));
        var onTrial = !proven && sum.provenBuild && sum.coding !== 'refused';
        var rec = { v: 1, enabled: true, target: t.target, ino: st1.ino, size: st1.size, mtime: st1.mtime.getTime(), sha256: sum.sha256,
            build: sum.build, version: sum.version, planSha256: sum.planSha256, edits: sum.edits, writes: sum.writes, args: args,
            inputs: inputs, copies: copies, proven: proven, trial: onTrial, at: new Date().toISOString() };
        if (sum.rev) rec.rev = sum.rev;
        try {
            var text = fs.readFileSync(tmp);
            fsyncPath(tmp);
            p.copies.forEach(function (c, i) { fsyncPath(copyTmp[i]); fs.renameSync(copyTmp[i], c.state); });
            fs.renameSync(tmp, p.plan);
            writeWhole(p.record, JSON.stringify(rec) + '\n');
            /* All read back as written, or nothing is relied on. */
            if (!fs.readFileSync(p.plan).equals(text) || sha256(text) !== rec.planSha256 || JSON.stringify(readRecord(name)) !== JSON.stringify(rec) ||
                p.copies.some(function (c) { return sha256(fs.readFileSync(c.state)) !== copies[c.key]; }))
                throw new Error('the plan, a copy or its record does not read back as written');
        } catch (e4) { cleanup(); cb(e4); return; }
        cb(null, rec);
    });
}

/* An enabled record whose file was written again with the same bytes (a
 * stray patch of the file that boot recovery put back, a restore of the
 * same file) describes it again once the target holds exactly the bytes
 * the plan was made from (their SHA-256): the stat it then has is recorded.
 * Root only (boot recovery, patchd). true when the record describes the
 * target after the call. */
function adopt(name) {
    var rec = readRecord(name), t = TARGETS[name];
    if (!rec || rec.enabled !== true || !rec.planSha256 || describes(name, rec)) return !!rec && describes(name, rec);
    var plan = readOr(paths(name).plan), buf, st;
    if (!plan || sha256(plan) !== rec.planSha256) return false;
    try { st = fs.statSync(t.target); buf = fs.readFileSync(t.target); } catch (e) { return false; }
    if (buf.length !== rec.size || sha256(buf) !== rec.sha256) return false;
    /* Each input holding the bytes the plan was made from, by its SHA-256. */
    var ins = (rec.inputs || []).map(function (x) {
        var now = statOf(x.file), b = readOr(x.file);
        return now && b && x.sha256 && sha256(b) === x.sha256 ? Object.assign({}, x, { ino: now.ino, size: now.size, mtime: now.mtime }) : x;
    });
    try { update(name, { ino: st.ino, mtime: st.mtime.getTime(), inputs: ins }); } catch (e) { return false; }
    return describes(name, readRecord(name));
}

/* A plan that could not be made: the record keeps the arguments and why,
 * enabled, with no plan, so nothing is armed and the next try (the
 * watcher at the next head-unit start, the Patch button) plans it. */
function planFailed(name, args, why) {
    var t = TARGETS[name], p = paths(name);
    /* A plan left that cannot be removed is never used: the record names no plan. */
    try { fs.unlinkSync(p.plan); } catch (e) {}
    ensureDir(STATE_DIR);
    writeWhole(p.record, JSON.stringify({ v: 1, enabled: true, needsPlan: true, target: t.target, args: args, error: why, at: new Date().toISOString() }) + '\n');
}

/* Turns the patch off for later starts: the record enabled false with why
 * (fields: {by, ...}). The running process keeps what it applied until it
 * ends; disarm() keeps the next start of this boot stock. Throws. */
function disable(name, fields) {
    var rec = readRecord(name);
    if (!rec) return null;
    return update(name, Object.assign({ enabled: false, at: new Date().toISOString() }, fields));
}

/* Removes the record, the plan and this boot's files in RUN_DIR (a
 * removal of the tool). */
function remove(name) {
    var p = paths(name);
    /* A copy in /run stays: the running program may read it again until it
     * ends, and /run is empty at the next head-unit start. */
    [p.record, p.plan, p.record + '.tmp', p.armError, p.env, p.runPlan, p.result].concat(p.copies.map(function (c) { return c.state; })).forEach(function (f) {
        try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    });
    try { fs.rmdirSync(RUN_DIR); } catch (e) {}
}

/* The LD_PRELOAD the unit sets itself (carplay.service's and aapd.service's
 * Environment=, BMW's libschedconfig), kept in front of ours. */
function unitPreload(unit) {
    var out = '';
    try { out = cp.execFileSync(SYSTEMCTL, ['show', unit, '-p', 'Environment'], { timeout: 10000, encoding: 'utf8' }); } catch (e) { return null; }
    var m = /(?:^Environment=|\s)LD_PRELOAD=(\S+)/m.exec(out);
    return m ? m[1] : '';
}

function unitUser(unit) {
    var out = '';
    try { out = cp.execFileSync(SYSTEMCTL, ['show', unit, '-p', 'User'], { timeout: 10000, encoding: 'utf8' }); } catch (e) { return null; }
    var m = /^User=(\S+)/m.exec(out);
    return m ? m[1] : null;
}

function uidOf(user) {
    var lines = (readOr(PASSWD, 'utf8') || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].split(':');
        if (f[0] === user && f.length > 3) return { uid: parseInt(f[2], 10), gid: parseInt(f[3], 10) };
    }
    return null;
}

/* Whether this boot's next start is armed with the current plan and this
 * version's library. */
function armed(name) {
    var rec = current(name), p = paths(name), plan = readOr(p.runPlan), env = readOr(p.env, 'utf8');
    return !!rec && !!env && !!plan && sha256(plan) === rec.planSha256 && env.split('\n')[0].split(/[=\s]/).indexOf(LIB) >= 0 &&
        env.split('\n').indexOf('WOC_PATCH_ID=' + patchId(rec)) >= 0 &&
        p.copies.every(function (c) { var b = readOr(c.run); return !!b && sha256(b) === rec.copies[c.key]; });
}

/* Why the last arm failed (kept on /var/opt for the status), or null. */
function armError(name) { return readOr(paths(name).armError, 'utf8'); }

/* Arms the service's next starts this boot: the plan, the result file and
 * last the env file in RUN_DIR. Nothing when the record is not current or
 * enabled, or this boot is armed with it already (the result of a run is
 * kept). {armed: true} or {armed: false, why}. Never throws. */
function arm(name, opts) {
    opts = opts || {};
    var t = TARGETS[name], p = paths(name), rec = current(name);
    if (!rec) return { armed: false, why: 'no enabled in-memory patch for ' + t.target + ' as it is' };
    if (armed(name)) return { armed: true, already: true };
    /* Armed with this plan, the library path aside (an update in this boot):
     * only the env file is written again, so a run's result is kept. */
    var plan0 = readOr(p.runPlan), keepResult = !!plan0 && sha256(plan0) === rec.planSha256 && !!readOr(p.result);
    try {
        if (!fs.existsSync(LIB)) throw new Error(LIB + ' missing');
        var pre = opts.preload !== undefined ? opts.preload : unitPreload(t.unit);
        if (pre === null) throw new Error('cannot read ' + t.unit + '\'s environment');
        if (/\s/.test(LIB)) throw new Error('unusable preload path ' + LIB);
        pre = pre.split(/[\s:]+/).filter(function (x) { return x && x !== LIB; }).join(' ');
        var user = opts.user !== undefined ? opts.user : unitUser(t.unit), ids = user ? uidOf(user) : null;
        if (!ids) throw new Error('no user for ' + t.unit);
        try { fs.mkdirSync(RUN_DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        var rd = fs.lstatSync(RUN_DIR);
        if (!rd.isDirectory() || rd.uid !== (process.getuid ? process.getuid() : rd.uid)) throw new Error(RUN_DIR + ' is not our folder');
        fs.chmodSync(RUN_DIR, 0o755);
        /* Each copy at its place, before the env file names the plan that
         * points the program at it. A copy a running program reads is
         * replaced whole, by rename. */
        p.copies.forEach(function (c) {
            var b = fs.readFileSync(c.state);
            if (sha256(b) !== rec.copies[c.key]) throw new Error(c.state + ' is not the copy the plan was made with');
            var have = readOr(c.run);
            if (!have || !have.equals(b)) writeWhole(c.run, b, 0o644);
        });
        if (!keepResult) {
            writeWhole(p.runPlan, fs.readFileSync(p.plan), 0o644);
            try { fs.unlinkSync(p.result); } catch (e) {}
            var fd = fs.openSync(p.result, 'wx', 0o644);
            fs.closeSync(fd);
            fs.chmodSync(p.result, 0o644);
            if (process.getuid && process.getuid() === 0) fs.chownSync(p.result, ids.uid, ids.gid);
        }
        writeWhole(p.env, 'LD_PRELOAD=' + (pre ? pre + ' ' : '') + LIB + '\nWOC_PATCH_PLAN=' + p.runPlan + '\nWOC_PATCH_RESULT=' + p.result +
            '\nWOC_PATCH_ID=' + patchId(rec) + '\n', 0o644);
        try { fs.unlinkSync(p.armError); } catch (e) {}
        return { armed: true };
    } catch (e) {
        disarm(name);
        try { ensureDir(STATE_DIR); writeWhole(p.armError, e.message + '\n'); } catch (e2) {}
        return { armed: false, why: e.message };
    }
}

/* The next start runs stock: the env file goes first. Never throws;
 * false when it could not be removed. */
function disarm(name) {
    var p = paths(name), ok = true;
    [p.env, p.runPlan].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') ok = false; } });
    return ok;
}

/* The WOC_PATCH_ID the process pid was started with (/proc/<pid>/environ,
 * root): the plan and copies of the start that armed it, or null for a
 * start no arm named (stock) or one that cannot be read. */
function runningId(pid) {
    var env = readOr(path.join(PROC, String(pid), 'environ'), 'latin1');
    if (env === null) return null;
    var m = /(?:^|\0)WOC_PATCH_ID=([0-9a-f]{64})(?:\0|$)/.exec(env);
    return m ? m[1] : null;
}

/* Whether the process pid runs the record's patch: its memory holds the
 * plan at every site and it was started with the record's plan and copies.
 * null when that cannot be read. */
function runsCurrent(name, pid) {
    var rec = readRecord(name), mem = rec ? memState(name, pid) : null;
    if (!rec || mem === null) return null;
    return mem === 'patched' && runningId(pid) === patchId(rec);
}

/* The library's result of this boot: {pid, applied, edits, why}, or null. */
function result(name) {
    var r = null;
    try { r = JSON.parse(fs.readFileSync(paths(name).result, 'utf8')); } catch (e) { return null; }
    return r && r.v === 1 ? r : null;
}

/* The plan's edits ([{name, va, stock, patched}]), or null. */
function planEdits(text) {
    var p = require('./carplay_patch.js').parsePlan(text);
    return p.err ? null : p.edits;
}

/* What the process pid holds at the plan's sites, read from
 * /proc/<pid>/mem (root, read-only): 'patched' (every site), 'stock'
 * (every site), 'mixed', or null when it cannot be read. The base is the
 * first mapping, at file offset 0, of the file the process runs: its
 * /proc/<pid>/exe, or (a binary translator's exe) the target or a file a
 * change replaced while it ran (<target>.woc-running*). */
function memState(name, pid, planText) {
    var t = TARGETS[name], edits = planEdits(planText || readOr(paths(name).plan, 'utf8') || '');
    if (!edits || !(pid > 0)) return null;
    var inodes = [], exe = path.join(PROC, String(pid), 'exe'), exeName = '';
    try { exeName = path.basename(fs.readlinkSync(exe)); } catch (e) {}
    [exeName.indexOf(path.basename(t.target)) === 0 ? exe : null, t.target, t.target + '.woc-running', t.target + '.woc-running.1', t.target + '.woc-running.2'].forEach(function (f) {
        if (f) try { inodes.push(fs.statSync(f).ino); } catch (e) {}
    });
    var maps = readOr(path.join(PROC, String(pid), 'maps'), 'utf8');
    if (!maps) return null;
    var base = null;
    maps.split('\n').some(function (l) {
        var f = l.split(/\s+/);
        if (f.length < 6 || parseInt(f[2], 16) !== 0 || inodes.indexOf(Number(f[4])) < 0) return false;
        base = parseInt(f[0].split('-')[0], 16);
        return true;
    });
    if (base === null) return null;
    /* A region the plan leaves as it ships (the sink in the avb mode) must
     * read so either way: a process running another mode's sink is
     * neither. */
    var fd, seen = { patched: 0, stock: 0, other: 0 }, changed = 0;
    try {
        fd = fs.openSync(path.join(PROC, String(pid), 'mem'), 'r');
        edits.forEach(function (e) {
            var b = Buffer.alloc(e.stock.length);
            fs.readSync(fd, b, 0, b.length, base + e.va);
            if (e.stock.equals(e.patched)) { if (!b.equals(e.stock)) seen.other++; return; }
            changed++;
            seen[b.equals(e.patched) ? 'patched' : b.equals(e.stock) ? 'stock' : 'other']++;
        });
    } catch (e) { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
    return seen.other ? 'mixed' : seen.patched === changed ? 'patched' : seen.stock === changed ? 'stock' : 'mixed';
}

module.exports = {
    TARGETS: TARGETS, paths: paths, readRecord: readRecord, current: current, kind: kind, describes: describes, update: update,
    makePlan: makePlan, refusal: refusal, armError: armError, adopt: adopt, planFailed: planFailed, disable: disable, remove: remove, arm: arm, armed: armed, disarm: disarm, result: result, memState: memState,
    patchId: patchId, runningId: runningId, runsCurrent: runsCurrent,
    LIB: LIB, RUN_DIR: RUN_DIR,
};
