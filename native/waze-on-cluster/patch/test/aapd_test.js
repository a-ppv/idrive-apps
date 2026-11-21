#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
// Copyright (C) 2026 Robert Nisipeanu
/* The Android Auto patch end to end on temporary copies of the unit's aapd
 * (AAPD_BIN, aapd 22.39.3) and aapd.conf (AAPD_CONF). This version applies
 * it in aapd's memory (PATCH.md "In memory"): the plan's refusals (the
 * coding, a site not found, a modified proven build, a build outside the
 * proven list without --unproven, an aapd.conf without what the geometry
 * needs), the plan and the copy of aapd.conf it points aapd at, the byte-exact
 * undo of a patch an earlier release wrote to the files (waze-on-cluster
 * 0.12.1's patcher, earlier_patcher.js), patchd's hooks and socket next to
 * carplay's (CARPLAY_BIN, optional) with aapd's process in a fake /proc
 * (carplay_proc.js), the head-unit restart guard, and boot recovery for aapd
 * with /, /proc, mount and systemctl faked. The build outside the proven
 * list is the reference with its GNU build-id changed. Firmware is never in
 * this repository; without AAPD_BIN and AAPD_CONF the test skips.
 *
 *   AAPD_BIN=<aapd> AAPD_CONF=<aapd.conf> [CARPLAY_BIN=<carplay>] node aapd_test.js
 */
'use strict';

var headUnit = require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

/* The records the watcher tests below read (inmem.js) live in a folder of
 * this test. */
process.env.WOC_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aa-state-'));

var PATCH = path.join(__dirname, '..');
var BIN = process.env.AAPD_BIN || '', CONF = process.env.AAPD_CONF || '', CARPLAY = process.env.CARPLAY_BIN || '';
if (!fs.existsSync(BIN) || !fs.existsSync(CONF)) { process.stdout.write('SKIP: set AAPD_BIN and AAPD_CONF to copies of the unit\'s /usr/bin/aapd and /etc/aapd.conf\n'); process.exit(0); }

var ap = require('../aapd_patch.js');
var conf = require('../aapd_conf.js');
var locator = require('../aapd_locate.js');
var earlier = require('./earlier_patcher.js');
var proc = require('./carplay_proc.js');
var SRC = fs.readFileSync(BIN), SRCCONF = fs.readFileSync(CONF);
var LOC = locator.locate(SRC);
if (!LOC.ok) { process.stdout.write('FAIL AAPD_BIN is not located: ' + LOC.reason + '\n'); process.exit(1); }
var REGIONS = locator.EDITS.map(function (e) { return [LOC[e].offset, LOC[e].len]; });
/* The reference with its GNU build-id changed: a build outside the proven
 * list whose sites the locator finds. */
var UNPROVEN = (function () {
    var b = Buffer.from(SRC), id = require('../carplay_locate.js').buildId(SRC), at = b.indexOf(Buffer.from(id, 'hex'));
    b[at] ^= 0xff;
    return b;
})();
var fails = 0, dirs = [process.env.WOC_STATE_DIR], children = [];
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    dirs.forEach(function (d) { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} });
});
function sha(x) { return crypto.createHash('sha256').update(Buffer.isBuffer(x) ? x : fs.readFileSync(x)).digest('hex'); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* A coding image with KI_KOMBI_VARIANT v (flags 0x09: valid). */
function coding(v, flags) {
    var b = Buffer.alloc(ap.CODING.size);
    b[ap.CODING.flags] = flags === undefined ? 0x09 : flags;
    b[ap.CODING.at] = (v << ap.CODING.shift) | 0x01;
    return b;
}

/* A fresh unit: aapd, aapd.conf, the coding, a df reporting plenty. */
function unit(bin) {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aa-'));
    dirs.push(d);
    var t = { d: d, bin: path.join(d, 'aapd'), conf: path.join(d, 'aapd.conf'), coding: path.join(d, 'coding'), df: path.join(d, 'df') };
    fs.writeFileSync(t.bin, bin || SRC);
    fs.chmodSync(t.bin, 0o755);
    fs.writeFileSync(t.conf, SRCCONF);
    fs.chmodSync(t.conf, 0o644);
    fs.writeFileSync(t.coding, coding(7));
    fs.writeFileSync(t.df, '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/root 999999 1 1048576 1% /"\n');
    fs.chmodSync(t.df, 0o755);
    return t;
}
/* This version's patcher; an `apply` is an earlier release's (0.12.1, the
 * last that writes the patch to the files): what the tests start from where
 * a car still has that patch on disk. */
function patcher(t, args) {
    var r = cp.spawnSync(process.execPath, [earlier.aaScriptFor(args, path.join(PATCH, 'aapd_patch.js'))].concat(args, ['--target', t.bin, '--conf', t.conf, '--coding', t.coding]),
        { encoding: 'utf8', env: Object.assign({}, process.env, { WOC_DF: t.df }) });
    return { code: r.status, out: r.stdout + r.stderr };
}
function status(t) { return patcher(t, ['status']).out; }
/* This version's plan into the unit's folder: {code, out, plan, copy, sum}. */
function plan(t, args) {
    var p = path.join(t.d, 'aapd.plan'), c = path.join(t.d, 'aapd.conf.copy');
    [p, c].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    var r = patcher(t, ['plan', '--out', p, '--conf-out', c].concat(args || [])), sum = null;
    try { sum = JSON.parse(r.out.trim().split('\n').pop()); } catch (e) {}
    return { code: r.code, out: r.out, plan: p, copy: c, sum: sum };
}
function untouchedAs(t, bin) { return sha(t.bin) === sha(bin) && sha(t.conf) === sha(SRCCONF) && !fs.existsSync(t.bin + '.woc-orig') && !fs.existsSync(t.conf + '.woc-orig'); }
function untouched(t) { return untouchedAs(t, SRC); }
/* An untested aapd that aapd.service does not start. */
function foreignAapd(u) {
    fs.writeFileSync(u.bin, UNPROVEN);
    fs.mkdirSync(path.join(u.d, 'units', 'aapd.service.d'), { recursive: true });
    fs.writeFileSync(path.join(u.d, 'units', 'aapd.service.d', 'x.conf'), '[Service]\nExecStart=\nExecStart=/opt/other/aapd\n');
}
/* aapd_patch.js status slowed to 3 s in the patchd of unit u. */
function slowStatus(u) {
    var js = path.join(u.d, 'slow-status.js');
    fs.writeFileSync(js, 'if (/aapd_patch\\.js$/.test(process.argv[1] || "") && process.argv[2] === "status") { var t = Date.now() + 3000; while (Date.now() < t); }\n');
    u.env.NODE_OPTIONS = '--require=' + js;
}
function onlyEdits(a, b) {
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (!REGIONS.some(function (r) { return i >= r[0] && i < r[0] + r[1]; })) return false;
    }
    return a.length === b.length;
}
function density(text) { return JSON.parse(text).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY; }

/* ---- modes under umask 077: aapd runs as cia_13006 ---- */
(function modeTests() {
    var mask = process.umask(0o077);
    function mode(f) { return fs.statSync(f).mode & 0o7777; }
    function modes(t) { return mode(t.bin).toString(8) + ' ' + mode(t.conf).toString(8); }
    try {
        var t = unit();
        patcher(t, ['apply', '--yes']);
        fs.chmodSync(t.bin, 0o700); fs.chmodSync(t.conf, 0o600);
        fs.writeFileSync(t.bin + '.woc-tmp', 'cut short', { mode: 0o600 });
        var r = patcher(t, ['revert', '--yes']);
        ok('umask 077: revert of an earlier release\'s patch over 0700/0600 and a stale temporary file writes the originals at 0755 and 0644', r.code === 0 && sha(t.bin) === sha(SRC) &&
            sha(t.conf) === sha(SRCCONF) && modes(t) === '755 644' && !fs.existsSync(t.bin + '.woc-tmp'), r.out + ' ' + modes(t));
        fs.chmodSync(t.bin, 0o700); fs.chmodSync(t.conf, 0o600);
        r = patcher(t, ['revert', '--yes']);
        ok('umask 077: revert of the originals at 0700/0600 sets 0755 and 0644, bytes untouched', r.code === 0 && sha(t.bin) === sha(SRC) && modes(t) === '755 644', r.out + ' ' + modes(t));
        fs.chmodSync(t.bin, 0o555); fs.chmodSync(t.conf, 0o444);
        r = patcher(t, ['revert']);
        ok('originals at 0555/0444, which aapd\'s user can run and read, keep their modes', r.code === 0 && modes(t) === '555 444', r.out + ' ' + modes(t));
        var u = unit();
        fs.chmodSync(u.bin, 0o700);
        var p = plan(u);
        ok('umask 077: a plan writes nothing to aapd or aapd.conf, their modes included; the plan and the copy readable by all', p.code === 0 && modes(u) === '700 644' &&
            sha(u.bin) === sha(SRC) && mode(p.plan) === 0o644 && mode(p.copy) === 0o644, p.out + ' ' + modes(u));
    } finally { process.umask(mask); }
})();

/* ---- the patcher ---- */
(function patcherTests() {
    var t = unit();
    var s = status(t);
    ok('status: the pristine proven build, coding 7, nothing to restore, planable, nothing foreign', /known:\s+yes, pristine aapd 22\.39\.3/.test(s) && /coding:\s+KI_KOMBI_VARIANT 7/.test(s) &&
        /restorable:\s+no/.test(s) && /geometry:\s+ORIGINAL/.test(s) && /^confpath:\s+ORIGINAL$/m.test(s) && /^planable:\s+yes$/m.test(s) && /^foreign:\s+no$/m.test(s), s);

    [[coding(9), 'KI_KOMBI_VARIANT 9 is not the proven'], [coding(2), 'KI_KOMBI_VARIANT 2 is not the proven'], [coding(7, 0x0b), 'coding not valid'],
     [Buffer.alloc(16), 'is 16 bytes']].forEach(function (c) {
        var u = unit();
        fs.writeFileSync(u.coding, c[0]);
        var r = plan(u);
        ok('coding: the plan refused (' + c[1] + '), nothing written', r.code === 1 && r.out.indexOf(c[1]) >= 0 && untouched(u) && !fs.existsSync(r.plan) && !fs.existsSync(r.copy), r.out);
    });
    var nc = unit();
    fs.unlinkSync(nc.coding);
    var r = plan(nc);
    ok('coding: an unreadable coding fails the plan, not a refusal of the file (a later try may read it)', r.code === 1 && /^error: refusing: the cluster coding cannot be read/m.test(r.out) &&
        !require('../inmem.js').refusal(/^error: (.*)$/m.exec(r.out)[1]) && untouched(nc), r.out);

    /* A site the locator does not find (aapd_locate_test.js perturbs each):
     * refused with the reason, nothing written. */
    var nf = unit(), nb = Buffer.from(SRC);
    nb[LOC.gate.offset + 6] = 3;
    fs.writeFileSync(nf.bin, nb);
    r = plan(nf, ['--unproven']);
    ok('a site not found: the plan refused with the reason, nothing written', r.code === 1 && /refusing: gate: variant check not found/.test(r.out) &&
        sha(nf.bin) === sha(nb) && !fs.existsSync(r.plan), r.out);
    ok('a site not found: status says which', /known:\s+NO — gate: variant check not found/.test(status(nf)) && /gate:\s+UNKNOWN/.test(status(nf)), status(nf));
    var ncp = unit(), ncb = Buffer.from(SRC);
    ncb.write('/etc/aapd.cfg', LOC.confpath.offset, 'latin1');
    fs.writeFileSync(ncp.bin, ncb);
    r = plan(ncp, ['--unproven']);
    s = status(ncp);
    ok('the config path not found: the plan refused, status not planable, the four edits still known', r.code === 1 && /refusing: config path: the path string not found/.test(r.out) &&
        /^planable:\s+no \(config path/m.test(s) && /^confpath:\s+UNKNOWN/m.test(s) && !/known:\s+NO/.test(s), r.out + s);
    [['bytes appended', Buffer.concat([SRC, Buffer.alloc(16)])], ['a byte changed outside the sites', (function () { var b = Buffer.from(SRC); b[0x1000] ^= 1; return b; })()]].forEach(function (m) {
        var u = unit(m[1]), x = plan(u, ['--unproven']);
        ok('the proven build with ' + m[0] + ': the plan refused (in memory needs the pristine build), also with --unproven', x.code === 1 && /pristine build on disk: sha256/.test(x.out) &&
            !fs.existsSync(x.plan), x.out);
        ok('the proven build with ' + m[0] + ': status reads modified, nothing restorable', /known:\s+yes, modified build/.test(status(u)) && /restorable:\s+no/.test(status(u)));
    });
    var text = SRCCONF.toString('utf8');
    [['not JSON', text.slice(0, -10), /not JSON/],
     ['a number the edit sets missing', text.replace(/"SA_WIDTHPIXELS": 612/, '"SA_WIDTHPIXELS": "612"'), /no number SCREENS\/KOMBI_DISPLAY\/DIMENSIONS\/12\.3\/SA_WIDTHPIXELS/],
     ['two codecs for the 12.3" screen', text.replace(/"HIGH_1080P"\s*\]/, '"HIGH_1080P", "MID_1080P"]'), /no single codec for the 12\.3 screen/],
     ['a key twice', text.replace(/"FRAME_RATE"/, '"CODEC_WIDTH"'), /twice/],
     ['our geometry without our backup', conf.transform(text, 200, 'shown'), /holds our geometry without our backup/]].forEach(function (c) {
        var u = unit();
        fs.writeFileSync(u.conf, c[1]);
        var x = plan(u);
        ok('conf with ' + c[0] + ': the plan refused, nothing written', x.code === 1 && /^error: refusing: /m.test(x.out) && c[2].test(x.out) && sha(u.bin) === sha(SRC) &&
            fs.readFileSync(u.conf, 'utf8') === c[1] && !fs.existsSync(x.copy), x.out);
        ok('conf with ' + c[0] + ': status says why', new RegExp('geometry:\\s+UNKNOWN \\(').test(status(u)) && c[2].test(status(u)), status(u));
    });
    var cc = unit();
    fs.appendFileSync(cc.conf, '\n');
    r = plan(cc);
    ok('conf: an aapd.conf with what the edit needs is planned, whatever else it holds; it stays as it is', r.code === 0 &&
        conf.edited(SRCCONF.toString('utf8') + '\n', fs.readFileSync(r.copy, 'utf8')) !== null && fs.readFileSync(cc.conf, 'utf8') === SRCCONF.toString('utf8') + '\n', r.out);
    ok('dpi: a density off the steps is refused', plan(unit(), ['--dpi', '155']).code === 1);
    ok('card: a turn-card setting other than shown or hidden is refused', plan(unit(), ['--card', 'off']).code === 1);

    /* The plan: the five sites, stock to patched, and the copy of aapd.conf
     * at 180 dpi with the card shown; neither file written. */
    var st0 = fs.statSync(t.bin), cst0 = fs.statSync(t.conf);
    var p = plan(t);
    var lines = fs.readFileSync(p.plan, 'utf8');
    var want = ['wocplan 1', 'build-id 2dfb9881706bff435b05f621486e8eb8b6c55984'].concat(['gate', 'call', 'guard', 'screen', 'confpath'].map(function (e, i) {
        return ['edit', ['gate', 'selfstart-call', 'selfstart-guard', 'screen', 'confpath'][i], LOC[e].offset.toString(16), LOC[e].stock, LOC[e].patched].join(' ');
    }), ['end 5']).join('\n') + '\n';
    ok('plan: the five sites of the proven build at their addresses, stock to patched', p.code === 0 && lines === want, lines);
    ok('plan: the config path made /run/aapd.conf', /\nedit confpath 5008ec 2f6574632f616170642e636f6e6600 2f72756e2f616170642e636f6e6600\n/.test(lines));
    ok('plan: aapd and aapd.conf not written, not even their times', sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF) &&
        fs.statSync(t.bin).mtime.getTime() === st0.mtime.getTime() && fs.statSync(t.conf).mtime.getTime() === cst0.mtime.getTime() && !fs.existsSync(t.bin + '.woc-orig'));
    ok('plan: its summary names the build, the edits, the geometry, the revision and the SHA-256 of the plan, the copy and aapd.conf', !!p.sum && p.sum.provenBuild === true &&
        p.sum.edits.join() === 'gate,selfstart-call,selfstart-guard,screen,confpath' && p.sum.writes.dpi === 180 && p.sum.writes.card === 'shown' &&
        p.sum.writes.crop === '1280x720:0,0,1280,564' && p.sum.rev === ap.PATCH_REV && p.sum.planSha256 === sha(p.plan) && p.sum.copies.conf === sha(p.copy) &&
        p.sum.inputs.conf === sha(SRCCONF), JSON.stringify(p.sum));
    var laid = require('../carplay_patch.js').overlay(SRC, lines);
    ok('plan: laid over aapd, the four edits an earlier release wrote and the config path, nothing else', !laid.err && onlyEdits(SRC, Buffer.concat([laid.buf.slice(0, LOC.confpath.offset),
        SRC.slice(LOC.confpath.offset, LOC.confpath.offset + LOC.confpath.len), laid.buf.slice(LOC.confpath.offset + LOC.confpath.len)])) &&
        laid.buf.toString('latin1', LOC.confpath.offset, LOC.confpath.offset + 15) === '/run/aapd.conf\0', laid.err);
    var k = JSON.parse(fs.readFileSync(p.copy, 'utf8')).SCREENS.KOMBI_DISPLAY, c = k.CODEC_DEFINITION.HIGH_1080P, sa = k.DIMENSIONS['12.3'];
    var g = conf.GEOMETRY.shown;
    ok('plan: the copy asks for the geometry at 180 dpi; 10.25" and MID left stock', c.CODEC_WIDTH === g.codec.w && c.CODEC_HEIGHT === g.codec.h &&
        c.REPORTED_SCREEN_DENSITY === 180 && c.WIDTH_TARGET_VIEWPORT === g.ui.w && c.HEIGHT_TARGET_VIEWPORT === g.ui.h && sa.SA_WIDTHPIXELS === g.safe.w &&
        sa.SA_OFFSET_TOPPIXELS === g.safe.y && JSON.stringify(k.CODEC_DEFINITION.MID_1080P) === JSON.stringify(JSON.parse(SRCCONF).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.MID_1080P));
    var o = patcher(t, ['overlay', '--plan', p.plan, '--conf-copy', p.copy]).out;
    ok('overlay: every site patched, the copy\'s geometry, ok', ['gate', 'selfstart-call', 'selfstart-guard', 'screen', 'confpath'].every(function (e) {
        return new RegExp('^' + e + ':\\s+PATCHED$', 'm').test(o); }) && /^geometry:\s+PATCHED \(180 dpi, card shown, crop 1280x720:0,0,1280,564\)$/m.test(o) && /^overlay:\s+ok$/m.test(o), o);
    s = status(t);
    ok('status after a plan: the files as they ship', /^gate:\s+ORIGINAL$/m.test(s) && /^geometry:\s+ORIGINAL$/m.test(s) && /restorable:\s+no/.test(s), s);
    o = patcher(t, ['overlay', '--plan', p.plan, '--conf-copy', t.conf]).out;
    ok('overlay with aapd.conf as it ships for the copy: refused', /^overlay:\s+NO — /m.test(o), o);
    var planSha = sha(p.plan), every = true;
    conf.DENSITIES.forEach(function (d) {
        var x = plan(t, ['--dpi', String(d)]);
        if (x.code || sha(x.plan) !== planSha || density(fs.readFileSync(x.copy, 'utf8')) !== d) every = false;
    });
    ok('density: every step from 150 to 400 plans the same edits with its own copy', every);

    /* The turn card: hidden is the whole picture as UI with the safe area
     * from the top, and the crop under the card's rows, which grow with the
     * density (the car's values). */
    p = plan(t, ['--dpi', '240', '--card', 'hidden']);
    k = JSON.parse(fs.readFileSync(p.copy, 'utf8')).SCREENS.KOMBI_DISPLAY; c = k.CODEC_DEFINITION.HIGH_1080P; sa = k.DIMENSIONS['12.3'];
    ok('card hidden: 1280x720 drawn whole, safe area 592x672 at 336,0, 240 dpi', p.code === 0 && c.VERTICAL_MARGIN_SIZE === 0 && c.HEIGHT_TARGET_VIEWPORT === 720 &&
        [sa.SA_OFFSET_LEFTPIXELS, sa.SA_OFFSET_TOPPIXELS, sa.SA_WIDTHPIXELS, sa.SA_HEIGHTPIXELS].join() === '336,0,592,672' && c.REPORTED_SCREEN_DENSITY === 240, p.out);
    ok('card hidden: the summary and the overlay name the crop', p.sum.writes.crop === '1280x720:4,160,1270,560' &&
        /PATCHED \(240 dpi, card hidden, crop 1280x720:4,160,1270,560\)/.test(patcher(t, ['overlay', '--plan', p.plan, '--conf-copy', p.copy]).out));
    [[180, '1280x720:0,156,1280,564'], [200, '1280x720:0,156,1280,564'], [240, '1280x720:4,160,1270,560'], [300, '1280x720:46,196,1188,524'],
     [400, '1280x720:116,258,1048,462']].forEach(function (x) {
        var n = x[1].split(':')[1].split(',').map(Number);
        ok('card hidden at ' + x[0] + ' dpi: crop ' + x[1] + ', even, inside, the slot\'s shape', conf.srcCrop('hidden', x[0]) === x[1] &&
            n.every(function (v) { return v % 2 === 0; }) && n[0] + n[2] <= 1280 && n[1] + n[3] <= 720 && Math.abs(n[2] / n[3] / (1088 / 480) - 1) < 0.01);
    });
    var shipped = /^src_crop = (.*)$/m.exec(fs.readFileSync(path.join(PATCH, '..', 'waze-on-cluster.conf'), 'utf8'));
    ok('the shipped conf crops the card-shown geometry', shipped && shipped[1] === conf.srcCrop('shown', 180));
    var origText = SRCCONF.toString('utf8');
    every = true;
    conf.DENSITIES.forEach(function (d) {
        conf.CARDS.forEach(function (cd) {
            var e = conf.edited(origText, conf.transform(origText, d, cd));
            if (!e || e.dpi !== d || e.card !== cd || conf.otherFile(conf.transform(origText, d, cd), origText)) every = false;
        });
    });
    ok('every density and card is recognised and is the original\'s file', every);

    /* A build outside the proven list: planned only with --unproven. */
    var u = unit(UNPROVEN);
    s = status(u);
    ok('unproven build: pristine by its sites, not proven, its build-id and version', /known:\s+yes, pristine build [0-9a-f]{40}/.test(s) && /proven:\s+no/.test(s) &&
        /version:\s+22\.39\.3/.test(s) && /geometry:\s+ORIGINAL/.test(s), s);
    r = plan(u);
    ok('unproven build: the plan without --unproven refused, nothing written', r.code === 1 && /is not a proven build; pass --unproven/.test(r.out) && untouchedAs(u, UNPROVEN) &&
        !fs.existsSync(r.plan), r.out);
    r = plan(u, ['--unproven']);
    ok('unproven build: --unproven plans the proven build\'s edits for its build-id, not proven', r.code === 0 && r.sum.provenBuild === false &&
        fs.readFileSync(r.plan, 'utf8').split('\n').slice(2).join('\n') === want.split('\n').slice(2).join('\n') && untouchedAs(u, UNPROVEN), r.out);

    /* An earlier release's patch on disk, and what this version's revert
     * makes of it: undo needs no anchors: the patched aapd with an anchor
     * changed (an older release's edit there), and aapd.conf with
     * KOMBI_DISPLAY numbers no geometry of ours writes. */
    var e = unit();
    r = patcher(e, ['apply', '--yes']);
    s = status(e);
    ok('an earlier release\'s patch: status patched, restorable, nothing foreign; this version plans none over it', r.code === 0 && (s.match(/^\S+:\s+PATCHED/gm) || []).length === 5 &&
        /restorable:\s+yes/.test(s) && /^foreign:\s+no$/m.test(s) && /pristine build on disk/.test(plan(e).out), s);
    var pb = fs.readFileSync(e.bin);
    pb[LOC.gate.offset - 1] ^= 0x5a;
    fs.writeFileSync(e.bin, pb);
    var pc = JSON.parse(fs.readFileSync(e.conf, 'utf8'));
    fs.writeFileSync(e.conf, fs.readFileSync(e.conf, 'utf8').replace('"SA_OFFSET_TOPPIXELS": ' + pc.SCREENS.KOMBI_DISPLAY.DIMENSIONS['12.3'].SA_OFFSET_TOPPIXELS, '"SA_OFFSET_TOPPIXELS": 7'));
    s = status(e);
    ok('undo: anchors and geometry not ours, still restorable', /restorable:\s+yes/.test(s) && /UNKNOWN/.test(s), s);
    r = patcher(e, ['revert', '--yes']);
    ok('undo: revert writes both originals byte-exact', r.code === 0 && sha(e.bin) === sha(SRC) && sha(e.conf) === sha(SRCCONF), r.out);

    /* Another change beside an earlier patch of ours: foreign. */
    var fo = unit();
    patcher(fo, ['apply', '--yes']);
    var fob = fs.readFileSync(fo.bin);
    fob[0x1000] ^= 1;
    fs.writeFileSync(fo.bin, fob);
    ok('an earlier patch beside another change in aapd: foreign', /^foreign:\s+yes$/m.test(status(fo)), status(fo));
    var foc = unit();
    patcher(foc, ['apply', '--yes']);
    fs.writeFileSync(foc.conf, fs.readFileSync(foc.conf, 'utf8').replace(/"RACK_MODE"\s*:\s*\w+/, '"RACK_MODE": 1'));
    ok('an earlier patch beside another change in aapd.conf: foreign', /^foreign:\s+yes$/m.test(status(foc)), status(foc));

    /* A backup that is not its record's original is never trusted: on a
     * build outside the proven list aapd is then not undone; the proven
     * build is rebuilt from its own bytes. */
    var ub = unit(UNPROVEN);
    patcher(ub, ['apply', '--unproven', '--yes']);
    var bad = fs.readFileSync(ub.bin + '.woc-orig');
    bad[5] ^= 1;
    fs.writeFileSync(ub.bin + '.woc-orig', bad);
    var patched = sha(ub.bin);
    r = patcher(ub, ['revert', '--yes']);
    ok('backup: revert never writes it, restores aapd.conf on its own and fails: aapd is not undone', r.code === 1 && /recorded/.test(r.out) && /not undone: aapd untrusted, aapd\.conf original/.test(r.out) && sha(ub.bin) === patched && sha(ub.conf) === sha(SRCCONF), r.out);
    r = patcher(ub, ['revert', '--yes']);
    ok('backup: with nothing else to restore, revert fails and says why', r.code === 1 && /recorded/.test(r.out) && /restorable:\s+no \(backup sha256/.test(status(ub)), r.out);
    var pt = unit();
    patcher(pt, ['apply', '--yes']);
    bad = fs.readFileSync(pt.bin + '.woc-orig');
    bad[5] ^= 1;
    fs.writeFileSync(pt.bin + '.woc-orig', bad);
    s = status(pt);
    ok('backup not its record\'s, on the proven build: restorable from its shipped bytes', /^restorable:\s+yes$/m.test(s) && /^undo:\s+aapd restorable, aapd\.conf restorable$/m.test(s), s);
    r = patcher(pt, ['revert', '--yes']);
    ok('backup not its record\'s, on the proven build: revert writes the shipped bytes, never the backup; both files byte-exact', r.code === 0 &&
        /restored .*aapd from the proven file's shipped content/.test(r.out) && sha(pt.bin) === sha(SRC) && sha(pt.conf) === sha(SRCCONF), r.out);

    /* A firmware update: another aapd over the backup is left, aapd.conf
     * still restored; --force writes the backup over it. */
    var fw = unit();
    patcher(fw, ['apply', '--yes']);
    var other = Buffer.concat([SRC, Buffer.from('new firmware')]);
    fs.writeFileSync(fw.bin, other);
    r = patcher(fw, ['revert', '--yes']);
    ok('another build: aapd left as it is, aapd.conf restored on its own', r.code === 0 && sha(fw.bin) === sha(other) && sha(fw.conf) === sha(SRCCONF) && /left as it is/.test(r.out), r.out);
    r = patcher(fw, ['revert', '--yes']);
    ok('another build: nothing else to restore is an error, nothing written', r.code === 1 && sha(fw.bin) === sha(other), r.out);
    r = patcher(fw, ['revert', '--yes', '--force', '--drop-backup']);
    ok('another build: --force writes the backup, --drop-backup drops both', r.code === 0 && sha(fw.bin) === sha(SRC) && !fs.existsSync(fw.bin + '.woc-orig') &&
        !fs.existsSync(fw.conf + '.woc-orig') && !fs.existsSync(fw.bin + '.woc-orig.json'), r.out);

    /* A build outside the proven list an earlier release patched: undone
     * byte-exact. */
    var uu = unit(UNPROVEN);
    patcher(uu, ['apply', '--unproven', '--yes']);
    s = status(uu);
    ok('unproven build, patched by an earlier release: status patched, restorable', (s.match(/^\S+:\s+PATCHED/gm) || []).length === 5 && /restorable:\s+yes/.test(s) && /known:\s+yes, modified build/.test(s), s);
    r = patcher(uu, ['revert', '--yes', '--drop-backup']);
    ok('unproven build: revert restores both byte-exact and drops the backups', r.code === 0 && untouchedAs(uu, UNPROVEN), r.out);

    /* A locator that throws: status still prints every line, and revert
     * restores both files without it. */
    var th = unit();
    patcher(th, ['apply', '--yes']);
    var pre = path.join(th.d, 'throwing-locator.js');
    fs.writeFileSync(pre, 'var p = require.resolve(' + JSON.stringify(path.join(PATCH, 'aapd_locate.js')) + ');\n' +
        'require.cache[p] = { id: p, filename: p, loaded: true, exports: { locate: function () { throw new Error("boom"); } } };\n');
    function throwing(args) {
        var x = cp.spawnSync(process.execPath, ['-r', pre, path.join(PATCH, 'aapd_patch.js')].concat(args, ['--target', th.bin, '--conf', th.conf, '--coding', th.coding]), { encoding: 'utf8' });
        return { code: x.status, out: x.stdout + x.stderr };
    }
    r = throwing(['status']);
    ok('a throwing locator: status prints every line, restorable, the backup named', r.code === 0 &&
        ['target', 'size', 'sha256', 'build-id', 'version', 'conf', 'coding', 'restorable', 'undo', 'known', 'proven', 'gate', 'selfstart-call', 'selfstart-guard', 'screen', 'confpath', 'geometry', 'foreign', 'planable', 'backup']
            .every(function (k2) { return new RegExp('^' + k2 + ':', 'm').test(r.out); }) &&
        /^restorable:\s+yes$/m.test(r.out) && /^known:\s+NO — locator failed: boom$/m.test(r.out) && /^gate:\s+UNKNOWN \(locator failed: boom\)$/m.test(r.out) &&
        r.out.split('\n').some(function (l) { return /^backup:/.test(l) && l.indexOf(th.bin + '.woc-orig') > 0; }), r.out);
    r = throwing(['revert', '--yes']);
    ok('a throwing locator: revert restores both files byte-exact', r.code === 0 && sha(th.bin) === sha(SRC) && sha(th.conf) === sha(SRCCONF), r.out);
    var nr = unit(UNPROVEN);
    patcher(nr, ['apply', '--unproven', '--yes']);
    fs.unlinkSync(nr.bin + '.woc-orig.json');
    var nrBin = sha(nr.bin);
    r = patcher(nr, ['revert', '--yes']);
    ok('record: a backup without its record is not trusted', /has no record/.test(r.out) && sha(nr.bin) === nrBin && sha(nr.conf) === sha(SRCCONF), r.out);

    /* No backup at all: the proven aapd and aapd.conf are rebuilt from
     * their own content and the shipped mode, also under umask 077. */
    var nbk = unit();
    patcher(nbk, ['apply', '--dpi', '240', '--card', 'hidden', '--yes']);
    [nbk.bin, nbk.conf].forEach(function (f) { fs.unlinkSync(f + '.woc-orig'); fs.unlinkSync(f + '.woc-orig.json'); });
    fs.chmodSync(nbk.bin, 0o700);
    s = status(nbk);
    ok('no backup, the proven files patched: restorable', /^restorable:\s+yes$/m.test(s) && /^undo:\s+aapd restorable, aapd\.conf restorable$/m.test(s), s);
    var um = cp.spawnSync('sh', ['-c', 'umask 077; exec "$0" "$@"', process.execPath, path.join(PATCH, 'aapd_patch.js'), 'revert', '--yes',
        '--target', nbk.bin, '--conf', nbk.conf, '--coding', nbk.coding], { encoding: 'utf8' });
    ok('no backup: revert restores both byte-exact with the shipped modes under umask 077', um.status === 0 && sha(nbk.bin) === sha(SRC) && sha(nbk.conf) === sha(SRCCONF) &&
        (fs.statSync(nbk.bin).mode & 0o7777) === 0o755 && (fs.statSync(nbk.conf).mode & 0o7777) === 0o644, um.stdout + um.stderr);
    ok('no backup, the originals: nothing left to undo', /^undo:\s+aapd original, aapd\.conf original$/m.test(status(nbk)) && /^restorable:\s+no/m.test(status(nbk)), status(nbk));
    fs.chmodSync(nbk.bin, 0o700);
    r = patcher(nbk, ['revert', '--yes']);
    ok('the original aapd with another mode and no backup of ours: not restorable, revert leaves the mode', /^restorable:\s+no/m.test(status(nbk)) &&
        r.code === 0 && /nothing to do/.test(r.out) && (fs.statSync(nbk.bin).mode & 0o7777) === 0o700 && sha(nbk.bin) === sha(SRC), r.out);
    /* Beside a backup of ours (an earlier Remove patch kept it), the mode is
     * ours to repair. */
    var mb = unit();
    patcher(mb, ['apply', '--yes']);
    patcher(mb, ['revert', '--yes']);
    fs.chmodSync(mb.bin, 0o700);
    s = status(mb);
    r = patcher(mb, ['revert', '--yes']);
    ok('the original aapd with another mode beside our backup: restorable; revert sets 0755 and reports nothing to do', /^restorable:\s+yes$/m.test(s) &&
        r.code === 0 && /^set \S+'s mode and owner \(it had mode 0700, not 0755\)$/m.test(r.out) && /nothing to do/.test(r.out) && !/^restored /m.test(r.out) &&
        (fs.statSync(mb.bin).mode & 0o7777) === 0o755 && sha(mb.bin) === sha(SRC), s + r.out);
    /* woc-patch.sh, the by-hand path: aa-status, aa-revert with / read-write
     * only around the write, on the proven files without backups, and
     * aa-off for the patch in memory. */
    var wp = unit();
    patcher(wp, ['apply', '--yes']);
    [wp.bin, wp.conf].forEach(function (f) { fs.unlinkSync(f + '.woc-orig'); fs.unlinkSync(f + '.woc-orig.json'); });
    fs.mkdirSync(path.join(wp.d, 'bin'));
    fs.writeFileSync(path.join(wp.d, 'bin', 'mount'), '#!/bin/sh\necho "$*" >> "' + path.join(wp.d, 'mounts') + '"\n', { mode: 0o755 });
    var wenv = Object.assign({}, process.env, { PATH: path.join(wp.d, 'bin') + path.delimiter + process.env.PATH, WOC_AAPD: wp.bin, WOC_AAPD_CONF: wp.conf, WOC_CODING: wp.coding,
        WOC_STATE_DIR: path.join(wp.d, 'var'), WOC_PRELOAD_DIR: path.join(wp.d, 'run') });
    var ws = cp.spawnSync('sh', [path.join(PATCH, 'woc-patch.sh'), 'aa-status'], { env: wenv, encoding: 'utf8' });
    ok('woc-patch.sh aa-status: the status, restorable without backups', ws.status === 0 && /^restorable:\s+yes$/m.test(ws.stdout) && /^gate:\s+PATCHED$/m.test(ws.stdout), ws.stdout + ws.stderr);
    ws = cp.spawnSync('sh', [path.join(PATCH, 'woc-patch.sh'), 'aa-revert'], { env: wenv, encoding: 'utf8' });
    ok('woc-patch.sh aa-revert: both files byte-exact, / read-write then read-only', ws.status === 0 && sha(wp.bin) === sha(SRC) && sha(wp.conf) === sha(SRCCONF) &&
        fs.readFileSync(path.join(wp.d, 'mounts'), 'utf8') === '-o remount,rw /\n-o remount,ro /\n', ws.stdout + ws.stderr);
    fs.mkdirSync(path.join(wp.d, 'var'));
    fs.mkdirSync(path.join(wp.d, 'run'));
    fs.writeFileSync(path.join(wp.d, 'var', 'inmem-aapd.json'), JSON.stringify({ v: 1, enabled: true, planSha256: 'x' }) + '\n');
    fs.writeFileSync(path.join(wp.d, 'run', 'aapd.env'), 'LD_PRELOAD=x\n');
    ws = cp.spawnSync('sh', [path.join(PATCH, 'woc-patch.sh'), 'aa-off'], { env: wenv, encoding: 'utf8' });
    var off = JSON.parse(fs.readFileSync(path.join(wp.d, 'var', 'inmem-aapd.json'), 'utf8'));
    ok('woc-patch.sh aa-off: the next aapd start is stock, the record turned off by the user, / never remounted, the files untouched', ws.status === 0 &&
        !fs.existsSync(path.join(wp.d, 'run', 'aapd.env')) && off.enabled === false && off.by === 'user' && sha(wp.bin) === sha(SRC) &&
        fs.readFileSync(path.join(wp.d, 'mounts'), 'utf8') === '-o remount,rw /\n-o remount,ro /\n', ws.stdout + ws.stderr);

    /* No backup of ours: aapd.conf is rebuilt only from a geometry this tool
     * writes. One another tool changed is left as it is, with nothing to
     * undo. */
    var fc = unit();
    var foreign = SRCCONF.toString('utf8').replace('"SA_PHYSICALDENSITY": 208', '"SA_PHYSICALDENSITY": 211');
    fs.writeFileSync(fc.conf, foreign);
    s = status(fc);
    ok('aapd.conf changed by another tool, no backup: geometry original, nothing to undo, not restorable, nothing foreign of ours', /^geometry:\s+ORIGINAL$/m.test(s) &&
        /^undo:\s+aapd original, aapd\.conf none$/m.test(s) && /^restorable:\s+no/m.test(s) && /^foreign:\s+no$/m.test(s), s);
    r = patcher(fc, ['revert', '--yes']);
    ok('aapd.conf changed by another tool, no backup: revert leaves it byte for byte', fs.readFileSync(fc.conf, 'utf8') === foreign && sha(fc.bin) === sha(SRC), r.out);
    p = plan(fc);
    ok('aapd.conf changed by another tool: the plan\'s copy is our geometry of that file', p.code === 0 && !!conf.edited(foreign, fs.readFileSync(p.copy, 'utf8')), p.out);
    var gc = unit();
    patcher(gc, ['apply', '--dpi', '260', '--card', 'hidden', '--yes']);
    [gc.bin, gc.conf].forEach(function (f) { fs.unlinkSync(f + '.woc-orig'); fs.unlinkSync(f + '.woc-orig.json'); });
    fs.writeFileSync(gc.bin, SRC);
    s = status(gc);
    ok('aapd.conf at a geometry of ours, no backup, aapd stock: aapd.conf restorable', /^undo:\s+aapd original, aapd\.conf restorable$/m.test(s) &&
        /^restorable:\s+yes$/m.test(s), s);
    r = patcher(gc, ['revert', '--yes']);
    ok('aapd.conf at a geometry of ours, no backup: revert rebuilds the shipped file', r.code === 0 && sha(gc.conf) === sha(SRCCONF) && sha(gc.bin) === sha(SRC), r.out);
    var fb = unit();
    var foreignBin = Buffer.from(SRC);
    Buffer.from('83bb1c02000003', 'hex').copy(foreignBin, 0x998bd);
    fs.writeFileSync(fb.bin, foreignBin);
    s = status(fb);
    ok('aapd with a site changed by another tool, no backup: nothing to undo, not restorable', /^undo:\s+aapd none, aapd\.conf original$/m.test(s) &&
        /^restorable:\s+no/m.test(s), s);
    r = patcher(fb, ['revert', '--yes']);
    ok('aapd with a site changed by another tool, no backup: revert leaves it byte for byte', fs.readFileSync(fb.bin).equals(foreignBin), r.out);
    var nu = unit(UNPROVEN);
    patcher(nu, ['apply', '--unproven', '--yes']);
    fs.unlinkSync(nu.bin + '.woc-orig'); fs.unlinkSync(nu.bin + '.woc-orig.json');
    var nuBin = sha(nu.bin);
    r = patcher(nu, ['revert', '--yes']);
    ok('no backup, a build outside the proven list: aapd left as it is, aapd.conf restored', sha(nu.bin) === nuBin && sha(nu.conf) === sha(SRCCONF) &&
        /^undo:\s+aapd none, aapd\.conf original$/m.test(status(nu)), r.out + status(nu));
})();

/* ---- patchd: hooks and socket, next to carplay ---- */
var HAVE_CP = fs.existsSync(CARPLAY);
/* A unit for patchd: aapd's main process in a fake /proc (carplay_proc.js)
 * as unit.json's pid (0: none), started by the fake systemctl from the file
 * on disk, armed when this boot's env file is there. */
function patchdUnit(opts) {
    var t = unit();
    var d = t.d;
    ['shm', 'var', 'proc', 'units', 'bin', 'run'].forEach(function (x) { fs.mkdirSync(path.join(d, x)); });
    t.carplay = path.join(d, 'carplay');
    fs.writeFileSync(t.carplay, HAVE_CP ? fs.readFileSync(CARPLAY) : 'not a carplay build\n', { mode: 0o755 });
    t.calls = path.join(d, 'calls');
    fs.writeFileSync(t.calls, '');
    t.mounts = path.join(d, 'mounts');
    fs.writeFileSync(t.mounts, '/dev/root / ext4 ro 0 0\n');
    t.proc = path.join(d, 'proc');
    t.run = path.join(d, 'run');
    t.runConf = path.join(d, 'run-aapd.conf');
    t.dropin = path.join(d, 'aapd-dropin.conf');
    var mount = path.join(d, 'bin', 'mount');
    /* remount,ro fails while a process runs a file no name links any more,
     * as the kernel refuses it. */
    fs.writeFileSync(mount, '#!' + process.execPath + '\n' + [
        "var fs = require('fs'), path = require('path'), a = process.argv.slice(2).join(' ');",
        "var P = " + JSON.stringify(t.proc) + ", M = " + JSON.stringify(t.mounts) + ";",
        "if (/rw/.test(a)) fs.writeFileSync(M, '/dev/root / ext4 rw 0 0\\n');",
        "else {",
        "    var open = fs.readdirSync(P).some(function (p) { try { return fs.statSync(path.join(P, p, 'exe')).nlink <= 1; } catch (e) { return false; } });",
        "    if (open) { process.stderr.write('mount: / is busy\\n'); process.exit(32); }",
        "    fs.writeFileSync(M, '/dev/root / ext4 ro 0 0\\n');",
        "}",
    ].join('\n') + '\n');
    fs.chmodSync(mount, 0o755);
    /* systemctl: show answers from unit.json (its DropInPaths name the
     * tool's aapd drop-in), start starts aapd in the fake /proc, every call
     * recorded. */
    t.unitState = path.join(d, 'unit.json');
    fs.writeFileSync(t.unitState, JSON.stringify({ pid: 0 }));
    fs.writeFileSync(path.join(d, 'bin', 'systemctl'), '#!' + process.execPath + '\n' + [
        "var fs = require('fs'), a = process.argv.slice(2), u = JSON.parse(fs.readFileSync(" + JSON.stringify(t.unitState) + ", 'utf8'));",
        "var proc = require(" + JSON.stringify(path.join(__dirname, 'carplay_proc.js')) + ");",
        "fs.appendFileSync(" + JSON.stringify(t.calls) + ", 'systemctl ' + a.join(' ') + '\\n');",
        "if (a[0] === 'show') process.stdout.write('MainPID=' + u.pid + '\\nInvocationID=run-' + u.pid + '\\nExecMainStartTimestampMonotonic=1\\nActiveState=active\\nDropInPaths=' + " + JSON.stringify(t.dropin) + " + '\\nEnvironment=\\nUser=cia_13002\\n');",
        "else if (a[0] === 'start' && a[1] === 'aapd.service') proc.start(" + JSON.stringify(t.proc) + ", u.pid, " + JSON.stringify(t.bin) + ", " + JSON.stringify(t.run) + ", 'aapd');",
        "else if (a[0] === 'is-active') process.stdout.write('active\\n');",
    ].join('\n') + '\n');
    fs.chmodSync(path.join(d, 'bin', 'systemctl'), 0o755);
    t.reboot = path.join(d, 'bin', 'reboot');
    fs.writeFileSync(t.reboot, '#!/bin/sh\necho reboot >> "' + t.calls + '"\n' + (opts && opts.rebootFails ? 'exit 1\n' : ''));
    fs.chmodSync(t.reboot, 0o755);
    t.recmgr = path.join(d, 'recmgr.conf');
    var names = (opts && opts.recmgr) || [];
    fs.writeFileSync(t.recmgr, '[Whitelist]\n' + names.join('\n') + '\n[WhitelistExitSuccess]\n' + names.join('\n') + '\n');
    var boot = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(t.recmgr, boot - 3600, boot - 3600);
    fs.writeFileSync(path.join(d, 'stat'), 'btime ' + boot + '\n');
    t.shm = path.join(d, 'shm');
    /* the patches in memory: the preload library they name, the services'
     * user, and this boot's arming */
    fs.writeFileSync(path.join(d, 'libwocpatch.so'), 'a stand-in for libwocpatch.so\n');
    fs.writeFileSync(path.join(d, 'passwd'), 'root:x:0:0::/:/bin/sh\ncia_13002:x:13002:13002::/:/bin/false\n');
    t.env = Object.assign({}, process.env, {
        WOC_PRELOAD_LIB: path.join(d, 'libwocpatch.so'), WOC_PASSWD: path.join(d, 'passwd'), WOC_PRELOAD_DIR: t.run, WOC_AAPD_RUN_CONF: t.runConf,
        PATH: path.join(d, 'bin') + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: path.join(t.shm, 'patch.sock'), WOC_CARPLAY: t.carplay, WOC_AAPD: t.bin, WOC_AAPD_CONF: t.conf, WOC_CODING: t.coding,
        WOC_DF: t.df, WOC_MOUNT: mount, WOC_PROC_MOUNTS: t.mounts, WOC_PROC: t.proc, WOC_RECMGR_CONF: t.recmgr,
        WOC_RECMGR_AT_BOOT: path.join(d, 'none.json'), WOC_PROC_STAT: path.join(d, 'stat'), WOC_BOOT_ID: path.join(d, 'none'),
        WOC_UNIT_DIRS: path.join(d, 'units'), WOC_CAPTURE_SOCK: path.join(d, 'none.sock'), WOC_DLT_RECEIVE: path.join(d, 'none'),
        WOC_DLT_RETRY_MS: '600000', WOC_REBOOT_CMD: t.reboot, WOC_REMOUNT_LOCK: path.join(t.shm, 'remount.lock'),
        WOC_STATE_DIR: path.join(d, 'var'), WOC_RESTART_POLL_MS: '20', WOC_CARPLAY_DROPIN: path.join(d, 'dropin.conf'), WOC_AAPD_DROPIN: t.dropin,
        WOC_RECOVERY_STATE: path.join(d, 'var', 'boot-recovery.json'),
    });
    return t;
}
function hook(t, which) {
    var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'patchd.js'), which], { env: t.env, encoding: 'utf8', timeout: 90000 });
    var lines = (r.stdout || '').trim().split('\n'), last = {};
    try { last = JSON.parse(lines[lines.length - 1]); } catch (e) {}
    return { code: r.status, result: last, out: r.stdout + r.stderr };
}
function calls(t) { return fs.readFileSync(t.calls, 'utf8').split('\n').filter(Boolean); }
function marker(t, n) { try { return JSON.parse(fs.readFileSync(path.join(t.shm, n), 'utf8')); } catch (e) { return null; } }
function ro(t) { return /\bro\b/.test(fs.readFileSync(t.mounts, 'utf8')); }
function aaRecord(t) { try { return JSON.parse(fs.readFileSync(path.join(t.d, 'var', 'inmem-aapd.json'), 'utf8')); } catch (e) { return null; } }
function armedAa(t) { return fs.existsSync(path.join(t.run, 'aapd.env')); }
function noAaInmem(t) { return !aaRecord(t) && !armedAa(t) && !fs.existsSync(path.join(t.d, 'var', 'inmem-aapd.plan')) && !fs.existsSync(path.join(t.d, 'var', 'inmem-aapd.conf')); }
/* aapd's main process (pid) started now from the file on disk: armed when
 * this boot's env file is there. */
function aapdStarts(t, pid) {
    fs.writeFileSync(t.unitState, JSON.stringify({ pid: pid }));
    return proc.start(t.proc, pid, t.bin, t.run, 'aapd');
}
/* The next head-unit start: /dev/shm emptied, the boot step arms, aapd starts. */
function nextStart(t, pid) {
    ['aa-pending', 'activation-pending'].forEach(function (n) { try { fs.unlinkSync(path.join(t.shm, n)); } catch (e) {} });
    cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: t.env, encoding: 'utf8', timeout: 60000 });
    return aapdStarts(t, pid);
}

(function hooks() {
    var t = patchdUnit({ recmgr: ['carplay', 'aapd'] });
    var r = hook(t, 'activate');
    var rec = aaRecord(t);
    ok('activate: Android Auto armed in memory, pending its own marker, aapd and aapd.conf as they ship, / never remounted', r.code === 0 &&
        /Android Auto patch armed in memory/.test(r.result.aa && r.result.aa.status) && marker(t, 'aa-pending').action === 'apply' &&
        /next head-unit start/.test(r.result.reboot || '') && untouched(t) && ro(t) && !fs.readFileSync(t.mounts, 'utf8').match(/rw/), r.out);
    ok('activate: the record enabled, on trial, at 180 dpi with the card shown; the env, the plan and the copy in /run', !!rec && rec.enabled === true && rec.trial === true &&
        rec.writes.dpi === 180 && rec.writes.card === 'shown' && armedAa(t) && fs.existsSync(path.join(t.run, 'aapd.plan')) &&
        sha(t.runConf) === rec.copies.conf && density(fs.readFileSync(t.runConf, 'utf8')) === 180, JSON.stringify(rec));
    ok('activate: CarPlay ' + (HAVE_CP ? 'armed in memory alongside, its file as it ships' : 'refused on its own (not a carplay build)'),
        HAVE_CP ? /map patch armed in memory/.test(r.result.status) && marker(t, 'activation-pending').action === 'apply' && sha(t.carplay) === sha(CARPLAY)
            : /not patchable/.test(r.result.conflict || ''), JSON.stringify(r.result));
    ok('activate: no systemctl but its reads, no kill or reboot, even with recmgr\'s entries loaded', calls(t).every(function (l) { return /^systemctl show /.test(l); }),
        calls(t).join('; '));
    r = hook(t, 'activate');
    ok('activate again: the same plan armed, still pending, nothing written', r.code === 0 && /armed in memory/.test(r.result.aa.status) &&
        aaRecord(t).planSha256 === rec.planSha256 && marker(t, 'aa-pending').action === 'apply' && untouched(t), JSON.stringify(r.result));
    /* The next head-unit start runs it: aapd runs the plan. */
    nextStart(t, 4242);
    r = hook(t, 'activate');
    ok('activate with aapd running the plan: nothing pending', r.code === 0 && /aapd runs it already/.test(r.result.aa.status) && !marker(t, 'aa-pending'), JSON.stringify(r.result));
    r = hook(t, 'deactivate');
    ok('deactivate: the record, plan and copy gone, the next start stock; the files as they ship; the running patch pending removal', r.code === 0 &&
        noAaInmem(t) && untouched(t) && marker(t, 'aa-pending').action === 'revert' && ro(t), r.out);
    if (HAVE_CP) ok('deactivate: carplay as it ships, its plan gone', sha(t.carplay) === sha(CARPLAY) && !fs.existsSync(path.join(t.d, 'var', 'inmem-carplay.json')));

    /* An earlier release's patch on disk (an update from 0.12.1 or before):
     * put back as it ships, backups dropped, then planned in memory; the
     * running aapd, which runs that patch, kept linked. */
    var m = patchdUnit();
    patcher(m, ['apply', '--yes']);
    var mPatched = sha(m.bin);
    aapdStarts(m, 4343);
    r = hook(m, 'activate');
    ok('migration: aapd and aapd.conf back as they ship, no backup left, the patch armed in memory, pending', r.code === 0 && untouched(m) &&
        aaRecord(m) && aaRecord(m).enabled === true && armedAa(m) && marker(m, 'aa-pending').action === 'apply' && ro(m), r.out);
    ok('migration: the running aapd (the earlier patch) kept linked as aapd.woc-running', fs.existsSync(m.bin + '.woc-running') && sha(m.bin + '.woc-running') === mPatched);
    ['aa-pending'].forEach(function (n) { try { fs.unlinkSync(path.join(m.shm, n)); } catch (e) {} });
    r = hook(m, 'deactivate');
    ok('deactivate: the link aapd still runs goes to the deploy tool', (r.result.removeWhenUnused || []).indexOf(m.bin + '.woc-running') >= 0 && noAaInmem(m), JSON.stringify(r.result));

    /* An earlier release's Remove patch still waiting for the next start
     * (aapd not restartable then): an update in that boot leaves Android
     * Auto off, the backups kept. */
    var wr = patchdUnit();
    patcher(wr, ['apply', '--yes']);
    patcher(wr, ['revert', '--yes']);
    fs.writeFileSync(path.join(wr.shm, 'aa-pending'), JSON.stringify({ action: 'revert', reason: 'removed' }) + '\n');
    r = hook(wr, 'activate');
    ok('an earlier release\'s Remove patch waiting for the next start: an install leaves Android Auto off, nothing armed, the backups kept', r.code === 0 &&
        /turned off/.test(r.result.aa.status) && noAaInmem(wr) && fs.existsSync(wr.bin + '.woc-orig') && sha(wr.bin) === sha(SRC), JSON.stringify(r.result));

    /* An earlier patch beside another tool's change: left as it is, a
     * conflict, nothing armed. */
    var fo = patchdUnit();
    patcher(fo, ['apply', '--yes']);
    var fob = fs.readFileSync(fo.bin);
    fob[0x1000] ^= 1;
    fs.writeFileSync(fo.bin, fob);
    var foConf = sha(fo.conf);
    r = hook(fo, 'activate');
    ok('activate over our earlier patch beside another change: left as it is, a conflict, nothing armed', r.code === 0 &&
        /another change besides our earlier patch/.test(JSON.stringify(r.result.aa)) && fs.readFileSync(fo.bin).equals(fob) && sha(fo.conf) === foConf &&
        noAaInmem(fo) && !marker(fo, 'aa-pending'), r.out);

    /* Not supported, untested, absent: CarPlay is patched in memory as ever, except
     * on a car not coded 7, where CarPlay's patch is left too, with the
     * same conflict. */
    [['coding 9', function (u) { fs.writeFileSync(u.coding, coding(9)); }, /not supported on this car \(KI_KOMBI_VARIANT 9\)/],
     ['an untested aapd', function (u) { fs.writeFileSync(u.bin, UNPROVEN); }, /"conflict":"untested aapd build"/],
     ['an aapd the locator refuses', function (u) { var b = Buffer.from(SRC); b[LOC.gate.offset + 6] = 3; fs.writeFileSync(u.bin, b); }, /not patchable: gate: variant check not found/],
     ['an aapd without the config path', function (u) { var b = Buffer.from(SRC); b.write('/etc/aapd.cfg', LOC.confpath.offset, 'latin1'); fs.writeFileSync(u.bin, b); }, /not patchable: config path/],
     ['the proven aapd modified', function (u) { fs.writeFileSync(u.bin, Buffer.concat([SRC, Buffer.alloc(8)])); }, /aapd was modified by something else/],
     ['an aapd.conf without the 12.3" codec', function (u) { fs.writeFileSync(u.conf, SRCCONF.toString('utf8').replace(/"HIGH_1080P"\s*\]/, '"NONE"]')); }, /aapd\.conf not usable: no number/],
     /* an untested build is the conflict only when nothing else stands */
     ['an untested aapd and an aapd.conf without the 12.3" codec', function (u) {
         fs.writeFileSync(u.bin, UNPROVEN);
         fs.writeFileSync(u.conf, SRCCONF.toString('utf8').replace(/"HIGH_1080P"\s*\]/, '"NONE"]'));
     }, /"conflict":"aapd\.conf not usable: no number/],
     ['an untested aapd that aapd.service does not start', foreignAapd, /"conflict":"aapd\.service starts \/opt\/other\/aapd/],
     ['no aapd', function (u) { fs.unlinkSync(u.bin); }, /no Android Auto/]].forEach(function (c) {
        var u = patchdUnit();
        c[1](u);
        var before = fs.existsSync(u.bin) ? sha(u.bin) : null, confBefore = sha(u.conf);
        var x = hook(u, 'activate');
        ok('activate with ' + c[0] + ': Android Auto left as it is, nothing armed, exit 0', x.code === 0 && c[2].test(JSON.stringify(x.result.aa)) &&
            (before === null || sha(u.bin) === before) && sha(u.conf) === confBefore && !marker(u, 'aa-pending') && noAaInmem(u), x.out);
        if (HAVE_CP && c[0] === 'coding 9') ok('activate with ' + c[0] + ': CarPlay left as it is, the same conflict', x.result.conflict === 'not supported on this car (KI_KOMBI_VARIANT 9)' &&
            sha(u.carplay) === sha(CARPLAY) && !marker(u, 'activation-pending'), JSON.stringify(x.result));
        else if (HAVE_CP) ok('activate with ' + c[0] + ': CarPlay patched as ever, in memory', /map patch armed in memory/.test(x.result.status) && sha(u.carplay) === sha(CARPLAY), JSON.stringify(x.result));
    });

    /* A plan that cannot be made (here the patcher fails): aapd runs as it
     * ships, the status the error, and the next start's boot step plans it. */
    var pf = patchdUnit();
    var failJs = path.join(pf.d, 'plan-fails.js');
    fs.writeFileSync(failJs, 'if (/aapd_patch\\.js$/.test(process.argv[1] || "") && process.argv[2] === "plan") { process.stderr.write("error: an injected failure\\n"); process.exit(1); }\n');
    pf.env.NODE_OPTIONS = '--require=' + failJs;
    r = hook(pf, 'activate');
    rec = aaRecord(pf);
    ok('a plan that cannot be made: aapd runs as it ships, the record a plan still to make, the reason said, exit 0', r.code === 0 &&
        /could not be planned \(an injected failure\)/.test(r.result.aa.status) && !!rec && rec.needsPlan === true && !armedAa(pf) && untouched(pf), r.out);
    delete pf.env.NODE_OPTIONS;
    var bs = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: pf.env, encoding: 'utf8', timeout: 60000 });
    ok('... the next head-unit start\'s boot step plans it and arms that start', /planning the patch in memory again/.test(bs.stdout) && /aapd boot check: armed/.test(bs.stdout) &&
        aaRecord(pf).enabled === true && !aaRecord(pf).needsPlan && armedAa(pf) && untouched(pf), bs.stdout + bs.stderr);

    /* A removal that cannot undo an earlier patch on disk is refused. */
    var f = patchdUnit();
    patcher(f, ['apply', '--yes']);
    fs.writeFileSync(f.env.WOC_MOUNT, '#!/bin/sh\ncase "$*" in *rw*) exit 32;; esac\n');
    r = hook(f, 'deactivate');
    ok('deactivate: a remount failure that leaves an earlier patch on disk refuses the removal', r.code === 1 && sha(f.bin) !== sha(SRC) &&
        /Android Auto not undone/.test(JSON.stringify(r.result.aa)), r.out);

    /* A removal never leaves Android Auto patched behind: out of the hook's
     * time for its step, or its state unreadable, it is refused. */
    var late = patchdUnit();
    hook(late, 'activate');
    late.env.WOC_HOOK_DEADLINE_MS = '39000';
    r = hook(late, 'deactivate');
    ok('deactivate out of time for Android Auto: refused, the patch still armed (the tool keeps its recovery)', r.code === 1 &&
        /out of time/.test(JSON.stringify(r.result.aa)) && aaRecord(late) && aaRecord(late).enabled === true, r.out);
    var a2 = hook(late, 'activate');
    ok('activate out of time for Android Auto: the install goes on (exit 0)', a2.code === 0 && /out of time/.test(JSON.stringify(a2.result.aa)), a2.out);
    delete late.env.WOC_HOOK_DEADLINE_MS;
    fs.chmodSync(late.bin, 0);
    r = hook(late, 'deactivate');
    fs.chmodSync(late.bin, 0o755);
    ok('deactivate with aapd\'s state unreadable: refused, nothing changed', r.code === 1 && /unreadable/.test(JSON.stringify(r.result.aa)) && aaRecord(late).enabled === true, r.out);
    r = hook(late, 'deactivate');
    ok('deactivate once readable again: done, nothing of the patch left', r.code === 0 && noAaInmem(late) && untouched(late), r.out);

    /* A status cut short after its header (the patcher stopped before its
     * edit lines) is not read whole: a removal is refused until one is. */
    var cs = patchdUnit();
    patcher(cs, ['apply', '--yes']);
    var cutJs = path.join(cs.d, 'cut-status.js');
    fs.writeFileSync(cutJs, [
        "var m = /(aapd|carplay)_patch\\.js$/.exec(process.argv[1] || '');",
        "if (m && process.argv[2] === 'status' && process.env.WOC_CUT === m[1]) {",
        "    var w = process.stdout.write.bind(process.stdout), cut = false;",
        "    process.stdout.write = function (s) { if (cut) return true; if (/^proven:/.test(s)) { cut = true; if (process.env.WOC_CUT_EXIT) process.exitCode = 1; } return w(s); };",
        "}"].join('\n') + '\n');
    cs.env.NODE_OPTIONS = '--require=' + cutJs;
    cs.env.WOC_CUT = 'aapd';
    cs.env.WOC_CUT_EXIT = '';
    r = hook(cs, 'deactivate');
    ok('deactivate with aapd\'s status cut short, exit 0: refused, the earlier patch still on disk', r.code === 1 && /aapd status cut short/.test(JSON.stringify(r.result.aa)) &&
        sha(cs.bin) !== sha(SRC), r.out);
    cs.env.WOC_CUT_EXIT = '1';
    r = hook(cs, 'deactivate');
    ok('deactivate with aapd\'s status cut short, exit 1: refused, the earlier patch still on disk', r.code === 1 && /aapd status cut short/.test(JSON.stringify(r.result.aa)) &&
        sha(cs.bin) !== sha(SRC), r.out);
    if (HAVE_CP) {
        cs.env.WOC_CUT = 'carplay';
        r = hook(cs, 'deactivate');
        ok('deactivate with carplay\'s status cut short: refused', r.code === 1 && /carplay status cut short/.test(JSON.stringify(r.result)), r.out);
    }
    cs.env.WOC_CUT = '';
    r = hook(cs, 'deactivate');
    ok('deactivate once both statuses read whole: done, aapd and aapd.conf byte-exact', r.code === 0 && untouched(cs) && (!HAVE_CP || sha(cs.carplay) === sha(CARPLAY)), r.out);

    /* A firmware update replaced aapd under our backups: a removal leaves
     * it, as carplay's does; aapd.conf of ours is still restored. */
    var fw = patchdUnit();
    patcher(fw, ['apply', '--yes']);
    var newer = Buffer.concat([SRC, Buffer.from('firmware update')]);
    fs.writeFileSync(fw.bin, newer);
    r = hook(fw, 'deactivate');
    ok('deactivate over an aapd firmware update: exit 0, the new aapd left as it is, our aapd.conf restored', r.code === 0 && sha(fw.bin) === sha(newer) &&
        sha(fw.conf) === sha(SRCCONF) && /another build than its backup/.test(r.out), r.out);
    ok('a second removal attempt passes too', hook(fw, 'deactivate').code === 0);
    var fw2 = patchdUnit();
    patcher(fw2, ['apply', '--yes']);
    fs.writeFileSync(fw2.bin, newer);
    fs.writeFileSync(fw2.conf, SRCCONF);
    r = hook(fw2, 'deactivate');
    ok('deactivate with only another aapd build beside our backups: exit 0, left as it is', r.code === 0 && sha(fw2.bin) === sha(newer) &&
        /another build than our backup/.test(JSON.stringify(r.result.aa)), r.out);

    /* A removal passes only when nothing of Android Auto's is left to undo:
     * aapd restored but aapd.conf not is refused. */
    var half = patchdUnit();
    patcher(half, ['apply', '--yes']);
    fs.mkdirSync(half.conf + '.woc-tmp');
    r = hook(half, 'deactivate');
    ok('deactivate with aapd restored but aapd.conf\'s write failing: refused, aapd.conf\'s backup kept', r.code === 1 && sha(half.bin) === sha(SRC) &&
        sha(half.conf) !== sha(SRCCONF) && fs.existsSync(half.conf + '.woc-orig') && /not undone/.test(JSON.stringify(r.result.aa)), r.out);
    fs.rmdirSync(half.conf + '.woc-tmp');
    r = hook(half, 'deactivate');
    ok('deactivate once aapd.conf can be written: restored byte-exact', r.code === 0 && untouched(half), r.out);
    var nbk = patchdUnit();
    patcher(nbk, ['apply', '--yes']);
    [nbk.bin, nbk.conf].forEach(function (x) { fs.unlinkSync(x + '.woc-orig'); fs.unlinkSync(x + '.woc-orig.json'); });
    r = hook(nbk, 'deactivate');
    ok('deactivate with no backups, the proven files patched: both byte-exact, exit 0', r.code === 0 && sha(nbk.bin) === sha(SRC) && sha(nbk.conf) === sha(SRCCONF), r.out);
    var nbu = patchdUnit();
    fs.writeFileSync(nbu.bin, UNPROVEN);
    patcher(nbu, ['apply', '--unproven', '--yes']);
    fs.unlinkSync(nbu.bin + '.woc-orig'); fs.unlinkSync(nbu.bin + '.woc-orig.json');
    var nbuBin = sha(nbu.bin);
    r = hook(nbu, 'deactivate');
    ok('deactivate with an untested aapd patched and its backup gone: refused, exit 1, our edits named, aapd as it was', r.code === 1 && sha(nbu.bin) === nbuBin &&
        sha(nbu.conf) === sha(SRCCONF) && /Android Auto not undone \(aapd none, aapd\.conf original, our edits read in it\)/.test(JSON.stringify(r.result.aa)), r.out);
    var norec = patchdUnit();
    fs.writeFileSync(norec.conf, SRCCONF.toString('utf8').replace(/"RACK_MODE"\s*:\s*\w+/, '"RACK_MODE": 1'));
    var norecConf = sha(norec.conf);
    patcher(norec, ['apply', '--yes']);
    fs.unlinkSync(norec.conf + '.woc-orig.json');
    r = hook(norec, 'deactivate');
    ok('deactivate with aapd.conf\'s backup unrecorded: refused, its backup kept', r.code === 1 && sha(norec.bin) === sha(SRC) &&
        sha(norec.conf) !== norecConf && fs.existsSync(norec.conf + '.woc-orig') && /not undone/.test(JSON.stringify(r.result.aa)), r.out);
    ok('status names what is left to undo', /^undo:\s+aapd original, aapd\.conf untrusted$/m.test(status(norec)), status(norec));
})();

/* patchd's socket: one connection, its status events and replies. */
function daemon(t) {
    try { fs.unlinkSync(t.env.WOC_PATCH_SOCK); } catch (e) {}
    var c = cp.spawn(process.execPath, [path.join(PATCH, 'patchd.js')], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    var log = '';
    c.stdout.on('data', function (b) { log += b; });
    c.stderr.on('data', function (b) { log += b; });
    return new Promise(function (resolve) {
        (function wait(n) {
            if (fs.existsSync(t.env.WOC_PATCH_SOCK)) {
                var s = net.connect(t.env.WOC_PATCH_SOCK), buf = '', waiters = [];
                var api = { msgs: [], log: function () { return log; }, proc: c,
                    send: function (o) { s.write(JSON.stringify(o) + '\n'); },
                    next: function (pred, ms) {
                        return new Promise(function (res, rej) {
                            var tm = setTimeout(function () { rej(new Error('timeout; log: ' + log.slice(-800))); }, ms || 20000);
                            waiters.push({ pred: pred, res: function (m) { clearTimeout(tm); res(m); } });
                        });
                    } };
                s.setEncoding('utf8');
                s.on('data', function (d) {
                    buf += d;
                    var i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        var m = JSON.parse(buf.slice(0, i));
                        buf = buf.slice(i + 1);
                        api.msgs.push(m);
                        waiters = waiters.filter(function (w) { if (w.pred(m)) { w.res(m); return false; } return true; });
                    }
                });
                s.on('connect', function () { resolve(api); });
                return;
            }
            if (n > 200) throw new Error('patchd did not listen: ' + log);
            setTimeout(function () { wait(n + 1); }, 50);
        })(0);
    });
}
function cropEnv(t) { try { return fs.readFileSync(path.join(t.d, 'var', 'aa-crop.env'), 'utf8'); } catch (e) { return null; } }
function aaDone(m) { return m.ev === 'status' && m.aa && m.aa.state !== 'busy' && !/^(applying|reverting)$/.test(m.aa.reason || ''); }
/* A dummy aapd main process for patchd's SIGKILL, as unit.json's pid. */
function dummyAapd(t) {
    var c = cp.spawn('sleep', ['300']);
    children.push(c);
    c.died = new Promise(function (r) { c.on('exit', function (code, sig) { r(sig); }); });
    aapdStarts(t, c.pid);
    return c;
}

async function socketTests() {
    /* Without recmgr's aapd entry: armed in memory, deferred, aapd never
     * touched, its files as they ship. */
    var t = patchdUnit({ recmgr: ['carplay'] });
    var p = await daemon(t);
    var st = await p.next(function (m) { return m.ev === 'status'; });
    ok('status: Android Auto original, its density and range', st.aa.state === 'original' && st.aa.density === 180, JSON.stringify(st.aa));
    p.send({ cmd: 'aa-apply' });
    st = await p.next(function (m) { return aaDone(m) && m.aa.aapd; });
    ok('aa-apply without recmgr\'s aapd entry: armed in memory, deferred, pending marker, no systemctl but reads, the files as they ship', st.aa.aapd === 'deferred' &&
        st.aa.pending === 'apply' && marker(t, 'aa-pending').action === 'apply' && armedAa(t) && untouched(t) &&
        !calls(t).some(function (l) { return /aapd/.test(l) && !/^systemctl show/.test(l); }) && ro(t), JSON.stringify(st.aa) + calls(t).join(';'));
    ok('a pending patch is removable', st.aa.removable === true, JSON.stringify(st.aa));
    /* Remove patch while that patch waits: aapd runs as it ships already,
     * so nothing waits. */
    p.send({ cmd: 'aa-revert' });
    st = await p.next(function (m) { return aaDone(m) && m.aa.state === 'original'; });
    var off = aaRecord(t);
    ok('Remove patch of the pending patch: disarmed, turned off by the user, nothing pending, not removable, the files as they ship', !st.aa.pending && !st.aa.aapd &&
        !armedAa(t) && off && off.enabled === false && off.by === 'user' && !marker(t, 'aa-pending') && st.aa.removable === false && untouched(t), JSON.stringify(st.aa));
    p.send({ cmd: 'aa-apply' });
    st = await p.next(function (m) { return aaDone(m) && m.aa.pending === 'apply'; });
    ok('Patch again: the record keeps what it ran (none: on trial), armed', aaRecord(t).enabled === true && armedAa(t), JSON.stringify(aaRecord(t)));

    p.send({ cmd: 'aa-density', value: 155 });
    st = await p.next(function (m) { return m.ev === 'refused'; });
    ok('aa-density: a value off the steps is refused', /150-400/.test(st.reason), JSON.stringify(st));
    p.send({ cmd: 'aa-density', value: 240 });
    st = await p.next(function (m) { return aaDone(m) && m.aa.aapd && m.aa.dpi === 240; });
    ok('aa-density: planned again with a copy at 240 dpi, armed; aapd.conf as it ships', density(fs.readFileSync(t.runConf, 'utf8')) === 240 &&
        aaRecord(t).writes.dpi === 240 && sha(t.conf) === sha(SRCCONF) && fs.readFileSync(path.join(t.d, 'var', 'aa-density'), 'utf8').trim() === '240', JSON.stringify(st.aa));
    p.send({ cmd: 'status' });
    var spaced = await p.next(function (m) { return m.ev === 'status'; });
    p.send({ cmd: 'aa-density', value: 200 });
    st = await p.next(function (m) { return m.ev === 'refused'; });
    ok('aa-density: a second change within 10 s is refused, nothing planned; status says when one is taken again', /moments ago/.test(st.reason) &&
        spaced.aa.changeAt > Date.now() && spaced.aa.changeAt <= Date.now() + 10000 && aaRecord(t).writes.dpi === 240, JSON.stringify([st, spaced.aa]));
    ok('aa-density: pending, planned at 240 dpi, aapd still running as it ships', spaced.aa.pending === 'apply' && spaced.aa.dpi === 240 &&
        spaced.aa.runDpi === null && marker(t, 'aa-pending').run === null, JSON.stringify(spaced.aa));

    /* Restart head unit: once, then refused, and refused again by a new patchd within 10 min. */
    fs.writeFileSync(t.env.WOC_BOOT_ID, 'boot-R\n');
    p.send({ cmd: 'reboot' });
    var rb = await p.next(function (m) { return m.ev === 'reboot-reply'; });
    for (var i = 0; i < 250 && calls(t).indexOf('reboot') < 0; i++) await sleep(20);
    ok('reboot: a pending Android Auto change is enough; one reboot', rb.ok === true && calls(t).filter(function (l) { return l === 'reboot'; }).length === 1, JSON.stringify(rb));
    ok('reboot: the boot it was asked in is recorded for boot recovery', fs.readFileSync(path.join(t.d, 'var', 'restart-requested'), 'utf8') === 'boot-R\n');
    p.send({ cmd: 'reboot' });
    rb = await p.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('reboot: a second request is refused while the first runs', rb.ok === false && /already in progress/.test(rb.reason), JSON.stringify(rb));
    p.proc.kill('SIGKILL');
    await sleep(100);
    var p2 = await daemon(t);
    p2.send({ cmd: 'reboot' });
    rb = await p2.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('reboot: a restarted patchd refuses within 10 minutes of the last request', rb.ok === false && /possible again in \d+ min/.test(rb.reason) &&
        calls(t).filter(function (l) { return l === 'reboot'; }).length === 1, JSON.stringify(rb));
    p2.proc.kill('SIGKILL');

    /* A reboot that fails takes out only its own record. */
    var f = patchdUnit({ rebootFails: true });
    var older = Date.now() - 11 * 60 * 1000;
    fs.writeFileSync(path.join(f.d, 'var', 'reboots.json'), JSON.stringify({ at: [older] }));
    fs.writeFileSync(path.join(f.shm, 'aa-pending'), JSON.stringify({ action: 'apply' }));
    var pf = await daemon(f);
    pf.send({ cmd: 'reboot' });
    rb = await pf.next(function (m) { return m.ev === 'reboot-reply' && m.ok === false; });
    var rec = JSON.parse(fs.readFileSync(path.join(f.d, 'var', 'reboots.json'), 'utf8')).at;
    ok('reboot: a failed reboot takes out its own record only, and can be asked again', rec.length === 0 || (rec.length === 1 && rec[0] === older), JSON.stringify(rec));
    ok('reboot: a failed reboot leaves no restart for boot recovery', !fs.existsSync(path.join(f.d, 'var', 'restart-requested')));
    pf.send({ cmd: 'reboot' });
    rb = await pf.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('reboot: after a failed reboot a new request is accepted', rb.ok === true, JSON.stringify(rb));
    await pf.next(function (m) { return m.ev === 'reboot-reply' && m.ok === false; });
    pf.proc.kill('SIGKILL');

    /* With recmgr's aapd entry and the drop-in loaded: SIGKILL, start, the
     * killed run recorded; the started aapd runs the plan. */
    var r = patchdUnit({ recmgr: ['aapd'] });
    var victim = dummyAapd(r);
    var pr = await daemon(r);
    await pr.next(function (m) { return m.ev === 'status'; });
    pr.send({ cmd: 'aa-apply' });
    st = await pr.next(function (m) { return aaDone(m) && m.aa.aapd; });
    var sig = await Promise.race([victim.died, sleep(3000)]);
    ok('aa-apply with recmgr\'s aapd entry: aapd SIGKILLed and started armed, nothing pending, the files as they ship', st.aa.aapd === 'restarted' && sig === 'SIGKILL' &&
        calls(r).indexOf('systemctl start aapd.service') >= 0 && !marker(r, 'aa-pending') && ro(r) && untouched(r), JSON.stringify(st.aa) + calls(r).join(';'));
    pr.send({ cmd: 'status' });
    st = await pr.next(function (m) { return aaDone(m); });
    ok('status: Patched, 180 dpi, card shown', st.aa.state === 'patched' && st.aa.dpi === 180 && st.aa.diskCard === 'shown' && !st.aa.pending, JSON.stringify(st.aa));
    ok('aa-apply: the killed run is recorded for the watcher', fs.readFileSync(path.join(r.shm, 'aapd-killed'), 'utf8').trim() === 'run-' + victim.pid);
    ok('aa-apply: never a systemctl stop, restart or reboot', !calls(r).some(function (l) { return /systemctl (stop|restart)|reboot/.test(l); }), calls(r).join(';'));
    ok('aa-apply: carplay untouched', !calls(r).some(function (l) { return /carplay/.test(l) && !/^systemctl show carplay/.test(l); }) && (HAVE_CP ? sha(r.carplay) === sha(CARPLAY) : true));
    /* Hiding the card changes the render's crop, which it reads at start:
     * the copy and the crop wait for the next head-unit start. */
    var before = calls(r).length;
    pr.send({ cmd: 'aa-card', value: 'hidden' });
    st = await pr.next(function (m) { return aaDone(m) && m.aa.aapd; });
    ok('aa-card hidden: planned again, the crop override written, deferred, aapd not restarted', st.aa.aapd === 'deferred' && st.aa.card === 'hidden' &&
        cropEnv(r) === 'WOC_SRC_CROP=-s src_crop=1280x720:0,156,1280,564\n' && marker(r, 'aa-pending').action === 'apply' && aaRecord(r).writes.card === 'hidden' &&
        !calls(r).slice(before).some(function (l) { return /aapd/.test(l) && !/^systemctl show/.test(l); }), JSON.stringify(st.aa) + calls(r).slice(before).join(';'));
    ok('aa-card hidden: what aapd runs until then is the card shown', st.aa.runDpi === 180 && st.aa.runCard === 'shown' && st.aa.diskCard === 'hidden', JSON.stringify(st.aa));
    dummyAapd(r);
    nextStart(r, JSON.parse(fs.readFileSync(r.unitState, 'utf8')).pid);
    pr.send({ cmd: 'status' });
    st = await pr.next(function (m) { return aaDone(m); });
    ok('after the head-unit start: aapd runs the hidden card\'s plan, nothing pending', st.aa.state === 'patched' && st.aa.diskCard === 'hidden' && !st.aa.pending, JSON.stringify(st.aa));
    var v2 = dummyAapd(r);
    pr.send({ cmd: 'aa-revert' });
    st = await pr.next(function (m) { return aaDone(m) && (m.aa.state === 'original' || m.aa.pending === 'revert'); });
    var sig2 = await Promise.race([v2.died, sleep(3000)]);
    ok('aa-revert: aapd restarted stock, the files as they ship, the crop override gone', st.aa.state === 'original' && st.aa.aapd === 'restarted' && sig2 === 'SIGKILL' &&
        untouched(r) && cropEnv(r) === null && !armedAa(r), JSON.stringify(st.aa));
    pr.proc.kill('SIGKILL');

    /* Android Auto's Patch button patches a build outside the proven list,
     * which an install leaves. */
    var un = patchdUnit();
    fs.writeFileSync(un.bin, UNPROVEN);
    var pu = await daemon(un);
    st = await pu.next(function (m) { return m.ev === 'status'; });
    ok('untested aapd: status original with the conflict', st.aa.state === 'original' && st.aa.conflict === 'untested aapd build', JSON.stringify(st.aa));
    pu.send({ cmd: 'aa-apply' });
    st = await pu.next(function (m) { return aaDone(m) && m.aa.aapd; });
    ok('untested aapd: Patch plans it (--unproven), the conflict gone, the file as it is', st.aa.pending === 'apply' && !st.aa.conflict && sha(un.bin) === sha(UNPROVEN) &&
        aaRecord(un).args.indexOf('--unproven') >= 0 && aaRecord(un).proven === false && aaRecord(un).trial === false, JSON.stringify(st.aa));
    pu.proc.kill('SIGKILL');
    fs.unlinkSync(path.join(un.shm, 'aa-pending'));
    var ua = hook(un, 'activate');
    ok('untested aapd once enabled: an install keeps it planned like a proven one', ua.code === 0 && !ua.result.aa.conflict && aaRecord(un).enabled === true, ua.out);
    ua = hook(un, 'deactivate');
    ok('untested aapd: a removal removes the plan, the file as it is', ua.code === 0 && sha(un.bin) === sha(UNPROVEN) && sha(un.conf) === sha(SRCCONF) && noAaInmem(un), ua.out);

    /* Patch refuses what the app does not offer it for: an untested aapd
     * that aapd.service does not start, an unusable aapd.conf. */
    var refused = [['an untested aapd that aapd.service does not start', foreignAapd, /aapd\.service starts \/opt\/other\/aapd/], ['an aapd.conf without the 12.3" codec', function (u) {
        fs.writeFileSync(u.conf, SRCCONF.toString('utf8').replace(/"HIGH_1080P"\s*\]/, '"NONE"]'));
    }, /aapd\.conf not usable/]];
    for (var ri = 0; ri < refused.length; ri++) {
        var fu = patchdUnit();
        refused[ri][1](fu);
        var binBefore = sha(fu.bin), confBefore = sha(fu.conf);
        var pf2 = await daemon(fu);
        await pf2.next(function (m) { return m.ev === 'status'; });
        pf2.send({ cmd: 'aa-apply' });
        st = await pf2.next(function (m) { return m.ev === 'status' && m.aa && m.aa.state === 'error'; });
        ok('Patch with ' + refused[ri][0] + ': refused with the conflict, nothing written or armed', refused[ri][2].test(st.aa.reason) &&
            sha(fu.bin) === binBefore && sha(fu.conf) === confBefore && noAaInmem(fu) && !marker(fu, 'aa-pending'), JSON.stringify(st.aa));
        pf2.proc.kill('SIGKILL');
    }

    /* Patch while the connect-time read is still running (aapd_patch.js
     * status slowed to 3 s) checks a read made after it arrived, not the
     * daemon's placeholder state. */
    var slow = patchdUnit();
    foreignAapd(slow);
    slowStatus(slow);
    var ps = await daemon(slow);
    await sleep(1000);
    ps.send({ cmd: 'aa-apply' });
    st = await ps.next(function (m) { return m.ev === 'status' && m.aa && m.aa.state === 'error'; }, 30000);
    ok('Patch during the connect-time read: refused with the foreign start, nothing written', /aapd\.service starts \/opt\/other\/aapd/.test(st.aa.reason) &&
        sha(slow.bin) === sha(UNPROVEN) && sha(slow.conf) === sha(SRCCONF) && noAaInmem(slow), JSON.stringify(st.aa));
    ps.proc.kill('SIGKILL');

    /* A density change during the connect-time read on a patched unit
     * applies it, whatever the daemon's placeholder state says. */
    var sd = patchdUnit();
    hook(sd, 'activate');
    slowStatus(sd);
    var psd = await daemon(sd);
    await sleep(1000);
    psd.send({ cmd: 'aa-density', value: 200 });
    st = await psd.next(function (m) { return aaDone(m) && m.aa.dpi === 200; }, 40000);
    ok('a density change during the connect-time read: planned at 200 dpi', aaRecord(sd).writes.dpi === 200 && density(fs.readFileSync(sd.runConf, 'utf8')) === 200, JSON.stringify(st.aa));
    psd.proc.kill('SIGKILL');

    /* Zoom and the turn card under a conflict other than an untested build
     * (aapd.service starting another program): each refused with the
     * conflict, neither the choice nor the plan written. */
    var zc = patchdUnit();
    hook(zc, 'activate');
    fs.mkdirSync(path.join(zc.d, 'units', 'aapd.service.d'));
    fs.writeFileSync(path.join(zc.d, 'units', 'aapd.service.d', 'x.conf'), '[Service]\nExecStart=\nExecStart=/opt/other/aapd\n');
    var zPlan = aaRecord(zc).planSha256, zCopy = sha(zc.runConf);
    var pz = await daemon(zc);
    await pz.next(function (m) { return m.ev === 'status'; });
    pz.send({ cmd: 'aa-density', value: 200 });
    st = await pz.next(function (m) { return m.ev === 'refused' && m.cmd === 'aa-density'; });
    ok('Zoom under a foreign start: refused with the conflict, nothing written', /aapd\.service starts \/opt\/other\/aapd/.test(st.reason) &&
        aaRecord(zc).planSha256 === zPlan && sha(zc.runConf) === zCopy && !fs.existsSync(path.join(zc.d, 'var', 'aa-density')), JSON.stringify(st));
    await pz.next(function (m) { return m.ev === 'status' && m.aa && m.aa.state !== 'busy'; });
    pz.send({ cmd: 'aa-card', value: 'hidden' });
    st = await pz.next(function (m) { return m.ev === 'refused' && m.cmd === 'aa-card'; });
    ok('the turn card under a foreign start: refused with the conflict, not for the spacing; nothing written', /aapd\.service starts \/opt\/other\/aapd/.test(st.reason) &&
        sha(zc.runConf) === zCopy && !fs.existsSync(path.join(zc.d, 'var', 'aa-card')) && cropEnv(zc) === null, JSON.stringify(st));
    pz.proc.kill('SIGKILL');

    /* A density or card change is busy from the moment it is accepted:
     * nothing else starts meanwhile, a reboot included. */
    var b = patchdUnit();
    fs.writeFileSync(path.join(b.shm, 'activation-pending'), JSON.stringify({ action: 'apply' }));
    hook(b, 'activate');
    var pb = await daemon(b);
    await pb.next(function (m) { return m.ev === 'status'; });
    pb.send({ cmd: 'aa-density', value: 200 });
    pb.send({ cmd: 'aa-revert' });
    st = await pb.next(function (m) { return m.ev === 'refused' && m.cmd === 'aa-revert'; });
    ok('Zoom then Android Auto\'s Remove patch button: the second is refused as busy', /another operation/.test(st.reason), JSON.stringify(st));
    pb.send({ cmd: 'status' });
    st = await pb.next(function (m) { return m.ev === 'status'; });
    ok('while it runs, status says busy for Android Auto, keeps the values planned and leaves CarPlay\'s state', st.busy === 'aa' &&
        st.aa.state === 'busy' && st.aa.dpi === 180 && st.aa.diskCard === 'shown' && st.state !== 'busy', JSON.stringify(st));
    pb.send({ cmd: 'revert' });
    st = await pb.next(function (m) { return m.ev === 'refused' && m.cmd === 'revert'; });
    ok('Zoom then CarPlay\'s Remove patch button: refused as busy', /another operation/.test(st.reason), JSON.stringify(st));
    pb.send({ cmd: 'reboot' });
    var rb2 = await pb.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('Zoom then Restart head unit: refused while it runs', rb2.ok === false && /another operation/.test(rb2.reason), JSON.stringify(rb2));
    await pb.next(function (m) { return aaDone(m) && m.aa.dpi === 200; });
    ok('the zoom itself completes, planned at 200 dpi', aaRecord(b).writes.dpi === 200);
    pb.proc.kill('SIGKILL');

    /* What aapd runs, taken before each change and kept in the marker:
     * the first deferred change's stays through a second; a marker
     * without it (an older patchd's) stays without. */
    var n = patchdUnit();
    n.env.WOC_DENSITY_SPACING_MS = '1';
    hook(n, 'activate');
    nextStart(n, 4646);   /* the next head-unit start ran it */
    var pn = await daemon(n);
    await pn.next(function (m) { return aaDone(m) && m.aa.state === 'patched'; });
    pn.send({ cmd: 'aa-density', value: 200 });
    st = await pn.next(function (m) { return aaDone(m) && m.aa.aapd; });
    var run = marker(n, 'aa-pending').run;
    ok('a deferred change: the marker\'s run is what aapd ran before it', !!run && run.dpi === 180 && run.card === 'shown' &&
        st.aa.runDpi === 180 && st.aa.dpi === 200, JSON.stringify([marker(n, 'aa-pending'), st.aa]));
    pn.send({ cmd: 'aa-card', value: 'hidden' });
    st = await pn.next(function (m) { return aaDone(m) && m.aa.diskCard === 'hidden'; });
    run = marker(n, 'aa-pending').run;
    ok('a second deferred change keeps the first run', !!run && run.dpi === 180 && run.card === 'shown' &&
        st.aa.runDpi === 180 && st.aa.runCard === 'shown', JSON.stringify([marker(n, 'aa-pending'), st.aa]));
    fs.writeFileSync(path.join(n.shm, 'aa-pending'), JSON.stringify({ action: 'apply' }) + '\n');
    pn.send({ cmd: 'aa-density', value: 190 });
    st = await pn.next(function (m) { return aaDone(m) && m.aa.dpi === 190; });
    ok('a marker without run stays without', !marker(n, 'aa-pending').hasOwnProperty('run') && st.aa.runDpi === undefined,
        JSON.stringify([marker(n, 'aa-pending'), st.aa]));
    pn.proc.kill('SIGKILL');

    /* An operation takes what aapd runs from a read that starts after its
     * command: aa-apply sent while a status read runs (patchd just started,
     * nothing read yet) still finds the pending marker and keeps its run. */
    var fr = patchdUnit();
    hook(fr, 'activate');
    fs.writeFileSync(path.join(fr.shm, 'aa-pending'), JSON.stringify({ action: 'apply', run: { dpi: 180, card: 'shown' } }) + '\n');
    fs.writeFileSync(path.join(fr.d, 'var', 'aa-density'), '200\n');
    var pf3 = await daemon(fr);
    pf3.send({ cmd: 'status' });
    pf3.send({ cmd: 'status' });
    pf3.send({ cmd: 'aa-apply' });
    st = await pf3.next(function (m) { return aaDone(m) && m.aa.dpi === 200; });
    run = marker(fr, 'aa-pending').run;
    ok('aa-apply during a status read: run from a read after the command, the marker\'s', !!run && run.dpi === 180 && run.card === 'shown',
        JSON.stringify(marker(fr, 'aa-pending')));
    pf3.proc.kill('SIGKILL');

    /* Nothing changes without the remount lock: held by another process,
     * an operation gives up and writes nothing. */
    var l = patchdUnit();
    l.env.WOC_OP_LOCK_WAIT_MS = '500';
    var pl = await daemon(l);
    await pl.next(function (m) { return m.ev === 'status'; });
    fs.writeFileSync(l.env.WOC_REMOUNT_LOCK, '1 held by another\n');
    pl.send({ cmd: 'aa-apply' });
    st = await pl.next(function (m) { return m.ev === 'status' && m.aa && m.aa.state === 'error'; });
    ok('lock held elsewhere: Android Auto\'s Patch button gives up, nothing written or armed, / never remounted', /another change to \/ is running/.test(st.aa.reason) &&
        untouched(l) && noAaInmem(l) && ro(l), JSON.stringify(st.aa));
    fs.unlinkSync(l.env.WOC_REMOUNT_LOCK);

    /* A deferred change whose pending marker cannot be written: patchd
     * reports it and stays up. */
    fs.mkdirSync(path.join(l.shm, 'aa-pending'));
    pl.send({ cmd: 'aa-apply' });
    st = await pl.next(function (m) { return aaDone(m) && (m.aa.aapd || m.aa.state === 'error' || m.aa.pending); });
    pl.send({ cmd: 'status' });
    var alive = await pl.next(function (m) { return m.ev === 'status'; });
    ok('a pending marker that cannot be written does not take patchd down', !!alive && pl.proc.exitCode === null, JSON.stringify(st.aa));
    pl.proc.kill('SIGKILL');
}

/* ---- boot recovery for aapd ---- */
var recovery = require('../recovery.js');
var record = require('../patch_record.js');
/* The aapd watcher on an earlier release's patch of aapd (its backup and
 * record) in a folder of its own, with systemd and the restore stubbed. */
function fakeRec(opts) {
    var d = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aarec-'));
    dirs.push(d);
    var t = recovery.targets({ state: path.join(d, 'boot-recovery.json'), sock: path.join(d, 'patch.sock'), carplay: path.join(d, 'carplay'),
        aapd: path.join(d, 'aapd'), aapdConf: path.join(d, 'aapd.conf') }).aapd;
    if (!opts.dir) {
        fs.writeFileSync(t.target + '.woc-orig', 'aapd\n');
        fs.writeFileSync(t.target + '.woc-orig.json', JSON.stringify({ sha256_original: sha(Buffer.from('aapd\n')) }));
        fs.writeFileSync(t.target, 'patched aapd\n');
        record.write(t.target, { patched: true, proven: true });
    }
    if (opts.killed) fs.writeFileSync(t.killed, opts.killed + '\n');
    var now = 0, ev = [], info = opts.info || { state: 'active', run: 'r1', pid: 1 };
    var rec = new recovery.Recovery({
        target: t, bootId: opts.boot || 'B1', healthyMs: 60000,
        restore: function (f, cb) { ev.push('restore'); cb(opts.restoreFails ? new Error('remount lock held; deferring') : null, 'restored'); },
        disarm: function (f, cb, why) { ev.push('disarm ' + why); cb(null, 'restored'); },
        probe: function (cb) { cb(rec.info); }, systemState: function (cb) { cb('running'); },
        start: function (cb) { ev.push('start'); cb(null); },
        alive: function () { return false; },
        recmgrLoaded: function (n) { ev.push('recmgr ' + n); return opts.recmgr !== false; },
        lock: { tryAcquire: function () { return true; }, release: function () {} }, now: function () { return now; }, log: function () {},
    });
    rec.info = info;
    rec.ev = ev;
    rec.dir = d;
    rec.advance = function (ms) { now += ms; };
    return rec;
}
function tick(rec) { return new Promise(function (res) { rec.tick(res); }); }

async function recoveryTests() {
    var a = fakeRec({});
    await new Promise(function (r) { a.startBoot(r); });
    a.info = { state: 'failed', result: 'signal', code: '2', status: '9', run: 'r1', pid: 0 };
    a.advance(6000);
    var x = await tick(a);
    ok('aapd SIGKILLed by another (Result=signal, status 9): no crash, started again', x.action === 'killed' && a.ev.indexOf('recmgr aapd') >= 0, JSON.stringify(x));
    for (var i = 0; i < 6; i++) { a.advance(5000); await tick(a); }
    ok('aapd killed: started once 5 s later', a.ev.filter(function (e) { return e === 'start'; }).length === 1 && a.ev.indexOf('restore') < 0, a.ev.join(','));

    var b = fakeRec({});
    await new Promise(function (r) { b.startBoot(r); });
    var crashes = 0;
    for (var run = 1; run <= 5; run++) {
        b.info = { state: 'failed', result: 'core-dump', code: '3', status: '11', run: 'c' + run, pid: 0 };
        b.advance(70000);
        var y = await tick(b);
        if (y.action === 'crash') crashes++;
        await tick(b);   /* the same run seen again: no second count */
        b.advance(70000);
        await tick(b);
    }
    var starts = b.ev.filter(function (e) { return e === 'start'; }).length;
    ok('aapd crashes (an earlier release\'s patch on disk): each run counted once, restored at the first, before its start', crashes === 5 &&
        b.ev.indexOf('restore') >= 0 && b.ev.indexOf('restore') < b.ev.indexOf('start'), b.ev.join(','));
    ok('aapd crashes: started again after every one, no limit a boot', starts === 5, String(starts));
    var st = JSON.parse(fs.readFileSync(b.statePath, 'utf8'));
    ok('aapd crashes: the starts since the last healthy run are on disk', st.starts && st.starts.n === 5, JSON.stringify(st));

    /* The delays: 2, 5, 15, 30 s, then 60 s each time; a healthy run makes
     * the next one quick again. A clean exit is followed by a start too. */
    var w = fakeRec({});
    await new Promise(function (r) { w.startBoot(r); });
    async function endAndWait(run2, how) {
        w.info = how === 'exit' ? { state: 'inactive', result: 'success', code: '1', status: '0', run: run2, pid: 0, started: true }
            : { state: 'failed', result: 'core-dump', code: '3', status: '11', run: run2, pid: 0 };
        w.advance(1000);
        await tick(w);
        var before = w.ev.filter(function (e) { return e === 'start'; }).length, waited = 0;
        while (w.ev.filter(function (e) { return e === 'start'; }).length === before && waited < 120000) { w.advance(1000); waited += 1000; await tick(w); }
        return waited;
    }
    var delays = [];
    for (i = 1; i <= 7; i++) delays.push(await endAndWait('w' + i));
    ok('aapd: started again 2, 5, 15, 30, then 60 s after each end in a row', JSON.stringify(delays) === JSON.stringify([2000, 5000, 15000, 30000, 60000, 60000, 60000]), JSON.stringify(delays));
    w.info = { state: 'active', run: 'h1', pid: 7 };
    w.advance(1000); await tick(w);
    w.advance(61000); await tick(w);
    ok('aapd: after a healthy run, an exit is followed by a start 2 s later', await endAndWait('h1', 'exit') === 2000);
    /* A crash of the aapd a pending change replaced: nothing counted or
     * restored; the start runs the file on disk and the marker goes. */
    var pend = fakeRec({ info: { state: 'active', run: 'p1', pid: 5 } });
    await new Promise(function (r) { pend.startBoot(r); });
    pend.advance(1000); await tick(pend);
    fs.writeFileSync(pend.target.pending, '{"action":"apply","boot":"B1"}\n');
    pend.advance(1000); await tick(pend);
    pend.info = { state: 'failed', result: 'core-dump', code: '3', status: '6', run: 'p1', pid: 0 };
    for (i = 0; i < 5; i++) { pend.advance(1000); await tick(pend); }
    ok('a crash of the run a pending change replaced the file of: not counted, not restored, started',
        pend.ev.indexOf('restore') < 0 && pend.ev.indexOf('start') >= 0 &&
        JSON.parse(fs.readFileSync(pend.statePath, 'utf8')).arm.crashes === 0, pend.ev.join(','));
    pend.info = { state: 'active', run: 'p2', pid: 6 };
    pend.advance(1000); await tick(pend);
    pend.info = { state: 'failed', result: 'core-dump', code: '3', status: '6', run: 'p2', pid: 0 };
    for (i = 0; i < 3; i++) { pend.advance(1000); await tick(pend); }
    ok('then a crash of the run started after it, with the marker still there: restored at once', pend.ev.indexOf('restore') >= 0, pend.ev.join(','));
    var pw = fakeRec({ info: { state: 'active', run: 'q1', pid: 5 } });
    fs.writeFileSync(pw.target.pending, '{"action":"apply","boot":"B1"}\n');
    await new Promise(function (r) { pw.startBoot(r); });
    pw.advance(1000); await tick(pw);
    pw.info = { state: 'failed', result: 'core-dump', code: '3', status: '6', run: 'q1', pid: 0 };
    for (i = 0; i < 5; i++) { pw.advance(1000); await tick(pw); }
    ok('a watcher started with the marker there: the crash of the run it found up is not counted', pw.ev.indexOf('restore') < 0 && pw.ev.indexOf('start') >= 0, pw.ev.join(','));

    var f1 = fakeRec({ boot: 'F1' });
    await new Promise(function (r) { f1.startBoot(r); });
    fs.writeFileSync(path.join(f1.dir, 'shutdown-aapd'), 'F1 failed crash\n');
    var fb = await new Promise(function (r) { fakeRec({ boot: 'F2', dir: f1.dir, restoreFails: true }).startBoot(r); });
    var fw = await new Promise(function (r) { fakeRec({ boot: 'F2', dir: f1.dir }).startBoot(r); });
    ok('a boot-step restore after aapd\'s crash that failed: the watcher restores at its start', fb.action === 'restore-failed' && fw.action === 'restored',
        JSON.stringify([fb, fw]));

    var never = fakeRec({});
    await new Promise(function (r) { never.startBoot(r); });
    never.info = { state: 'inactive', result: 'success', code: '', status: '', run: 'n0', pid: 0, started: false };
    for (i = 0; i < 30; i++) { never.advance(5000); await tick(never); }
    ok('aapd that never ran (a start condition not met) is not started', never.ev.indexOf('start') < 0, never.ev.join(','));

    var k = fakeRec({ killed: 'pk' });
    k.info = { state: 'failed', result: 'signal', code: '2', status: '9', run: 'pk', pid: 0 };
    await new Promise(function (r) { k.startBoot(r); });
    k.advance(6000);
    var z = await tick(k);
    ok('patchd\'s own kill (aapd-killed) is neither a crash nor started again', z.action === 'watch' && k.ev.indexOf('start') < 0, JSON.stringify(z));

    var nr = fakeRec({ recmgr: false });
    await new Promise(function (r) { nr.startBoot(r); });
    nr.info = { state: 'failed', result: 'core-dump', code: '3', status: '6', run: 'x1', pid: 0 };
    nr.advance(6000);
    await tick(nr);
    for (i = 0; i < 20; i++) { nr.advance(5000); await tick(nr); }
    ok('without recmgr\'s aapd entry: the crash recorded, aapd not started', nr.ev.indexOf('start') < 0 && JSON.parse(fs.readFileSync(nr.statePath, 'utf8')).arm.crashes === 1);

    /* The patch in memory: a crash of an armed start turns it off at once
     * (aapd's own threshold), before the start that follows, which runs
     * aapd as it ships; nothing written to the files. */
    var im = patchdUnit({ recmgr: ['aapd'] });
    hook(im, 'activate');
    nextStart(im, 4747);
    var iEnv = Object.assign({}, im.env);
    var watcher = cp.spawnSync(process.execPath, ['-e', [
        'var r = require(process.argv[1]), t = r.TARGETS.aapd, ev = [], now = 0, info = { state: "active", run: "a1", pid: 4747 };',
        'var x = new r.Recovery({ target: t, bootId: "IM", healthyMs: 60000, probe: function (cb) { cb(info); }, systemState: function (cb) { cb("running"); },',
        '  start: function (cb) { ev.push("start"); cb(null); }, alive: function () { return false; }, recmgrLoaded: function () { return true; },',
        '  lock: { tryAcquire: function () { return true; }, release: function () {} }, now: function () { return now; }, log: function (l) { ev.push(l); } });',
        'x.startBoot(function () {',
        '  info = { state: "failed", result: "core-dump", code: "3", status: "11", run: "a1", pid: 0 }; now += 6000;',
        '  x.tick(function (res) { var n = 0; (function loop() { if (n++ > 10) { console.log(JSON.stringify({ res: res, ev: ev })); return; } now += 3000; x.tick(loop); })(); });',
        '});'].join('\n'), path.join(PATCH, 'recovery.js')], { env: iEnv, encoding: 'utf8', timeout: 60000 });
    var wres = {};
    try { wres = JSON.parse(watcher.stdout.trim().split('\n').pop()); } catch (e) {}
    var irec = aaRecord(im);
    ok('a crash of aapd armed in memory: turned off at once (recovery, crash), the next start stock, started again, the files as they ship',
        !!irec && irec.enabled === false && irec.by === 'recovery' && irec.why === 'crash' && !armedAa(im) && untouched(im) &&
        (wres.ev || []).indexOf('start') >= 0, watcher.stdout + watcher.stderr + JSON.stringify(irec));
    var ih = hook(im, 'activate');
    ok('after that crash an install of the same revision leaves Android Auto off and says why', ih.code === 0 &&
        /removed the patch after the patched aapd crashed/.test(ih.result.aa.status) && aaRecord(im).enabled === false && !armedAa(im), JSON.stringify(ih.result));
    var older = aaRecord(im);
    older.rev = ap.PATCH_REV - 1;
    fs.writeFileSync(path.join(im.d, 'var', 'inmem-aapd.json'), JSON.stringify(older) + '\n');
    ih = hook(im, 'activate');
    ok('a patch of an older revision a crash turned off: an install plans this one, on trial', ih.code === 0 && aaRecord(im).enabled === true && aaRecord(im).trial === true &&
        aaRecord(im).rev === ap.PATCH_REV && armedAa(im), JSON.stringify(ih.result));

    /* Across boots: a crash at start (mark failed) restores before
     * aapd; a switch-off (mark running) counts nothing. */
    var d = fakeRec({ boot: 'B1' });
    await new Promise(function (r) { d.startBoot(r); });
    fs.writeFileSync(path.join(d.dir, 'shutdown-aapd'), 'B1 failed crash\n');
    var r2 = await new Promise(function (r) { fakeRec({ boot: 'B2', dir: d.dir }).startBoot(r); });
    ok('boot step: a boot whose patched aapd crashed restores before aapd starts', r2.action === 'restored', JSON.stringify(r2));
    var s1 = fakeRec({ boot: 'S1' });
    await new Promise(function (r) { s1.startBoot(r); });
    fs.writeFileSync(path.join(s1.dir, 'shutdown-aapd'), 'S1 running\n');
    var rs = await new Promise(function (r) { fakeRec({ boot: 'S2', dir: s1.dir }).startBoot(r); });
    ok('boot step: a switch-off within seconds (mark running) is no failure', rs.action === 'armed' && rs.fails === 0, JSON.stringify(rs));

    /* The real boot step on copies: an earlier release's patch put back
     * before aapd starts, whatever the count, / read-only, then planned and
     * armed for that start. */
    var t = patchdUnit();
    patcher(t, ['apply', '--yes']);
    fs.writeFileSync(path.join(t.d, 'var', 'aa-boot-recovery.json'), JSON.stringify({ fails: 0, unknown: 0, arm: null }));
    fs.writeFileSync(path.join(t.d, 'bootid'), 'new\n');
    var env = Object.assign({}, t.env, { WOC_BOOT_ID: path.join(t.d, 'bootid') });
    var res = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: env, encoding: 'utf8', timeout: 60000 });
    ok('real boot step over an earlier release\'s patch: put back byte-exact, no backup left, / read-only, then armed in memory, exit 0', res.status === 0 && untouched(t) && ro(t) &&
        /restored the original aapd in/.test(res.stdout) && /aapd boot check: armed/.test(res.stdout) && armedAa(t) && aaRecord(t).enabled === true, res.stdout + res.stderr);
    ok('real boot step: carplay\'s counter untouched', !fs.existsSync(path.join(t.d, 'var', 'boot-recovery.json')));
    /* At the threshold the plan's start is left stock: turned off, nothing
     * remounted. */
    fs.writeFileSync(path.join(t.d, 'var', 'aa-boot-recovery.json'), JSON.stringify({ fails: 1, unknown: 0, arm: { boot: 'new', crashes: 0, at: 0 } }));
    fs.writeFileSync(path.join(t.d, 'var', 'shutdown-aapd'), 'new failed crash\n');
    fs.writeFileSync(path.join(t.d, 'bootid'), 'newer\n');
    var mountsBefore = fs.readFileSync(t.mounts, 'utf8');
    res = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: env, encoding: 'utf8', timeout: 60000 });
    ok('real boot step at the threshold of a patch in memory: turned off, the start stock, / not remounted', res.status === 0 && aaRecord(t).enabled === false &&
        aaRecord(t).by === 'recovery' && !armedAa(t) && untouched(t) && fs.readFileSync(t.mounts, 'utf8') === mountsBefore && /aapd boot check: restored/.test(res.stdout),
        res.stdout + res.stderr);

    /* A restore cut short after aapd (aapd.conf still patched): patchd
     * reports the restore; an install leaves the patch off and puts the
     * leftover back. */
    var q = patchdUnit();
    patcher(q, ['apply', '--yes']);
    var patchedConf = fs.readFileSync(q.conf);
    var qr = cp.spawnSync(process.execPath, ['-e', 'var r = require(process.argv[1]); r.restoreTarget(r.TARGETS.aapd, true, 2, function (e, o) { process.stdout.write(String(e || o)); });',
        path.join(PATCH, 'recovery.js')], { env: q.env, encoding: 'utf8' });
    fs.writeFileSync(q.conf, patchedConf);
    var qh = hook(q, 'activate');
    ok('a restore that left aapd.conf patched: an install leaves Android Auto off, says why and puts the leftover back', qr.stdout === 'restored' && sha(q.bin) === sha(SRC) &&
        sha(q.conf) === sha(SRCCONF) && noAaInmem(q) && /boot recovery removed the patch after 2 failed head-unit starts/.test((qh.result.aa || {}).status || ''),
        qr.stdout + qr.stderr + ' ' + JSON.stringify(qh.result));

    /* A restore after a crash of an earlier release's patch: an install of
     * the same patch revision leaves it off and says why; one of a newer
     * revision than the removed patch's applies it again, in memory. */
    var cr = patchdUnit();
    patcher(cr, ['apply', '--yes']);
    var crr = cp.spawnSync(process.execPath, ['-e', 'var r = require(process.argv[1]); r.restoreTarget(r.TARGETS.aapd, true, 1, function (e, o) { process.stdout.write(String(e || o)); }, 0, "crash");',
        path.join(PATCH, 'recovery.js')], { env: cr.env, encoding: 'utf8' });
    var crRec = record.current(cr.bin), crh = hook(cr, 'activate');
    ok('a restore after a crash: recorded with why and the revision; an install of that revision leaves Android Auto off and says why',
        crr.stdout === 'restored' && crRec.why === 'crash' && crRec.rev === ap.PATCH_REV && sha(cr.bin) === sha(SRC) && noAaInmem(cr) &&
        /removed the patch after the patched aapd crashed/.test((crh.result.aa || {}).status || ''), crr.stdout + crr.stderr + ' ' + JSON.stringify(crh.result));
    record.write(cr.bin, { patched: false, by: 'recovery', at: crRec.at, fails: 1, why: 'crash' });
    crh = hook(cr, 'activate');
    ok('a patch of an older revision that a crash removed: an install plans this one in memory, the files as they ship', untouched(cr) &&
        aaRecord(cr) && aaRecord(cr).enabled === true && armedAa(cr), JSON.stringify(crh.result));

    /* The boot step's SIGTERM waits for a put-back in progress. */
    var u = patchdUnit();
    patcher(u, ['apply', '--yes']);
    var remounting = path.join(u.d, 'remounting');
    fs.writeFileSync(u.env.WOC_MOUNT, '#!/bin/sh\ncase "$*" in *rw*) : > "' + remounting + '";; esac\nsleep 1\ncase "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + u.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + u.mounts + '";; esac\n');
    var envU = Object.assign({}, u.env, { WOC_BOOT_ID: path.join(u.d, 'bootid') });
    fs.writeFileSync(path.join(u.d, 'bootid'), 'x\n');
    var ch = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: envU });
    children.push(ch);
    var chOut = '';
    ch.stdout.on('data', function (d) { chOut += d; });
    ch.stderr.on('data', function (d) { chOut += d; });
    for (var wait = 0; wait < 300 && !fs.existsSync(remounting); wait++) await sleep(50);
    ch.kill('SIGTERM');
    await new Promise(function (res2) { ch.on('exit', res2); });
    ok('boot step: SIGTERM mid-put-back lets it finish, / read-only', fs.existsSync(remounting) && sha(u.bin) === sha(SRC) && ro(u), chOut);

    /* Both boot steps over earlier patches in the same boot: they share the
     * remount lock, and each waits for the other's put-back. */
    if (HAVE_CP) {
        var both = patchdUnit();
        patcher(both, ['apply', '--yes']);
        var cpr = cp.spawnSync(process.execPath, [earlier.script(), 'apply', '--panel', 'high', '--target', both.carplay, '--yes'], { encoding: 'utf8' });
        fs.writeFileSync(both.env.WOC_MOUNT, '#!/bin/sh\nsleep 1\ncase "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + both.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + both.mounts + '";; esac\n');
        fs.writeFileSync(path.join(both.d, 'bootid'), 'b\n');
        var be = Object.assign({}, both.env, { WOC_BOOT_ID: path.join(both.d, 'bootid') });
        var ends = await Promise.all(['carplay', 'aapd'].map(function (nm) {
            return new Promise(function (res3) {
                var c = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', nm], { env: be });
                var o = '';
                c.stdout.on('data', function (dd) { o += dd; });
                c.on('exit', function () { res3(o); });
            });
        }));
        ok('both boot steps over earlier patches at once: each puts back, one after the other', cpr.status === 0 && /restored the original carplay in/.test(ends[0]) &&
            /restored the original aapd in/.test(ends[1]) && sha(both.carplay) === sha(CARPLAY) && untouched(both) && ro(both), ends.join(' | '));
    }

    /* A boot cut off with no record of its own counts for the service
     * that crashed in it, not for the other; with no crash of either it is
     * unknown for carplay (power lost), and the second such boot in a row
     * counts one. */
    [[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 1]].forEach(function (c) {
        var xu = patchdUnit();
        var vs = path.join(xu.d, 'var');
        var planText = 'wocplan test\n', cst0 = fs.statSync(xu.carplay);
        fs.writeFileSync(path.join(vs, 'inmem-carplay.plan'), planText);
        fs.writeFileSync(path.join(vs, 'inmem-carplay.json'), JSON.stringify({ v: 1, enabled: true, target: xu.carplay, ino: cst0.ino, size: cst0.size,
            mtime: cst0.mtime.getTime(), sha256: sha(xu.carplay), planSha256: crypto.createHash('sha256').update(planText).digest('hex'), proven: true, trial: false }) + '\n');
        fs.writeFileSync(path.join(vs, 'boot-recovery.json'), JSON.stringify({ fails: 0, unknown: c[3], arm: { boot: 'old', crashes: 0 } }));
        fs.writeFileSync(path.join(vs, 'aa-boot-recovery.json'), JSON.stringify({ fails: 0, unknown: 0, prev: null, arm: { boot: 'old', crashes: c[0] } }));
        fs.writeFileSync(path.join(xu.d, 'bootid'), 'new\n');
        var e = Object.assign({}, xu.env, { WOC_BOOT_ID: path.join(xu.d, 'bootid') });
        cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'carplay'], { env: e, encoding: 'utf8', timeout: 30000 });
        var cst = JSON.parse(fs.readFileSync(path.join(vs, 'boot-recovery.json'), 'utf8'));
        ok(c[0] ? 'an unrecorded end after aapd crashed in that boot is not carplay\'s failure'
            : c[3] ? 'a second unrecorded end in a row with no aapd crash counts one for carplay' : 'a first unrecorded end with no aapd crash is unknown for carplay (power lost)',
            cst.fails === c[1] && cst.unknown === c[2] && cst.arm.boot === 'new', JSON.stringify(cst));
    });

    /* shutdown_mark.sh: aapd SIGKILLed is stopped (no crash), as for its
     * watcher; carplay's record is unchanged. */
    var md = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-mark-'));
    dirs.push(md);
    fs.writeFileSync(path.join(md, 'boot_id'), 'B\n');
    fs.writeFileSync(path.join(md, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=failed\\nResult=signal\\nExecMainCode=2\\nExecMainStatus=9\\n"\n');
    fs.chmodSync(path.join(md, 'systemctl'), 0o755);
    fs.mkdirSync(path.join(md, 'state'));
    var mr = cp.spawnSync('sh', [path.join(PATCH, 'shutdown_mark.sh')], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(md, 'state'),
        WOC_BOOT_ID: path.join(md, 'boot_id'), WOC_SYSTEMCTL: path.join(md, 'systemctl'), WOC_MARK_WAIT: '2' }), stdio: 'ignore' });
    ok('shutdown mark: a SIGKILLed aapd is stopped, a SIGKILLed carplay (no drop-in) failed', mr.status === 0 &&
        /^B stopped up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown-aapd'), 'utf8')) && /^B failed up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown'), 'utf8')));
    fs.writeFileSync(path.join(md, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=failed\\nResult=signal\\nExecMainCode=2\\nExecMainStatus=90\\n"\n');
    cp.spawnSync('sh', [path.join(PATCH, 'shutdown_mark.sh')], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(md, 'state'),
        WOC_BOOT_ID: path.join(md, 'boot_id'), WOC_SYSTEMCTL: path.join(md, 'systemctl'), WOC_MARK_WAIT: '2' }), stdio: 'ignore' });
    ok('shutdown mark: another signal end of aapd is failed', /^B failed up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown-aapd'), 'utf8')));
    fs.writeFileSync(path.join(md, 'state', 'shutdown-aapd'), 'B stopped\n');
    fs.writeFileSync(path.join(md, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=failed\\nResult=oom-kill\\nExecMainCode=2\\nExecMainStatus=9\\n"\n');
    cp.spawnSync('sh', [path.join(PATCH, 'shutdown_mark.sh')], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(md, 'state'),
        WOC_BOOT_ID: path.join(md, 'boot_id'), WOC_SYSTEMCTL: path.join(md, 'systemctl'), WOC_MARK_WAIT: '2' }), stdio: 'ignore' });
    ok('shutdown mark: an oom-killed aapd (status 9) is failed', /^B failed up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown-aapd'), 'utf8')));

    ok('the units\' timeouts cover the restore bound', [/TimeoutStartSec=(\d+)/, /TimeoutStopSec=(\d+)/].every(function (re) {
        return Number(re.exec(fs.readFileSync(path.join(PATCH, '..', 'systemd', 'waze-on-cluster-aa-boot.service'), 'utf8'))[1]) * 1000 > recovery.BOOT_BOUND_MS + 5000;
    }));
    var unitText = fs.readFileSync(path.join(PATCH, '..', 'systemd', 'waze-on-cluster-aa-boot.service'), 'utf8');
    ok('the aa boot unit runs before aapd.service, after the coding, a oneshot', /^Before=aapd\.service$/m.test(unitText) && /^After=.*codingshm\.service/m.test(unitText) &&
        /^Type=oneshot$/m.test(unitText) && /recovery\.js boot aapd$/m.test(unitText));
    var dropin = fs.readFileSync(path.join(PATCH, '..', 'systemd', 'aapd.service.d', '50-waze-on-cluster.conf'), 'utf8');
    ok('aapd.service\'s drop-in reads the env file of an armed start, optional', /^EnvironmentFile=-\/run\/woc-preload\/aapd\.env$/m.test(dropin) &&
        !/^(ExecStart|Environment|User|SuccessExitStatus)=/m.test(dropin));
    var comp = JSON.parse(fs.readFileSync(path.join(PATCH, '..', 'component.json'), 'utf8'));
    ok('component.json: aapd and every unit in recmgr, aapd a crash name, no boot unit restarted on update, the aapd drop-in installed',
        ['aapd', 'carplay'].concat(comp.units.filter(function (x2) { return /\.(service|socket)$/.test(x2.name); })
            .map(function (x2) { return x2.name.replace(/\.(service|socket)$/, ''); })).every(function (n2) { return comp.recmgr.indexOf(n2) >= 0; }) &&
        comp.crashNames.indexOf('aapd') >= 0 && !comp.restart.some(function (x2) { return /boot/.test(x2); }) &&
        comp.dropins.some(function (x2) { return x2.unit === 'aapd.service' && x2.from === 'systemd/aapd.service.d/50-waze-on-cluster.conf'; }), JSON.stringify(comp.recmgr));
}

/* Android Auto on a head unit that refuses our parts, and on MID and HIGH F. */
function headUnitTests() {
    var NOT = headUnit.REFUSED;
    var t = unit();
    headUnit.set(headUnit.NONE);
    var r = plan(t);
    ok('no hwvariant=: the aapd plan refuses with the reason line, writes nothing', r.code !== 0 && r.out === 'error: refusing: ' + NOT + '\n' && untouched(t) && !fs.existsSync(r.plan), r.out);
    headUnit.set(null);
    r = plan(t);
    ok('no kernel command line: the aapd plan refuses, writes nothing', r.code !== 0 && /unknown variant is not supported \(kernel command line unreadable\)/.test(r.out) && untouched(t), r.out);
    [['MID', headUnit.MID], ['HIGH F', headUnit.HIGHF]].forEach(function (v) {
        headUnit.set(v[1]);
        r = plan(t);
        ok(v[0] + ': the aapd plan is made', r.code === 0 && untouched(t), r.out);
    });
    headUnit.set(headUnit.HIGH);
    patcher(t, ['apply', '--yes']);
    headUnit.set(headUnit.NONE);
    r = patcher(t, ['revert', '--yes']);
    ok('no hwvariant=: aapd revert restores both files an earlier release patched', r.code === 0 && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF), r.out);

    var u = patchdUnit();
    r = hook(u, 'activate');
    ok('no hwvariant=: activate leaves Android Auto, the conflict, no marker, nothing armed', r.code === 0 && r.result.aa && r.result.aa.conflict === 'not supported on this car (' + NOT + ')' &&
        untouched(u) && !marker(u, 'aa-pending') && noAaInmem(u), JSON.stringify(r.result));

    var b = patchdUnit();
    headUnit.set(headUnit.HIGH);
    patcher(b, ['apply', '--yes']);
    headUnit.set(headUnit.NONE);
    fs.writeFileSync(path.join(b.d, 'bootid'), 'new\n');
    var env = Object.assign({}, b.env, { WOC_BOOT_ID: path.join(b.d, 'bootid') });
    r = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: env, encoding: 'utf8', timeout: 60000 });
    ok('no hwvariant=: the boot step restores aapd and aapd.conf before aapd starts, below the threshold, / read-only, nothing armed', r.status === 0 &&
        sha(b.bin) === sha(SRC) && sha(b.conf) === sha(SRCCONF) && ro(b) && /aapd boot check: restored/.test(r.stdout) && !armedAa(b), r.stdout + r.stderr);

    var c = patchdUnit();
    headUnit.set(headUnit.HIGH);
    patcher(c, ['apply', '--yes']);
    fs.appendFileSync(c.conf, '# another tool\n');
    var conf2 = sha(c.conf);
    headUnit.set(headUnit.NONE);
    var mcalls = path.join(c.d, 'mount.calls');
    fs.writeFileSync(c.env.WOC_MOUNT, '#!/bin/sh\necho "$*" >> "' + mcalls + '"\n' +
        'case "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + c.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + c.mounts + '";; esac\n');
    var bootEnv = Object.assign({}, c.env, { WOC_BOOT_ID: path.join(c.d, 'bootid') });
    function boot(id) {
        fs.writeFileSync(path.join(c.d, 'bootid'), id + '\n');
        try { fs.unlinkSync(mcalls); } catch (e) {}
        return cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: bootEnv, encoding: 'utf8', timeout: 60000 });
    }
    r = boot('b1');
    ok('no hwvariant=, aapd.conf changed by another tool: aapd restored, the conf left', r.status === 0 && sha(c.bin) === sha(SRC) && sha(c.conf) === conf2 &&
        fs.existsSync(mcalls) && ro(c), r.stdout + r.stderr);
    r = boot('b2');
    ok('no hwvariant=, aapd.conf changed by another tool: the next boot leaves / alone', r.status === 0 && !fs.existsSync(mcalls) && /aapd boot check: idle/.test(r.stdout), r.stdout + r.stderr);

    /* A car 0.8.2's boot recovery restored on HIGH F (the files at their
     * originals, our backups beside them): the first install there applies
     * Android Auto's patch again, in memory, pending; none after it, nor on
     * HIGH, nor over an untrusted backup. */
    function restored(unitV, mark) {
        var x = patchdUnit();
        headUnit.set(headUnit.HIGH);
        patcher(x, ['apply', '--yes']);
        patcher(x, ['revert', '--yes']);
        if (mark) fs.writeFileSync(path.join(x.d, 'var', 'highf-repatched'), '{"carplay":"applied","aa":"applied"}\n');
        headUnit.set(unitV);
        return x;
    }
    var x = restored(headUnit.HIGHF);
    r = hook(x, 'activate');
    ok('HIGH F restored by 0.8.2: Android Auto applied again in memory, pending; the backups gone, the files as they ship', r.code === 0 && r.result.aa && r.result.aa.reset === true &&
        untouched(x) && aaRecord(x).enabled === true && marker(x, 'aa-pending') && marker(x, 'aa-pending').action === 'apply' &&
        JSON.parse(fs.readFileSync(path.join(x.d, 'var', 'highf-repatched'), 'utf8')).aa === 'applied', JSON.stringify(r.result));
    [['HIGH F, marker present', function () { return restored(headUnit.HIGHF, true); }], ['HIGH', function () { return restored(headUnit.HIGH); }]].forEach(function (cs) {
        var y = cs[1]();
        r = hook(y, 'activate');
        ok(cs[0] + ': Android Auto stays off', r.code === 0 && sha(y.bin) === sha(SRC) && !marker(y, 'aa-pending') && /turned off/.test(r.result.aa.status) && !aaRecord(y),
            JSON.stringify(r.result));
    });
    var z = restored(headUnit.HIGHF);
    fs.writeFileSync(z.bin + '.woc-orig.json', JSON.stringify({ sha256_original: '0'.repeat(64) }));
    r = hook(z, 'activate');
    var zMark = {};
    try { zMark = JSON.parse(fs.readFileSync(path.join(z.d, 'var', 'highf-repatched'), 'utf8')); } catch (e) {}
    ok('HIGH F, untrusted aapd backup: Android Auto stays off, left for the next install', r.code === 0 && sha(z.bin) === sha(SRC) &&
        !marker(z, 'aa-pending') && !zMark.aa && !aaRecord(z), JSON.stringify(r.result));
    headUnit.set(headUnit.HIGH);
}

(async function () {
    headUnitTests();
    await socketTests();
    await recoveryTests();
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
})().catch(function (e) { ok('no exception', false, e.stack); process.exit(1); });
