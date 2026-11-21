// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Earlier releases' patchers, for the tests that need carplay or aapd as
 * an earlier release patched it in the file: waze-on-cluster 0.10.12, the
 * last release whose carplay_patch.js has `apply`, and 0.12.1, the last
 * whose aapd_patch.js has it. Each patch folder comes from its release tag
 * (fetched when missing) into a temporary folder, once per process, removed
 * at exit.
 *
 *   var earlier = require('./earlier_patcher.js');
 *   earlier.script()             0.10.12's carplay_patch.js
 *   earlier.scriptFor(args, cur) its carplay_patch.js for an `apply`, else cur
 *   earlier.run(args, env)       {code, out} of its carplay_patch.js
 *   earlier.aaScript()           0.12.1's aapd_patch.js
 *   earlier.aaScriptFor(args, cur) its aapd_patch.js for an `apply`, else cur
 *   earlier.dir(tag)             a release's patch folder (default 0.10.12)
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var TAG = 'waze-on-cluster@0.10.12';
var AA_TAG = 'waze-on-cluster@0.12.1';
var REPO = path.join(__dirname, '..', '..', '..', '..');
var dirs = {};

function git(args) { return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function hasTag(tag) {
    try { return git(['tag', '-l', tag]).trim() === tag; } catch (e) { return false; }
}

/* A release's patch folder. */
function patchDir(tag) {
    tag = tag || TAG;
    if (dirs[tag]) return dirs[tag];
    if (!hasTag(tag)) {
        /* a shallow checkout (CI) fetches it shallow; a full clone stays full */
        var shallow = false;
        try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch (e) {}
        try { git(['fetch', '--no-tags'].concat(shallow ? ['--depth=1'] : [], ['origin', '+refs/tags/' + tag + ':refs/tags/' + tag])); } catch (e) {}
        if (!hasTag(tag)) throw new Error('earlier_patcher: no ' + tag + ' tag, and fetching it failed');
    }
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-earlier-'));
    process.on('exit', function () { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} });
    cp.execSync('git archive "' + tag + '" native/waze-on-cluster/patch | tar -x -C "' + d + '" --strip-components=3', { cwd: REPO });
    dirs[tag] = d;
    return d;
}

function script() { return path.join(patchDir(), 'carplay_patch.js'); }
function aaScript() { return path.join(patchDir(AA_TAG), 'aapd_patch.js'); }
function aaScriptFor(args, cur) { return args[0] === 'apply' ? aaScript() : cur; }

/* The patcher that runs args: the release's for an apply (this version has
 * none), cur for every other command. */
function scriptFor(args, cur) { return args[0] === 'apply' ? script() : cur; }

function run(args, env) {
    var r = cp.spawnSync(process.execPath, [script()].concat(args), { encoding: 'utf8', env: env || process.env });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

module.exports = { TAG: TAG, AA_TAG: AA_TAG, dir: patchDir, script: script, scriptFor: scriptFor, run: run, aaScript: aaScript, aaScriptFor: aaScriptFor };
