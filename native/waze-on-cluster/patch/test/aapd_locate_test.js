#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* aapd_locate.js on real aapd builds, and the mutation test on the
 * reference build (AAPD_BIN, aapd 22.39.3, checked by SHA-256).
 *
 * Builds: the reference's sites are the ones the patch was proven at; every
 * build in AAPD_BIN and AAPD_BINS (paths separated by ':') with a known
 * SHA-256 is located or refused as recorded below, and any other is
 * reported.
 *
 * Mutations: each case perturbs a copy of the reference in memory the way
 * another build could differ (code at other addresses, a name string
 * duplicated, a check byte changed, a second copy of a check, a call
 * retargeted, a constant changed, a relocation over an edit) and the
 * locator must either find every site where it really is or refuse the
 * build. A located build with any site elsewhere is a failure. Nothing is
 * written to disk; no BMW bytes are held here.
 *
 *   AAPD_BIN=<aapd 22.39.3> [AAPD_BINS=<aapd>:<aapd>...] node aapd_locate_test.js
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var locator = require('../aapd_locate.js');

var REF_SHA = '6880f54c3abba40c1368f2bf254c77bd4a169323c0d4cab8f9662a7c912dcf89';
/* What each known build locates to: its sites, or the reasons it is refused
 * with and the sites it still finds. */
var BUILDS = {};
BUILDS[REF_SHA] = { name: 'aapd 22.39.3 (ID7 P18_23w44)', buildId: '2dfb9881706bff435b05f621486e8eb8b6c55984', version: '22.39.3',
    sites: { gate: 0x998bd, call: 0x1d43eb, guard: 0x1d3f53, screen: 0x15b440 } };
BUILDS.a7971d64fc0feb4e48942441dc76a67d6df282b56cb5d64e92248ff83f18d62e = { name: 'aapd 23.16.5 (ID8)', buildId: 'ef291b7185f210a24d8e68855d94d44e9f32cb62',
    version: '23.16.5', sites: { screen: 0x180c50 },
    refused: { gate: 'gate: variant check not found', call: 'self-start: onNewNavigationStatus string not found',
               guard: 'self-start: onNewNavigationStatus string not found' } };

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function json(x) { return JSON.stringify(x); }
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

var paths = [process.env.AAPD_BIN || ''].concat((process.env.AAPD_BINS || '').split(':')).filter(function (p, i, a) { return p && a.indexOf(p) === i; });
if (!paths.some(function (p) { return fs.existsSync(p); })) { process.stdout.write('SKIP: set AAPD_BIN (and AAPD_BINS) to copies of aapd builds\n'); process.exit(0); }

/* ---- every build ---------------------------------------------------- */

paths.forEach(function (p) {
    if (!fs.existsSync(p)) { ok(p + ': readable', false); return; }
    var b = fs.readFileSync(p), h = sha(b), want = BUILDS[h], loc = locator.locate(b);
    if (!want) {
        process.stdout.write('note ' + p + ' (sha256 ' + h + ', build-id ' + loc.buildId + ', ' + loc.version + '): ' +
            (loc.ok ? 'located' : 'refused: ' + loc.reason) + '\n');
        return;
    }
    var bad = locator.EDITS.filter(function (e) {
        var r = loc[e];
        if (want.sites[e] !== undefined) return !r.ok || r.offset !== want.sites[e] || r.state !== 'original';
        return r.ok || r.reason !== want.refused[e];
    });
    ok(want.name + ': ' + (want.refused ? 'refused as recorded, ' + Object.keys(want.sites).join(', ') + ' found' : 'every site where the patch was proven'),
        !bad.length && loc.buildId === want.buildId && loc.version === want.version && loc.ok === !want.refused, json(loc));
});

/* ---- the reference ------------------------------------------------------ */

var REF = paths.map(function (p) { return fs.existsSync(p) ? fs.readFileSync(p) : null; }).filter(function (b) { return b && sha(b) === REF_SHA; })[0];
if (!REF) {
    process.stdout.write('skip the patched build and the mutations: none of the builds is aapd 22.39.3\n');
    process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
    process.exit(fails ? 1 : 0);
}
var LOC = locator.locate(REF);
ok('reference: the stock and patched bytes of every edit', LOC.ok && json(locator.EDITS.map(function (e) { return [LOC[e].stock, LOC[e].patched]; })) === json([
    ['83bb1c02000001', '83bb1c02000002'], ['e800f8ffff', 'e840fbffff'], ['837b3802740a837b44020f848d000000', '807b4100740a837b38020f858d000000'],
    ['660fefc0ebe1662e0f1f840000000000', '83f802740b660fefc0ebdc0f1f440000']]), json(LOC));

function patchAll(b, loc) { locator.EDITS.forEach(function (e) { Buffer.from(loc[e].patched, 'hex').copy(b, loc[e].offset); }); return b; }
(function () {
    var p = patchAll(Buffer.from(REF), LOC), loc = locator.locate(p);
    ok('patched build: the same sites, each read patched, the same edits', loc.ok && locator.EDITS.every(function (e) {
        return loc[e].offset === LOC[e].offset && loc[e].state === 'patched' && loc[e].patched === LOC[e].patched;
    }), json(loc));
    var mixed = Buffer.from(REF);
    Buffer.from(LOC.call.patched, 'hex').copy(mixed, LOC.call.offset);
    loc = locator.locate(mixed);
    ok('one edit patched: located, that edit patched, the others original', loc.ok && loc.call.state === 'patched' && loc.gate.state === 'original' &&
        loc.guard.state === 'original' && loc.screen.state === 'original', json(loc));
    /* The patch releases up to 0.10.10 wrote: requestStream's second test a
     * jmp, which reads outdated, with this release's stock and patched
     * bytes over the whole test. */
    var old = patchAll(Buffer.from(REF), LOC);
    REF.copy(old, LOC.guard.offset, LOC.guard.offset, LOC.guard.offset + 10);
    Buffer.from('e98e00000090', 'hex').copy(old, LOC.guard.offset + 10);
    loc = locator.locate(old);
    ok('the earlier release\'s patch: located, the guard outdated, the same edits', loc.ok && loc.guard.state === 'outdated' &&
        loc.guard.stock === LOC.guard.stock && loc.guard.patched === LOC.guard.patched && loc.gate.state === 'patched', json(loc));
})();

/* ---- mutation helpers (ELF program headers, .eh_frame_hdr, rel32) ------- */

function phdrs(buf) {
    var phoff = buf.readUInt32LE(0x20), n = buf.readUInt16LE(0x38), out = [];
    for (var i = 0; i < n; i++) {
        var o = phoff + i * 56;
        out.push({ hdr: o, type: buf.readUInt32LE(o), off: buf.readUInt32LE(o + 8), va: buf.readUInt32LE(o + 16), size: buf.readUInt32LE(o + 32) });
    }
    return out;
}
var LOADS = phdrs(REF).filter(function (p) { return p.type === 1; });
function vaOf(off) { var l = LOADS.filter(function (p) { return off >= p.off && off < p.off + p.size; })[0]; return l ? l.va + off - l.off : null; }
function offOf(va) { var l = LOADS.filter(function (p) { return va >= p.va && va < p.va + p.size; })[0]; return l ? l.off + va - l.va : null; }
var STARTS = (function () {
    var eh = phdrs(REF).filter(function (p) { return p.type === 0x6474e550; })[0], n = REF.readUInt32LE(eh.off + 8), s = [];
    for (var i = 0; i < n; i++) s.push(offOf((eh.va + REF.readInt32LE(eh.off + 12 + i * 8)) >>> 0));
    return s.sort(function (a, b) { return a - b; });
})();
function func(off) {
    for (var i = STARTS.length - 1; i >= 0; i--) if (STARTS[i] <= off) return { off: STARTS[i], end: STARTS[i + 1] };
    return null;
}
function relTo(buf, pos, next) { return offOf((vaOf(next) + buf.readInt32LE(pos)) >>> 0); }
function setRel(buf, pos, next, to) { buf.writeInt32LE(vaOf(to) - vaOf(next), pos); }
function callsIn(f) {
    var out = [];
    for (var p = f.off; p + 5 <= f.end; p++) if (REF[p] === 0xe8) out.push({ at: p, to: relTo(REF, p + 1, p + 5) });
    return out;
}
function leasIn(f) {
    var out = [];
    for (var p = f.off + 1; p + 6 <= f.end; p++) {
        if (REF[p] === 0x8d && (REF[p - 1] & 0xfb) === 0x48 && (REF[p + 1] & 0xc7) === 0x05) out.push({ at: p - 1, to: relTo(REF, p + 2, p + 6) });
    }
    return out;
}
function callersOf(to) {
    var out = [];
    for (var p = 0; p + 5 <= LOADS[0].size; p++) if (REF[p] === 0xe8 && relTo(REF, p + 1, p + 5) === to) out.push(p);
    return out;
}
function cstrStart(s) { var i = REF.indexOf(Buffer.from(s, 'latin1')); while (REF[i - 1] !== 0) i--; return i; }
function cstr(off) { return REF.toString('latin1', off, REF.indexOf(0, off)); }
function find(hex, from, to) { var i = REF.indexOf(Buffer.from(hex, 'hex'), from); return i >= 0 && (to === undefined || i < to) ? i : -1; }

/* Copy [from, from+len) to `to`, fixing every call/rip-lea rel32 so it keeps
 * its target. */
function plant(b, from, len, to) {
    REF.copy(b, to, from, from + len);
    var f = { off: from, end: from + len };
    callsIn(f).forEach(function (c) { if (c.to !== null) setRel(b, c.at - from + to + 1, c.at - from + to + 5, c.to); });
    leasIn(f).forEach(function (l) { if (l.to !== null) setRel(b, l.at - from + to + 3, l.at - from + to + 7, l.to); });
}

/* ---- the reference's structure ------------------------------------------ */

var GATE_FN = func(LOC.gate.offset), SCREEN_FN = func(LOC.screen.offset);
var RS = LOC.call.requestStream, RS_FN = func(RS), SS = LOC.call.setNaviStreamStatus, ONNAV = func(LOC.call.onNav);
var PREP_CALL = callersOf(GATE_FN.off)[0], PREP = func(PREP_CALL);
var KOMBI_CALL = callersOf(SCREEN_FN.off)[0], KOMBI = func(KOMBI_CALL);
var K_CALL = callsIn(KOMBI).filter(function (c) { return c.at < KOMBI_CALL; }).pop();
var FIELD = REF.readUInt32LE(LOC.gate.offset + 2);
var CODING_LEA = find('488db3' + LOC.gate.stock.slice(4, 12));
var CODING = func(CODING_LEA);
var CMD_CALL = callersOf(RS)[0];
/* G: requestStream's opening test (16 bytes), its jump at G + 10. */
var G = LOC.guard.offset;
var LDO = G + 16 + REF.readInt32LE(G + 12);
var STREAMING = find('c7442408' + '02000000', LDO, RS_FN.end);
var SS_STORE = find('895738', SS, func(SS).end);
var MARK = find('c74344' + '01000000', LDO, RS_FN.end);
function named(name) { var at = cstrStart(name); return func(leasIn({ off: LOADS[0].off, end: LOADS[0].size }).filter(function (l) { return l.to === at; })[0].at); }
var READY = named('AlternateDisplays::onAlternateVideoReady()'), END = named('AlternateDisplays::onEndSession()');
var SUBSCRIBE = named('AlternateDisplays::subscribeEvents()'), INIT = named('Application::initAlternateDisplays()');
var GATE_FLAG = REF.readUInt32LE(PREP_CALL + 7);
var INIT_TEST = find('80bb' + REF.toString('hex', PREP_CALL + 7, PREP_CALL + 11) + '00', INIT.off, INIT.end);
var NAV_TEST = (function () {
    for (var p = 0; p + 5 <= LOADS[0].size; p++) if (REF[p] === 0xe9 && relTo(REF, p + 1, p + 5) === LOC.call.onNav) return find('80b8' + REF.toString('hex', PREP_CALL + 7, PREP_CALL + 11) + '00', p - 0x40, p);
    return -1;
})();
var UNAVAILABLE = find('c7442418' + '00000000', LOC.call.offset - 32, LOC.call.offset);
var AVAILABLE = find('c7442418' + '01000000', ONNAV.off, ONNAV.end);
/* The variant converter: the function whose jump table maps raw 9 to class 0. */
var CONV_NAME = cstrStart('codingToInternal(const CodingKOMBI_HUD::eKI_KOMBI_VARIANT&');
var CONV = func(leasIn({ off: LOADS[0].off, end: LOADS[0].size }).filter(function (l) { return l.to === CONV_NAME; })[0].at);
var SWITCH = find('803f', CONV.off, CONV.end);
var TABLE = relTo(REF, SWITCH + 11, SWITCH + 15);
var L0 = LOC.screen.offset + LOC.screen.len;
/* Functions far from every site, to plant code in. */
function victim(min, max, from) {
    for (var i = 0; i < STARTS.length - 1; i++) {
        var s = STARTS[i], e = STARTS[i + 1];
        if (s >= (from || 0x300000) && e - s >= min && e - s <= max) return { off: s, end: e };
    }
    return null;
}
var VICTIM = victim(0x200, 0x10000), SHORT = victim(0x60, 0x80);
/* one loading a string in its first 0x40 bytes */
var LOADER = (function () {
    for (var v = victim(0x100, 0x10000, 0x380000); v; v = victim(0x100, 0x10000, v.end)) {
        var l = leasIn(v).filter(function (x) { return x.at - v.off < 0x40; })[0];
        if (l) return { off: v.off, end: v.end, lea: l.at };
    }
    return null;
})();
ok('mutation anchors found in the reference', [GATE_FN, SCREEN_FN, PREP, KOMBI, K_CALL, CODING, CONV, VICTIM, SHORT, LOADER].every(Boolean) &&
    [CODING_LEA, CMD_CALL, STREAMING, SS_STORE, MARK, UNAVAILABLE, AVAILABLE, SWITCH, INIT_TEST, NAV_TEST].every(function (x) { return x >= 0; }) &&
    [READY, END, SUBSCRIBE, INIT].every(Boolean) &&
    func(CMD_CALL).off !== RS_FN.off && CONV.off < SWITCH);

var EXPECT = {}; locator.EDITS.forEach(function (e) { EXPECT[e] = LOC[e].offset; });
function sites(loc) { var s = {}; locator.EDITS.forEach(function (e) { s[e] = loc[e].offset; }); return s; }
function shifted(d) { var s = {}; Object.keys(EXPECT).forEach(function (k) { s[k] = EXPECT[k] + d; }); return s; }
function moved(over) { var s = JSON.parse(json(EXPECT)); Object.keys(over).forEach(function (k) { s[k] = over[k]; }); return s; }
function appendString(b, s) { return Buffer.concat([b, Buffer.from('\0' + s + '\0', 'latin1')]); }

/* A screen-size helper of another layout, at SHORT, called in place of the
 * build's: `pad` NOP bytes after the fall-through (stock: 10). */
function helperAt(b, pad) {
    var at = SHORT.off, c1 = relTo(REF, find('f20f1005', SCREEN_FN.off, SCREEN_FN.end) + 4, find('f20f1005', SCREEN_FN.off, SCREEN_FN.end) + 8);
    var c0 = relTo(REF, L0 + 4, L0 + 8), lf = at + 20, l0 = lf + 6 + pad;
    b.fill(0x90, at, SHORT.end);
    Buffer.from('8b0785c074' + (l0 - (at + 6)).toString(16).padStart(2, '0') + 'f20f100500000000' + '83f80175' + (lf - (at + 19)).toString(16).padStart(2, '0') +
        'c3' + '660fefc0eb' + ((at + 19 - (lf + 6) + 256) & 0xff).toString(16), 'hex').copy(b, at);
    setRel(b, at + 10, at + 14, c1);
    Buffer.from('f20f100500000000eb' + ((at + 19 - (l0 + 10) + 256) & 0xff).toString(16), 'hex').copy(b, l0);
    setRel(b, l0 + 4, l0 + 8, c0);
    setRel(b, KOMBI_CALL + 1, KOMBI_CALL + 5, at);
    return lf;
}

/* Each: [name, mutate(b) -> b' (or nothing: b changed in place), allowed
 * outcomes, sites when located (default the reference's), the cross-check
 * that alone refuses it]. A case naming a check is run again with that
 * check off, where the build must be located: patched, correctly or not. */
var CASES = [
    ['code and data at other file offsets and addresses', function (b) {
        var pad = 0x1000, out = Buffer.concat([Buffer.alloc(pad), b]);
        b.copy(out, 0, 0, 0x40 + 56 * b.readUInt16LE(0x38));
        phdrs(out).forEach(function (p) {
            out.writeUInt32LE(p.off + pad, p.hdr + 8);
            if (p.type !== 6) { out.writeUInt32LE(p.va + 0x400000, p.hdr + 16); out.writeUInt32LE(p.va + 0x400000, p.hdr + 24); }
            if (p.type === 2) for (var o = p.off + pad; o + 16 <= p.off + pad + p.size && out.readUInt32LE(o) !== 0; o += 16) {
                if (out.readUInt32LE(o) === 7 || out.readUInt32LE(o) === 23) out.writeUInt32LE(out.readUInt32LE(o + 8) + 0x400000, o + 8);
            }
        });
        return out;
    }, ['correct'], shifted(0x1000)],
    ['the patched build at other addresses', function (b) { return CASES[0][1](patchAll(b, LOC)); }, ['correct'], shifted(0x1000)],
    ['a screen-size helper of another layout (16-byte fall-through)', function (b) { helperAt(b, 10); }, ['correct'], moved({ screen: SHORT.off + 20 })],
    ['a copy of the screen helper elsewhere, not called', function (b) { plant(b, SCREEN_FN.off, SCREEN_FN.end - SCREEN_FN.off, SHORT.off); }, ['correct']],

    /* names */
    ['requestStream\'s name string twice', function (b) { return appendString(b, cstr(cstrStart('AlternateDisplays::requestStream()'))); }, ['refused'], null, 'name-once'],
    ['onNewNavigationStatus\'s name loaded by another function too', function (b) {
        setRel(b, LOADER.lea + 3, LOADER.lea + 7, cstrStart('AlternateDisplays::onNewNavigationStatus('));
    }, ['refused'], null, 'name-one-function'],
    ['prepareCinemoConfiguration\'s name loaded only deep inside it', function (b) {
        var l = leasIn(PREP).filter(function (x) { return /prepareCinemoConfiguration/.test(cstr(x.to)); });
        l.forEach(function (x) { setRel(b, x.at + 3, x.at + 7, cstrStart('Preparing external dependencies')); });
        var deep = leasIn(PREP).filter(function (x) { return x.at - PREP.off > 0x100; })[0];
        setRel(b, deep.at + 3, deep.at + 7, l[0].to);
    }, ['refused'], null, 'name-at-entry'],
    ['loadKombiDisplayDefinition\'s name not loaded', function (b) {
        var l = leasIn(KOMBI).filter(function (x) { return /loadKombiDisplayDefinition/.test(cstr(x.to)); })[0];
        setRel(b, l.at + 3, l.at + 7, cstrStart('Kombi Variant:'));
    }, ['refused']],
    ['onNewNavigationStatus\'s name string missing', function (b) { b[cstrStart('AlternateDisplays::onNewNavigationStatus(') + 4] = 0x58; }, ['refused']],

    /* the variant mapping */
    ['raw 7 mapped to class 0', function (b) { b.writeInt32LE(b.readInt32LE(TABLE + 9 * 4), TABLE + 7 * 4); }, ['refused'], null, 'conv-mapping'],
    ['raw 9 and 10 swapped', function (b) { var s9 = b.readInt32LE(TABLE + 36); b.writeInt32LE(b.readInt32LE(TABLE + 40), TABLE + 36); b.writeInt32LE(s9, TABLE + 40); }, ['refused'], null, 'conv-mapping'],
    ['class 2 stored as 3', function (b) { var h = relTo(b, TABLE + 7 * 4, TABLE); b.writeUInt32LE(3, h + 2); }, ['refused'], null, 'conv-mapping'],
    ['a converter handler that is not a store', function (b) { var h = relTo(b, TABLE + 7 * 4, TABLE); b[h] = 0x8b; }, ['refused'], null, 'conv-mapping'],
    ['a copy of the converter elsewhere', function (b) {
        plant(b, CONV.off, CONV.end - CONV.off, VICTIM.off);
        leasIn(CONV).filter(function (l) { return l.to === CONV_NAME; }).forEach(function (l) {
            var at = l.at - CONV.off + VICTIM.off;
            setRel(b, at + 3, at + 7, cstrStart('Kombi Variant:'));
        });
    }, ['refused'], null, 'conv-copy'],
    ['a second switch in the converter', function (b) { REF.copy(b, SWITCH + 0xc0, SWITCH, SWITCH + 24); setRel(b, SWITCH + 0xc0 + 11, SWITCH + 0xc0 + 15, TABLE); }, ['refused'], null, 'conv-switch-once'],
    ['the converter\'s name string missing', function (b) { b[CONV_NAME + cstr(CONV_NAME).indexOf('eKI_')] = 0x58; }, ['refused']],

    /* the variant field and getter */
    ['loadKombiDisplayDefinition reads the variant with another getter', function (b) { setRel(b, K_CALL.at + 1, K_CALL.at + 5, SS); }, ['refused'], null, 'getter-shared'],
    ['initCodingProvider calls the getter twice', function (b) {
        var other = callsIn(CODING).filter(function (c) { return c.at < CODING_LEA && c.to !== K_CALL.to; }).pop();
        setRel(b, other.at + 1, other.at + 5, K_CALL.to);
    }, ['refused'], null, 'getter-once'],
    ['initCodingProvider reads the variant into no field', function (b) { b[CODING_LEA + 1] = 0x8b; }, ['refused']],

    /* screen */
    ['the screen helper called twice', function (b) {
        var other = callsIn(KOMBI).filter(function (c) { return c.at > KOMBI_CALL; })[0];
        setRel(b, other.at + 1, other.at + 5, SCREEN_FN.off);
    }, ['refused'], null, 'helper-once'],
    ['the 10.25" size changed', function (b) { var h = find('f20f1005', SCREEN_FN.off, SCREEN_FN.end); b.writeDoubleLE(10.5, relTo(REF, h + 4, h + 8)); }, ['refused'], null, 'size-1'],
    ['the 12.3" size changed', function (b) { b.writeDoubleLE(12.5, relTo(REF, L0 + 4, L0 + 8)); }, ['refused'], null, 'size-0'],
    ['class 0 does not return through the shared exit', function (b) { b[L0 + 9] -= 2; }, ['refused'], null, 'class0-shape'],
    ['an 18-byte fall-through', function (b) { helperAt(b, 12); }, ['refused'], moved({ screen: SHORT.off + 20 }), 'room'],
    ['a byte other than NOP in the padding', function (b) { b[LOC.screen.offset + 8] = 0xcc; }, ['refused'], null, 'fall-through'],
    ['the fall-through returns elsewhere', function (b) { b[LOC.screen.offset + 5] -= 2; }, ['refused'], null, 'fall-through'],
    ['the helper handed another register than the getter\'s', function (b) { b[KOMBI_CALL - 1] = 0xef; }, ['refused'], null, 'helper-arg'],
    ['the 12.3" and 10.25" loads swapped', function (b) {
        var h = find('8b0785c074', SCREEN_FN.off, SCREEN_FN.end), c0 = relTo(REF, L0 + 4, L0 + 8), c1 = relTo(REF, h + 10, h + 14);
        setRel(b, L0 + 4, L0 + 8, c1); setRel(b, h + 10, h + 14, c0);
    }, ['refused']],
    ['the helper tests the variant otherwise', function (b) { b[find('8b0785c074', SCREEN_FN.off, SCREEN_FN.end) + 3] = 0xff; }, ['refused']],

    /* gate */
    ['the gate reads another field', function (b) { b.writeUInt32LE(FIELD + 4, LOC.gate.offset + 2); }, ['refused'], null, 'gate-field'],
    ['initCodingProvider stores the variant in another field', function (b) { b.writeUInt32LE(FIELD + 4, CODING_LEA + 3); }, ['refused'], null, 'gate-field'],
    ['the gate without the feature-flag test', function (b) { b[LOC.gate.offset - 1] = 0x0c; }, ['refused'], null, 'gate-flag'],
    ['prepareCinemoConfiguration calls the gate twice', function (b) {
        var other = callsIn(PREP).filter(function (c) { return c.at > PREP_CALL && c.to !== GATE_FN.off; })[0];
        setRel(b, other.at + 1, other.at + 5, GATE_FN.off);
    }, ['refused'], null, 'gate-once'],
    ['prepareCinemoConfiguration does not keep the gate\'s result', function (b) { b[PREP_CALL + 5] = 0x89; }, ['refused'], null, 'gate-kept'],
    ['the variant compared once more elsewhere', function (b) { Buffer.from(LOC.gate.stock, 'hex').copy(b, VICTIM.off + 0x40); }, ['refused'], null, 'gate-unique'],
    ['a copy of the gate function elsewhere, not called', function (b) { plant(b, GATE_FN.off, GATE_FN.end - GATE_FN.off, SHORT.off); }, ['refused'], null, 'gate-unique'],
    ['the gate compares with 0', function (b) { b[LOC.gate.offset + 6] = 0; }, ['refused']],
    ['the gate compares with 3', function (b) { b[LOC.gate.offset + 6] = 3; }, ['refused']],
    ['the gate uses setb', function (b) { b[LOC.gate.offset + 8] = 0x92; }, ['refused']],
    ['prepareCinemoConfiguration no longer calls the gate', function (b) { b.fill(0x90, PREP_CALL, PREP_CALL + 5); }, ['refused']],

    /* self-start */
    ['requestStream far from its siblings', function (b) {
        var len = RS_FN.end - RS_FN.off, name = cstrStart('AlternateDisplays::requestStream()');
        plant(b, RS_FN.off, len, VICTIM.off);
        leasIn(RS_FN).filter(function (x) { return x.to === name; }).forEach(function (x) { setRel(b, x.at + 3, x.at + 7, cstrStart('AlternateDisplays::stopStream()')); });
        setRel(b, CMD_CALL + 1, CMD_CALL + 5, VICTIM.off);
    }, ['refused'], null, 'near'],
    ['requestStream not called by onStreamCommandChanged', function (b) { setRel(b, CMD_CALL + 1, CMD_CALL + 5, SS); }, ['refused'], null, 'rs-called'],
    ['a second guard in requestStream', function (b) {
        /* over 16 bytes of whole instructions (call ; mov ; call ; mov), its
         * first branch landing on the next instruction, its second on Ldo */
        var at = RS_FN.off + 0x40;
        while (!(REF[at] === 0xe8 && REF[at + 5] === 0x4c && REF[at + 8] === 0xe8 && REF[at + 13] === 0x48)) at++;
        REF.copy(b, at, G, G + 16);
        setRel(b, at + 12, at + 16, LDO);
    }, ['refused'], null, 'guard-once'],
    ['the guard branches on not-equal', function (b) { b[G + 11] = 0x85; }, ['refused'], null, 'guard-form'],
    ['the guard\'s branch points at the already-streaming path', function (b) { setRel(b, G + 12, G + 16, G + 16); }, ['refused']],
    ['the already-streaming log not loaded', function (b) {
        var l = leasIn(RS_FN).filter(function (x) { return /Already streaming/.test(cstr(x.to)); })[0];
        setRel(b, l.at + 3, l.at + 7, cstrStart('Cinemo navigation status received'));
    }, ['refused'], null, 'already-log'],
    ['the request log not loaded', function (b) {
        var l = leasIn(RS_FN).filter(function (x) { return /Request Stream Command/.test(cstr(x.to)); })[0];
        setRel(b, l.at + 3, l.at + 7, cstrStart('Ignoring event. Already streaming'));
    }, ['refused'], null, 'request-log'],
    ['requestStream logs the request twice', function (b) {
        var recv = leasIn(RS_FN).filter(function (x) { return /Request Stream Command/.test(cstr(x.to)); })[0];
        var later = leasIn(RS_FN).filter(function (x) { return x.at > recv.at && !/Request Stream Command/.test(cstr(x.to)); })[0];
        setRel(b, later.at + 3, later.at + 7, recv.to);
    }, ['refused'], null, 'request-log-once'],
    ['requestStream calls a second function beside it after the request', function (b) {
        var ssc = callsIn(RS_FN).filter(function (x) { return x.to === SS; })[0];
        var later = callsIn(RS_FN).filter(function (x) { return x.at > ssc.at && Math.abs(x.to - SS) > 0x10000; })[0];
        setRel(b, later.at + 1, later.at + 5, func(SS - 1).off);
    }, ['refused'], null, 'ss-call-once'],
    ['setNaviStreamStatus stores a second argument in the field', function (b) {
        Buffer.from('8b4e0c894f3890', 'hex').copy(b, find('4c8b8200010000', SS, func(SS).end));
    }, ['refused'], null, 'ss-field-once'],
    ['onNewNavigationStatus passes another stack slot', function (b) { b[find('4c8d642410', ONNAV.off, ONNAV.end) + 4] = 0x20; }, ['refused'], null, 'arg-pointer'],
    ['requestStream passes another register', function (b) { b[find('4c89e6', LDO, RS_FN.end) + 2] = 0xee; }, ['refused'], null, 'arg-pointer'],
    ['requestStream writes the argument\'s register after setting it to rsp', function (b) {
        Buffer.from('4989c4', 'hex').copy(b, find('4c89e7', find('4989e4', LDO, RS_FN.end), RS_FN.end));
    }, ['refused'], null, 'arg-pointer'],
    ['onNewNavigationStatus writes the argument\'s register after the lea', function (b) {
        Buffer.from('4989c4', 'hex').copy(b, find('4c89e7', find('4c8d642410', ONNAV.off, ONNAV.end), LOC.call.offset));
    }, ['refused'], null, 'arg-pointer'],
    ['onNewNavigationStatus pushes in the call\'s tail', function (b) {
        Buffer.from('509090', 'hex').copy(b, find('4c89ff', UNAVAILABLE + 8, LOC.call.offset));
    }, ['refused']],
    ['onNewNavigationStatus pushes after its status, then points rsi at the new frame', function (b) {
        Buffer.from('50488d742410', 'hex').copy(b, find('4c89e64c89ff', UNAVAILABLE + 8, LOC.call.offset));
        b[find('4883c438', LOC.call.offset, ONNAV.end) + 3] = 0x40;   /* its epilogue pops the push */
    }, ['refused'], null, 'arg-frame'],
    ['onNewNavigationStatus passes lea rsi,[rsp+B] itself', function (b) {
        Buffer.from('488d74241090', 'hex').copy(b, find('4c89e64c89ff', UNAVAILABLE + 8, LOC.call.offset));
    }, ['correct']],
    ['onNewNavigationStatus writes rsi after lea rsi,[rsp+B]', function (b) {
        Buffer.from('488d74241090', 'hex').copy(b, find('4c89e64c89ff', UNAVAILABLE + 8, LOC.call.offset));
        Buffer.from('4889c690', 'hex').copy(b, find('4883c010', UNAVAILABLE + 8, LOC.call.offset));
    }, ['refused'], null, 'arg-pointer'],
    ['a setNaviStreamStatus name of another shape loaded by another function', function (b) {
        var at = cstrStart('AlternateDisplays19setNaviStreamStatus');
        b.write('aapd::navigation::AlternateDisplays::setNaviStreamStatus(int)\0', at, 'latin1');
        setRel(b, LOADER.lea + 3, LOADER.lea + 7, at);
    }, ['refused'], null, 'ss-name'],
    ['the guard compares with 3 first', function (b) { b[G + 3] = 3; }, ['refused']],
    ['the guard\'s first branch lands elsewhere', function (b) { b[G + 5] = 0x0c; }, ['refused']],
    ['the guard compares through another register second', function (b) { b[G + 7] = 0x7a; }, ['refused']],
    ['the guard compares one field twice', function (b) { b[G + 8] = b[G + 2]; }, ['refused']],
    ['requestStream tests another object than its own', function (b) { b[find('4889fb', RS_FN.off, G) + 2] = 0xf3; }, ['refused'], null, 'guard-this'],
    ['onAlternateVideoReady sets its ready flag twice', function (b) {
        var st = find('c6454101', READY.off, READY.end);
        Buffer.from('c64541019090', 'hex').copy(b, st - 8);
    }, ['refused'], null, 'ready-flag'],
    ['onAlternateVideoReady sets no ready flag', function (b) { b[find('c6454101', READY.off, READY.end) + 3] = 2; }, ['refused']],
    ['onAlternateVideoReady does not subscribe to the stream commands', function (b) {
        var c = callsIn(READY).filter(function (x) { return x.to === SUBSCRIBE.off; })[0];
        setRel(b, c.at + 1, c.at + 5, SS);
    }, ['refused'], null, 'ready-subscribe'],
    ['onEndSession clears another flag', function (b) { b[find('c6434100', END.off, END.end) + 2] = 0x42; }, ['refused'], null, 'end-resets'],
    ['onEndSession leaves the focus mode', function (b) { b[find('c7434402000000', END.off, END.end) + 3] = 1; }, ['refused'], null, 'end-resets'],
    ['the patched guard tests another flag than the ready flag', function (b) { patchAll(b, LOC); b[G + 2] = 0x40; }, ['refused'], null, 'guard-ready'],
    ['initAlternateDisplays tests another flag than the gate\'s', function (b) { b.writeUInt32LE(GATE_FLAG + 4, INIT_TEST + 2); }, ['refused'], null, 'gate-gates-alt'],
    ['onNewNavigationStatus reached without a test of the gate\'s result', function (b) { b.writeUInt32LE(GATE_FLAG + 4, NAV_TEST + 2); }, ['refused'], null, 'onnav-gated'],
    ['setNaviStreamStatus stores the status elsewhere', function (b) { b[SS_STORE + 2] = 0x3c; }, ['refused'], null, 'ss-field'],
    ['requestStream passes another status than STREAMING', function (b) { b[STREAMING + 4] = 3; }, ['refused'], null, 'streaming'],
    ['requestStream marks another field', function (b) { b[MARK + 2] = 0x48; }, ['refused'], null, 'mark'],
    ['setNaviStreamStatus\'s name loaded by another function', function (b) {
        var at = cstrStart('AlternateDisplays19setNaviStreamStatus');
        b.write('void aapd::navigation::AlternateDisplays::setNaviStreamStatus(const StreamTypes&)\0', at, 'latin1');
        setRel(b, LOADER.lea + 3, LOADER.lea + 7, at);
    }, ['refused'], null, 'ss-name'],
    ['onNewNavigationStatus calls setNaviStreamStatus twice', function (b) {
        var c = callsIn(ONNAV).filter(function (x) { return x.at < LOC.call.offset && x.to !== SS && Math.abs(x.to - RS) > 0x10000; });
        setRel(b, c[c.length - 1].at + 1, c[c.length - 1].at + 5, SS);
    }, ['refused']],
    ['onNewNavigationStatus calls setNaviStreamStatus again later', function (b) {
        var c = callsIn(ONNAV).filter(function (x) { return x.at > LOC.call.offset && x.to !== SS && Math.abs(x.to - RS) > 0x10000; })[0];
        setRel(b, c.at + 1, c.at + 5, SS);
    }, ['refused'], null, 'onnav-once'],
    ['the UNAVAILABLE status built in another slot', function (b) { b[UNAVAILABLE + 3] = 0x20; }, ['refused'], null, 'status-unavailable'],
    ['the AVAILABLE status built in another slot', function (b) { b[AVAILABLE + 3] = 0x20; }, ['refused'], null, 'status-available'],
    ['the AVAILABLE status jumps elsewhere', function (b) { b.writeInt32LE(b.readInt32LE(AVAILABLE + 9) - 8, AVAILABLE + 9); }, ['refused'], null, 'status-available'],
    ['both statuses moved away from the call\'s argument', function (b) { b[UNAVAILABLE + 3] = 0x20; b[AVAILABLE + 3] = 0x20; }, ['refused']],
    ['onNewNavigationStatus calls another function', function (b) { setRel(b, LOC.call.offset + 1, LOC.call.offset + 5, func(SS - 1).off); }, ['refused']],
    ['requestStream calls another function in place of setNaviStreamStatus', function (b) {
        var c = callsIn(RS_FN).filter(function (x) { return x.to === SS; })[0];
        setRel(b, c.at + 1, c.at + 5, func(SS - 1).off);
    }, ['refused']],
    ['requestStream\'s name loaded only deep inside it', function (b) {
        var name = cstrStart('AlternateDisplays::requestStream()'), l = leasIn(RS_FN).filter(function (x) { return x.to === name; });
        setRel(b, l[0].at + 3, l[0].at + 7, cstrStart('AlternateDisplays::stopStream()'));
    }, ['correct', 'refused']],

    /* the build */
    ['a dynamic relocation over the gate', function (b) {
        var shoff = b.readUInt32LE(0x28), n = b.readUInt16LE(0x3c);
        for (var i = 0; i < n; i++) {
            var o = shoff + i * 64;
            if (b.readUInt32LE(o + 4) === 4) { b.writeUInt32LE(vaOf(LOC.gate.offset), b.readUInt32LE(o + 24)); return; }
        }
        throw new Error('no .rela section');
    }, ['refused'], null, 'reloc'],
    ['no function table', function (b) { var eh = phdrs(b).filter(function (p) { return p.type === 0x6474e550; })[0]; b[eh.off] = 2; }, ['refused']],
];

var tally = { correct: 0, refused: 0, WRONG: 0 }, proved = {};
function outcome(loc, want) { return !loc.ok ? 'refused' : json(sites(loc)) === json(want) ? 'correct' : 'WRONG'; }
CASES.forEach(function (t) {
    var b = Buffer.from(REF), out;
    try { out = t[1](b) || b; } catch (e) { ok(t[0] + ': mutation built', false, e.message); return; }
    var want = t[3] || EXPECT, loc = locator.locate(out), got = outcome(loc, want);
    tally[got]++;
    ok(t[0] + ': ' + got + (got === 'refused' ? ' (' + loc.reason + ')' : ''), t[2].indexOf(got) >= 0,
        'allowed ' + t[2].join('/') + (loc.ok ? '; got ' + json(sites(loc)) + ', want ' + json(want) : ''));
    if (!t[4]) return;
    var wloc = locator.locate(out, { off: [t[4]] }), without = outcome(wloc, want);
    proved[t[4]] = proved[t[4]] || without !== 'refused';
    ok('  with ' + t[4] + ' off: ' + (without === 'correct' ? 'patched' : without === 'WRONG' ? 'patched at the wrong sites' : 'refused (' + wloc.reason + ')'), without !== 'refused');
});
var unproved = locator.CHECKS.filter(function (c) { return !proved[c]; });
ok('every cross-check alone refuses a mutation (' + locator.CHECKS.length + ' checks)', !unproved.length, 'unproved: ' + unproved.join(', '));
ok('the reference with every check off: the same sites', json(sites(locator.locate(REF, { off: locator.CHECKS }))) === json(EXPECT));
process.stdout.write('\n' + CASES.length + ' mutations: ' + tally.correct + ' located correctly, ' + tally.refused + ' refused, ' + tally.WRONG + ' located wrongly\n');
process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
