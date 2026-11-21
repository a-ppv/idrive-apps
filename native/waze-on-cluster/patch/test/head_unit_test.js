#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The head-unit rule (head_unit.js) on the cases cluster-render's
 * head_unit_test runs too (cluster-render/test/head_unit_cases.jsonl), and
 * the patchers behind it on a synthetic carplay build.
 *
 *   node head_unit_test.js
 */
'use strict';

var headUnit = require('./head_unit_env.js');

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var synthetic = require('./synthetic_carplay.js');
var gate = require('../head_unit.js');
var earlier = require('./earlier_patcher.js');

var CASES = path.join(__dirname, '..', '..', '..', 'cluster-render', 'test', 'head_unit_cases.jsonl');
var CARPLAY_PATCH = path.join(__dirname, '..', 'carplay_patch.js');
var AAPD_PATCH = path.join(__dirname, '..', 'aapd_patch.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function run(script, args) {
    var r = cp.spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

var cases = fs.readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
ok('the shared cases are there', cases.length >= 10, cases.length);
cases.forEach(function (c) {
    var got = gate.rule(c.cmdline === undefined ? null : c.cmdline) || '';
    ok('case: ' + c.name, got === c.refused, got);
});

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-hu-patch-'));
var tgt = path.join(dir, 'carplay'), stock = synthetic.build({}).buf;
function fresh() {
    [tgt + '.woc-orig', tgt + '.woc-orig.json'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    fs.writeFileSync(tgt, stock, { mode: 0o755 });
}
var PLAN = path.join(dir, 'carplay.plan');
function plan(extra) { try { fs.unlinkSync(PLAN); } catch (e) {} return run(CARPLAY_PATCH, ['plan', '--panel', 'high', '--target', tgt, '--out', PLAN].concat(extra || ['--unproven'])); }
function untouched() { return fs.readFileSync(tgt).equals(stock) && !fs.existsSync(tgt + '.woc-orig') && !fs.existsSync(PLAN); }

try {
    [['HIGH', headUnit.HIGH], ['MID', headUnit.MID], ['HIGH F', headUnit.HIGHF]].forEach(function (u) {
        fresh();
        headUnit.set(u[1]);
        var r = plan();
        ok(u[0] + ': carplay plan made, the file untouched', r.code === 0 && fs.existsSync(PLAN) && fs.readFileSync(tgt).equals(stock), r.out);
    });
    [['no kernel command line', null, 'head unit: unknown variant is not supported (kernel command line unreadable)'],
     ['no hwvariant=', headUnit.NONE, headUnit.REFUSED]].forEach(function (u) {
        fresh();
        headUnit.set(u[1]);
        var r = plan([]);
        ok(u[0] + ': carplay plan refuses with the reason line, writes nothing', r.code !== 0 && r.out === 'error: refusing: ' + u[2] + '\n' && untouched(), r.out);
        r = plan(['--unproven']);
        ok(u[0] + ': --unproven does not get past it', r.code !== 0 && r.out === 'error: refusing: ' + u[2] + '\n' && untouched(), r.out);
    });

    fresh();
    headUnit.set(headUnit.HIGH);
    run(earlier.script(), ['apply', '--panel', 'high', '--target', tgt, '--yes', '--unproven']);
    headUnit.set(headUnit.NONE);
    var r = run(CARPLAY_PATCH, ['revert', '--target', tgt, '--yes']);
    ok('no hwvariant=: carplay revert restores the original an earlier release patched', r.code === 0 && fs.readFileSync(tgt).equals(stock), r.out);

    /* aapd: the gate comes before any file is read, so these paths need not exist. */
    var aa = ['plan', '--target', path.join(dir, 'aapd'), '--conf', path.join(dir, 'aapd.conf'), '--coding', path.join(dir, 'coding'),
        '--out', path.join(dir, 'aapd.plan'), '--conf-out', path.join(dir, 'aapd.conf.copy')];
    r = run(AAPD_PATCH, aa);
    ok('no hwvariant=: aapd plan refuses with the reason line', r.code !== 0 && r.out === 'error: refusing: ' + headUnit.REFUSED + '\n', r.out);
    [['HIGH', headUnit.HIGH], ['HIGH F', headUnit.HIGHF]].forEach(function (u) {
        headUnit.set(u[1]);
        r = run(AAPD_PATCH, aa);
        ok(u[0] + ': aapd plan gets past the gate (to the coding check)', r.code !== 0 && /cluster coding cannot be read/.test(r.out), r.out);
    });
} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}

process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
process.exit(fails ? 1 : 0);
