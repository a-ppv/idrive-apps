#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Copyright (C) 2026 mlurker@gmail.com
/* aapd_patch.js — the Android Auto patch: four edits to the Android Auto
 * Projected Daemon (/usr/bin/aapd), its config path, and the cluster
 * geometry of its aapd.conf (aapd_conf.js), which together make Google Maps
 * send its cluster view to the stream waze-on-cluster shows (PATCH.md
 * "Android Auto"). They are applied in aapd's memory (PATCH.md "In
 * memory"): /usr/bin/aapd and /etc/aapd.conf stay as they ship.
 *
 *   gate       `cmp dword [rbx+0x21c],1 ; setbe al` in secondVideoEnabled()
 *              (featureFlag && KombiVariant <= 1): the immediate 1 -> 2.
 *              aapd maps raw KI_KOMBI_VARIANT 9 -> 0, 10 -> 1, 1..8 and
 *              11 -> 2, 0 -> 3, so this admits every raw value of class 2;
 *              the plan refuses unless the coding is the proven 7.
 *   selfstart  onNewNavigationStatus()'s call of setNaviStreamStatus
 *              retargeted to requestStream() (same `this`), and
 *              requestStream()'s opening test, `not streaming && focus mode
 *              native`, made `cluster display ready && not streaming`: aapd
 *              starts the cluster stream itself on the phone's navigation
 *              status, once the phone has set up its cluster display. Its
 *              SetVideoFocus() throws on a Cinemo error, and nothing catches
 *              that, so the request must wait for the display as the car's
 *              own request does.
 *   screen     the KombiVariant -> screen-size helper's fall-through: class 2
 *              reads 12.3 as class 0 does, so aapd uses aapd.conf's 12.3
 *              geometry instead of its built-in 800x480 default.
 *   confpath   the path aapd reads its configuration from, /etc/aapd.conf,
 *              made /run/aapd.conf: a copy of aapd.conf with the cluster
 *              geometry, which boot recovery writes there for a start it
 *              arms (inmem.js).
 *
 * The sites are found in each build by aapd_locate.js; a build where any of
 * them is not found is refused. `plan` reads aapd on disk, which must be
 * the pristine build (a build on the proven list, by build-id, needs the
 * whole file to be the shipped one; any other build needs --unproven), and
 * aapd.conf, which must have the entries the geometry needs and hold none of
 * our geometries (aapd_conf.js check); it writes the plan libwocpatch.so
 * applies and the copy of aapd.conf the plan points aapd at. `overlay`
 * reads aapd with a plan laid over it. This version writes aapd and
 * aapd.conf only to put back a patch an earlier release wrote into them
 * (`revert`): from backups trusted by the recorded SHA-256, or, without
 * them, the proven files' own shipped content; revert needs no locator.
 * plan is refused on a head unit that refuses our parts (head_unit.js);
 * revert works on any.
 *
 *   aapd_patch.js status  [--target <aapd>] [--conf <aapd.conf>] [--coding <shm>]
 *   aapd_patch.js probe   [<file>] [--target <aapd>]
 *   aapd_patch.js plan    --out <plan> --conf-out <aapd.conf copy> [--dpi <n>] [--card shown|hidden] [--target ...] [--conf ...] [--coding ...] [--unproven]
 *   aapd_patch.js overlay --plan <plan> [--conf-copy <file>] [--target ...] [--conf ...]
 *   aapd_patch.js revert  [--target ...] [--conf ...] [--yes] [--force] [--drop-backup]
 *
 * Every write is an atomic rename. A revert takes effect when aapd next
 * starts; each file keeps its original's owner and mode, aapd executable and
 * aapd.conf readable by aapd.service's user (file_mode.js). status, probe,
 * plan and overlay only read aapd and aapd.conf.
 * Node 8 on the unit, no dependencies. */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var path = require('path');
var cp = require('child_process');
var conf = require('./aapd_conf.js');
var locator = require('./aapd_locate.js');
var cpLocate = require('./carplay_locate.js'), buildId = cpLocate.buildId;
var headUnit = require('./head_unit.js');
var record = require('./patch_record.js');
var fileMode = require('./file_mode.js');

/* Builds proven as shipped, by GNU build-id: aapd 22.39.3 of MGU
 * P18_23w44.2-1-3. A first edit of one needs the whole file to be the
 * shipped one, and anything else counts as modified. A first edit of any
 * other build needs --unproven: its sites pass the locator's checks, but no
 * car has run it patched. */
var PROVEN = {
    '2dfb9881706bff435b05f621486e8eb8b6c55984': {
        version: 'aapd 22.39.3+gitrAUTOINC+d5a1db18c4-r0',
        sha256: '6880f54c3abba40c1368f2bf254c77bd4a169323c0d4cab8f9662a7c912dcf89',
        stock: [[0x998bd, '83bb1c02000001'], [0x1d43eb, 'e800f8ffff'], [0x1d3f53, '837b3802740a837b44020f848d000000'], [0x15b440, '660fefc0ebe1662e0f1f840000000000']],
    },
};

/* The locator's edits and their names on the status lines: the four an
 * earlier release also wrote to the file, then the config path, which only
 * the patch in memory writes. */
var EDITS = [['gate', 'gate'], ['call', 'selfstart call'], ['guard', 'selfstart guard'], ['screen', 'screen']];
var SITES = EDITS.concat([['confpath', 'confpath']]);
/* The most bytes aapd may differ in from its backup and still be its build:
 * the edits' bytes (gate 7, call 5, guard 16, screen at most 16), twice
 * over. */
var SAME_BUILD_MAX_DIFF = 2 * (7 + 5 + 16 + 16);
/* The patch's revision, kept in the plan's record (inmem.js) and in an
 * earlier release's patch record. Boot recovery keeps it when it turns a
 * patch off, and an install applies again a patch boot recovery turned off
 * only when this revision is newer than the turned-off one (patchd.js). 2:
 * requestStream goes ahead only while the phone's cluster display is set
 * up. */
var PATCH_REV = 2;

/* /dev/shm/rawcodingdata, the coding image CodingShmApp publishes: a 0x2c
 * byte header (flags at 0x28, 0x09 = valid coding) and the blocks. aapd's
 * and carplay's CodingKOMBI_HUD is the 150 bytes at block offset 0x75a;
 * KI_KOMBI_VARIANT is getBits(0, 0x7e, 1) of it. carplay_patch.js reads
 * it through readCoding too. */
var CODING = { size: 0x1030, flags: 0x28, valid: 0x09, at: 0x2c + 0x75a, mask: 0x7e, shift: 1, proven: 7 };

var hashes = new WeakMap();
function sha256(buf) {
    if (!hashes.has(buf)) hashes.set(buf, crypto.createHash('sha256').update(buf).digest('hex'));
    return hashes.get(buf);
}
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }
function backupPath(t) { return t + '.woc-orig'; }
function metaPath(t) { return t + '.woc-orig.json'; }
function readOr(p) { try { return fs.readFileSync(p); } catch (e) { return null; } }

/* {variant} or {err}. */
function readCoding(p) {
    var b = readOr(p);
    if (!b) return { err: p + ' unreadable' };
    if (b.length !== CODING.size) return { err: p + ' is ' + b.length + ' bytes, not ' + CODING.size };
    if ((b[CODING.flags] & 0x0f) !== CODING.valid) return { err: 'coding not valid (flags 0x' + b[CODING.flags].toString(16) + ')' };
    return { variant: (b[CODING.at] & CODING.mask) >> CODING.shift };
}

/* Why a coding readCoding read ({variant} or {err}) is not the proven one,
 * or null. */
function codingRefusal(cd) {
    return cd.err ? 'the cluster coding cannot be read (' + cd.err + ')'
        : cd.variant !== CODING.proven ? 'KI_KOMBI_VARIANT ' + cd.variant + ' is not the proven cluster coding (' + CODING.proven + ')' : null;
}

/* The located binary: { loc, size, sha256, bad: [why an edit is not
 * found] }, once per content. A locator failure is a reason like any
 * other, so a revert never depends on it. */
var classified = {};
function classify(buf) {
    var h = sha256(buf);
    if (!classified[h]) {
        var loc, bad = [];
        try { loc = locator.locate(buf); } catch (e) {
            loc = { elf: false, buildId: null, version: null, reason: 'locator failed: ' + e.message };
            EDITS.forEach(function (x) { loc[x[0]] = { ok: false, reason: loc.reason }; });
        }
        if (!loc.elf) bad.push(loc.reason);
        else EDITS.forEach(function (e) { if (!loc[e[0]].ok && bad.indexOf(loc[e[0]].reason) < 0) bad.push(loc[e[0]].reason); });
        /* inMem: why the patch in memory cannot be planned for it, the
         * config path included */
        var inMem = bad.slice();
        if (loc.elf && (!loc.confpath || !loc.confpath.ok)) inMem.push(loc.confpath ? loc.confpath.reason : 'config path: not located');
        classified[h] = { loc: loc, size: buf.length, sha256: h, bad: bad, inMem: inMem };
    }
    return classified[h];
}

/* The byte ranges the edits write: [[offset, length]]. */
function regions(loc) { return EDITS.map(function (e) { return [loc[e[0]].offset, loc[e[0]].len]; }); }

/* Two classified images are the same build: the same size, build-id and
 * edit sites. */
function sameBuild(a, b) {
    return !a.bad.length && !b.bad.length && a.size === b.size && a.loc.buildId === b.loc.buildId &&
        JSON.stringify(regions(a.loc)) === JSON.stringify(regions(b.loc));
}

/* Why the image is not the pristine build, or null: an edit not found or
 * present, or for a proven build any byte not as shipped. */
function notPristine(c) {
    if (c.bad.length) return c.bad[0];
    var edited = EDITS.filter(function (e) { return c.loc[e[0]].state !== 'original'; });
    if (edited.length) return edited.map(function (e) { return e[1]; }).join(', ') + ' edited';
    var proven = PROVEN[c.loc.buildId];
    return proven && c.sha256 !== proven.sha256 ? 'sha256 ' + proven.sha256 + ', got ' + c.sha256 : null;
}

function label(c) {
    var proven = PROVEN[c.loc.buildId];
    return proven ? proven.version : c.loc.buildId ? 'build ' + c.loc.buildId : 'build without a build-id';
}

/* The backup with its record, trusted by the recorded SHA-256: {buf, meta}
 * or {err}; null when there is no backup. */
function trusted(file) {
    var buf = readOr(backupPath(file));
    if (!buf) return null;
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(file), 'utf8')); } catch (e) {}
    if (!meta || !meta.sha256_original) return { err: 'backup ' + backupPath(file) + ' has no record' };
    if (sha256(buf) !== meta.sha256_original) return { err: 'backup sha256 ' + sha256(buf) + ' != recorded ' + meta.sha256_original };
    return { buf: buf, meta: meta };
}

function binOther(cur, orig) {
    if (cur.length !== orig.length) return 'its size differs';
    var a = buildId(cur), b = buildId(orig);
    if (a && b) return a === b ? null : 'its build-id differs';
    for (var i = 0, n = 0; i < cur.length; i++) if (cur[i] !== orig[i] && ++n > SAME_BUILD_MAX_DIFF) return 'more than ' + SAME_BUILD_MAX_DIFF + ' bytes differ';
    return null;
}

/* What a revert writes over `cur` from its backup `b` (trusted()): {out,
 * other} or {err}; null without a backup. The binary: when the locator
 * reads it and its pristine backup as the same build, only the edits' bytes
 * (another tool's changes stay), else the whole backup. */
function restorePlan(b, cur, isBin) {
    if (!b || b.err) return b;
    if (!cur) return { out: b.buf, other: 'it is missing' };
    var other = isBin ? binOther(cur, b.buf) : conf.otherFile(cur.toString('utf8'), b.buf.toString('utf8'));
    var out = b.buf;
    if (isBin && !other) {
        var cc = classify(cur), bc = classify(b.buf);
        if (!notPristine(bc) && sameBuild(cc, bc)) {
            out = Buffer.from(cur);
            regions(cc.loc).forEach(function (r) { b.buf.copy(out, r[0], r[0], r[0] + r[1]); });
        }
    }
    return { out: out, other: other };
}

function oursIn(c) { return EDITS.some(function (e) { return c.loc[e[0]].ok && (c.loc[e[0]].state === 'patched' || c.loc[e[0]].state === 'outdated'); }); }

/* Each file's undo as it stands, aapd then aapd.conf: { file, cur, b (its
 * backup), p (the restore plan), floor (the bits aapd.service's user needs,
 * file_mode.js), modeBad (the file is exactly its trusted backup of ours
 * but lacks those bits; without a backup of ours its mode is left) },
 * each file read once; `bin`, when given, is aapd as already read. Without
 * a backup to trust, a proven aapd holding an edit of ours, or the proven
 * aapd.conf holding a geometry of ours, is rebuilt from its own content
 * (the shipped file is its own original); anything else of it is left as
 * it is. */
function undos(t, bin) {
    return [[t.target, true], [t.conf, false]].map(function (f) {
        var cur = f[1] && bin ? bin : readOr(f[0]), b = trusted(f[0]), p = restorePlan(b, cur, f[1]);
        if ((!p || p.err) && cur) {
            var so = f[1] ? cpLocate.stockOriginal(PROVEN, cur) : conf.stockOriginal(cur.toString('utf8'));
            if (so && f[1] && !so.equals(cur) && !oursIn(classify(cur))) so = null;
            if (so) p = { out: f[1] ? so : Buffer.from(so, 'utf8'), other: null, stock: true };
        }
        var floor = f[1] ? fileMode.EXEC : fileMode.READ, orig = p && !p.err && !p.other && !p.stock ? b.buf : null;
        return { file: f[0], cur: cur, b: b, p: p, floor: floor, modeBad: !!cur && !!orig && cur.equals(orig) && fileMode.lacks(f[0], floor) };
    });
}

/* Why the revert would not change anything, or null when it would. */
function notRestorable(us) {
    var bad = [], any = false;
    us.forEach(function (u) {
        if (!u.p) return;
        if (u.p.err) bad.push(u.p.err);
        else if (u.p.other) bad.push(path.basename(u.file) + ' is another build than its backup: ' + u.p.other);
        else if (!u.cur || !u.p.out.equals(u.cur) || u.modeBad) any = true;
    });
    return any ? null : bad.length ? bad.join('; ') : 'nothing of ours to undo';
}

/* What undoing one file would find: none (no backup of ours, not a proven
 * file), untrusted (a backup whose record does not vouch for it), other
 * (another build than the backup), original (nothing to restore) or
 * restorable (its bytes, or the original's mode). */
function undoState(u) {
    return !u.p ? 'none' : u.p.err ? 'untrusted' : u.p.other ? 'other' : u.cur && u.p.out.equals(u.cur) && !u.modeBad ? 'original' : 'restorable';
}
function undoLine(us) { return 'aapd ' + undoState(us[0]) + ', aapd.conf ' + undoState(us[1]); }

function fsyncFile(p) {
    var fd = fs.openSync(p, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/* file's mode and owner (file_mode.js): its original's, recorded with the
 * backup, with at least floor's bits. */
function wantedMode(file, floor) {
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(file), 'utf8')); } catch (e) {}
    return fileMode.wanted(file, meta, floor);
}

function writeInPlace(target, buf, floor) {
    try { fileMode.replace(target, buf, wantedMode(target, floor)); } catch (e) { die('writing ' + target + ': ' + e.message); }
    if (!fs.readFileSync(target).equals(buf)) die('post-write verification failed: ' + target + '; restore from ' + backupPath(target));
}

/* Each of files ([file, floor]) that aapd.service's user cannot use given
 * its original's mode and owner, with --yes; files holding bytes this tool
 * did not write are the caller's to leave out. */
function repairModes(files, yes) {
    files.forEach(function (f) {
        if (!fileMode.lacks(f[0], f[1])) return;
        var want = wantedMode(f[0], f[1]), fix = fileMode.mismatch(f[0], want);
        if (!yes) die(f[0] + ' has ' + fix + '; pass --yes to set them');
        try { fileMode.repair(f[0], want); } catch (e) { die('setting ' + f[0] + '\'s mode and owner: ' + e.message); }
        process.stdout.write('set ' + f[0] + '\'s mode and owner (it had ' + fix + ')\n');
    });
}

/* Why aapd.conf without a backup of ours cannot be taken as its original,
 * or null: it lacks what the edit needs, or it already holds a geometry of
 * ours. */
function confNotOriginal(text) {
    return conf.check(text) || (conf.edited(text, text) ? 'it holds our geometry without our backup' : null);
}

function geometryText(cur, b) {
    if (!cur) return 'MISSING';
    var text = cur.toString('utf8');
    if (!b || b.err) { var why = confNotOriginal(text); return why ? 'UNKNOWN (' + why + ')' : 'ORIGINAL'; }
    if (cur.equals(b.buf)) return 'ORIGINAL';
    var g = conf.edited(b.buf.toString('utf8'), text);
    return g ? 'PATCHED (' + g.dpi + ' dpi, card ' + g.card + ', crop ' + conf.srcCrop(g.card, g.dpi) + ')' : 'UNKNOWN (not our edit of the backup)';
}

function line(k, v) { process.stdout.write((k + ':                ').slice(0, 17) + v + '\n'); }

function cmdStatus(t) {
    var buf = readOr(t.target);
    if (!buf) die('cannot read ' + t.target);
    var c = classify(buf), cd = readCoding(t.coding), us = undos(t, buf), bak = us[0].b;
    line('target', t.target);
    line('size', buf.length);
    line('sha256', c.sha256);
    line('build-id', c.loc.buildId || 'none');
    line('version', c.loc.version || 'unknown');
    line('conf', t.conf);
    line('coding', cd.err ? 'unreadable (' + cd.err + ')' : 'KI_KOMBI_VARIANT ' + cd.variant);
    var why = notRestorable(us);
    line('restorable', why ? 'no (' + why + ')' : 'yes');
    line('undo', undoLine(us));
    line('known', c.bad.length ? 'NO — ' + c.bad[0] : notPristine(c) ? 'yes, modified build' : 'yes, pristine ' + label(c));
    line('proven', PROVEN[c.loc.buildId] ? 'yes' : 'no');
    SITES.forEach(function (e) {
        var s = c.loc[e[0]];
        line(e[1].replace(' ', '-'), s && s.ok ? s.state.toUpperCase() : 'UNKNOWN (' + (s ? s.reason : 'not located') + ')');
    });
    line('geometry', geometryText(us[1].cur, us[1].b));
    var fo = foreignIn(t);
    line('foreign', fo === null ? 'unknown' : fo ? 'yes' : 'no');
    line('planable', c.inMem.length ? 'no (' + c.inMem.join('; ') + ')' : 'yes');
    line('backup', (bak ? backupPath(t.target) + (bak.err ? ' (' + bak.err + ')' : '') : 'none') +
        (fs.existsSync(backupPath(t.conf)) ? ', ' + backupPath(t.conf) : ''));
}

/* What the locator reads at each site of the file (aapd by default), for
 * Save logs: its build, every edit's offset, bytes on disk, stock and
 * patched forms and state, or why it is not found; and the files beside it
 * (the backup, the running copy patchd keeps linked, the patch record). It
 * never writes. */
function cmdProbe(t, file) {
    var f = file || t.target, buf = readOr(f);
    if (!buf) die('cannot read ' + f);
    var c = classify(buf);
    line('file', f);
    line('size', buf.length);
    line('sha256', c.sha256);
    line('build-id', c.loc.buildId || 'none');
    line('version', c.loc.version || 'unknown');
    line('proven', PROVEN[c.loc.buildId] ? 'yes' : 'no');
    line('patch-rev', String(PATCH_REV));
    line('patchable', c.inMem.length ? 'no (' + c.inMem.join('; ') + ')' : 'yes');
    SITES.forEach(function (e) {
        var s = c.loc[e[0]], k = e[1].replace(' ', '-');
        if (!s || !s.ok) { line(k, 'not found (' + (s ? s.reason : 'not located') + ')'); return; }
        line(k, s.state + ' at 0x' + s.offset.toString(16) + ', ' + s.len + ' bytes: ' + buf.toString('hex', s.offset, s.offset + s.len) +
            ' (stock ' + (s.stock || '?') + ', patched ' + s.patched + ')' + (s.readyFlag !== undefined ? ', ready flag +0x' + s.readyFlag.toString(16) : ''));
    });
    [[backupPath(t.target), 'backup'], [t.target + '.woc-running', 'running']].forEach(function (x) {
        var b = readOr(x[0]);
        line(x[1], b ? x[0] + ' sha256 ' + sha256(b) + ', build-id ' + (buildId(b) || 'none') : 'none');
    });
    var rec = null;
    try { rec = fs.readFileSync(record.recordPath(t.target), 'utf8').trim(); } catch (e) {}
    line('record', rec || 'none');
}

/* Each file is restored on its own: one whose backup is not trusted, or
 * that is another build than its backup (a firmware update replaced it;
 * --force overwrites that one), is left as it is while the other is still
 * restored. */
function cmdRevert(t, yes, force, dropBackup) {
    var plans = undos(t), wrote = false, repaired = false, left = [];
    if (!plans.some(function (x) { return x.p; })) die('no backup at ' + backupPath(t.target) + ' or ' + backupPath(t.conf) + ', and neither file is a proven one to rebuild; cannot revert');
    plans.forEach(function (x) {
        if (x.p && x.p.err) { left.push(x.p.err + '; ' + x.file + ' left as it is'); return; }
        if (!x.p || (x.cur && x.p.out.equals(x.cur) && !x.modeBad)) return;
        if (x.p.other && !force) { left.push(x.file + ' is another build than its backup (' + x.p.other + '); left as it is (--force overwrites it)'); return; }
        if (!yes) die('pass --yes to proceed');
        /* At its original already: only the mode and owner. */
        if (x.cur && x.p.out.equals(x.cur)) { repairModes([[x.file, x.floor]], yes); repaired = true; return; }
        writeInPlace(x.file, x.p.out, x.floor);
        wrote = true;
        process.stdout.write('restored ' + x.file + (x.p.stock ? ' from the proven file\'s shipped content' : '') + '\n');
    });
    if (!wrote && !repaired && left.length) die(left.join('; '));
    left.forEach(function (l) { process.stdout.write(l + '\n'); });
    if (!wrote) process.stdout.write('already at the original; nothing to do\n');
    var after = undos(t);
    if (/^(original|other)$/.test(undoState(after[0]))) record.ensure(t.target, { patched: false });
    /* A file left restorable or with an untrusted backup keeps its backup,
     * and the revert fails: it is not undone. */
    var kept = after.map(function (x) { var u = undoState(x); return u === 'restorable' || u === 'untrusted'; });
    if (dropBackup) {
        after.forEach(function (x, i) {
            if (kept[i]) return;
            [backupPath(x.file), metaPath(x.file), backupPath(x.file) + '.tmp', metaPath(x.file) + '.tmp', x.file + '.woc-tmp', record.recordPath(x.file)].forEach(function (f) {
                try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') die('dropping ' + f + ': ' + e.message); }
            });
        });
        process.stdout.write('backup dropped\n');
    }
    if (kept.some(Boolean)) die('not undone: ' + undoLine(after));
}

/* ---- in memory (PATCH.md "In memory") ---- */

/* carplay_patch.js holds the plan's reading and writing, shared by both
 * patches. */
function plans() { return require('./carplay_patch.js'); }

/* The plan's regions of the classified image `c` ([[offset, length]]) and
 * their names. */
function planRegions(c) { return SITES.map(function (e) { return [c.loc[e[0]].offset, c.loc[e[0]].len]; }); }
var PLAN_NAMES = ['gate', 'selfstart-call', 'selfstart-guard', 'screen', 'confpath'];

function writeFileWhole(file, data) {
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    fsyncFile(tmp);
    fs.renameSync(tmp, file);
}

/* `plan`: the patch, as a plan for libwocpatch.so, made from aapd on disk,
 * which must be the pristine build (it is what the process maps), and the
 * copy of aapd.conf with the cluster geometry the plan's config path points
 * aapd at, made from /etc/aapd.conf, which must hold none of our
 * geometries. Neither file is written. Checks: the head unit, the coding,
 * the locator, a proven build (--unproven), aapd.conf. Writes the plan to
 * `outFile` and the copy to `confOut`, each by rename, and prints one JSON
 * line: build, version, sha256, size, edits, provenBuild, coding, writes
 * ({dpi, card, crop}), planSha256, rev, copies ({conf: the copy's SHA-256}),
 * inputs ({conf: aapd.conf's SHA-256}). */
function cmdPlan(t, dpi, card, unproven, outFile, confOut) {
    var hu = headUnit.refused();
    if (hu) die('refusing: ' + hu);
    if (!outFile || !confOut) die('plan needs --out <file> and --conf-out <file>');
    if (conf.DENSITIES.indexOf(dpi) < 0) die('--dpi must be ' + conf.DENSITY_MIN + '-' + conf.DENSITY_MAX + ' in steps of ' + conf.DENSITY_STEP);
    if (conf.CARDS.indexOf(card) < 0) die('--card must be ' + conf.CARDS.join(' or '));
    var codingWhy = codingRefusal(readCoding(t.coding));
    if (codingWhy) die('refusing: ' + codingWhy);
    var buf = readOr(t.target);
    if (!buf) die('cannot read ' + t.target);
    var c = classify(buf);
    if (c.inMem.length) die('refusing: ' + c.inMem.join('; '));
    var why = notPristine(c) || (c.loc.confpath.state !== 'original' ? 'confpath edited' : null);
    if (why) die('in memory needs the pristine build on disk: ' + why);
    if (!PROVEN[c.loc.buildId] && !unproven) die(label(c) + ' (aapd ' + (c.loc.version || 'version unknown') + ') is not a proven build; pass --unproven to patch it anyway');
    var text = readOr(t.conf);
    if (!text) die('cannot read ' + t.conf);
    var confWhy = confNotOriginal(text.toString('utf8'));
    if (confWhy) die('refusing: ' + t.conf + ': ' + confWhy);
    var out = Buffer.from(buf);
    SITES.forEach(function (e) { Buffer.from(c.loc[e[0]].patched, 'hex').copy(out, c.loc[e[0]].offset); });
    var oc = classify(out);
    if (!sameBuild(c, oc) || oc.loc.confpath.offset !== c.loc.confpath.offset || SITES.some(function (e) { return !oc.loc[e[0]].ok || oc.loc[e[0]].state !== 'patched'; }))
        die('refusing: the edited image does not verify');
    var p = plans().planOf(buf, out, planRegions(c), PLAN_NAMES, c.loc.buildId);
    if (p.err) die('refusing: ' + p.err);
    var o = plans().overlay(buf, p.text);
    if (o.err || !o.buf.equals(out)) die('refusing: the plan does not reproduce the edited image (' + (o.err || 'bytes differ') + ')');
    var copy;
    try { copy = Buffer.from(conf.transform(text.toString('utf8'), dpi, card), 'utf8'); } catch (e) { die('refusing: ' + t.conf + ': ' + e.message); }
    writeFileWhole(confOut, copy);
    writeFileWhole(outFile, p.text);
    process.stdout.write(JSON.stringify({ build: c.loc.buildId, version: label(c), sha256: c.sha256, size: buf.length, edits: p.edits,
        provenBuild: !!PROVEN[c.loc.buildId], coding: 'ok', writes: { dpi: dpi, card: card, crop: conf.srcCrop(card, dpi) },
        planSha256: sha256(Buffer.from(p.text)), rev: PATCH_REV, copies: { conf: sha256(copy) }, inputs: { conf: sha256(text) } }) + '\n');
}

/* `overlay`: the edit lines of `status` for aapd with the plan laid over it
 * (what a process the plan was applied to runs), `geometry:` the copy of
 * aapd.conf it reads (`confCopy`) against /etc/aapd.conf, then `overlay:
 * ok` or `overlay: NO — why`. Read-only. */
function cmdOverlay(t, planFile, confCopy) {
    var buf = readOr(t.target), text;
    if (!buf) { line('overlay', 'NO — cannot read ' + t.target); return; }
    try { text = fs.readFileSync(planFile, 'utf8'); } catch (e) { line('overlay', 'NO — ' + e.message); return; }
    var o = plans().overlay(buf, text);
    if (o.err) { line('overlay', 'NO — ' + o.err); return; }
    var c = classify(o.buf), bad = [];
    SITES.forEach(function (e) {
        var x = c.loc[e[0]];
        line(e[1].replace(' ', '-'), x && x.ok ? x.state.toUpperCase() : 'UNKNOWN (' + (x ? x.reason : 'not located') + ')');
        if (!x || !x.ok || x.state !== 'patched') bad.push(e[1] + ' not patched');
    });
    var orig = readOr(t.conf), copy = confCopy ? readOr(confCopy) : null, g = orig && copy ? conf.edited(orig.toString('utf8'), copy.toString('utf8')) : null;
    line('geometry', !copy ? 'MISSING' : g ? 'PATCHED (' + g.dpi + ' dpi, card ' + g.card + ', crop ' + conf.srcCrop(g.card, g.dpi) + ')' : 'UNKNOWN (not our edit of ' + t.conf + ')');
    if (!g) bad.push('the copy of aapd.conf is not our edit of ' + t.conf);
    line('edits', o.edits.join(' '));
    line('overlay', bad.length ? 'NO — ' + bad.join('; ') : 'ok');
}

/* Whether aapd or aapd.conf holds a change besides our edits, against its
 * original (our trusted backup, or the proven file's own shipped content):
 * true, false, or null when that cannot be told (status prints it as
 * `foreign:`). A file with nothing of ours in it is not ours to compare:
 * false. */
function foreignIn(t) {
    var us;
    try { us = undos(t); } catch (e) { return null; }
    var bin = us[0], cf = us[1], out = [];
    /* aapd: the original of its build, and our edit regions in it */
    (function () {
        if (!bin.cur) { out.push(null); return; }
        var orig = bin.b && !bin.b.err ? bin.b.buf : bin.p && bin.p.stock ? bin.p.out : null;
        if (!orig) { out.push(oursIn(classify(bin.cur)) ? null : false); return; }
        if (binOther(bin.cur, orig)) { out.push(null); return; }
        var oc = classify(orig);
        if (oc.bad.length) { out.push(null); return; }
        var rs = regions(oc.loc);
        for (var i = 0; i < orig.length; i++) {
            if (bin.cur[i] === orig[i]) continue;
            if (!rs.some(function (r) { return i >= r[0] && i < r[0] + r[1]; })) { out.push(true); return; }
        }
        out.push(false);
    })();
    /* aapd.conf: its original, or exactly one of our geometries of it */
    (function () {
        if (!cf.cur) { out.push(null); return; }
        var cur = cf.cur.toString('utf8'), orig = cf.b && !cf.b.err ? cf.b.buf.toString('utf8') : cf.p && cf.p.stock ? cf.p.out.toString('utf8') : null;
        if (orig === null) { out.push(confNotOriginal(cur) ? null : false); return; }
        out.push(cur === orig || !!conf.edited(orig, cur) ? false : true);
    })();
    return out.indexOf(true) >= 0 ? true : out.indexOf(null) >= 0 ? null : false;
}

function main() {
    var argv = process.argv.slice(2), a = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var k = argv[i];
        if (k === '--yes' || k === '--force' || k === '--drop-backup' || k === '--unproven') a[k.slice(2)] = true;
        else if (k === '--target' || k === '--conf' || k === '--coding' || k === '--dpi' || k === '--card' || k === '--out' || k === '--conf-out' ||
            k === '--plan' || k === '--conf-copy') a[k.slice(2)] = argv[++i];
        else a._.push(k);
    }
    var t = { target: a.target || '/usr/bin/aapd', conf: a.conf || '/etc/aapd.conf', coding: a.coding || '/dev/shm/rawcodingdata' };
    if (a._[0] === 'status') { cmdStatus(t); line('end', 'complete'); }
    else if (a._[0] === 'probe') cmdProbe(t, a._[1]);
    else if (a._[0] === 'plan') cmdPlan(t, a.dpi === undefined ? conf.DEFAULT_DPI : Number(a.dpi), a.card || conf.DEFAULT_CARD, a.unproven, a.out, a['conf-out']);
    else if (a._[0] === 'overlay') { cmdOverlay(t, a.plan, a['conf-copy']); line('end', 'complete'); }
    else if (a._[0] === 'revert') cmdRevert(t, a.yes, a.force, a['drop-backup']);
    else { process.stderr.write('usage: aapd_patch.js status|probe [<file>]|plan|overlay|revert [--target <aapd>] [--conf <aapd.conf>] [--coding <shm>] [--dpi <n>] [--card shown|hidden] [--out <plan>] [--conf-out <copy>] [--plan <plan>] [--conf-copy <copy>] [--unproven] [--yes] [--force] [--drop-backup]\n'); process.exit(2); }
}

module.exports = { CODING: CODING, PROVEN: PROVEN, PATCH_REV: PATCH_REV, trusted: trusted, binOther: binOther, readCoding: readCoding, codingRefusal: codingRefusal,
    foreignIn: foreignIn };

if (require.main === module) main();
