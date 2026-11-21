#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* carplay_patch.js — six reversible edits to the CarPlay binary that,
 * together, put the CarPlay instrument-cluster ("alternate screen") H.264 where
 * this tool can read it, at the size this tool displays (PATCH.md).
 *
 *   variant  one 4-byte jump-table slot. The converter maps raw
 *            KI_KOMBI_VARIANT 9->IC_HIGH, 10->IC_MID, everything else incl. 7
 *            ->OTHER (which fails the alternate-display gate). Remapping the
 *            variant-7 slot to a supported value makes every downstream check
 *            pass, so MGU advertises the 2nd display and the phone sends the
 *            cluster stream. Touches variant 7 only.
 *   sink     the 2nd-stream Cinemo sink URL string. As shipped it is
 *            `avb://media_transport.avb_streaming.15?mime_type=video/H264`,
 *            sending the H.264 undecoded over AVB to the cluster. Repointing it
 *            (--sink <url>, or --capture <fifo> for the file:// form) sends the
 *            same undecoded H.264 to this tool: a `udp://127.0.0.1:<port>`
 *            stream sink, or a `file://<fifo>`. Same length or shorter,
 *            NUL-padded in place.
 *   selfstart one `call` retargeted (4-byte rel32). CarPlay's AlternateDisplays
 *            waits for NavController to forward a requestStream command before it
 *            shows the cluster UI, but NavController never forwards it, so the
 *            stream never starts. Retargeting onSuggestUi's
 *            setStreamStatus(AVAILABLE) call to requestStream() makes CarPlay
 *            start the stream itself. Applied in every mode.
 *   resolution the IC_HIGH display geometry `ICSafeAreaProvider` advertises to
 *            the phone: pixel size, physical size (mm), and the view/safe
 *            areas, held as four `movabs` immediates in one builder function.
 *            The stock cluster display is larger than the part this tool
 *            shows, so the patch with `--panel high` rewrites the geometry to the
 *            displayed size (1088x480 px at 138x61 mm, view area the full
 *            frame) and the phone renders its cluster map at that size. The
 *            safe area, where the phone keeps its guidance UI, is the part of
 *            the frame the gauges and native readouts leave visible (504x368
 *            at 286,72). `--res WxH` picks another pixel size at the same
 *            physical size, `--safe` another safe area; `--res stock`, and
 *            `--panel mid`, keep the build's stock geometry.
 *
 *   mapurl   the cluster display's initial URL. CarPlay hands the phone an
 *            empty initial URL for the cluster display, so the phone streams
 *            the cluster map only once a route starts. Pointing it at
 *            `maps:/car/instrumentcluster/map` makes the phone stream the map
 *            from connect, route or not. Two sites: a log string only the
 *            path the variant edit disables reads, rewritten to a shorter log
 *            text followed by the URL, and the `lea rsi` that builds the
 *            initial URL, repointed from "" to it. Applied in every mode on a
 *            build where it is found; a build where it is not gets the other
 *            edits without it. Both sites holding the URL with `?showETA=yes`
 *            that releases 0.10.2-0.10.3 wrote read as `eta`, which the patch
 *            replaces and a revert restores.
 *   showui   the URL the ShowUI command sends the phone when CarPlay starts
 *            the cluster stream: `maps:/car/instrumentcluster` as built,
 *            `maps:/car/instrumentcluster?showETA=yes` patched, so Apple Maps
 *            and Google Maps draw their arrival-time card on the cluster map
 *            during a route. Two sites: the log text of that ShowUI call's
 *            result check, cut to `mCinemoCarPlay->ShowUI(` followed by the
 *            URL, and requestStream's 11 bytes reading the cluster display's
 *            URL for ShowUI, rewritten to load the URL. Applied in every
 *            mode on a build where it is found; a build where it is not, or
 *            one that adds carplay.conf's SHOW_UI_OPTIONS to the URL itself,
 *            gets the other edits without it.
 *
 *            The two sites of the map URL or the ShowUI URL edit holding
 *            different forms, or one written and not the other, read as
 *            unrecognised, like another edit's site that reads as neither.
 *
 * The sites are found in each build by carplay_locate.js; a build where one
 * of the first four is not found, or reads as neither stock nor this patch,
 * is refused.
 * The edits are applied in carplay's memory (PATCH.md "In memory"): `plan`
 * reads the stock file, runs every check (the head unit, the coding, the
 * locator, a proven build, else --unproven) and writes the plan
 * libwocpatch.so applies; `overlay` reads the file with a plan laid over it.
 * This version writes carplay only to put back a patch an earlier release
 * wrote into the file (`revert`): the edits' regions or the whole verified
 * backup, or, without one, the proven build's own bytes, each kept only when
 * it verifies. revert works on any head unit.
 *
 * Node 8.16.2 on the unit, no dependencies.
 *
 *   carplay_patch.js status  [--target <file>] [--coding <shm>]
 *   carplay_patch.js probe   [<file>]
 *   carplay_patch.js plan    --panel high|mid [--sink <url> | --capture <fifo>] [--res WxH|stock] [--safe WxH+X+Y|full] --out <file> [--target <file>] [--coding <shm>] [--unproven]
 *   carplay_patch.js overlay --plan <file> [--target <file>]
 *   carplay_patch.js revert  [--target <file>] [--yes] [--drop-backup]
 *   carplay_patch.js verify  [--target <file>]
 *
 * Default target /usr/bin/carplay, coding $WOC_CODING or
 * /dev/shm/rawcodingdata. status, probe, plan, overlay and verify only read
 * the file.
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var path = require('path');
var locator = require('./carplay_locate.js');
var headUnit = require('./head_unit.js');
var record = require('./patch_record.js');
var fileMode = require('./file_mode.js');

function latin1(s) { return Buffer.from(s, 'latin1').toString('hex'); }

var MAP_URL = locator.MAP_URL;
var ETA_URL = locator.MAP_URL_FORMS.filter(function (f) { return f.name === 'eta'; })[0].url;
var SHOWUI_URL = locator.SHOWUI_URL;

/* Builds proven as shipped, by GNU build-id. A first edit of one needs the
 * whole file to be the shipped one, and anything else counts as modified. A
 * first edit of any other build needs --unproven: its sites pass the
 * locator's checks, but no car has run it patched. stock: the shipped bytes
 * at every offset any version of this tool writes in it, for a revert
 * without the backup; the rebuilt file is kept only when its SHA-256 is the
 * shipped one, so a list that lacks an offset rebuilds nothing. */
var PROVEN = {
    '5de62156575d737391ea42254e778a97dbbb51f8': {
        version: 'carplay 22.28.3+gitr624+993efc1-r0.14',
        sha256: 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50',
        stock: [[0x2ba4f0, 'ecf2f7ff'], [0x2a20b0, latin1(locator.SINK_STOCK)], [0x18176c, 'e8effdffff'],
                [0x20ca32, 'ea0000006e000000'], [0x20ca54, '8007000084030000'], [0x20ca66, '0000000064020000'], [0x20ca74, '0e0200000202c000'],
                [0x257838, latin1('Head-Unit does not support Alternate Displays feature.\0')], [0x7b533, '488d3559922100'],
                [0x2908a0, latin1('mCinemoCarPlay->ShowUI( ::carplay::CarPlayConstantsRepository::a')], [0x18188a, 'e851cd07004c89e7488b30']],
    },
    /* Confirmed on a G07 X7 (variant 7) through CarPlay's Patch button
     * (issue #95), from its probe output. stock holds the sink, self-start
     * and pixel-size bytes the probe shows; the variant slot and the other
     * three geometry immediates are not known, so this build is reverted
     * from our backup only, as are the map URL and ShowUI URL edits' sites. */
    '389c1d0536f8cc9283c156410f2f2634a9f952c0': {
        version: 'carplay 21.27.4',
        sha256: 'fb5d6b179ad4f62a968697d21e84dbb80adc1ad8e618a6f02c6a9a0467aca1ac',
        stock: [[0x29bb10, latin1(locator.SINK_STOCK)], [0x1802dc, 'e8effdffff'], [0x20b484, '8007000084030000']],
    },
};

/* The geometry `--panel high` advertises: the cluster's 1088x480 central map
 * area (138x61 mm of glass), which the render's texture covers pixel for
 * pixel. Every geometry this tool writes has this physical size, which tells
 * it from a build's stock geometry. */
var RES_DEFAULT = { w: 1088, h: 480, mmw: 138, mmh: 61 };
/* The default safe area in the 1088x480 frame (PATCH.md "Safe area"): x
 * from BMW's own IC_MID safe area (which lies inside the map area), y from
 * below the native model badge. Other --res sizes scale it. The
 * safe area 0.10.6 wrote (476x306 at 306,72) reads as patched, and the patch
 * rewrites it. */
var SAFE_DEFAULT = { x: 286, y: 72, w: 504, h: 368 };
var EDITS = ['variant', 'sink', 'selfstart', 'res'];
var URL_EDITS = ['mapurl', 'showui'];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }
function hex(n) { return '0x' + n.toString(16); }

/* The cluster coding, read and judged as aapd_patch.js does: {variant} or
 * {err}, and why it is not the proven one (null when it is). Loaded on use,
 * so boot recovery, which loads this file for its backup check, does not
 * load the Android Auto patcher. */
function readCoding(file) { return require('./aapd_patch.js').readCoding(file); }
function codingRefusal(cd) { return require('./aapd_patch.js').codingRefusal(cd); }

/* The record of a patch has run healthy on this car: a patch record saying
 * proven without trial (the watcher's, or one written before trial
 * existed), or a revert's record of such a patch. */
function vetted(rec) {
    return !!rec && (rec.healthy === true || (rec.patched === true && rec.proven === true && rec.trial !== true));
}

/* What the patch the vetted record `rec` vouches for held, as this version
 * writes it: { mapurl, showui }, each true or false, and res, the IC_HIGH
 * geometry it advertised (resKey) or false for the stock one. For a patch
 * record, the target's own (classified as `c`); for a revert, the revert
 * record's mapurl, showui and res (earlier releases recorded `mapurl: true`
 * for maps:/car/instrumentcluster/map and the URL with `?showETA=yes` as a
 * string, and no showui or res). */
function ranEdits(rec, c) {
    if (rec.patched === true) return { mapurl: !!c.mapurl && c.mapurl.state === 'patched', showui: !!c.showui && c.showui.state === 'patched',
        res: !!c.res && c.res.state === 'patched' && resKey(c.res.res) };
    return { mapurl: rec.mapurl === MAP_URL, showui: rec.showui === SHOWUI_URL, res: typeof rec.res === 'string' && rec.res };
}

/* The record a revert of the target (classified as `c`) writes: a patch
 * that ran healthy is remembered, with the URLs of the URL edits it held as
 * this version writes them (false for none or another URL) and the geometry
 * it advertised (false for the stock one). */
function revertRecord(prior, c) {
    if (!vetted(prior)) return { patched: false };
    var held = ranEdits(prior, c);
    return { patched: false, healthy: true, mapurl: held.mapurl ? MAP_URL : false, showui: held.showui ? SHOWUI_URL : false, res: held.res || false };
}

function backupPath(t) { return t + '.woc-orig'; }
function metaPath(t) { return t + '.woc-orig.json'; }

function variantState(buf, v) {
    if (!v.ok) return { state: 'unknown', reason: v.reason };
    var x = buf.readUInt32LE(v.slot);
    return x === v.original ? { state: 'original' } : { state: 'patched', panel: x === v.high ? 'high' : 'mid' };
}

function sinkState(buf, s) {
    if (!s.ok) return { state: 'unknown', reason: s.reason };
    var slot = buf.slice(s.offset, s.offset + s.len), nul = slot.indexOf(0);
    var url = (nul >= 0 ? slot.slice(0, nul) : slot).toString('latin1');
    return url === locator.SINK_STOCK ? { state: 'original' } : { state: 'redirected', url: url };
}

/* 'original', 'patched' (MAP_URL) or 'eta' (ETA_URL) when both sites read
 * stock or both hold that form; 'unknown' when they differ (a write of ours
 * cut short), which only the whole backup restores; 'absent' with why when
 * the locator does not find it: the edit is then left alone. sites: [offset,
 * hex MAP_URL's form writes] of each. */
function mapUrlState(m) {
    if (!m.ok) return { state: 'absent', reason: m.reason };
    var sites = [[m.slot, m.slotBytes], [m.lea, m.leaBytes]];
    if (m.slotIs !== m.leaIs) return { state: 'unknown', reason: 'map URL: partly patched', sites: sites };
    return { state: m.slotIs === 'stock' ? 'original' : m.slotIs === 'current' ? 'patched' : 'eta', sites: sites };
}
function mapUrlOurs(s) { return s.state === 'patched' || s.state === 'eta'; }

/* 'original' or 'patched' (SHOWUI_URL) when both sites read stock or both
 * patched; 'unknown' when they differ or one holds a mix of the two (a write
 * of ours cut short), which only the whole backup restores; 'absent' with
 * why when the locator does not find it (na: the build adds carplay.conf's
 * options itself): the edit is then left alone. sites: [offset, hex the
 * edit writes] of each. */
function showUiState(m) {
    if (!m.ok) return { state: 'absent', reason: m.reason, na: !!m.na };
    var sites = [[m.str, m.strBytes], [m.call, m.callBytes]];
    if (m.strIs !== m.callIs || m.strIs === 'mixed') return { state: 'unknown', reason: 'ShowUI URL: partly patched', sites: sites };
    return { state: m.strIs === 'stock' ? 'original' : 'patched', sites: sites };
}

/* The URL edits' states (`c` classified): ours when any holds our bytes. */
function urlsOurs(c) { return mapUrlOurs(c.mapurl) || c.showui.state === 'patched'; }

function selfstartState(buf, s) {
    if (!s.ok) return { state: 'unknown', reason: s.reason };
    return { state: buf.toString('hex', s.offset, s.offset + 5) === s.original ? 'original' : 'patched' };
}

/* The IC_HIGH geometry in the four immediates: mm pair; px pair; view x,y
 * (u16) + safe width; safe height + safe x,y (u16). */
function readRes(buf, r) {
    return {
        mmw: buf.readUInt32LE(r.mm), mmh: buf.readUInt32LE(r.mm + 4),
        w: buf.readUInt32LE(r.px), h: buf.readUInt32LE(r.px + 4),
        viewx: buf.readUInt16LE(r.safe1), viewy: buf.readUInt16LE(r.safe1 + 2), safew: buf.readUInt32LE(r.safe1 + 4),
        safeh: buf.readUInt32LE(r.safe2), safex: buf.readUInt16LE(r.safe2 + 4), safey: buf.readUInt16LE(r.safe2 + 6),
    };
}

/* This tool's geometry has its physical size, the view area at (0,0) and a
 * safe area inside the frame; a stock one has another physical size and a
 * safe area inside the frame. */
function resState(buf, r) {
    if (!r.ok) return { state: 'unknown', reason: r.reason };
    var g = readRes(buf, r);
    var inside = g.w > 0 && g.h > 0 && g.safew > 0 && g.safeh > 0 && g.safex + g.safew <= g.w && g.safey + g.safeh <= g.h;
    var ours = g.mmw === RES_DEFAULT.mmw && g.mmh === RES_DEFAULT.mmh;
    if (inside && !ours && g.mmw > 0 && g.mmh > 0) return { state: 'original', res: g };
    if (inside && ours && g.viewx === 0 && g.viewy === 0) return { state: 'patched', res: g };
    return { state: 'unknown', reason: 'resolution: geometry not recognised', res: g };
}

function writeRes(buf, r, g) {
    buf.writeUInt32LE(g.mmw, r.mm); buf.writeUInt32LE(g.mmh, r.mm + 4);
    buf.writeUInt32LE(g.w, r.px); buf.writeUInt32LE(g.h, r.px + 4);
    buf.writeUInt16LE(0, r.safe1); buf.writeUInt16LE(0, r.safe1 + 2); buf.writeUInt32LE(g.safew, r.safe1 + 4);
    buf.writeUInt32LE(g.safeh, r.safe2); buf.writeUInt16LE(g.safex, r.safe2 + 4); buf.writeUInt16LE(g.safey, r.safe2 + 6);
}

function safeText(g) { return 'safe ' + g.safew + 'x' + g.safeh + ' at ' + g.safex + ',' + g.safey; }
function geomText(g) { return g.w + 'x' + g.h + ' at ' + g.mmw + 'x' + g.mmh + 'mm, ' + safeText(g); }
/* A geometry as one string, for the patch record. */
function resKey(g) { return g.w + 'x' + g.h + '/' + g.mmw + 'x' + g.mmh + '/' + g.safew + 'x' + g.safeh + '+' + g.safex + '+' + g.safey; }

function classify(buf) {
    var loc = locator.locate(buf);
    if (!loc.elf) return { ok: false, reason: loc.reason, loc: loc, size: buf.length };
    return { ok: true, loc: loc, size: buf.length, variant: variantState(buf, loc.variant), sink: sinkState(buf, loc.sink),
             selfstart: selfstartState(buf, loc.selfstart), res: resState(buf, loc.res), mapurl: mapUrlState(loc.mapurl), showui: showUiState(loc.showui) };
}

/* Why the patcher does not recognise the build: [] when every edit is found
 * and reads as stock or as this patch. */
function unrecognised(c) {
    if (!c.ok) return [c.reason];
    return EDITS.concat(URL_EDITS).filter(function (e) { return c[e].state === 'unknown'; }).map(function (e) { return c[e].reason; });
}
function brief(reasons) { return reasons[0] + (reasons.length > 1 ? ' (+' + (reasons.length - 1) + ' more)' : ''); }

/* Why `buf` is not the pristine build, or null: an edit present, or for a
 * proven build any byte not as shipped. */
function notPristine(c, buf) {
    var bad = unrecognised(c);
    if (bad.length) return brief(bad);
    var edited = EDITS.filter(function (e) { return c[e].state !== 'original'; }).concat(mapUrlOurs(c.mapurl) ? ['mapurl'] : [],
        c.showui.state === 'patched' ? ['showui'] : []);
    if (edited.length) return edited.join(', ') + ' edited';
    var proven = PROVEN[c.loc.buildId], hash = sha256(buf);
    return proven && hash !== proven.sha256 ? 'sha256 ' + proven.sha256 + ', got ' + hash : null;
}

function oursIn(c) {
    return c.ok && (c.variant.state === 'patched' || c.sink.state === 'redirected' || c.selfstart.state === 'patched' || c.res.state === 'patched' ||
        urlsOurs(c) || c.mapurl.state === 'unknown' || c.showui.state === 'unknown');
}

function label(c) {
    var proven = PROVEN[c.loc.buildId];
    return proven ? proven.version : c.loc.buildId ? 'build ' + c.loc.buildId : 'build without a build-id';
}

/* The byte ranges the four located edits write. */
function located(loc) {
    var r = loc.res;
    return [[loc.variant.slot, 4], [loc.sink.offset, loc.sink.len], [loc.selfstart.offset, 5],
        [r.mm, 8], [r.px, 8], [r.safe1, 8], [r.safe2, 8]];
}

/* The byte ranges the edits write in the classified image `c`, the URL
 * edits' where the locator finds them: the patch changes only these, and revert
 * restores only these, so changes another tool made elsewhere stay. */
function regions(c) {
    var out = located(c.loc);
    URL_EDITS.forEach(function (e) { if (c[e].sites) out = out.concat(c[e].sites.map(function (s) { return [s[0], s[1].length / 2]; })); });
    return out;
}

/* Two classified images are the same build: the same size, build-id and
 * sites of the four required edits. */
function sameBuild(a, b) {
    return a.ok && b.ok && a.loc.ok && b.loc.ok && a.size === b.size && a.loc.buildId === b.loc.buildId &&
        JSON.stringify(located(a.loc)) === JSON.stringify(located(b.loc));
}

function readTarget(t) {
    try { return fs.readFileSync(t); } catch (e) { die('cannot read ' + t + ': ' + e.message); }
}

function pad(s) { return (s + ':          ').slice(0, Math.max(11, s.length + 2)); }
function line(name, text) { process.stdout.write(pad(name) + text + '\n'); }

function describe(name, s) {
    if (s.state === 'unknown') return 'UNKNOWN (' + s.reason + (s.res ? ': ' + geomText(s.res) : '') + ')';
    if (name === 'variant') return s.state === 'original' ? 'ORIGINAL (2nd display gated off for variant 7)' : 'PATCHED -> IC_' + s.panel.toUpperCase();
    if (name === 'sink') return s.state === 'original' ? 'ORIGINAL (2nd stream -> AVB stream 15)' : 'REDIRECTED -> ' + s.url;
    if (name === 'mapurl') return s.state === 'absent' ? 'NOT APPLIED (' + s.reason + ')'
        : s.state === 'original' ? 'ORIGINAL (the phone streams the cluster map once a route starts)'
        : s.state === 'eta' ? 'PATCHED WITH ETA (the phone streams the cluster map from connect: ' + ETA_URL + '; the patch writes ' + MAP_URL + ')'
        : 'PATCHED (the phone streams the cluster map from connect: ' + MAP_URL + ')';
    if (name === 'showui') return s.state === 'absent' ? 'NOT APPLIED (' + s.reason + ')'
        : s.state === 'original' ? 'ORIGINAL (ShowUI asks the phone for ' + locator.ALT_URL + ')'
        : 'PATCHED (ShowUI asks the phone for ' + SHOWUI_URL + ', with the arrival-time card)';
    if (name === 'selfstart') return s.state === 'original' ? 'ORIGINAL (waits for NavController; stream never starts)' : 'SELF-START (CarPlay starts the cluster stream itself)';
    return s.state === 'original' ? 'ORIGINAL (IC_HIGH advertises ' + s.res.w + 'x' + s.res.h + ')' : 'PATCHED (IC_HIGH advertises ' + geomText(s.res) + ')';
}

function header(target, buf, c) {
    line('target', target);
    line('size', buf.length);
    line('sha256', sha256(buf));
    line('build-id', c.loc.buildId || 'none');
    line('version', c.loc.version || 'unknown');
}

function cmdStatus(target, codingFile) {
    var buf = readTarget(target), c = classify(buf), cd = readCoding(codingFile);
    header(target, buf, c);
    line('coding', cd.err ? 'unreadable (' + cd.err + ')' : 'KI_KOMBI_VARIANT ' + cd.variant);
    var p;
    try { p = restorePlan(target, buf, c); } catch (e) { p = { err: e.message }; }
    line('restorable', p.err ? 'no (' + p.err + ')' : p.b.other ? 'no (another build: ' + p.b.other + ')' : !p.out.equals(buf) || modeOnly(target, buf, p) ? 'yes' : 'no');
    /* Our edits beside another change: the file differs from its original
     * outside the sites of our edits. */
    var fo = foreignIn(target);
    line('foreign', fo === null ? 'unknown' : fo ? 'yes' : 'no');
    var bad = unrecognised(c);
    if (!c.ok) { line('known', 'NO — ' + c.reason); return; }
    /* A backup the patch would refuse (another build's original, or
     * not the original recorded) makes the build one this tool cannot patch. */
    var bak = backupPath(target), hasBak = fs.existsSync(bak), bakWhy = '';
    if (hasBak && !bad.length) {
        var b;
        try { b = checkedBackup(target, p.bc && !p.b.stock ? { buf: p.b.buf, c: p.bc } : null); } catch (e) { b = { err: e.message }; }
        bakWhy = b.err ? 'backup ' + bak + ' is not a pristine original'
            : !sameBuild(c, b.c) ? 'backup ' + bak + ' is the original of another carplay build' : '';
    }
    line('known', bad.length ? 'NO — ' + brief(bad) : bakWhy ? 'NO — ' + bakWhy
        : notPristine(c, buf) ? 'yes, modified build' : 'yes, pristine ' + label(c));
    line('proven', PROVEN[c.loc.buildId] ? 'yes' : 'no');
    EDITS.concat(URL_EDITS).forEach(function (e) { line(e, describe(e, c[e])); });
    line('backup', hasBak ? bak : 'none');
}

/* Where each edit sits and how it reads, and whether the patcher can patch
 * this build. Read-only. */
function cmdProbe(target) {
    var buf = readTarget(target), c = classify(buf), loc = c.loc;
    header(target, buf, c);
    if (!c.ok) { line('patchable', 'no — ' + c.reason); return; }
    line('proven', PROVEN[loc.buildId] ? 'yes, ' + PROVEN[loc.buildId].version : 'no');
    var at = {
        variant: loc.variant.ok && 'slot ' + hex(loc.variant.slot) + ' (table ' + hex(loc.variant.table) + ', ' + loc.variant.slots + ' slots): ',
        sink: loc.sink.ok && 'slot ' + hex(loc.sink.offset) + ' (' + loc.sink.len + ' bytes): ',
        selfstart: loc.selfstart.ok && 'call ' + hex(loc.selfstart.offset) + ' in onSuggestUi ' + hex(loc.selfstart.onSuggestUi) +
            ' (setStreamStatus ' + hex(loc.selfstart.setStreamStatus) + ', requestStream ' + hex(loc.selfstart.requestStream) + '): ',
        res: loc.res.ok && 'immediates ' + [loc.res.mm, loc.res.px, loc.res.safe1, loc.res.safe2].map(hex).join(' ') +
            ' (builder ' + hex(loc.res.builder) + '): ',
        mapurl: loc.mapurl.ok && 'string ' + hex(loc.mapurl.slot) + ' (' + loc.mapurl.len + ' bytes, log ' + hex(loc.mapurl.log) + '), initial URL ' +
            hex(loc.mapurl.lea) + ' (display builder ' + hex(loc.mapurl.builder) + '): ',
        showui: loc.showui.ok && 'log text ' + hex(loc.showui.str) + ' (' + loc.showui.len + ' bytes), call site ' + hex(loc.showui.call) + ' (' +
            loc.showui.callLen + ' bytes, requestStream ' + hex(loc.showui.requestStream) + ', URL getter ' + hex(loc.showui.getter) + '): ',
    };
    EDITS.concat(URL_EDITS).forEach(function (e) { line(e, (at[e] || '') + describe(e, c[e])); });
    var bad = unrecognised(c);
    line('patchable', bad.length ? 'no — ' + bad.join('; ') : 'yes');
}

/* The sink URL a --capture/--sink patch writes, or undefined for the stock AVB
 * sink (the AVB test). --capture <fifo> is sugar for a file:// FIFO; --sink
 * <url> takes a full udp://, tcp:// or file:// URL. */
function sinkUrlFor(capture, sink) {
    if (sink !== undefined) {
        if (sink === null || !/^(file|udp|tcp):\/\/[^\0]+$/.test(sink)) die('--sink needs a file://, udp:// or tcp:// URL');
        return sink;
    }
    if (capture === undefined) return undefined;
    if (capture === null) die('--capture needs an absolute FIFO path');
    if (!/^\/[^\0]+$/.test(capture)) die('--capture must be an absolute path');
    return 'file://' + capture + '?mime_type=video/H264';
}

/* The geometry the patch writes, or null for the build's stock IC_HIGH
 * geometry (--res stock and the mid panel; the mid builder is never
 * rewritten). The high panel advertises this tool's display size: --res WxH,
 * or the default, at the map area's physical size, with the default safe
 * area scaled to that size, --safe WxH+X+Y, or --safe full (the whole frame). */
function resFor(panel, res, safe) {
    if (res !== undefined && panel !== 'high') die('--res rewrites the IC_HIGH geometry; it goes with --panel high');
    if (safe !== undefined && (panel !== 'high' || res === 'stock')) die('--safe sets the safe area of the advertised size; it goes with --panel high, not --res stock');
    if (panel !== 'high' || res === 'stock') return null;
    var w = RES_DEFAULT.w, h = RES_DEFAULT.h;
    if (res !== undefined) {
        var m = /^([0-9]+)x([0-9]+)$/.exec(res || '');
        if (!m) die('--res needs WxH (e.g. 1088x480) or "stock"');
        w = parseInt(m[1], 10); h = parseInt(m[2], 10);
        if (w < 16 || w > 1920 || h < 16 || h > 1080 || (w % 2) !== 0 || (h % 2) !== 0)
            die('--res ' + res + ' out of range: width 16..1920, height 16..1080, both even (H.264)');
    }
    /* The default safe area's edges, scaled from the default size. */
    var d = SAFE_DEFAULT, dw = RES_DEFAULT.w, dh = RES_DEFAULT.h;
    var x0 = Math.round(d.x * w / dw), x1 = Math.round((d.x + d.w) * w / dw);
    var y0 = Math.round(d.y * h / dh), y1 = Math.round((d.y + d.h) * h / dh);
    var g = { w: w, h: h, mmw: RES_DEFAULT.mmw, mmh: RES_DEFAULT.mmh, safew: x1 - x0, safeh: y1 - y0, safex: x0, safey: y0 };
    if (safe === 'full') {
        g.safew = w; g.safeh = h; g.safex = 0; g.safey = 0;
    } else if (safe !== undefined) {
        var sm = /^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/.exec(safe || '');
        if (!sm) die('--safe needs WxH+X+Y (e.g. 504x368+286+72) or "full"');
        g.safew = parseInt(sm[1], 10); g.safeh = parseInt(sm[2], 10);
        g.safex = parseInt(sm[3], 10); g.safey = parseInt(sm[4], 10);
        if (g.safew < 16 || g.safeh < 16 || g.safex + g.safew > w || g.safey + g.safeh > h)
            die('--safe ' + safe + ' out of range: at least 16x16, inside the ' + w + 'x' + h + ' frame');
    }
    return g;
}

/* The backup, checked for a patch: its SHA-256 is the one recorded when it
 * was taken, and it is a pristine build. `pre`, when given, is the backup
 * already read and classified ({ buf, c }). { buf, hash, c } or { err }. */
function checkedBackup(target, pre) {
    var orig = pre ? pre.buf : fs.readFileSync(backupPath(target)), hash = sha256(orig), meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(target), 'utf8')); } catch (e) {}
    if (meta && meta.sha256_original && meta.sha256_original !== hash) return { err: 'sha256 ' + hash + ' != recorded ' + meta.sha256_original };
    var c = pre ? pre.c : classify(orig), why = notPristine(c, orig);
    return why ? { err: why } : { buf: orig, hash: hash, c: c };
}

/* The most bytes a binary may differ in from its backup and still count as
 * the backup's build when either lacks a GNU build-id: the edits' bytes
 * (variant 4, sink 59, self-start 5, geometry 4 x 8, map URL 55 + 7, ShowUI
 * URL 64 + 11), twice over. */
var SAME_BUILD_MAX_DIFF = 2 * (4 + 59 + 5 + 4 * 8 + 55 + 7 + 64 + 11);

/* Why `cur` is not the build `orig` is the original of, or null when it is:
 * the same build-id and size, or, when either has no build-id, the same size
 * and at most SAME_BUILD_MAX_DIFF bytes apart. */
function otherBuild(cur, orig) {
    if (cur.length !== orig.length) return 'its size differs';
    var a = locator.buildId(cur), b = locator.buildId(orig);
    if (a && b) return a === b ? null : 'its build-id differs';
    for (var i = 0, n = 0; i < cur.length; i++) {
        if (cur[i] !== orig[i] && ++n > SAME_BUILD_MAX_DIFF) return 'no build-id, and more than ' + SAME_BUILD_MAX_DIFF + ' bytes differ';
    }
    return null;
}

/* The backup, checked for a restore without the locator, so a binary any
 * version of this tool patched can be restored: its SHA-256 and GNU build-id
 * are the recorded ones (each when recorded). { buf, hash, meta (the record,
 * or null), other } or { err }; other says why `cur` is not the backup's
 * build (which writing the backup whole would replace), null when it is. */
function trustedBackup(target, cur) {
    var orig, meta = null;
    try { orig = fs.readFileSync(backupPath(target)); } catch (e) { return { err: 'no backup' }; }
    try { meta = JSON.parse(fs.readFileSync(metaPath(target), 'utf8')); } catch (e) {}
    var hash = sha256(orig), id = locator.buildId(orig);
    if (meta && meta.sha256_original && meta.sha256_original !== hash) return { err: 'sha256 ' + hash + ' != recorded ' + meta.sha256_original };
    if (meta && meta.buildId && id && meta.buildId !== id) return { err: 'build-id ' + id + ' != recorded ' + meta.buildId };
    return { buf: orig, hash: hash, meta: meta, other: otherBuild(cur, orig) };
}

/* The backup's URL edit sites (located in it as `bc`) where `cur` holds
 * the bytes a patched form writes: [offset, length] each. A region-wise
 * revert restores them also where the locator does not find the edit in
 * `cur`. */
function urlsLeft(cur, bc) {
    var m = bc.ok && bc.loc.mapurl, u = bc.ok && bc.loc.showui, out = [];
    if (m && m.ok) out = [[m.slot, 'slotBytes'], [m.lea, 'leaBytes']].filter(function (s) {
        return m.forms.some(function (f) { return cur.toString('hex', s[0], s[0] + f[s[1]].length / 2) === f[s[1]]; });
    }).map(function (s) { return [s[0], m[s[1]].length / 2]; });
    if (u && u.ok) out = out.concat([[u.str, u.strBytes], [u.call, u.callBytes]].filter(function (s) {
        return cur.toString('hex', s[0], s[0] + s[1].length / 2) === s[1];
    }).map(function (s) { return [s[0], s[1].length / 2]; }));
    return out;
}

/* What a revert of `cur` (classified as `c`) writes, without --force:
 * { b, bc (the backup classified), regionWise, out } or { err }. When the
 * locator recognises the target and the backup as the same build, the
 * backup's bytes in the edits' regions only (another tool's changes stay);
 * otherwise the whole backup. A backup with no record of the original (an
 * older release's, cut short by a power loss) is written whole only when the
 * locator reads it as the pristine build or it has the target's size. */
function restorePlan(target, cur, c) {
    var b = trustedBackup(target, cur);
    if (b.err) {
        /* No backup to trust: a proven build with an edit of ours is
         * rebuilt from its own bytes; the shipped file is its own original. */
        var so = locator.stockOriginal(PROVEN, cur);
        if (!so || (!so.equals(cur) && !oursIn(c))) return b;
        return { b: { buf: so, hash: sha256(so), meta: false, other: null, stock: true }, bc: classify(so), regionWise: false, out: so };
    }
    var orig = b.buf, bc = classify(orig), pristine = !notPristine(bc, orig);
    if (!b.other && !unrecognised(c).length && pristine && sameBuild(c, bc)) {
        var out = Buffer.from(cur);
        regions(c).concat(urlsLeft(cur, bc)).forEach(function (r) { orig.copy(out, r[0], r[0], r[0] + r[1]); });
        return { b: b, bc: bc, regionWise: true, out: out };
    }
    if (!b.meta && !pristine && orig.length !== cur.length) return { err: 'no record of the original, and it is not the pristine build' };
    return { b: b, bc: bc, regionWise: false, out: orig };
}

/* The edited image of `buf` (classified as `c`; `orig`, the pristine
 * original of its build, whose stock geometry `--res stock` and the mid
 * panel write back): { out, changed (what each changed region is for),
 * writes ({ mapurl, showui, res }: what the edit leaves written), wrong (why
 * the edited image does not read as exactly the requested state, at the
 * same sites, changed only in the edit regions; null when it does) }. The
 * in-memory plan (plan) comes from here. */
function edited(buf, c, orig, panel, sinkUrl, wantRes) {
    var slotLen = locator.SINK_STOCK.length;
    var loc = c.loc, out = Buffer.from(buf), changed = [];
    function put(what, off, bytes) {
        if (out.slice(off, off + bytes.length).equals(bytes)) return;
        bytes.copy(out, off);
        if (changed.indexOf(what) < 0) changed.push(what);
    }
    var slot = Buffer.alloc(4);
    slot.writeUInt32LE(panel === 'high' ? loc.variant.high : loc.variant.mid, 0);
    put('variant -> IC_' + panel.toUpperCase(), loc.variant.slot, slot);

    /* With a sink URL, redirect the 2nd stream to this tool. Without one, ensure
     * the sink is the stock avb:// endpoint (resetting it if a previous patch
     * redirected it), so `--panel X` alone is the AVB test mode: variant
     * patched, stock sink. */
    var sinkWant = Buffer.alloc(slotLen, 0);
    sinkWant.write(sinkUrl !== undefined ? sinkUrl : locator.SINK_STOCK, 'latin1');
    put(sinkUrl !== undefined ? 'sink -> ' + sinkUrl : 'sink -> stock AVB', loc.sink.offset, sinkWant);

    /* Self-start is applied in every mode: without it NavController never
     * forwards the start command and the phone never streams, whatever the sink
     * is. Enabling the map therefore always ensures this edit is present. */
    put('self-start -> requestStream', loc.selfstart.offset, Buffer.from(loc.selfstart.patched, 'hex'));

    /* The advertised IC_HIGH geometry: this tool's display size on the high
     * panel, the backup's stock immediates otherwise, so the binary carries
     * one panel's geometry at a time. */
    var resWant = Buffer.from(out);
    if (wantRes) writeRes(resWant, loc.res, wantRes);
    var resText = wantRes ? 'resolution -> ' + geomText(wantRes) : 'resolution -> stock ' + readRes(orig, loc.res).w + 'x' + readRes(orig, loc.res).h;
    [loc.res.mm, loc.res.px, loc.res.safe1, loc.res.safe2].forEach(function (o) {
        put(resText, o, (wantRes ? resWant : orig).slice(o, o + 8));
    });

    /* The URL edits, in every mode, where the build has them. */
    var writes = { mapurl: c.mapurl.state !== 'absent', showui: c.showui.state !== 'absent', res: wantRes };
    if (writes.mapurl) c.mapurl.sites.forEach(function (s) { put('map URL -> ' + MAP_URL, s[0], Buffer.from(s[1], 'hex')); });
    if (writes.showui) c.showui.sites.forEach(function (s) { put('ShowUI URL -> ' + SHOWUI_URL, s[0], Buffer.from(s[1], 'hex')); });


    /* The edited image must read as exactly the requested state, at the same
     * sites, changed only in the edit regions, before it is written. */
    var cc = classify(out);
    var wrong = !sameBuild(c, cc) ? 'the edit sites' : cc.variant.panel !== panel ? 'variant'
        : cc.sink.state !== (sinkUrl !== undefined ? 'redirected' : 'original') ? 'sink'
        : cc.selfstart.state !== 'patched' ? 'self-start'
        : cc.res.state !== (wantRes ? 'patched' : 'original') ? 'resolution'
        : cc.mapurl.state !== (writes.mapurl ? 'patched' : 'absent') ? 'map URL'
        : cc.showui.state !== (writes.showui ? 'patched' : 'absent') ? 'ShowUI URL'
        : !onlyRegionsDiffer(buf, out, regions(c)) ? 'bytes outside the edit regions' : null;
    return { out: out, changed: changed, writes: writes, wrong: wrong };
}

/* Revert writes what restorePlan says: the edits' regions of a target the
 * locator recognises as the backup's build, else the whole backup over the
 * backup's own build, which also undoes a patch any version of this tool
 * wrote at a site the locator now refuses. --force writes the whole backup
 * over another build too, never a backup restorePlan refuses. --drop-backup
 * deletes the backup once none of the edits is left in the target, for a
 * removal of the tool: nothing is left to revert. */
function cmdRevert(target, yes, force, dropBackup) {
    function drop() {
        if (!dropBackup) return;
        [bak, metaPath(target), bak + '.tmp', metaPath(target) + '.tmp', record.recordPath(target)].forEach(function (f) {
            try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') die('dropping ' + f + ': ' + e.message); }
        });
        process.stdout.write('backup dropped\n');
    }
    var bak = backupPath(target), cur = readTarget(target), cc = classify(cur), p;
    var revRec = revertRecord(record.current(target), cc);
    try { p = restorePlan(target, cur, cc); } catch (e) { p = { err: e.message }; }
    if (p.err) die(fs.existsSync(bak) ? 'backup ' + bak + ' is not a verified original (' + p.err + '), and ' + target + ' cannot be rebuilt from its shipped bytes; refusing to restore it'
        : 'no backup at ' + bak + ', and ' + target + ' cannot be rebuilt from its shipped bytes; cannot revert');
    var b = p.b, orig = b.buf;
    if (cur.equals(orig)) {
        if (modeOnly(target, cur, p)) repairMode(target, yes);
        process.stdout.write('already at the original; nothing to do\n'); record.ensure(target, revRec); drop(); return;
    }
    /* Another build (a firmware update replaced carplay and left the old
     * backup behind): restoring would downgrade it. */
    if (b.other && !force) {
        die('current ' + target + ' is another build than the backup (' + b.other + ').' +
            '\n  It may have been replaced (e.g. a firmware update). Refusing to overwrite it.' +
            '\n  Pass --force only if you are sure this backup is the right original for it.');
    }
    var regionWise = p.regionWise && !force, out = regionWise ? p.out : orig;
    if (regionWise && out.equals(cur)) { process.stdout.write('nothing to do: none of the edits is in it; other changes kept\n'); record.ensure(target, revRec); drop(); return; }
    process.stdout.write('About to restore ' + (regionWise ? 'the edited regions of ' : '') + target + ' from ' +
        (b.stock ? 'the proven build\'s shipped bytes' : bak) + ' (sha256 ' + b.hash + ')\n');
    if (!yes) die('pass --yes to proceed');
    writeInPlace(target, out);
    var after = readTarget(target), ca = regionWise ? classify(after) : null;
    if (!after.equals(out) || (ca && (!ca.ok || urlsOurs(ca) || unrecognised(ca).length || urlsLeft(after, p.bc).length ||
        EDITS.some(function (e) { return ca[e].state !== 'original'; })))) die('restore verification failed');
    record.ensure(target, revRec);
    process.stdout.write(after.equals(orig) ? 'restored OK. sha256 now ' + b.hash + '\n'
        : 'restored the edited regions; changes outside them kept. sha256 now ' + sha256(after) + '\n');
    if (dropBackup) drop();
    else if (!b.stock) process.stdout.write('You may delete the backup: ' + bak + ' and ' + metaPath(target) + '\n');
}

function cmdVerify(target) {
    var c = classify(readTarget(target)), bad = unrecognised(c);
    if (bad.length) { process.stderr.write('FAIL: ' + bad.join('; ') + '\n'); process.exit(1); }
    /* A fully enabled build has every edit its panel needs. A variant/
     * sink-patched build with stock self-start (an Edit-1/2-only binary)
     * would advertise the display but never start the stream; a high-panel
     * build with stock resolution advertises a display size this tool does
     * not show. Verify calls neither enabled. The mid panel keeps the stock
     * geometry by design. */
    var resOk = c.variant.panel !== 'high' || c.res.state === 'patched';
    var enabled = c.variant.state === 'patched' && c.selfstart.state === 'patched' && resOk;
    var partial = (c.variant.state === 'patched' || c.selfstart.state === 'patched' || c.res.state === 'patched') && !enabled;
    if (partial) { process.stderr.write('FAIL: partially patched — variant ' + c.variant.state + ', self-start ' + c.selfstart.state + ', res ' + c.res.state + ' (the patch applies all edits)\n'); process.exit(1); }
    process.stdout.write('OK: variant ' + (c.variant.state === 'original' ? 'original' : 'IC_' + c.variant.panel.toUpperCase()) +
        ', sink ' + (c.sink.state === 'original' ? 'original (AVB 15)' : c.sink.url) +
        ', self-start ' + (c.selfstart.state === 'patched' ? 'on' : 'off') +
        ', res ' + (c.res.state === 'patched' ? c.res.res.w + 'x' + c.res.res.h : 'stock') +
        ', map URL ' + (c.mapurl.state === 'patched' ? 'on' : c.mapurl.state === 'eta' ? 'on with ETA' : c.mapurl.state === 'original' ? 'off' : 'n/a') +
        ', ShowUI URL ' + (c.showui.state === 'patched' ? 'with ETA' : c.showui.state === 'original' ? 'stock' : 'n/a') + '\n');
}

function fsyncFile(path) {
    var fd = fs.openSync(path, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/* carplay's mode and owner (file_mode.js): its original's, recorded with
 * the backup, at least 0755. */
function wantedMode(target) {
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(target), 'utf8')); } catch (e) {}
    return fileMode.wanted(target, meta, fileMode.EXEC);
}

/* Whether target holds exactly the verified pristine backup of ours but
 * carplay.service's user cannot run it: a revert sets only its mode. A
 * carplay without a backup of ours keeps its mode. */
function modeOnly(target, cur, p) {
    return !p.err && !p.b.other && !p.b.stock && cur.equals(p.b.buf) && !notPristine(p.bc || classify(p.b.buf), p.b.buf) && fileMode.lacks(target, fileMode.EXEC);
}

/* target given its original's mode and owner, with --yes, when
 * carplay.service's user cannot run it. */
function repairMode(target, yes) {
    if (!fileMode.lacks(target, fileMode.EXEC)) return;
    var want = wantedMode(target), fix = fileMode.mismatch(target, want);
    if (!yes) die(target + ' has ' + fix + '; pass --yes to set them');
    try { fileMode.repair(target, want); } catch (e) { die('setting ' + target + '\'s mode and owner: ' + e.message); }
    process.stdout.write('set ' + target + '\'s mode and owner (it had ' + fix + ')\n');
}

/* ---- in memory (PATCH.md "In memory") ---- */

/* The names of the regions regions(c) lists, in its order. */
function regionNames(c) {
    var out = ['variant', 'sink', 'selfstart', 'res-mm', 'res-px', 'res-safe1', 'res-safe2'];
    URL_EDITS.forEach(function (e) { if (c[e].sites) c[e].sites.forEach(function (s, i) { out.push(e + '-' + (i + 1)); }); });
    return out;
}

/* The plan libwocpatch.so applies ("wocplan 1"): the build-id, and for
 * every edit region its virtual address, the bytes `buf` holds there and
 * the bytes `out` holds (the same where the edit leaves the region stock,
 * as the sink in the avb mode: the library checks it, and patchd's memory
 * check tells a process running another mode's sink apart). Each region
 * lies in one file-backed PT_LOAD part. { text, edits (the regions that
 * change) } or { err }. */
function planText(buf, out, c) { return planOf(buf, out, regions(c), regionNames(c), c.loc.buildId); }

/* The plan of the edit regions rs ([[offset, length]], named by `names`)
 * between `buf` and its edited image `out`, for the build `id` (aapd's
 * plan is made here too). { text, edits } or { err }. */
function planOf(buf, out, rs, names, id) {
    var elf = locator.elf.parseElf(buf), lines = ['wocplan 1', 'build-id ' + id], edits = [];
    if (!elf.load || !id) return { err: 'no ELF load segments or no build-id' };
    for (var i = 0; i < rs.length; i++) {
        var off = rs[i][0], len = rs[i][1];
        var seg = elf.load.filter(function (s) { return off >= s.off && off + len <= s.off + s.size; })[0];
        if (!seg) return { err: names[i] + ' at ' + hex(off) + ' is not inside one loaded segment' };
        if (len > 128) return { err: names[i] + ' is ' + len + ' bytes, more than a plan line holds' };
        lines.push(['edit', names[i], (seg.va + off - seg.off).toString(16), buf.slice(off, off + len).toString('hex'), out.slice(off, off + len).toString('hex')].join(' '));
        if (!buf.slice(off, off + len).equals(out.slice(off, off + len))) edits.push(names[i]);
    }
    if (!edits.length) return { err: 'nothing to edit' };
    lines.push('end ' + rs.length);
    return { text: lines.join('\n') + '\n', edits: edits };
}

/* A plan's edits ([{name, va, stock, patched}]) and build-id, or { err }. */
function parsePlan(text) {
    var lines = text.split('\n'), edits = [], id = null, ended = false;
    if (lines.pop() !== '' || lines[0] !== 'wocplan 1') return { err: 'not a version 1 plan' };
    for (var i = 1; i < lines.length; i++) {
        var f = lines[i].split(' ');
        if (ended) return { err: 'lines after its end' };
        if (f[0] === 'build-id' && f.length === 2) id = f[1];
        else if (f[0] === 'edit' && f.length === 5) edits.push({ name: f[1], va: parseInt(f[2], 16), stock: Buffer.from(f[3], 'hex'), patched: Buffer.from(f[4], 'hex') });
        else if (f[0] === 'end' && f.length === 2 && Number(f[1]) === edits.length) ended = true;
        else return { err: 'bad line ' + (i + 1) };
    }
    return ended && id && edits.length ? { id: id, edits: edits } : { err: 'cut short' };
}

/* What an earlier release's patch in `cur` is, against the original
 * `orig` of its build and a plan made from `orig`: onlyPlan, the two differ
 * only inside the plan's regions (a revert gives back exactly `orig`), and
 * same, `cur` holds the plan's bytes at every one of them (the patch runs
 * what the plan writes). { onlyPlan, same } or { err }. */
function againstPlan(cur, orig, text) {
    var p = parsePlan(text), elf = locator.elf.parseElf(orig);
    if (p.err) return { err: 'plan: ' + p.err };
    if (!elf.load) return { err: elf.reason };
    if (cur.length !== orig.length) return { onlyPlan: false, same: false };
    var rs = [], same = true;
    for (var i = 0; i < p.edits.length; i++) {
        var e = p.edits[i], seg = elf.load.filter(function (s) { return e.va >= s.va && e.va + e.stock.length <= s.va + s.size; })[0];
        if (!seg) return { err: e.name + ' is not inside one loaded segment' };
        var off = seg.off + e.va - seg.va;
        rs.push([off, e.stock.length]);
        if (!cur.slice(off, off + e.stock.length).equals(e.patched)) same = false;
    }
    return { onlyPlan: onlyRegionsDiffer(cur, orig, rs), same: same };
}

/* `buf` with the plan laid over it, as the process the plan is applied to
 * sees it, or { err } when the plan is not for this build or a site does
 * not read stock. */
function overlay(buf, text) {
    var p = parsePlan(text), elf = locator.elf.parseElf(buf);
    if (p.err) return { err: 'plan: ' + p.err };
    if (!elf.load) return { err: elf.reason };
    if (locator.elf.noteBuildId(buf, elf.notes) !== p.id) return { err: 'the plan is for build ' + p.id };
    var out = Buffer.from(buf);
    for (var i = 0; i < p.edits.length; i++) {
        var e = p.edits[i], seg = elf.load.filter(function (s) { return e.va >= s.va && e.va + e.stock.length <= s.va + s.size; })[0];
        if (!seg) return { err: e.name + ' is not inside one loaded segment' };
        var off = seg.off + e.va - seg.va;
        if (!buf.slice(off, off + e.stock.length).equals(e.stock)) return { err: e.name + ' does not read as the plan\'s stock bytes' };
        e.patched.copy(out, off);
    }
    return { buf: out, edits: p.edits.map(function (e) { return e.name; }) };
}

/* `plan`: the patch, as a plan for libwocpatch.so, made from
 * the file on disk, which must be the pristine build (it is what the
 * process maps) and stays as it is. Checks:
 * the head unit, the coding (--unproven), the locator, a proven build
 * (--unproven). Writes the plan to `outFile` by rename and prints one JSON
 * line: build, sha256, size, edits, provenBuild, coding ('ok', 'refused',
 * 'unreadable'), writes. */
function cmdPlan(target, panel, capture, sink, res, safe, unproven, codingFile, outFile) {
    var hu = headUnit.refused();
    if (hu) die('refusing: ' + hu);
    if (!outFile) die('plan needs --out <file>');
    if (panel !== 'high' && panel !== 'mid') die('--panel must be high or mid');
    var coding = readCoding(codingFile), codingBad = codingRefusal(coding);
    if (codingBad && !unproven) die('refusing: ' + codingBad + '; pass --unproven to patch it anyway');
    var wantRes = resFor(panel, res, safe);
    var sinkUrl = sinkUrlFor(capture, sink);
    if (sinkUrl !== undefined && Buffer.byteLength(sinkUrl, 'latin1') > locator.SINK_STOCK.length) die('sink URL too long');
    var buf = readTarget(target), c = classify(buf), bad = unrecognised(c);
    if (bad.length) die('refusing: ' + bad.join('; '));
    var why = notPristine(c, buf);
    if (why) die('in memory needs the pristine build on disk: ' + why);
    if (!PROVEN[c.loc.buildId] && !unproven) die(label(c) + ' (carplay ' + (c.loc.version || 'version unknown') + ') is not a proven build; pass --unproven to patch it anyway');
    var e = edited(buf, c, buf, panel, sinkUrl, wantRes);
    if (e.wrong) die('refusing: the edited image does not verify (' + e.wrong + ')');
    var p = planText(buf, e.out, c);
    if (p.err) die('refusing: ' + p.err);
    var o = overlay(buf, p.text);
    if (o.err || !o.buf.equals(e.out)) die('refusing: the plan does not reproduce the edited image (' + (o.err || 'bytes differ') + ')');
    var tmp = outFile + '.tmp';
    fs.writeFileSync(tmp, p.text, { mode: 0o644 });
    fsyncFile(tmp);
    fs.renameSync(tmp, outFile);
    process.stdout.write(JSON.stringify({ build: c.loc.buildId, version: label(c), sha256: sha256(buf), size: buf.length, edits: p.edits,
        provenBuild: !!PROVEN[c.loc.buildId], coding: cd(coding), writes: { mapurl: e.writes.mapurl, showui: e.writes.showui, res: e.writes.res ? resKey(e.writes.res) : null },
        planSha256: sha256(Buffer.from(p.text)) }) + '\n');
    function cd(x) { return x.err ? 'unreadable' : codingRefusal(x) ? 'refused' : 'ok'; }
}

/* `overlay`: the edit lines of `status` for the file with the plan laid
 * over it (what a process the plan was applied to runs), then `overlay:
 * ok` or `overlay: NO — why`. Read-only. */
function cmdOverlay(target, planFile) {
    var buf = readTarget(target), text;
    try { text = fs.readFileSync(planFile, 'utf8'); } catch (e) { line('overlay', 'NO — ' + e.message); return; }
    var o = overlay(buf, text);
    if (o.err) { line('overlay', 'NO — ' + o.err); return; }
    var c = classify(o.buf);
    if (!c.ok) { line('overlay', 'NO — ' + c.reason); return; }
    EDITS.concat(URL_EDITS).forEach(function (e) { line(e, describe(e, c[e])); });
    line('edits', o.edits.join(' '));
    line('overlay', 'ok');
}

/* Write by atomic rename so a crash mid-write cannot leave carplay half
 * written; fall back to in-place rewrite on a cross-device/busy rename.
 * Either way carplay gets its mode and owner explicitly (file_mode.js). The
 * caller remounts / read-write around this (the remount window). */
function writeInPlace(target, buf) {
    try { fileMode.replace(target, buf, wantedMode(target), true); } catch (e) { die('writing ' + target + ': ' + e.message); }
}

function onlyRegionsDiffer(a, b, regions) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        var inside = regions.some(function (r) { return i >= r[0] && i < r[0] + r[1]; });
        if (!inside) return false;
    }
    return true;
}

function parseArgs(argv) {
    var a = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var t = argv[i];
        if (t === '--yes') a.yes = true;
        else if (t === '--force') a.force = true;
        else if (t === '--drop-backup') a.dropBackup = true;
        else if (t === '--unproven') a.unproven = true;
        else if (t === '--target') a.target = argv[++i];
        else if (t === '--coding') a.coding = argv[++i];
        else if (t === '--panel') a.panel = argv[++i];
        else if (t === '--out') a.out = argv[++i];
        else if (t === '--plan') a.plan = argv[++i];
        else if (t === '--capture') {
            /* A missing or flag-shaped value is an error, not "no capture". */
            a.capture = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else if (t === '--sink') {
            a.sink = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else if (t === '--res') {
            a.res = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else if (t === '--safe') {
            a.safe = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else a._.push(t);
    }
    return a;
}

function main() {
    var a = parseArgs(process.argv.slice(2));
    var cmd = a._[0];
    var target = a.target || '/usr/bin/carplay';
    var coding = a.coding || process.env.WOC_CODING || '/dev/shm/rawcodingdata';
    if (cmd === 'status') { cmdStatus(target, coding); line('end', 'complete'); }
    else if (cmd === 'probe') cmdProbe(a.target || a._[1] || '/usr/bin/carplay');
    else if (cmd === 'revert') cmdRevert(target, a.yes, a.force, a.dropBackup);
    else if (cmd === 'verify') cmdVerify(target);
    else if (cmd === 'plan') cmdPlan(target, a.panel, a.capture, a.sink, a.res, a.safe, a.unproven, coding, a.out);
    else if (cmd === 'overlay') { cmdOverlay(target, a.plan); line('end', 'complete'); }
    else { process.stderr.write('usage: carplay_patch.js status|probe|revert|verify|plan|overlay [--target <file>] [--coding <shm>] [--panel high|mid] [--capture <fifo> | --sink <url>] [--res WxH|stock] [--safe WxH+X+Y|full] [--unproven] [--yes] [--force] [--drop-backup]\n'); process.exit(2); }
}

/* Whether target holds a change besides our edits, against its original
 * (our trusted backup, or the proven build's own bytes): true, false, or
 * null when that cannot be told (status prints it as `foreign:`). */
function foreignIn(target) {
    try {
        var buf = fs.readFileSync(target), c = classify(buf), p = restorePlan(target, buf, c);
        if (!c.ok || p.err || p.b.other) return null;
        return !onlyRegionsDiffer(buf, p.b.buf, regions(c).concat(urlsLeft(buf, p.bc)));
    } catch (e) { return null; }
}

/* edited, classify, resFor and sinkUrlFor: the image an earlier release's
 * apply wrote, for the tests' fixtures. */
module.exports = { trustedBackup: trustedBackup, PROVEN: PROVEN, parsePlan: parsePlan, overlay: overlay, againstPlan: againstPlan, planOf: planOf,
    foreignIn: foreignIn, edited: edited, classify: classify, resFor: resFor, sinkUrlFor: sinkUrlFor };

if (require.main === module) main();
