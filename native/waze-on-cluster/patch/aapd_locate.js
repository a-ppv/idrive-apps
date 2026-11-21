// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* aapd_locate.js — finds the four Android Auto edit sites (PATCH.md "Android
 * Auto") in an aapd build by code and data structure, in their stock or
 * patched form. Each site has to be found exactly once and pass every
 * cross-check; otherwise that edit carries ok:false and a short reason
 * naming what was not found. The functions are found by the name strings
 * their logging prologues load, function bounds come from the .eh_frame_hdr
 * search table, aapd's raw KI_KOMBI_VARIANT -> class mapping must be the
 * one the edits rely on, and a site a dynamic relocation would rewrite at
 * load is refused (carplay_locate.js's ELF reading). It only reads the
 * buffer.
 *
 * Each cross-check has a name (CHECKS); locate(buf, { off: [names] }) skips
 * those, for the mutation test to show what each one alone refuses.
 *
 * Node 8 on the unit, no dependencies. */
'use strict';

var E = require('./carplay_locate.js').elf;
var X86 = require('./x86_flow.js');

/* A function's own name string is loaded by its logging prologue within
 * ENTRY bytes of its start; functions of one source file lie within NEAR. */
var ENTRY = 0x80, NEAR = 0x10000;
/* The largest function a gate or screen-size helper is. */
var SMALL = 0x80;

var NAMES = {
    conv: ['codingToInternal(const CodingKOMBI_HUD::eKI_KOMBI_VARIANT&',
        /^bool (?:\w+::)*codingToInternal\(const (?:\w+::)*eKI_KOMBI_VARIANT&, (?:\w+::)*KombiVariant::Values&\)$/, 'variant: codingToInternal'],
    prep: ['Application::prepareCinemoConfiguration()', /^void (?:\w+::)*Application::prepareCinemoConfiguration\(\)$/, 'gate: prepareCinemoConfiguration'],
    coding: ['Application::initCodingProvider()', /^void (?:\w+::)*Application::initCodingProvider\(\)$/, 'gate: initCodingProvider'],
    kombi: ['ConfigurationManagerInstance::loadKombiDisplayDefinition()',
        /^void (?:\w+::)*ConfigurationManagerInstance::loadKombiDisplayDefinition\(\)$/, 'screen: loadKombiDisplayDefinition'],
    onNav: ['AlternateDisplays::onNewNavigationStatus(',
        /^void (?:\w+::)*AlternateDisplays::onNewNavigationStatus\(CINEMO_ANDROIDAUTO_NAVIGATION_STATUS\)$/, 'self-start: onNewNavigationStatus'],
    rs: ['AlternateDisplays::requestStream()', /^void (?:\w+::)*AlternateDisplays::requestStream\(\)$/, 'self-start: requestStream'],
    cmd: ['AlternateDisplays::onStreamCommandChanged(',
        /^void (?:\w+::)*AlternateDisplays::onStreamCommandChanged\(const (?:\w+::)*ProjectedModeStreamCommand&\)$/, 'self-start: onStreamCommandChanged'],
    received: ['Request Stream Command event received', /^Request Stream Command event received$/, 'self-start: request log'],
    already: ['Ignoring event. Already streaming', /^Ignoring event\. Already streaming\.\.\.$/, 'self-start: already-streaming log'],
    ready: ['AlternateDisplays::onAlternateVideoReady()', /^void (?:\w+::)*AlternateDisplays::onAlternateVideoReady\(\)$/, 'self-start: onAlternateVideoReady'],
    endSession: ['AlternateDisplays::onEndSession()', /^void (?:\w+::)*AlternateDisplays::onEndSession\(\)$/, 'self-start: onEndSession'],
    subscribe: ['AlternateDisplays::subscribeEvents()', /^void (?:\w+::)*AlternateDisplays::subscribeEvents\(\)$/, 'self-start: subscribeEvents'],
    initAlt: ['Application::initAlternateDisplays()', /^void (?:\w+::)*Application::initAlternateDisplays\(\)$/, 'gate: initAlternateDisplays'],
    /* not in every build: checked whenever a string names it */
    ss: ['AlternateDisplays::setNaviStreamStatus(', /AlternateDisplays::setNaviStreamStatus\(/, 'self-start: setNaviStreamStatus'],
};
var EDITS = ['gate', 'call', 'guard', 'screen'];
/* The part of the patch each edit belongs to, for reasons. */
var LABEL = { gate: 'gate', call: 'self-start', guard: 'self-start', screen: 'screen', confpath: 'config path' };
/* The config path aapd reads its configuration from, and the file it reads
 * patched: the same length, so every copy aapd makes of it is the whole
 * path. The patch in memory points it at the copy of aapd.conf with the
 * cluster geometry (PATCH.md "Android Auto: the geometry"). */
var CONF_STOCK = '/etc/aapd.conf', CONF_RUN = '/run/aapd.conf';
/* Every site the patch in memory writes: the four edits an earlier release
 * also wrote to the file, and the config path. */
var SITES = EDITS.concat(['confpath']);

var CHECKS = [
    'name-once', 'name-one-function', 'name-at-entry',
    'conv-copy', 'conv-switch-once', 'conv-mapping',
    'getter-shared', 'getter-once', 'helper-arg',
    'helper-once', 'size-1', 'size-0', 'class0-shape', 'room', 'fall-through',
    'gate-field', 'gate-flag', 'gate-once', 'gate-kept', 'gate-unique', 'gate-gates-alt', 'onnav-gated',
    'near', 'rs-called', 'guard-once', 'guard-form', 'guard-this', 'ready-flag', 'ready-subscribe', 'end-resets', 'guard-ready', 'already-log', 'request-log', 'request-log-once',
    'ss-call-once', 'ss-field', 'ss-field-once', 'streaming', 'mark', 'ss-name', 'onnav-once', 'arg-pointer', 'arg-frame',
    'status-unavailable', 'status-available',
    'conf-once', 'conf-inline', 'conf-read', 'conf-whole', 'conf-ro',
    'reloc',
];
var off = {};
function on(name) { return !off[name]; }

function fail(reason) { return { ok: false, reason: reason }; }
function hex(buf, off, len) { return buf.toString('hex', off, off + len); }
function rel8(from, to) { var d = to - from; return d >= -128 && d < 128 ? ((d + 256) & 0xff).toString(16).replace(/^(.)$/, '0$1') : null; }
function rel32(buf, p) { return p + 4 + buf.readInt32LE(p); }

/* ---- names --------------------------------------------------------------- */

/* NAMES[k]'s one string: { off } or { err }. A string starts after the last
 * byte before it that is not printable ASCII. */
function namedString(buf, k) {
    var key = Buffer.from(NAMES[k][0], 'latin1'), found = [];
    for (var i = buf.indexOf(key); i >= 0; i = buf.indexOf(key, i + 1)) {
        var s = i;
        while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
        var end = buf.indexOf(0, s);
        if (found.indexOf(s) < 0 && NAMES[k][1].test(buf.toString('latin1', s, end < 0 ? buf.length : end))) found.push(s);
    }
    if (found.length === 1 || (found.length > 1 && !on('name-once'))) return { off: found[0] };
    return { err: NAMES[k][2] + (found.length ? ' string found ' + found.length + ' times' : ' string not found') };
}

/* The function loading NAMES[k]'s string, within ENTRY bytes of its start
 * (its logging prologue: an inlined copy or a split-off part loads it
 * deeper), and only it. { off, end } or { err }. */
function entryFunc(im, refs, str, k) {
    var s = str[k], label = NAMES[k][2];
    if (s.err) return s;
    var sites = refs[s.off] || [];
    if (!sites.length) return { err: label + ' string not referenced' };
    var f = im.func(sites[0]);
    if (!f) return { err: label + ' outside the function table' };
    if (on('name-one-function') && sites.some(function (p) { var g = im.func(p); return !g || g.off !== f.off; })) return { err: label + ' used by several functions' };
    if (on('name-at-entry') && !sites.some(function (p) { return p - f.off < ENTRY; })) return { err: label + ' name not loaded at the function entry' };
    return f;
}

/* The short function starting at `to`, or null. */
function small(im, to) {
    var fn = im.func(to);
    return fn && fn.off === to && fn.end - fn.off <= SMALL ? fn : null;
}

/* The first of `list` when it has one entry, or when `check` is off and it
 * has several; else undefined. */
function one(list, check) { return list.length === 1 || (list.length > 1 && !on(check)) ? list[0] : undefined; }
function count(list, what) { return what + ' ' + (list.length ? 'found ' + list.length + ' times' : 'not found'); }

/* ---- the variant: its converter, initCodingProvider and
 * loadKombiDisplayDefinition ---------------------------------------------- */

/* The class each raw KI_KOMBI_VARIANT the edits rely on maps to: the gate
 * and screen edits act on class 2 (a variant-7 car), next to classes 0 and 1
 * (raw 9 and 10, aapd's own 12.3" and 10.25" clusters). */
var CLASS = { 9: 0, 10: 1, 7: 2 };
function mapsVariant(sw) { return !sw.reason && Object.keys(CLASS).every(function (r) { return sw.kinds[r] === CLASS[r]; }); }

/* Why aapd's raw -> class mapping is not CLASS, or null: the converter is
 * the function loading its own name string (`bool …codingToInternal(const
 * …eKI_KOMBI_VARIANT&, …KombiVariant::Values&)`) and its jump-table switch
 * the one in it. A switch elsewhere decoding to the same mapping is another
 * copy of the converter, which the build could use instead. */
function variantMapping(im, str, refs) {
    var conv = str.conv.err ? str.conv : E.funcOfString(im, refs, str.conv, NAMES.conv[2]);
    if (conv.err) return conv.err;
    var inside = [], outside = 0;
    E.scan(im.buf, im.exec.off, im.exec.end, E.SWITCH).forEach(function (m) {
        var sw = E.switchSlots(im, m, 'variant');
        if (m >= conv.off && m < conv.end) inside.push(sw);
        else if (mapsVariant(sw)) outside++;
    });
    if (outside && on('conv-copy')) return 'variant: converter switch also outside codingToInternal';
    var sw = one(inside, 'conv-switch-once');
    if (!sw) return count(inside, 'variant: converter switch');
    if (!on('conv-mapping')) return null;
    if (sw.reason) return sw.reason;
    var bad = Object.keys(CLASS).filter(function (r) { return sw.kinds[r] !== CLASS[r]; })[0];
    return bad === undefined ? null : 'variant: raw ' + bad + ' maps to class ' + sw.kinds[bad] + ', not ' + CLASS[bad];
}

/* `lea rsi,[reg+disp]` (no SIB) ending at `end`: the displacement, or
 * null. */
function leaRsi(buf, end) {
    function at(p, mod) { return (buf[p] === 0x48 || buf[p] === 0x49) && buf[p + 1] === 0x8d && (buf[p + 2] & 0xf8) === mod && (buf[p + 2] & 7) !== 4; }
    return at(end - 7, 0xb0) ? buf.readUInt32LE(end - 4) : at(end - 4, 0x70) ? buf.readInt8(end - 1) : null;
}

/* initCodingProvider hands the address of its object's variant field to the
 * coding getter K that loadKombiDisplayDefinition reads it with: its one
 * call of K, right after `lea rsi,[reg+disp]`. { field } or { err }. */
function variantField(im, str, refs, k) {
    var f = entryFunc(im, refs, str, 'coding');
    if (f.err) return f;
    var calls = im.calls(f.off, f.end);
    if (on('getter-once') && calls.filter(function (c) { return c.to === k; }).length > 1) return { err: 'gate: initCodingProvider reads the variant twice' };
    var hits = calls.filter(function (c) { return (c.to === k || !on('getter-shared')) && leaRsi(im.buf, c.at) !== null; });
    var hit = one(hits, 'getter-once');
    if (!hit) return { err: 'gate: initCodingProvider ' + (hits.length ? 'reads ' + hits.length + ' fields' : 'reads the variant getter into no field') };
    return { field: leaRsi(im.buf, hit.at) };
}

/* ---- Edit: screen (the variant -> screen-size helper) ------------------- */

/* mov eax,[rdi] ; test eax,eax ; je L0 ; movsd xmm0,[rip+C1] ; cmp eax,1 ; jne Lf */
var SCREEN = [0x8b, 0x07, 0x85, 0xc0, 0x74, null, 0xf2, 0x0f, 0x10, 0x05, null, null, null, null, 0x83, 0xf8, 0x01, 0x75, null];
var SIZE_0 = 12.3, SIZE_1 = 10.25;
/* GNU as's NOPs, by length, for the patched fall-through's padding. */
var NOP = ['', '90', '6690', '0f1f00', '0f1f4000', '0f1f440000'];

/* The bytes [s, e) are NOP instructions: 90, or 0f 1f with a zero memory
 * operand, each with any 66/2e prefixes. */
function nops(buf, s, e) {
    for (var p = s; p < e;) {
        while (p < e && (buf[p] === 0x66 || buf[p] === 0x2e)) p++;
        if (p >= e) return false;
        if (buf[p] === 0x90) { p++; continue; }
        if (buf[p] !== 0x0f || buf[p + 1] !== 0x1f) return false;
        var m = buf[p + 2], mod = m >> 6, rm = m & 7;
        if (mod === 3 || (mod === 0 && rm === 5) || (m & 0x38)) return false;
        var n = 3 + (rm === 4 ? 1 : 0) + (mod === 1 ? 1 : mod === 2 ? 4 : 0);
        for (var i = p + 3; i < p + n; i++) if (buf[i] !== 0) return false;
        p += n;
    }
    return p === e;
}

function doubleAt(im, ripPos, next) {
    var at = im.rel(ripPos, next);
    return at === null || at + 8 > im.buf.length ? null : im.buf.readDoubleLE(at);
}

/* The helper at `to`: class 0 reads SIZE_0 (L0), class 1 SIZE_1, every other
 * class falls through to Lf: `pxor xmm0,xmm0 ; jmp Lret` and NOP padding up
 * to L0 (stock), or `cmp eax,2 ; je L0 ; pxor xmm0,xmm0 ; jmp Lret` and NOPs
 * (patched), 11 to 16 bytes. L0 is `movsd xmm0,[rip+C0] ; jmp Lret`.
 * { off, len, state, stock, patched } or { err }; null when it is not this
 * helper at all. */
function screenHelper(im, to) {
    var fn = small(im, to), buf = im.buf;
    if (!fn) return null;
    var h = E.scan(buf, fn.off, fn.end, SCREEN);
    if (h.length !== 1) return null;
    h = h[0];
    var l0 = h + 6 + buf.readInt8(h + 5), lret = h + 19, lf = lret + buf.readInt8(h + 18), len = l0 - lf;
    if (l0 + 10 > fn.end || lf <= lret || lf + 11 > l0) return { err: 'screen: the class 0 and fall-through blocks are not where the helper branches' };
    if (on('size-1') && doubleAt(im, h + 10, h + 14) !== SIZE_1) return { err: 'screen: class 1 is not ' + SIZE_1 };
    if (on('class0-shape') && (hex(buf, l0, 4) !== 'f20f1005' || buf[l0 + 8] !== 0xeb || l0 + 10 + buf.readInt8(l0 + 9) !== lret))
        return { err: 'screen: class 0 does not load its size and return' };
    if (on('size-0') && doubleAt(im, l0 + 4, l0 + 8) !== SIZE_0) return { err: 'screen: class 0 is not ' + SIZE_0 };
    if (on('room') && len > 16) return { err: 'screen: the fall-through is not the 11 to 16 bytes the edit fills' };
    var patched = '83f80274' + rel8(lf + 5, l0) + '660fefc0eb' + rel8(lf + 11, lret) + (NOP[len - 11] || '');
    var stock = hex(buf, lf, 5) === '660fefc0eb' && lf + 6 + buf.readInt8(lf + 5) === lret && nops(buf, lf + 6, l0);
    var isPatched = hex(buf, lf, 11) === patched.slice(0, 22) && nops(buf, lf + 11, l0);
    if (!stock && !isPatched && on('fall-through')) return { err: 'screen: the fall-through is neither stock nor patched' };
    return { off: lf, len: len, state: isPatched ? 'patched' : 'original', stock: isPatched ? null : hex(buf, lf, len), patched: patched };
}

/* `mov <dst>,R` (REX.W 89 /r, register to register) ending at `end`, R a
 * register a call preserves (rbx, rbp, r12-r15): R's number, or null. dst
 * 7 is rdi, 6 rsi. */
var KEPT = [3, 5, 12, 13, 14, 15];
function movFromKept(buf, end, dst) {
    var p = end - 3, rex = buf[p], m = buf[p + 2];
    if ((rex !== 0x48 && rex !== 0x4c) || buf[p + 1] !== 0x89 || (m & 0xc7) !== (0xc0 | dst)) return null;
    var r = ((m >> 3) & 7) + (rex === 0x4c ? 8 : 0);
    return KEPT.indexOf(r) >= 0 ? r : null;
}

/* loadKombiDisplayDefinition reads the variant through the coding getter K
 * and hands it to the screen-size helper: its one call of a helper, right
 * after its call of K, `mov rsi,R ; call K ; mov rdi,R ; call helper`: the
 * helper reads the value K just wrote. { site, k } or { err }. */
function locateScreen(im, str, refs) {
    var kombi = entryFunc(im, refs, str, 'kombi'), buf = im.buf;
    if (kombi.err) return kombi;
    var calls = im.calls(kombi.off, kombi.end), found = [];
    calls.forEach(function (c, i) {
        var s = screenHelper(im, c.to);
        if (s) found.push({ s: s, k: i > 0 ? calls[i - 1] : null, at: c.at });
    });
    var f = one(found, 'helper-once');
    if (!f) return { err: found.length ? 'screen: size helper called ' + found.length + ' times' : 'screen: size helper not found' };
    if (f.s.err) return f.s;
    if (!f.k) return { err: 'screen: nothing reads the variant before the helper' };
    var r = movFromKept(buf, f.at, 7);
    if (on('helper-arg') && (r === null || f.k.at + 5 !== f.at - 3 || movFromKept(buf, f.k.at, 6) !== r))
        return { err: 'screen: the helper is not handed the value the getter wrote' };
    return { site: f.s, k: f.k.to };
}

/* ---- Edit: gate (secondVideoEnabled) ------------------------------------ */

/* test al,al ; je over the next two ; cmp dword [reg+disp32],1|2 ; setbe al:
 * the cmp's offsets in `fn` comparing `field`. */
function gateIn(buf, fn, field) {
    var out = [];
    for (var p = fn.off; p + 14 <= fn.end; p++) {
        if (buf[p] !== 0x84 || buf[p + 1] !== 0xc0 || buf[p + 2] !== 0x74 || (buf[p + 3] !== 10 && on('gate-flag'))) continue;
        var c = cmpField(buf, p + 4);
        if (c && (c.field === field || !on('gate-field')) && (c.imm === 1 || c.imm === 2) && hex(buf, p + 11, 3) === '0f96c0') out.push(p + 4);
    }
    return out;
}

/* `cmp dword [reg+disp32],imm8` with no SIB at `p`: { field, imm } or null. */
function cmpField(buf, p) {
    return buf[p] === 0x83 && (buf[p + 1] & 0xf8) === 0xb8 && (buf[p + 1] & 7) !== 4 ? { field: buf.readUInt32LE(p + 2), imm: buf[p + 6] } : null;
}

/* prepareCinemoConfiguration keeps the result of one short function as a
 * byte of its object (`call G ; mov byte [reg+disp32],al`): G returns
 * featureFlag && variant <= 1 on the field initCodingProvider fills. No
 * other code compares that field with 1 or 2: a copy the edit would leave
 * stock. */
function locateGate(im, str, refs, field) {
    var prep = entryFunc(im, refs, str, 'prep'), buf = im.buf;
    if (prep.err) return fail(prep.err);
    var gs = [];
    im.calls(prep.off, prep.end).forEach(function (c) {
        var fn = small(im, c.to), g = fn ? gateIn(buf, fn, field) : [];
        if (g.length === 1) gs.push({ call: c.at, at: g[0] });
    });
    var g = one(gs, 'gate-once');
    if (!g) return fail(gs.length ? 'gate: variant check called ' + gs.length + ' times' : 'gate: variant check not found');
    var st = g.call + 5;
    if (on('gate-kept') && (buf[st] !== 0x88 || (buf[st + 1] & 0xf8) !== 0x80 || (buf[st + 1] & 7) === 4)) return fail('gate: its result is not kept');
    var disp = Buffer.alloc(4);
    disp.writeUInt32LE(field >>> 0, 0);
    for (var p = buf.indexOf(disp, im.exec.off + 2); on('gate-unique') && p >= 0 && p + 5 <= im.exec.end; p = buf.indexOf(disp, p + 1)) {
        var c = p - 2 === g.at ? null : cmpField(buf, p - 2);
        if (c && c.field === field && (c.imm === 1 || c.imm === 2)) return fail('gate: variant compared outside secondVideoEnabled');
    }
    var body = hex(buf, g.at, 6);
    return { ok: true, offset: g.at, len: 7, state: buf[g.at + 6] === 1 ? 'original' : 'patched', stock: body + '01', patched: body + '02',
             flag: on('gate-kept') ? buf.readUInt32LE(st + 2) : null };
}

/* `cmp byte [reg+disp32],0` (80 /7) with disp32 `flag` in [from, to). */
function flagTests(buf, from, to, flag) {
    return E.scan(buf, from, to, [0x80, null, flag & 0xff, (flag >>> 8) & 0xff, (flag >>> 16) & 0xff, flag >>> 24, 0])
        .filter(function (q) { return (buf[q + 1] & 0xf8) === 0xb8 && (buf[q + 1] & 7) !== 4; });
}

/* The gate's kept result is the flag that turns the AlternateDisplays code
 * on: initAlternateDisplays tests it before it builds the cluster display,
 * and every branch into onNewNavigationStatus (the navigation-status
 * callback's) is taken only after a test of it. Why not, or null. */
function gateGatesAlt(im, str, refs, flag, onNav) {
    var buf = im.buf, init = entryFunc(im, refs, str, 'initAlt');
    if (init.err) return init.err;
    if (on('gate-gates-alt') && !flagTests(buf, init.off, init.end, flag).length) return 'gate: initAlternateDisplays does not test the gate\'s result';
    if (!on('onnav-gated')) return null;
    var into = [];
    for (var p = im.exec.off; p + 5 <= im.exec.end; p++) {
        if ((buf[p] === 0xe8 || buf[p] === 0xe9) && im.rel(p + 1, p + 5) === onNav) into.push(p);
    }
    if (!into.length) return 'self-start: nothing branches into onNewNavigationStatus';
    var open = into.filter(function (p) { return !flagTests(buf, Math.max(im.exec.off, p - 0x40), p, flag).length; });
    return open.length ? 'self-start: onNewNavigationStatus reached without a test of the gate\'s result' : null;
}

/* ---- Edit: selfstart (onNewNavigationStatus's call, requestStream's guard) */

/* requestStream's opening test at `p`, 16 bytes, R its object register, L1
 * the end of the 16 bytes:
 *   cmp dword [R+A],2 ; je L1 ; cmp dword [R+B],2 ; je Ldo         (stock)
 *   cmp byte [R+F],0  ; je L1 ; cmp dword [R+A],2 ; jne Ldo        (patched)
 *   cmp dword [R+A],2 ; je L1 ; cmp dword [R+B],2 ; jmp Ldo ; nop  (outdated:
 *                                     the patch of releases up to 0.10.10)
 * A is the stream status, B the video focus mode, F the alternate display's
 * ready flag. { form (original | patched | outdated | null: the opening
 * test with another jump), r, a, b (null when patched), f (patched only),
 * g (the jump's offset), ldo } or null. */
function guardAt(buf, p) {
    var r = buf[p + 1], g = p + 10;
    if ((r & 0xf8) !== 0x78 || (r & 7) === 4 || buf[p + 4] !== 0x74 || buf[p + 5] !== 10 || buf[p + 6] !== 0x83 || buf[p + 7] !== r || buf[p + 9] !== 2) return null;
    var out = { p: p, r: r & 7, g: g, form: null, ldo: null };
    if (buf[p] === 0x80 && buf[p + 3] === 0) {
        if (buf[g] !== 0x0f || buf[g + 1] !== 0x85) return null;
        out.form = 'patched'; out.f = buf[p + 2]; out.a = buf[p + 8]; out.b = null; out.ldo = rel32(buf, g + 2);
        return out;
    }
    if (buf[p] !== 0x83 || buf[p + 3] !== 2 || buf[p + 2] === buf[p + 8]) return null;
    out.a = buf[p + 2]; out.b = buf[p + 8];
    if (buf[g] === 0xe9 && buf[g + 5] === 0x90) { out.form = 'outdated'; out.ldo = rel32(buf, g + 1); }
    else if (buf[g] === 0x0f && (buf[g + 1] === 0x84 || !on('guard-form'))) { out.form = 'original'; out.ldo = rel32(buf, g + 2); }
    return out;
}

/* `mov byte [reg+d8],v` (c6 /0) in fn: the d8 of each. */
function byteStores(buf, fn, v) {
    return E.scan(buf, fn.off, fn.end, [0xc6, null, null, v]).filter(function (q) { return (buf[q + 1] & 0xf8) === 0x40 && (buf[q + 1] & 7) !== 4; }).map(function (q) { return buf[q + 2]; });
}
/* `mov dword [reg+d8],v` (c7 /0) in [from, to): the d8 of each. */
function dwordStores(buf, from, to, v) {
    return E.scan(buf, from, to, [0xc7, null, null, v, 0, 0, 0]).filter(function (q) { return (buf[q + 1] & 0xf8) === 0x40 && (buf[q + 1] & 7) !== 4; }).map(function (q) { return buf[q + 2]; });
}
function h8(n) { return (n & 0xff).toString(16).replace(/^(.)$/, '0$1'); }

/* A status argument built on the stack: its vtable stored at [rsp+B]
 * (`mov [rsp+B],rax`) and its value at [rsp+B+X], X where
 * setNaviStreamStatus reads it. The B+X of each vtable store in [from, to). */
function argSlots(buf, from, to, x) { return argStores(buf, from, to, x).map(function (v) { return v.d; }); }
/* The same, with each vtable store's offset: [{ q, d }]. */
function argStores(buf, from, to, x) {
    return E.scan(buf, from, to, [0x48, 0x89, 0x44, 0x24, null]).map(function (q) { return { q: q, d: buf[q + 4] + x }; })
        .concat(E.scan(buf, from, to, [0x48, 0x89, 0x04, 0x24]).map(function (q) { return { q: q, d: x }; }));
}
/* The flow of function `fn` (x86_flow), once per function. */
function flowOf(im, fn) {
    im.flows = im.flows || {};
    if (!(fn.off in im.flows)) im.flows[fn.off] = X86.flow(im.buf, fn.off, fn.end, im.exec.off, im.exec.end);
    return im.flows[fn.off];
}

/* The call at `at` in function `fn` passes rsi = rsp+b on every path to
 * it: whatever sets rsi, or the register it is copied from, no later write,
 * push or call changes it. A function the decoder cannot follow passes
 * nothing known. */
function argPointer(im, fn, at, b) {
    var f = flowOf(im, fn), st = f && f.at(at);
    return !!st && st[6] === b;
}

/* The stores at `offs` and the call at `at` see one rsp: the same depth
 * below the function's entry on every path to each. */
function sameFrame(im, fn, offs, at) {
    var f = flowOf(im, fn), c = f && f.at(at);
    return !!c && c[X86.DEPTH] !== null && offs.every(function (q) { var st = f.at(q); return !!st && st[X86.DEPTH] === c[X86.DEPTH]; });
}

/* `mov dword [rsp+d8],v` in [from, to): the offsets, with d8 when given. */
function statusStores(buf, from, to, v, d) {
    return E.scan(buf, from, to, [0xc7, 0x44, 0x24, d === undefined ? null : d, v, 0, 0, 0]);
}

/* requestStream (called by onStreamCommandChanged) opens with one of
 * guardAt's forms, L1 logging that it is streaming already, Ldo logging the request and
 * calling setNaviStreamStatus(STREAMING), then setting B to 1.
 * setNaviStreamStatus (named so where the build has its name string) copies
 * the status argument's value into A. onNewNavigationStatus calls it
 * (stock) or requestStream (patched) once, in a tail the UNAVAILABLE status
 * falls into and the AVAILABLE one jumps to, both built in the argument the
 * call passes. */
function locateSelfstart(im, str, refs) {
    var buf = im.buf, rs = entryFunc(im, refs, str, 'rs'), onNav = entryFunc(im, refs, str, 'onNav'), cmd = entryFunc(im, refs, str, 'cmd');
    var err = rs.err || onNav.err || cmd.err || str.received.err || str.already.err;
    if (err) return fail(err);
    if (on('near') && Math.max(rs.off, onNav.off, cmd.off) - Math.min(rs.off, onNav.off, cmd.off) > NEAR) return fail('self-start: AlternateDisplays functions far apart');
    if (on('rs-called') && !im.calls(cmd.off, cmd.end).some(function (c) { return c.to === rs.off; })) return fail('self-start: onStreamCommandChanged does not call requestStream');
    var gs = [];
    for (var p = rs.off; p + 16 <= Math.min(rs.end, rs.off + ENTRY); p++) { var x = guardAt(buf, p); if (x) gs.push(x); }
    var gd = one(gs, 'guard-once');
    if (!gd) return fail(count(gs, 'self-start: requestStream guard'));
    var g = gd.g, ldo = gd.ldo, gState = gd.form;
    if (!gState) return fail('self-start: requestStream guard is neither stock nor patched');
    /* R is requestStream's this: copied from rdi before the test. */
    if (on('guard-this') && !E.scan(buf, rs.off, gd.p, [0x48, null, null]).some(function (q) {
        return (buf[q + 1] === 0x89 && buf[q + 2] === (0xf8 | gd.r)) || (buf[q + 1] === 0x8b && buf[q + 2] === (0xc7 | gd.r << 3));
    })) return fail('self-start: requestStream tests another object than its own');
    /* The alternate display's ready flag F: onAlternateVideoReady sets it
     * and subscribes to the car's stream commands, the only way stock
     * requestStream is reached; onEndSession clears it with the stream
     * status and puts the focus mode back to native (2). The patched test
     * reads that flag, so requestStream goes ahead only while the phone's
     * cluster display is set up. */
    var ready = entryFunc(im, refs, str, 'ready'), endS = entryFunc(im, refs, str, 'endSession'), sub = entryFunc(im, refs, str, 'subscribe');
    if (ready.err || endS.err || sub.err) return fail(ready.err || endS.err || sub.err);
    var fs1 = byteStores(buf, ready, 1), F = one(fs1, 'ready-flag');
    if (F === undefined) return fail(count(fs1, 'self-start: onAlternateVideoReady\'s ready flag'));
    if (on('ready-subscribe') && !im.calls(ready.off, ready.end).some(function (c) { return c.to === sub.off; })) return fail('self-start: onAlternateVideoReady does not subscribe to the stream commands');
    function loads(s, from, to) { return refs[s.off].some(function (q) { return q >= from && q < to; }); }
    if (on('already-log') && !loads(str.already, gd.p + 16, ldo)) return fail('self-start: requestStream does not log streaming already');
    var recvs = on('request-log') ? refs[str.received.off].filter(function (q) { return q >= ldo && q < rs.end; }) : [ldo];
    var recv = one(recvs, 'request-log-once');
    if (recv === undefined) return fail(recvs.length ? 'self-start: requestStream logs the request ' + recvs.length + ' times' : 'self-start: requestStream does not log the request');
    var ssCalls = im.calls(recv, rs.end).filter(function (c) { return Math.abs(c.to - onNav.off) <= NEAR; });
    var ssCall = one(ssCalls, 'ss-call-once');
    var ss = ssCall && ssCall.to, ssFn = ss !== undefined && im.func(ss);
    if (!ssFn || ssFn.off !== ss) return fail(ssCalls.length > 1 ? 'self-start: requestStream calls ' + ssCalls.length + ' functions beside it after the request' : 'self-start: requestStream calls no setNaviStreamStatus');
    /* mov r32,[rsi+X] ; ... ; mov [rdi+A],r32 */
    var reads = E.scan(buf, ss, ssFn.end, [0x8b, null, null]).filter(function (q) { return (buf[q + 1] & 0xc7) === 0x46; });
    var pairs = reads.filter(function (q) { return E.scan(buf, q + 3, ssFn.end, [0x89, (buf[q + 1] & 0x38) | 0x47, gd.a]).length; });
    if (on('ss-field') && !pairs.length) return fail('self-start: setNaviStreamStatus does not store its argument in the field requestStream checks');
    if (on('ss-field-once') && pairs.length > 1) return fail('self-start: setNaviStreamStatus stores ' + pairs.length + ' arguments in the field requestStream checks');
    var xq = pairs.length ? pairs[0] : reads[0];
    if (xq === undefined) return fail('self-start: setNaviStreamStatus reads no argument');
    var X = buf[xq + 2];
    var sv = argStores(buf, recv, ssCall.at, X).map(function (v) { return { v: v, s: statusStores(buf, recv, ssCall.at, 2, v.d)[0] }; })
        .filter(function (x) { return x.s !== undefined; })[0];
    var streaming = sv && sv.v.d;
    if (on('streaming') && streaming === undefined) return fail('self-start: requestStream does not pass STREAMING');
    if (on('arg-pointer') && streaming !== undefined && !argPointer(im, rs, ssCall.at, streaming - X))
        return fail('self-start: requestStream does not pass the STREAMING status it builds');
    if (on('arg-frame') && sv && !sameFrame(im, rs, [sv.v.q, sv.s], ssCall.at))
        return fail('self-start: requestStream builds STREAMING in another frame than the call\'s');
    /* After the call requestStream sets the focus mode B to projected (1).
     * The patched form does not name B: there it is the one field set so
     * that onEndSession sets to 2. */
    var marked = E.scan(buf, ssCall.at + 5, Math.min(rs.end, ssCall.at + 0x30), [0xc7, 0x40 | gd.r, null, 0x01, 0x00, 0x00, 0x00]).map(function (q) { return buf[q + 2]; });
    var endTwo = dwordStores(buf, endS.off, endS.end, 2);
    var B = gd.b !== null ? gd.b : one(marked.filter(function (d) { return endTwo.indexOf(d) >= 0; }), 'mark');
    if (on('mark') && (B === undefined || marked.indexOf(B) < 0)) return fail('self-start: requestStream does not mark the request');
    if (on('end-resets') && (byteStores(buf, endS, 0).indexOf(F) < 0 || dwordStores(buf, endS.off, endS.end, 0).indexOf(gd.a) < 0 || endTwo.indexOf(B) < 0))
        return fail('self-start: onEndSession does not reset the ready flag, the stream status and the focus mode requestStream tests');
    if (on('guard-ready') && gState === 'patched' && gd.f !== F) return fail('self-start: requestStream tests another flag than the ready flag');
    if (on('ss-name') && !/not found$/.test(str.ss.err || '')) {
        var named = entryFunc(im, refs, str, 'ss');
        if (named.err || named.off !== ss) return fail(named.err || 'self-start: requestStream calls another function than setNaviStreamStatus');
    }
    var sites = im.calls(onNav.off, onNav.end).filter(function (c) { return c.to === ss || c.to === rs.off; });
    var site = one(sites, 'onnav-once');
    if (!site) return fail(count(sites, 'self-start: onNewNavigationStatus call'));
    /* UNAVAILABLE stored right before the call's tail, in the slot the tail
     * passes; AVAILABLE in that slot, jumping to the tail. */
    var at = site.at, unavail = statusStores(buf, Math.max(onNav.off, at - 32), at, 0).filter(function (q) {
        return argSlots(buf, q + 8, at, X).indexOf(buf[q + 3]) >= 0;
    });
    if (on('status-unavailable') && unavail.length !== 1) return fail('self-start: onNewNavigationStatus builds no UNAVAILABLE status for the call');
    var t = unavail.length ? unavail[0] + 8 : null, d = unavail.length ? buf[unavail[0] + 3] : argSlots(buf, Math.max(onNav.off, at - 24), at, X)[0];
    var avail = statusStores(buf, onNav.off, onNav.end, 1, d).filter(function (q) {
        return t === null || (buf[q + 8] === 0xeb ? q + 10 + buf.readInt8(q + 9) : buf[q + 8] === 0xe9 ? rel32(buf, q + 9) : null) === t;
    });
    if (on('status-available') && avail.length !== 1) return fail('self-start: onNewNavigationStatus builds no AVAILABLE status for the call');
    if (on('arg-pointer') && d !== undefined && !argPointer(im, onNav, at, d - X)) return fail('self-start: onNewNavigationStatus does not pass the status it builds');
    var vt = d === undefined ? [] : argStores(buf, Math.max(onNav.off, at - 24), at, X).filter(function (v) { return v.d === d; }).map(function (v) { return v.q; });
    if (on('arg-frame') && !sameFrame(im, onNav, vt.concat(unavail, avail), at))
        return fail('self-start: onNewNavigationStatus builds its statuses in another frame than the call\'s');
    var next = im.va(at + 5);
    return {
        call: { ok: true, offset: at, len: 5, state: site.to === ss ? 'original' : 'patched',
                stock: 'e8' + E.hex32(im.va(ss) - next), patched: 'e8' + E.hex32(im.va(rs.off) - next),
                onNav: onNav.off, requestStream: rs.off, setNaviStreamStatus: ss },
        guard: { ok: true, offset: gd.p, len: 16, state: gState,
                 stock: '83' + h8(0x78 | gd.r) + h8(gd.a) + '02740a83' + h8(0x78 | gd.r) + h8(B === undefined ? 0 : B) + '020f84' + E.hex32(im.va(ldo) - im.va(gd.p + 16)),
                 patched: '80' + h8(0x78 | gd.r) + h8(F) + '00740a83' + h8(0x78 | gd.r) + h8(gd.a) + '020f85' + E.hex32(im.va(ldo) - im.va(gd.p + 16)),
                 readyFlag: F },
    };
}

/* ---- the config path ----------------------------------------------------- */

/* The one string naming aapd's configuration file, CONF_STOCK (or, in a
 * process the plan was applied to, CONF_RUN), NUL-terminated and starting
 * after a NUL, such that rewriting its bytes in memory, before any code of
 * aapd runs, changes every path aapd opens it by and nothing else:
 *   conf-once    the whole string is in the file once, in one form;
 *   conf-inline  no 8 bytes of it are anywhere else (a copy built from
 *                immediates or a literal pool would keep the stock path);
 *   conf-read    code loads its address with a rip-relative lea;
 *   conf-whole   no rip-relative lea, mov or SSE load or store, absolute
 *                pointer or relocation addend points inside it (another
 *                string merged into its tail would change with it);
 *   conf-ro      it lies in a PT_LOAD without write permission, outside
 *                PT_GNU_RELRO, so nothing writes it after the load;
 * and no dynamic relocation covers it (reloc). */
/* Whether the opcode ending at `o`, before a rip-relative modrm, is one
 * that reads or takes the address of memory without an immediate: lea or
 * mov with a REX prefix, or an SSE load or store (0f 10/11/28/29/6f/7f). */
function ripLoad(buf, o) {
    if ((buf[o] === 0x8d || buf[o] === 0x8b) && buf[o - 1] >= 0x40 && buf[o - 1] <= 0x4f) return true;
    return buf[o - 1] === 0x0f && [0x10, 0x11, 0x28, 0x29, 0x6f, 0x7f].indexOf(buf[o]) >= 0;
}

function confPathSite(im, addends) {
    var buf = im.buf, len = CONF_STOCK.length + 1, forms = [CONF_STOCK, CONF_RUN].map(function (s) { return Buffer.from(s + '\0', 'latin1'); });
    var found = [];
    forms.forEach(function (k, i) {
        for (var p = buf.indexOf(k); p >= 0; p = buf.indexOf(k, p + 1)) found.push({ off: p, state: i ? 'patched' : 'original', k: k });
    });
    var s = one(found, 'conf-once');
    if (!s) return fail(count(found, 'config path: the path string'));
    if (on('conf-once') && !(s.off > 0 && buf[s.off - 1] === 0)) return fail('config path: the path is the tail of another string');
    for (var w = 0; on('conf-inline') && w + 8 <= len; w++) {
        var win = s.k.slice(w, w + 8);
        for (var q = buf.indexOf(win); q >= 0; q = buf.indexOf(win, q + 1))
            if (q !== s.off + w) return fail('config path: its bytes are also at 0x' + q.toString(16));
    }
    var va = im.va(s.off), end = va + len, seg = null;
    im.load.forEach(function (g) { if (s.off >= g.off && s.off + len <= g.off + g.size) seg = g; });
    if (on('conf-ro') && (!seg || (seg.flags & 2) || (im.relro && va < im.relro.va + im.relro.size && im.relro.va < end)))
        return fail('config path: the path is not in read-only data');
    var refs = E.leaRefs(im, [s.off])[s.off] || [];
    if (on('conf-read') && !refs.length) return fail('config path: the path is not referenced');
    if (on('conf-whole')) {
        var inner = null, ex = im.exec;
        for (var p = ex.off + 3; !inner && p + 4 <= ex.end; p++) {
            if ((buf[p - 1] & 0xc7) !== 0x05 || !ripLoad(buf, p - 2)) continue;
            var nv = im.va(p + 4), t = nv === null ? null : (nv + buf.readInt32LE(p)) >>> 0;
            if (t !== null && t > va && t < end) inner = p - 1;
        }
        for (var a = 0; !inner && a < addends.length; a++) if (addends[a] > va && addends[a] < end) inner = 'a relocation';
        /* pointers: in the writable segments' data (a PIE's are relocation
         * addends, above) */
        im.load.forEach(function (g) {
            if (!(g.flags & 2)) return;
            for (var o = g.off + ((8 - g.off % 8) % 8); !inner && o + 8 <= g.off + g.size; o += 8) {
                var lo = buf.readUInt32LE(o);
                if (lo > va && lo < end && buf.readUInt32LE(o + 4) === 0) inner = o;
            }
        });
        if (inner !== null) return fail('config path: something points inside the path (' + (typeof inner === 'number' ? 'at 0x' + inner.toString(16) : inner) + ')');
    }
    return { ok: true, offset: s.off, len: len, state: s.state, stock: forms[0].toString('hex'), patched: forms[1].toString('hex'), path: CONF_RUN, refs: refs.length };
}

/* ---- the build ---------------------------------------------------------- */

/* All five sites: { elf, reason, buildId, version, gate, call, guard,
 * screen, confpath, ok }, each { ok, reason } or { ok, offset, len, state
 * (original | patched), stock (hex, null when it cannot be told from the
 * patched form), patched (hex) }. ok is true when every site was found.
 * opts.off: the CHECKS not to make. */
function locate(buf, opts) {
    off = {};
    ((opts && opts.off) || []).forEach(function (c) { if (CHECKS.indexOf(c) < 0) throw new Error('no check ' + c); off[c] = true; });
    var elf = E.parseElf(buf), out = { elf: !!elf.load, buildId: null, version: null };
    if (!elf.load) {
        SITES.forEach(function (e) { out[e] = fail('not located'); });
        out.ok = false;
        out.reason = elf.reason;
        return out;
    }
    var im = new E.Image(buf, elf), str = {}, offs = [];
    out.buildId = E.noteBuildId(buf, elf.notes);
    out.version = E.version(buf, 'aapd');
    Object.keys(NAMES).forEach(function (k) {
        str[k] = namedString(buf, k);
        if (!str[k].err) offs.push(str[k].off);
    });
    var refs = E.leaRefs(im, offs);
    if (!im.starts.length) {
        EDITS.forEach(function (e) { out[e] = fail(LABEL[e] + ': no function table'); });
    } else {
        var vm = variantMapping(im, str, refs), sc = vm ? { err: vm } : locateScreen(im, str, refs);
        out.screen = sc.err ? fail(sc.err) : { ok: true, offset: sc.site.off, len: sc.site.len, state: sc.site.state, stock: sc.site.stock, patched: sc.site.patched };
        var vf = sc.err ? { err: vm || 'gate: the variant getter is not confirmed (' + sc.err + ')' } : variantField(im, str, refs, sc.k);
        out.gate = vf.err ? fail(vf.err) : locateGate(im, str, refs, vf.field);
        var ssr = locateSelfstart(im, str, refs);
        out.call = ssr.ok === false ? ssr : ssr.call;
        out.guard = ssr.ok === false ? ssr : ssr.guard;
        var gg = out.gate.ok && out.call.ok && out.gate.flag !== null ? gateGatesAlt(im, str, refs, out.gate.flag, out.call.onNav) : null;
        if (gg) out.gate = out.call = out.guard = fail(gg);
    }
    var all = E.relocated(im, []);
    out.confpath = confPathSite(im, all.addends);
    var hit = on('reloc') ? E.relocated(im, SITES.filter(function (e) { return out[e].ok; }).map(function (e) { return [e, out[e].offset, out[e].len]; }))
        : { all: null, edits: [] };
    SITES.forEach(function (e) {
        if (out[e].ok && (hit.all || hit.edits.indexOf(e) >= 0)) out[e] = fail(LABEL[e] + ': ' + (hit.all || 'a dynamic relocation over the edit'));
    });
    var failed = SITES.filter(function (e) { return !out[e].ok; }).map(function (e) { return out[e].reason; });
    out.ok = failed.length === 0;
    if (failed.length) out.reason = failed.filter(function (r, i) { return failed.indexOf(r) === i; }).join('; ');
    return out;
}

module.exports = { locate: locate, EDITS: EDITS, SITES: SITES, CHECKS: CHECKS, CONF_STOCK: CONF_STOCK, CONF_RUN: CONF_RUN };
