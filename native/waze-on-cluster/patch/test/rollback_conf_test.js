#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Every released waze-on-cluster against the settings files this version
 * leaves. This version does not read waze-on-cluster.local.conf; earlier
 * ones do, so it stays on the unit, one each release starts with: with the
 * opt-in keys (hosted_vpp_scale, always_packed) turned on, and on a car whose
 * local conf has the owner's settings, the app's map settings and the opt-in
 * keys, through an install or update (patchd activate), a head-unit start
 * (patchd's daemon), a downgrade (Undo update), Remove and uninstall (patchd
 * deactivate), a reinstall, an update cut short or undone, and a move cut
 * short between its two writes; a removal is refused while the local conf
 * cannot be rewritten; a unit without a local conf is left without one; and
 * every release whose code reads features.conf, where the keys live, knows
 * them.
 *
 * A release loads its shipped waze-on-cluster.conf first and refuses to
 * start with a key it does not know, so a key that file sets is one the
 * release knows. A local conf every key of which the release's shipped conf
 * sets is one the release starts with (its Config::load: '#' starts a
 * comment, key = value or key += value). The release tags come from the
 * repository's git, fetched when missing.
 *
 *   node rollback_conf_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit, for patchd's hooks */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var REPO = path.join(__dirname, '..', '..', '..', '..');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function git(args) { return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }); }

/* ---- the releases ------------------------------------------------------- */

function cmp(a, b) { a = a.split('.').map(Number); b = b.split('.').map(Number); for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
function tags() {
    try { return git(['tag', '-l', 'waze-on-cluster@*']).split('\n').filter(Boolean); } catch (e) { return null; }
}
var list = tags();
if (list === null) { process.stdout.write('SKIP: not in a git checkout\n'); process.exit(0); }
if (!list.length) {
    var shallow = false;
    try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch (e) {}
    try { git(['fetch', '--no-tags'].concat(shallow ? ['--depth=1'] : [], ['origin', '+refs/tags/waze-on-cluster@*:refs/tags/waze-on-cluster@*'])); } catch (e) {}
    list = tags() || [];
}
var RELEASES = list.map(function (t) { return t.slice('waze-on-cluster@'.length); }).filter(function (v) { return /^\d+\.\d+\.\d+$/.test(v); }).sort(cmp);
ok('every release from 0.5.0 to 0.10.9 is at hand', ['0.5.0', '0.10.7', '0.10.8', '0.10.9'].every(function (v) { return RELEASES.indexOf(v) >= 0; }),
    RELEASES.join(' '));
if (!RELEASES.length) process.exit(1);

/* A conf's lines as Config::load reads them: [key, value] or [null, line]
 * for one without '='. */
function lines(text) {
    return text.split('\n').map(function (l) { return l.replace(/#.*/, '').trim(); }).filter(Boolean).map(function (l) {
        var eq = l.indexOf('=');
        return eq < 0 ? [null, l] : [l.slice(0, eq).trim().replace(/\s*\+$/, ''), l.slice(eq + 1).trim()];
    });
}
var KNOWN = {}, READS_FEATURES = {};
RELEASES.forEach(function (v) {
    var tag = 'waze-on-cluster@' + v;
    KNOWN[v] = lines(git(['show', tag + ':native/waze-on-cluster/waze-on-cluster.conf'])).map(function (kv) { return kv[0]; });
    var hits = '';
    try {
        hits = git(['grep', '-l', '-e', 'features.conf', '-e', 'features_file', tag, '--', 'native/waze-on-cluster',
            'native/cluster-render', ':(exclude,glob)**/*.md', ':(exclude,glob)**/test/**']);
    } catch (e) {
        if (e.status !== 1) throw e;   /* 1: no match */
    }
    READS_FEATURES[v] = hits.trim();
});
/* The releases that would refuse to start with this local conf, each with
 * the line it refuses. A release reads a local conf when its shipped conf
 * sets local_conf; one that does not cannot refuse it. */
function refusing(text) {
    var out = [];
    RELEASES.filter(function (v) { return KNOWN[v].indexOf('local_conf') >= 0; }).forEach(function (v) {
        var bad = lines(text).filter(function (kv) { return kv[0] === null || KNOWN[v].indexOf(kv[0]) < 0; });
        if (bad.length) out.push(v + ' (' + (bad[0][0] || bad[0][1]) + ')');
    });
    return out;
}

var OPT_IN = ['hosted_vpp_scale', 'always_packed'];
/* A release that reads features.conf takes the keys from it: it must know
 * them, so none that refuses them (every one up to 0.10.7, below) reads it. */
var unknowing = RELEASES.filter(function (v) {
    return READS_FEATURES[v] && OPT_IN.some(function (k) { return KNOWN[v].indexOf(k) < 0; });
});
ok('every release that reads features.conf knows the opt-in keys', unknowing.length === 0,
    unknowing.map(function (v) { return v + ': ' + READS_FEATURES[v]; }).join('; '));
/* The local conf the owner keeps: keys every release knows. */
var USER = '# mine\ntarget_fps = 20\npan_blocks = 1\n';
ok('every release starts with the owner\'s own local conf', refusing(USER).length === 0, refusing(USER).join(' '));
/* What this test guards against: every release up to 0.10.7 refuses an
 * opt-in key in the local conf. */
var UP_TO_0107 = RELEASES.filter(function (v) { return cmp(v, '0.10.7') <= 0; });
OPT_IN.forEach(function (k) {
    var refused = refusing(USER + k + ' = 1\n').map(function (r) { return r.split(' ')[0]; });
    var accepted = UP_TO_0107.filter(function (v) { return refused.indexOf(v) < 0; });
    ok('every release up to 0.10.7 refuses ' + k + ' in the local conf', accepted.length === 0, accepted.join(' '));
});

/* ---- this version's patchd on a temporary /var/opt/waze-on-cluster ------- */

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rollback-conf-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});
var STATE = path.join(dir, 'state'), LOCAL = path.join(STATE, 'waze-on-cluster.local.conf'), FEATURES = path.join(STATE, 'features.conf');
var MAP_STATE = path.join(STATE, 'map.state.conf');
var SOCK = path.join(dir, 'shm', 'patch.sock');
fs.mkdirSync(STATE);
var ENV = Object.assign({}, process.env, {
    WOC_PATCH_SOCK: SOCK,
    WOC_PATCH_GROUP: '',
    WOC_LOCAL_CONF: LOCAL,
    WOC_STATE_DIR: STATE,
    WOC_CARPLAY: path.join(dir, 'no-carplay'),
    WOC_AAPD: path.join(dir, 'no-aapd'),
    WOC_STREAM_STATE: path.join(dir, 'no-stream.json'),
    WOC_RESYNC_FILE: path.join(dir, 'resync.json'),
    WOC_RECMGR_CONF: path.join(dir, 'no-recmgr'),
    WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_PROC_STAT: path.join(dir, 'no-stat'),
    WOC_PROC: path.join(dir, 'no-proc'),
    WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
    WOC_MOUNT: '/usr/bin/false',
    WOC_PROC_MOUNTS: path.join(dir, 'no-mounts'),
    WOC_SYSTEMCTL: '/usr/bin/false',
    WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
    WOC_DLT_RETRY_MS: '600000',
    WOC_REMOUNT_LOCK: path.join(dir, 'remount.lock'),
    WOC_RECOVERY_STATE: path.join(dir, 'recovery.json'),
});

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var hookCode = null;   /* the last hook's exit code */
function hook(which) {
    var r = cp.spawnSync(process.execPath, [PATCHD, which], { encoding: 'utf8', env: ENV, timeout: 60000 });
    hookCode = r.status;
    return (r.stdout || '') + (r.stderr || '');
}
/* A head-unit start: patchd's daemon, up to its socket, then stopped. */
async function boot() {
    try { fs.unlinkSync(SOCK); } catch (e) {}
    var c = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: 'ignore' });
    children.push(c);
    for (var t = 0; t < 10000 && !fs.existsSync(SOCK); t += 50) await sleep(50);
    var up = fs.existsSync(SOCK);
    c.kill('SIGKILL');
    await new Promise(function (r) { if (c.exitCode !== null || c.signalCode) r(); else c.on('exit', r); });
    return up ? '' : 'patchd did not come up';
}
var STEPS = {
    'an install or update': function () { return hook('activate'); },
    'a head-unit start': boot,
    'Undo update or Remove': function () { return hook('deactivate'); },
};
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }
function set(local, features) {
    fs.writeFileSync(LOCAL, local);
    if (features === null) try { fs.unlinkSync(FEATURES); } catch (e) {} else fs.writeFileSync(FEATURES, features);
}
/* After a step: every release starts with the local conf; it and
 * features.conf hold what they should. */
function check(name, wantLocal, wantFeatures, out) {
    var local = read(LOCAL), feat = read(FEATURES), refused = refusing(local || '');
    ok(name + ': every release starts with the local conf', refused.length === 0, refused.join(' ') + ' ' + (out || '').slice(-300));
    ok(name + ': the owner\'s other lines kept, the opt-in settings in features.conf', local === wantLocal && feat === wantFeatures,
        JSON.stringify(local) + ' ' + JSON.stringify(feat));
}

var ON = 'hosted_vpp_scale = 1\nalways_packed = 1\n';

(async function () {
    /* 1. Turned on in features.conf: every step, in the order an owner meets
     * them, leaves both files as they are. */
    set(USER, ON);
    var seq = [['an update to this version', 'activate'], ['a head-unit start', 'boot'], ['Undo update', 'deactivate'],
        ['an update to this version again', 'activate'], ['a head-unit start', 'boot'], ['Remove', 'deactivate'],
        ['a reinstall', 'activate'], ['removal', 'deactivate']];
    for (var i = 0; i < seq.length; i++) {
        var out = seq[i][1] === 'boot' ? await boot() : hook(seq[i][1]);
        check('features.conf, ' + seq[i][0], USER, ON, out);
    }

    /* 2. Written in the local conf: each step moves them to features.conf,
     * the local conf's other lines kept. */
    var steps = Object.keys(STEPS);
    for (i = 0; i < steps.length; i++) {
        set(USER + 'hosted_vpp_scale = 1\n# packed\nalways_packed = 1\n', null);
        out = await STEPS[steps[i]]();
        check('in the local conf, ' + steps[i], USER + '# packed\n', ON, out);
        out = await STEPS[steps[i]]();
        check('in the local conf, ' + steps[i] + ' again', USER + '# packed\n', ON, out);
    }

    /* 3. One in both files: features.conf's kept. One that is not 0 or 1:
     * dropped. A += line and one with a comment after the value: moved. */
    set(USER + 'hosted_vpp_scale = 1\nalways_packed = 2\n', 'hosted_vpp_scale = 0\n');
    out = hook('activate');
    check('in both files, and one out of range', USER, 'hosted_vpp_scale = 0\n', out);
    set(USER + 'always_packed += 1\nhosted_vpp_scale = 1 # on\n', null);
    out = hook('activate');
    check('a += line, a comment after the value', USER, ON, out);

    /* 4. An update cut short. After this version's files, before its hook:
     * the next head-unit start moves them. Its activate ran, then the update
     * was undone (this version's deactivate, the earlier one's activate):
     * moved, and gone from the local conf (the earlier version's activate
     * does not touch them). */
    set(USER + 'hosted_vpp_scale = 1\nalways_packed = 1\n', null);
    out = await boot();
    check('an update cut short before its hook, then a head-unit start', USER, ON, out);
    set(USER + 'hosted_vpp_scale = 1\nalways_packed = 1\n', null);
    out = hook('activate') + hook('deactivate');
    check('an update undone after its activate', USER, ON, out);
    /* A valid value in features.conf is kept; one that is not 0 or 1 there
     * is replaced by the local conf's. */
    set(USER + 'always_packed = 1\n', 'always_packed = yes\n');
    out = hook('activate');
    check('an invalid value in features.conf', USER, 'always_packed = 1\n', out);
    /* The local conf cannot be written: the removal (Undo update, Remove,
     * a restore) is refused, so no earlier version is put in its place. */
    var LOCAL0 = USER + 'always_packed = 1\n';
    set(LOCAL0, null);
    fs.mkdirSync(LOCAL + '.tmp');
    out = hook('deactivate');
    ok('the local conf cannot be written: the removal refused, the local conf as it was',
        hookCode !== 0 && read(LOCAL) === LOCAL0 && /could not be moved/.test(out), hookCode + ' ' + out.slice(-300));
    fs.rmdirSync(LOCAL + '.tmp');
    /* The move cut short between its two writes (features.conf cannot be
     * written): the local conf is rewritten first, so every release starts
     * with it; the setting is lost. */
    set(USER + 'hosted_vpp_scale = 1\nalways_packed = 1\n', null);
    fs.mkdirSync(FEATURES + '.tmp');
    out = hook('activate');
    check('the move cut short between its writes', USER, null, out);
    fs.rmdirSync(FEATURES + '.tmp');

    /* 5. A car with a local conf: the owner's settings (a target, a frame
     * rate), the app's map settings and an opt-in key, which releases up to
     * 0.8.8 and 0.10.7 refuse. The first install moves those two into their
     * files; the owner's lines stay in the local conf, which every release
     * starts with, through every step after. */
    var OWN = '# mine\ntarget = panel\ntarget_fps = 20\n';
    var CAR_LOCAL = OWN + 'cluster = 0\nhud_width_pct = 50\nhosted_vpp_scale = 1\n';
    var CAR_MAP = 'cluster = 0\nhud_width_pct = 50\n', CAR_FEAT = 'hosted_vpp_scale = 1\n';
    ok('every release starts with the owner\'s settings', refusing(OWN).length === 0, refusing(OWN).join(' '));
    ok('releases refuse the car\'s local conf as it was', refusing(CAR_LOCAL).length > 0);
    var life = [['an update to this version', 'activate'], ['a head-unit start', 'boot'], ['a downgrade', 'deactivate'],
        ['an update to this version again', 'activate'], ['a head-unit start', 'boot'], ['Remove', 'deactivate'],
        ['a reinstall', 'activate'], ['a head-unit start', 'boot'], ['uninstall', 'deactivate'], ['a reinstall', 'activate']];
    async function step(which) { return which === 'boot' ? boot() : hook(which); }
    set(CAR_LOCAL, null);
    try { fs.unlinkSync(MAP_STATE); } catch (e) {}
    for (i = 0; i < life.length; i++) {
        out = await step(life[i][1]);
        var map = read(MAP_STATE);
        check('a car with a local conf, ' + life[i][0], OWN, CAR_FEAT, out);
        ok('a car with a local conf, ' + life[i][0] + ': the app\'s map settings in map.state.conf', map === CAR_MAP,
            JSON.stringify(map));
    }

    /* 6. No local conf (every Store install): none made, nor any other
     * settings file, through every step. */
    [LOCAL, FEATURES, MAP_STATE].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    for (i = 0; i < life.length; i++) {
        out = await step(life[i][1]);
        ok('no local conf, ' + life[i][0] + ': none made, no settings file', read(LOCAL) === null && read(FEATURES) === null &&
            read(MAP_STATE) === null, out.slice(-300));
    }

    process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
    process.exit(fails ? 1 : 0);
})().catch(function (e) { process.stdout.write('FAIL ' + (e.stack || e) + '\n'); process.exit(1); });
