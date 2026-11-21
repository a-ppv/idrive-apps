// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* carplay_locate.js — finds the six carplay-patch edit sites (PATCH.md) in a
 * carplay build by code and data structure. Each site has to be found exactly
 * once and pass its semantic checks; otherwise that edit carries ok:false and
 * a short reason naming what was not found. File offsets and virtual
 * addresses are converted through the ELF program headers, and function
 * bounds come from the .eh_frame_hdr search table. The variant, self-start and
 * resolution sites are found from the functions that load their own name
 * strings, the map URL sites from the cluster display's builder and the log
 * path the variant edit disables, the ShowUI URL sites from requestStream's
 * ShowUI call and its result check, and a site a dynamic relocation would
 * rewrite at load is refused.
 * It only reads the buffer.
 *
 * Node 8 on the unit, no dependencies.
 */
'use strict';

var X86 = require('./x86_flow.js');

var SINK_STOCK = 'avb://media_transport.avb_streaming.15?mime_type=video/H264';
var SINK_NEXT = 'mCarPlay->GetDisplaySource(';
var REDIRECT = /^(file|udp|tcp):\/\/[^\0]+$/;
var IC_HIGH = 0, IC_MID = 1, OTHER = 2, NOT_ACTIVE = 3, SLOT = 7;
/* A function's own name string is loaded by its logging prologue, within
 * ENTRY bytes of its start; functions of one source file lie within NEAR. */
var ENTRY = 0x60, NEAR = 0x10000;

/* A 64-bit field of a file under 4 GiB, else null. */
function u64(buf, off) { return buf.readUInt32LE(off + 4) === 0 ? buf.readUInt32LE(off) >>> 0 : null; }

function parseElf(buf) {
    if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return { reason: 'not an ELF file' };
    if (buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) return { reason: 'not a 64-bit little-endian x86-64 ELF' };
    var phoff = u64(buf, 0x20), phentsize = buf.readUInt16LE(0x36), phnum = buf.readUInt16LE(0x38);
    if (phoff === null || phoff + phnum * phentsize > buf.length) return { reason: 'ELF program headers out of range' };
    var elf = { load: [], exec: null, eh: null, notes: [], dyn: null, dynBad: false, relro: null };
    for (var i = 0; i < phnum; i++) {
        var o = phoff + i * phentsize, type = buf.readUInt32LE(o);
        /* flags: PF_X 1, PF_W 2, PF_R 4 */
        var seg = { off: u64(buf, o + 8), va: u64(buf, o + 16), size: u64(buf, o + 32), flags: buf.readUInt32LE(o + 4) };
        if (seg.off === null || seg.va === null || seg.size === null || seg.off + seg.size > buf.length) {
            if (type === 2) elf.dynBad = true;          /* a PT_DYNAMIC outside the file */
            continue;
        }
        if (type === 1) {                               /* PT_LOAD; PF_X marks the code */
            elf.load.push(seg);
            if ((seg.flags & 1) && !elf.exec) elf.exec = { off: seg.off, end: seg.off + seg.size };
        } else if (type === 0x6474e550) elf.eh = seg;   /* PT_GNU_EH_FRAME */
        else if (type === 4) elf.notes.push(seg);       /* PT_NOTE */
        else if (type === 2) elf.dyn = seg;             /* PT_DYNAMIC */
        else if (type === 0x6474e552) elf.relro = { va: seg.va, size: u64(buf, o + 40) };   /* PT_GNU_RELRO, its memory size */
    }
    if (!elf.exec) return { reason: 'no executable ELF segment' };
    return elf;
}

/* The GNU build-id of an ELF image as hex, or null: what tells one build
 * from another without locating anything. */
function elfBuildId(buf) {
    var elf = parseElf(buf);
    return elf.load ? buildId(buf, elf.notes) : null;
}

/* The GNU build-id note as hex, or null. */
function buildId(buf, notes) {
    for (var n = 0; n < notes.length; n++) {
        for (var o = notes[n].off, end = o + notes[n].size; o + 12 <= end;) {
            var namesz = buf.readUInt32LE(o), descsz = buf.readUInt32LE(o + 4);
            var desc = o + 12 + ((namesz + 3) & ~3);
            if (desc + descsz > end) break;
            if (buf.readUInt32LE(o + 8) === 3 && namesz === 4 && buf.toString('latin1', o + 12, o + 16) === 'GNU\0')
                return buf.toString('hex', desc, desc + descsz);
            o = desc + ((descsz + 3) & ~3);
        }
    }
    return null;
}

/* The image: offset/address conversion, function bounds and code scans. */
function Image(buf, elf) {
    this.buf = buf;
    this.load = elf.load;
    this.exec = elf.exec;
    this.starts = funcStarts(buf, elf.eh);
    this.dyn = elf.dyn;
    this.dynBad = elf.dynBad;
    this.relro = elf.relro;
    this.callIndex = null;
}
Image.prototype.va = function (off) {
    for (var i = 0; i < this.load.length; i++) {
        var s = this.load[i];
        if (off >= s.off && off < s.off + s.size) return s.va + (off - s.off);
    }
    return null;
};
Image.prototype.off = function (va) {
    for (var i = 0; i < this.load.length; i++) {
        var s = this.load[i];
        if (va >= s.va && va < s.va + s.size) return s.off + (va - s.va);
    }
    return null;
};
/* The function holding `off`, as file offsets { off, end }, or null. */
Image.prototype.func = function (off) {
    var va = this.va(off), s = this.starts, lo = 0, hi = s.length - 1, at = -1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (s[mid] <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0) return null;
    var start = this.off(s[at]);
    var end = at + 1 < s.length ? this.off(s[at + 1]) : this.exec.end;
    return start === null || end === null || end > this.exec.end ? null : { off: start, end: end };
};
/* The target (file offset) of a rel32 branch whose 4-byte displacement is
 * at `pos` and whose next instruction starts at `next`. */
Image.prototype.rel = function (pos, next) {
    var va = this.va(next);
    return va === null ? null : this.off((va + this.buf.readInt32LE(pos)) >>> 0);
};
/* The `call rel32` instructions in [start, end): [{ at, to }]. */
Image.prototype.calls = function (start, end) {
    var out = [];
    for (var p = start; p + 5 <= end; p++) {
        if (this.buf[p] === 0xe8) { var to = this.rel(p + 1, p + 5); if (to !== null) out.push({ at: p, to: to }); }
    }
    return out;
};

/* The offsets of the `call rel32` instructions anywhere in the code
 * segment that reach `to`. */
Image.prototype.callers = function (to) {
    if (!this.callIndex) {
        var idx = {}, all = this.calls(this.exec.off, this.exec.end);
        all.forEach(function (c) { (idx[c.to] = idx[c.to] || []).push(c.at); });
        this.callIndex = idx;
    }
    return this.callIndex[to] || [];
};

/* The rel32 jmp (e9), jcc (0f 8x) and, with `calls`, call (e8) encodings
 * anywhere in the code segment landing in [lo, hi]: [{ at, to }], every
 * byte read as a possible start. */
Image.prototype.branchesInto = function (lo, hi, calls) {
    var buf = this.buf, end = this.exec.end, out = [];
    for (var p = this.exec.off; p + 5 <= end; p++) {
        var c = buf[p], t;
        if (c === 0xe9 || (calls && c === 0xe8)) t = p + 5 + buf.readInt32LE(p + 1);
        else if (c === 0x0f && buf[p + 1] >= 0x80 && buf[p + 1] <= 0x8f && p + 6 <= end) t = p + 6 + buf.readInt32LE(p + 2);
        else continue;
        if (t >= lo && t <= hi) out.push({ at: p, to: t });
    }
    return out;
};

/* Function start addresses from .eh_frame_hdr's search table (version 1,
 * eh_frame_ptr pcrel sdata4, fde_count udata4, table datarel sdata4: the GCC
 * encoding), sorted; empty when the build has no such table. */
function funcStarts(buf, eh) {
    if (!eh || eh.size < 12 || buf.readUInt32BE(eh.off) !== 0x011b033b) return [];
    var count = buf.readUInt32LE(eh.off + 8), table = eh.off + 12;
    if (table + count * 8 > eh.off + eh.size) return [];
    var starts = [];
    for (var i = 0; i < count; i++) starts.push((eh.va + buf.readInt32LE(table + i * 8)) >>> 0);
    return starts.sort(function (a, b) { return a - b; });
}

/* Offsets matching `pat` (bytes, null = any) in [start, end). */
function scan(buf, start, end, pat) {
    var out = [];
    for (var i = start; i + pat.length <= end; i++) {
        if (buf[i] !== pat[0]) continue;
        for (var j = 1; j < pat.length && (pat[j] === null || buf[i + j] === pat[j]); j++);
        if (j === pat.length) out.push(i);
    }
    return out;
}
function any(n) { var a = []; while (n--) a.push(null); return a; }

/* The NUL-terminated string at `off`. */
function stringAt(buf, off) { var end = buf.indexOf(0, off); return buf.toString('latin1', off, end < 0 ? buf.length : end); }

/* The one string that contains `key` and matches `re`: { off } or { err }. A
 * string starts after the last byte before it that is not printable ASCII. */
function namedString(buf, key, re, label) {
    var found = [], k = Buffer.from(key, 'latin1');
    for (var i = buf.indexOf(k); i >= 0; i = buf.indexOf(k, i + 1)) {
        var s = i;
        while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
        if (found.indexOf(s) < 0 && re.test(stringAt(buf, s))) found.push(s);
    }
    if (found.length === 1) return { off: found[0] };
    return { err: label + (found.length ? ' string found ' + found.length + ' times' : ' string not found') };
}

/* The rip-relative lea instructions (REX.W 8d, mod 00 rm 101) whose target is
 * one of `offs`: { off: [lea offsets] }. */
function leaRefs(im, offs) {
    var want = {}, out = {}, buf = im.buf;
    offs.forEach(function (o) { var va = im.va(o); if (va !== null) { want[va] = o; out[o] = []; } });
    for (var p = im.exec.off + 1; p + 6 <= im.exec.end; p++) {
        if (buf[p] !== 0x8d || (buf[p - 1] & 0xfb) !== 0x48 || (buf[p + 1] & 0xc7) !== 0x05) continue;
        var va = im.va(p + 6);
        var t = va === null ? null : want[(va + buf.readInt32LE(p + 2)) >>> 0];
        if (t !== undefined && t !== null) out[t].push(p - 1);
    }
    return out;
}

/* The one function referencing a string: { off, end } or { err }. */
function funcOfString(im, refs, str, label) {
    if (str.err) return str;
    var sites = refs[str.off] || [];
    if (!sites.length) return { err: label + ' string not referenced' };
    var f = im.func(sites[0]);
    for (var i = 1; f && i < sites.length; i++) {
        var g = im.func(sites[i]);
        if (!g || g.off !== f.off) return { err: label + ' used by several functions' };
    }
    return f || { err: label + ' outside the function table' };
}

function hex32(n) { return Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]).toString('hex'); }

/* ---- Edit 1: the KI_KOMBI_VARIANT converter switch ---------------------- */

/* cmp byte [rdi],imm8 ; ja ; movzx eax,byte [rdi] ; lea rdx,[rip+table] ;
 * movsxd rax,[rdx+rax*4] ; add rax,rdx ; jmp rax. Several switches share the
 * shape; the converter is the one whose table decodes to the variant mapping. */
var SWITCH = [0x80, 0x3f, null, 0x77, null, 0x0f, 0xb6, 0x07, 0x48, 0x8d, 0x15, null, null, null, null,
    0x48, 0x63, 0x04, 0x82, 0x48, 0x01, 0xd0, 0xff, 0xe0];

/* The converter is the function loading its own name string
 * (`bool …codingToInternal(const …eKI_KOMBI_VARIANT&, …KombiVariant::Values&)`),
 * and its switch is the one in it. A switch elsewhere that decodes to the
 * same mapping is another copy of the converter, which the edit would leave
 * unpatched: refused. */
function locateVariant(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'variant: no function table' };
    var conv = funcOfString(im, refs, str.conv, NAMES.conv[2]);
    if (conv.err) return { ok: false, reason: conv.err };
    var inside = [], outside = 0;
    scan(im.buf, im.exec.off, im.exec.end, SWITCH).forEach(function (m) {
        var d = decodeSwitch(im, m);
        if (m >= conv.off && m < conv.end) inside.push(d);
        else if (d.ok) outside++;
    });
    if (outside) return { ok: false, reason: 'variant: converter switch also outside codingToInternal' };
    var good = inside.filter(function (t) { return t.ok; });
    if (good.length === 1) return good[0];
    if (good.length > 1) return { ok: false, reason: 'variant: converter switch found ' + good.length + ' times' };
    /* None decodes: a table large enough for the variant values is the
     * converter's, and its reason says what is wrong with it. */
    var sized = inside.filter(function (t) { return !t.small; });
    return sized.length === 1 ? sized[0] : { ok: false, reason: 'variant: converter switch not found' };
}

/* The SWITCH at `m`, read: { table, n, vals (the table's entries), kinds
 * (the value each slot's handler stores) } or { reason, small } with the
 * reason prefixed by `label`. */
function switchSlots(im, m, label) {
    var buf = im.buf, n = buf[m + 2] + 1;
    if (n < 11) return { small: true, reason: label + ': converter table too small (' + n + ')' };
    var tableVa = im.va(m + 15);
    var table = tableVa === null ? null : im.off((tableVa + buf.readInt32LE(m + 11)) >>> 0);
    if (table === null || table + n * 4 > buf.length) return { reason: label + ': converter table out of range' };
    var vals = [], kinds = [];
    for (var i = 0; i < n; i++) {
        vals.push(buf.readUInt32LE(table + i * 4));
        var h = im.off((im.va(table) + buf.readInt32LE(table + i * 4)) >>> 0);
        /* each handler stores the internal value: mov dword [rsi],imm32 */
        if (h === null || h + 6 > buf.length || buf[h] !== 0xc7 || buf[h + 1] !== 0x06)
            return { reason: label + ': slot ' + i + ' handler not a store' };
        kinds.push(buf.readUInt32LE(h + 2));
    }
    return { table: table, n: n, vals: vals, kinds: kinds };
}

/* The switch at `m`: raw 9 -> IC_HIGH, 10 -> IC_MID, 0 -> NOT_ACTIVE, every
 * other raw value -> OTHER through one shared table value, and slot 7 that
 * OTHER value (stock) or slot 9's or 10's (patched). */
function decodeSwitch(im, m) {
    var sw = switchSlots(im, m, 'variant');
    if (sw.reason) return { ok: false, small: sw.small, reason: sw.reason };
    var n = sw.n, table = sw.table, vals = sw.vals, kinds = sw.kinds;
    if (kinds[9] !== IC_HIGH) return { ok: false, reason: 'variant: slot 9 is not IC_HIGH' };
    if (kinds[10] !== IC_MID) return { ok: false, reason: 'variant: slot 10 is not IC_MID' };
    if (kinds[0] !== NOT_ACTIVE) return { ok: false, reason: 'variant: slot 0 is not NOT_ACTIVE' };
    var other = null;
    for (var k = 1; k < n; k++) {
        if (k === 9 || k === 10 || k === SLOT) continue;
        if (kinds[k] !== OTHER) return { ok: false, reason: 'variant: slot ' + k + ' is not OTHER' };
        if (other !== null && vals[k] !== other) return { ok: false, reason: 'variant: OTHER slots differ' };
        other = vals[k];
    }
    if ([other, vals[9], vals[10]].indexOf(vals[SLOT]) < 0) return { ok: false, reason: 'variant: slot 7 not OTHER/IC_HIGH/IC_MID' };
    return { ok: true, table: table, slots: n, slot: table + SLOT * 4, original: other, high: vals[9], mid: vals[10] };
}

/* ---- Edit 2: the second-stream sink URL --------------------------------- */

/* The URL is its own string, followed after a NUL run by the string
 * `mCarPlay->GetDisplaySource( …`: the stock URL, or a redirect NUL-padded to
 * the stock URL's length. The slot ends at least one NUL and at most 16
 * alignment NULs before that string. */
function locateSink(buf) {
    var found = [], next = Buffer.from(SINK_NEXT, 'latin1'), len = SINK_STOCK.length;
    for (var i = buf.indexOf(next); i >= 0; i = buf.indexOf(next, i + 1)) {
        var e = i, s;
        while (e > 0 && buf[e - 1] === 0) e--;
        for (s = e; s > 0 && buf[s - 1] !== 0; s--);
        var url = buf.toString('latin1', s, e);
        if (s > 0 && i - s > len && i - s <= len + 16 && (url === SINK_STOCK || (REDIRECT.test(url) && url.length <= len))) found.push(s);
    }
    if (found.length === 0) return { ok: false, reason: 'sink: URL slot not found' };
    if (found.length > 1) return { ok: false, reason: 'sink: URL slot found ' + found.length + ' times' };
    return { ok: true, offset: found[0], len: len };
}

/* The slot is the string one `lea` loads; nothing loads a string inside it (a
 * merged string a rewrite would change). `refs` holds the slot's offsets. */
function sinkRefs(s, refs) {
    if (!s.ok) return s;
    function loads(o) { return (refs[o] || []).length; }
    if (loads(s.offset) !== 1) return { ok: false, reason: 'sink: URL slot loaded ' + loads(s.offset) + ' times (want 1)' };
    for (var i = 1; i < s.len; i++) if (loads(s.offset + i)) return { ok: false, reason: 'sink: another string inside the URL slot' };
    return s;
}

/* ---- Edit 3: the self-start call retarget ------------------------------- */

var NAMES = {
    conv: ['codingToInternal(const CodingKOMBI_HUD::eKI_KOMBI_VARIANT&',
        /^bool (?:\w+::)*codingToInternal\(const (?:\w+::)*eKI_KOMBI_VARIANT&, (?:\w+::)*KombiVariant::Values&\)$/, 'variant: codingToInternal'],
    ss: ['AlternateDisplays::setStreamStatus(', /^void (?:\w+::)*AlternateDisplays::setStreamStatus\(/, 'self-start: setStreamStatus'],
    osu: ['AlternateDisplays::onSuggestUi()', /^void (?:\w+::)*AlternateDisplays::onSuggestUi\(\)$/, 'self-start: onSuggestUi'],
    rs: ['AlternateDisplays::requestStream()', /^void (?:\w+::)*AlternateDisplays::requestStream\(\)$/, 'self-start: requestStream'],
    showUi: ['mCinemoCarPlay->ShowUI(', /^mCinemoCarPlay->ShowUI\(/, 'self-start: ShowUI'],
    keyframe: ['mCinemoCarPlay->ForceKeyframe(', /^mCinemoCarPlay->ForceKeyframe\(/, 'self-start: ForceKeyframe'],
    ctor: ['ICSafeAreaProvider::ICSafeAreaProvider(', /^(?:\w+::)*ICSafeAreaProvider::ICSafeAreaProvider\(const (?:\w+::)*KombiVariant::Values&\)$/, 'resolution: ICSafeAreaProvider'],
    setShowUi: ['AlternateDisplays::setShowUiUrl(', /^void (?:\w+::)*AlternateDisplays::setShowUiUrl\(\)$/, 'ShowUI URL: setShowUiUrl'],
};

/* The function loading `str` at its entry (its logging prologue): an inlined
 * copy or a split-off part loads it deeper. */
function entryFunc(im, refs, str, label) {
    var f = funcOfString(im, refs, str, label);
    if (f.err) return f;
    return refs[str.off].some(function (p) { return p - f.off < ENTRY; }) ? f : { err: label + ' name not loaded at the function entry' };
}

/* setStreamStatus, requestStream and onSuggestUi by their own function-name
 * strings, each loaded at its function's entry, the three within NEAR of each
 * other. requestStream must reference the ShowUI and ForceKeyframe checks,
 * call setStreamStatus, and be called directly from outside onSuggestUi (a
 * function in its own right, not a callback that inlined it). The site is
 * onSuggestUi's one call to either, with AVAILABLE (1) stored as its argument
 * just before it. */
function locateSelfstart(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'self-start: no function table' };
    var ss = entryFunc(im, refs, str.ss, NAMES.ss[2]);
    var rs = entryFunc(im, refs, str.rs, NAMES.rs[2]);
    var osu = entryFunc(im, refs, str.osu, NAMES.osu[2]);
    var err = ss.err || rs.err || osu.err || str.showUi.err || str.keyframe.err;
    if (err) return { ok: false, reason: err };
    if (Math.max(ss.off, rs.off, osu.off) - Math.min(ss.off, rs.off, osu.off) > NEAR)
        return { ok: false, reason: 'self-start: AlternateDisplays functions far apart' };
    if (!im.callers(rs.off).some(function (p) { return p < osu.off || p >= osu.end; }))
        return { ok: false, reason: 'self-start: requestStream not called directly' };
    function inRs(o) { return refs[o].some(function (p) { return p >= rs.off && p < rs.end; }); }
    if (!inRs(str.showUi.off) || !inRs(str.keyframe.off)) return { ok: false, reason: 'self-start: requestStream lacks ShowUI/keyframe' };
    if (!im.calls(rs.off, rs.end).some(function (c) { return c.to === ss.off; }))
        return { ok: false, reason: 'self-start: requestStream lacks setStreamStatus' };
    var sites = im.calls(osu.off, osu.end).filter(function (c) { return c.to === ss.off || c.to === rs.off; });
    if (sites.length !== 1) return { ok: false, reason: 'self-start: onSuggestUi call ' + (sites.length ? 'found ' + sites.length + ' times' : 'not found') };
    var at = sites[0].at;
    /* mov dword [rsp+disp8],1 */
    if (!scan(im.buf, Math.max(osu.off, at - 24), at, [0xc7, 0x44, 0x24, null, 0x01, 0x00, 0x00, 0x00]).length)
        return { ok: false, reason: 'self-start: call has no AVAILABLE argument' };
    var next = im.va(at + 5);
    return {
        ok: true, offset: at, setStreamStatus: ss.off, requestStream: rs.off, onSuggestUi: osu.off,
        original: 'e8' + hex32(im.va(ss.off) - next), patched: 'e8' + hex32(im.va(rs.off) - next)
    };
}

/* ---- Edit 4: the IC_HIGH geometry builder ------------------------------- */

/* mov [rdi+0x10],rdx (the mm pair, loaded earlier by movabs rdx) ;
 * movabs rax,px ; mov [rdi+8],rax ; mov [rdi+0x18],rax ;
 * movabs rax,safe1 ; mov [rdi+0x20],rax ; movabs rax,safe2 ; mov [rdi+0x28],rax */
var STORES = [0x48, 0x89, 0x57, 0x10, 0x48, 0xb8].concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x08, 0x48, 0x89, 0x47, 0x18, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x20, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x28]);

/* A geometry builder at `f`: a short function opening with `movabs rdx` (the
 * mm pair) and holding the stores once; its four immediates' offsets, or
 * null. */
function builder(im, f) {
    var fn = im.func(f), buf = im.buf;
    if (!fn || fn.off !== f || fn.end - fn.off > 0x80 || buf[f] !== 0x48 || buf[f + 1] !== 0xba) return null;
    var st = scan(buf, f, fn.end, STORES);
    return st.length === 1 && st[0] > f + 10 ? { builder: f, mm: f + 2, px: st[0] + 6, safe1: st[0] + 24, safe2: st[0] + 38 } : null;
}

/* The getters the builders' fields are read through: the small functions a
 * caller of the constructor calls after it, each reading one field of
 * `this` (mov rax,[rdi+d8] / mov eax,[rdi+d8] / movzx eax,word [rdi+d8]).
 * The edit writes pixel size (+0x18), view x,y (+0x20, +0x22), safe width
 * and height (+0x24) and safe x,y (+0x2c, +0x2e): the getters some caller
 * calls must read each of those, other fields besides, so the immediates
 * mean what the edit writes. */
var FIELDS = ['q18', 'w20', 'w22', 'q24', 'w2c', 'w2e'];
function fieldRead(im, f) {
    var fn = im.func(f), buf = im.buf, found = [];
    if (!fn || fn.off !== f || fn.end - fn.off > 0x40) return null;
    for (var p = f; p + 4 <= fn.end; p++) {
        if (buf[p] === 0x48 && buf[p + 1] === 0x8b && buf[p + 2] === 0x47) found.push('q' + buf[p + 3].toString(16));
        else if (buf[p] === 0x0f && buf[p + 1] === 0xb7 && buf[p + 2] === 0x47) found.push('w' + buf[p + 3].toString(16));
        else if (buf[p] === 0x8b && buf[p + 1] === 0x47 && buf[p - 1] !== 0x48) found.push('d' + buf[p + 2].toString(16));
    }
    return found.length === 1 ? found[0] : null;
}
/* The functions that call the constructor and then read the fields: { off,
 * end } each, once. */
function layoutReaders(im, ctor) {
    var out = [];
    im.callers(ctor.off).forEach(function (at) {
        var fn = im.func(at);
        if (!fn || out.some(function (f) { return f.off === fn.off; })) return;
        var got = im.calls(at + 5, Math.min(fn.end, at + 0x100)).map(function (c) { return fieldRead(im, c.to); })
            .filter(function (r) { return r; });
        if (FIELDS.every(function (f) { return got.indexOf(f) >= 0; })) out.push(fn);
    });
    return out;
}

/* The variant check called at `c`: 'high' for `[rdi] == IC_HIGH`, 'mid' for
 * `[rdi] == IC_MID`, small functions doing mov eax,[rdi] ; test eax,eax ;
 * sete al (or cmp dword [rdi],0 ; sete al) and cmp dword [rdi],1 ; sete al. */
function checkKind(im, to) {
    var fn = im.func(to), buf = im.buf;
    if (!fn || fn.off !== to || fn.end - fn.off > 128) return null;
    if (scan(buf, fn.off, fn.end, [0x8b, 0x07, 0x85, 0xc0, 0x0f, 0x94, 0xc0]).length ||
        scan(buf, fn.off, fn.end, [0x83, 0x3f, 0x00, 0x0f, 0x94, 0xc0]).length) return 'high';
    if (scan(buf, fn.off, fn.end, [0x83, 0x3f, 0x01, 0x0f, 0x94, 0xc0]).length) return 'mid';
    return null;
}

/* The start of the code run when the bool returned by the call at `at` is
 * true: test al,al within 8 bytes, then je (true falls through) or jne (true
 * jumps). */
function trueBranch(im, at, end) {
    var buf = im.buf, t = at + 5, j;
    while (t < Math.min(at + 13, end) && !(buf[t] === 0x84 && buf[t + 1] === 0xc0)) t++;
    if (buf[t] !== 0x84 || buf[t + 1] !== 0xc0) return null;
    j = t + 2;
    if (buf[j] === 0x74) return j + 2;
    if (buf[j] === 0x75) return j + 2 + buf.readInt8(j + 1);
    if (buf[j] === 0x0f && buf[j + 1] === 0x84) return j + 6;
    if (buf[j] === 0x0f && buf[j + 1] === 0x85) return im.rel(j + 2, j + 6);
    return null;
}

/* The ICSafeAreaProvider constructor `(const KombiVariant::Values&)` calls
 * two geometry builders within NEAR of it: the IC_HIGH one on the true branch
 * of its one call to the `variant == IC_HIGH` check, the IC_MID one on the
 * true branch of its one call to the `variant == IC_MID` check. A caller of
 * the constructor reads the fields the edit writes through their getters. */
function locateRes(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'resolution: no function table' };
    var ctor = funcOfString(im, refs, str.ctor, NAMES.ctor[2]);
    if (ctor.err) return { ok: false, reason: ctor.err };
    var calls = im.calls(ctor.off, ctor.end), builders = {}, checks = { high: [], mid: [] };
    calls.forEach(function (c) {
        if (builders[c.to] === undefined) builders[c.to] = builder(im, c.to);
        var k = checkKind(im, c.to);
        if (k) checks[k].push(c);
    });
    var found = Object.keys(builders).filter(function (k) { return builders[k]; });
    if (found.length !== 2) return { ok: false, reason: 'resolution: ' + found.length + ' geometry builders (want 2)' };
    function branchBuilder(kind) {
        if (checks[kind].length !== 1) return { err: 'resolution: IC_' + kind.toUpperCase() + ' check ' + (checks[kind].length ? 'called ' + checks[kind].length + ' times' : 'not found') };
        var branch = trueBranch(im, checks[kind][0].at, ctor.end);
        var c = calls.filter(function (x) { return branch !== null && x.at >= branch && x.at < branch + 16 && builders[x.to]; })[0];
        return c ? { to: c.to } : { err: 'resolution: IC_' + kind.toUpperCase() + ' builder not found' };
    }
    var high = branchBuilder('high'), mid = branchBuilder('mid');
    if (high.err || mid.err) return { ok: false, reason: high.err || mid.err };
    if (high.to === mid.to) return { ok: false, reason: 'resolution: IC_HIGH and IC_MID share a builder' };
    if (Math.abs(high.to - ctor.off) > NEAR || Math.abs(mid.to - ctor.off) > NEAR) return { ok: false, reason: 'resolution: builders far from the constructor' };
    var readers = layoutReaders(im, ctor);
    if (!readers.length) return { ok: false, reason: 'resolution: geometry getters not found' };
    var b = builders[high.to];
    return { ok: true, builder: high.to, mm: b.mm, px: b.px, safe1: b.safe1, safe2: b.safe2, readers: readers };
}

/* ---- Edit 5: the cluster display's initial URL ------------------------- */

/* The URL the edit gives the cluster display, and the log string whose bytes
 * hold it: patched, a shorter log text, its NUL, then the URL. FORMS are the
 * patched forms: `current`, which this version writes, and `eta`, the URL
 * with `?showETA=yes` that releases 0.10.2-0.10.3 wrote, which this version
 * recognises and replaces. */
var MAP_URL = 'maps:/car/instrumentcluster/map';
var SPARE_LOG = 'Head-Unit does not support Alternate Displays feature.';
var SPARE_LEN = SPARE_LOG.length + 1;
var SPARE_STOCK = Buffer.from(SPARE_LOG + '\0', 'latin1');
function spareForm(name, text, url) {
    if (text.length + 1 + url.length + 1 > SPARE_LEN) throw new Error('map URL longer than its spare string');
    var bytes = Buffer.alloc(SPARE_LEN);
    bytes.write(text + '\0' + url + '\0', 'latin1');
    return { name: name, url: url, at: text.length + 1, bytes: bytes };
}
var FORMS = [spareForm('current', 'Head-Unit: no AltDisp.', MAP_URL), spareForm('eta', 'No AltDisp', MAP_URL + '?showETA=yes')];
/* The alternate-display gate: a small function returning `variant <= 1`
 * (IC_HIGH or IC_MID): cmp esi|edi,1 ; setbe al. */
var GATE = [[0x83, 0xfe, 0x01, 0x0f, 0x96, 0xc0], [0x83, 0xff, 0x01, 0x0f, 0x96, 0xc0]];
/* A global std::string built in a static initializer: lea rsi,[rip+S] ;
 * lea rdi,[rip+G] ; call. */
var STRING_INIT = [0x48, 0x8d, 0x35].concat(any(4)).concat([0x48, 0x8d, 0x3d]).concat(any(4)).concat([0xe8]);

/* The rip-relative target address of the lea whose 4-byte displacement is
 * at `pos` and whose next instruction is at `next`. */
function leaVa(im, pos, next) { var va = im.va(next); return va === null ? null : (va + im.buf.readInt32LE(pos)) >>> 0; }

/* The spare string: the stock log string or one of its patched forms, as
 * its own string (a NUL before it), found once. { off } or { err }. */
function spareString(buf) {
    var found = [];
    [SPARE_STOCK].concat(FORMS.map(function (f) { return f.bytes; })).forEach(function (want) {
        for (var i = buf.indexOf(want); i >= 0; i = buf.indexOf(want, i + 1)) if (i > 0 && buf[i - 1] === 0) found.push(i);
    });
    if (found.length === 1) return { off: found[0] };
    return { err: 'map URL: log string ' + (found.length ? 'found ' + found.length + ' times' : 'not found') };
}

/* The instructions of [start, end), decoded in a row, or null when one is
 * not decoded. */
function linear(buf, start, end) {
    var out = [];
    for (var p = start; p < end;) { var i = X86.decode(buf, p, end); if (!i) return null; out.push({ at: p, i: i }); p += i.len; }
    return out;
}
function isNop(buf, p) {
    var q = p;
    while (buf[q] === 0x66 || buf[q] === 0x2e) q++;
    return buf[q] === 0x90 || (buf[q] === 0x0f && buf[q + 1] === 0x1f);
}

/* The start of the code a call's bool result skips to when false: from the
 * call, its result followed through `mov r32,r32` copies and calls that
 * keep the register (callee-saved), straight to `test r8,r8 ; je`. */
function falseBranch(buf, ins, k) {
    var held = [0], CALLER_SAVED = [0, 1, 2, 6, 7, 8, 9, 10, 11];
    for (var j = k + 1; j < ins.length && ins[j].at < ins[k].at + 0x40; j++) {
        var x = ins[j], p = x.at, rex = (buf[p] & 0xf0) === 0x40 ? buf[p++] : 0, m = buf[p + 1];
        if (buf[p] === 0x84 && (m >> 6) === 3 && ((m >> 3) & 7 | (rex & 4) << 1) === ((m & 7) | (rex & 1) << 3) && held.indexOf((m & 7) | (rex & 1) << 3) >= 0) {
            var je = ins[j + 1];
            return je && je.i.kind === 'jcc' && (buf[je.at] === 0x74 || (buf[je.at] === 0x0f && buf[je.at + 1] === 0x84)) ? { je: je.at, to: je.i.to } : null;
        }
        if (buf[p] === 0x89 && (m >> 6) === 3 && held.indexOf((m >> 3) & 7 | (rex & 4) << 1) >= 0) { held.push((m & 7) | (rex & 1) << 3); continue; }
        if (x.i.kind === 'call' || x.i.kind === 'icall') { held = held.filter(function (r) { return CALLER_SAVED.indexOf(r) < 0; }); continue; }
        if (x.i.kind === 'jcc' && x.i.to > x.at && x.i.to < x.at + 0x20) continue;   /* a short skip forward, e.g. over a release */
        if (x.i.kind !== 'op') return null;
        held = held.filter(function (r) { return x.i.w.indexOf(r) < 0; });
        if (!held.length) return null;
    }
    return null;
}

/* The spare string's one reader, the lea at `at`: a log block reached only
 * when the alternate-display gate says no, which the variant edit keeps
 * from running. Its function decodes in a row; one call there to the gate
 * (a small function doing `variant <= 1`) is followed by `test ; je` to the
 * block; the block runs straight (no branch) to the lea; no other branch in
 * the function, and no rel32 branch anywhere, lands in it; and the code
 * before it does not fall into it. Why not, or null. */
function logPathWhyNot(im, at) {
    var buf = im.buf, fn = im.func(at);
    if (!fn) return 'log string read outside the function table';
    var ins = linear(buf, fn.off, fn.end);
    if (!ins) return 'log function not decoded';
    var gates = {}, blocks = [];
    ins.forEach(function (x, k) {
        if (x.i.kind !== 'call') return;
        if (gates[x.i.to] === undefined) {
            var g = im.func(x.i.to);
            gates[x.i.to] = !!g && g.off === x.i.to && g.end - g.off <= 0x40 && GATE.some(function (pat) { return scan(buf, g.off, g.end, pat).length > 0; });
        }
        var fb = gates[x.i.to] && falseBranch(buf, ins, k);
        if (fb && fb.to <= at && at - fb.to < 0x40) blocks.push(fb);
    });
    if (blocks.length !== 1) return 'log ' + (blocks.length ? 'reached from ' + blocks.length + ' gate checks' : 'not on the alternate-display gate\'s false branch');
    var b = blocks[0], k0 = -1;
    for (var k = 0; k < ins.length; k++) if (ins[k].at === b.to) { k0 = k; break; }
    if (k0 < 0) return 'log block not at an instruction';
    for (k = k0; k < ins.length && ins[k].at < at; k++) if (ins[k].i.kind !== 'op' && ins[k].i.kind !== 'call') return 'log block branches before the log';
    if (k >= ins.length || ins[k].at !== at) return 'log string load not at an instruction';
    for (k = k0 - 1; k >= 0 && isNop(buf, ins[k].at); k--);
    if (k >= 0 && ins[k].i.kind !== 'jmp' && ins[k].i.kind !== 'exit') return 'log block entered by falling through';
    if (ins.some(function (x) { return (x.i.kind === 'jmp' || x.i.kind === 'jcc') && x.at !== b.je && x.i.to >= b.to && x.i.to <= at; }))
        return 'log block entered by another branch';
    if (im.branchesInto(b.to, at, false).some(function (x) { return x.at !== b.je; })) return 'log block entered from elsewhere';
    return null;
}

/* The global std::string a STRING_INIT at `m` builds, `d` bytes (a `mov
 * rdx,r64`) between its leas: [va of G, { at, ctor (the call's target), src
 * (S's offset or null), reg (the call `lea rsi,[rip+G] ; call` makes within
 * 0x20 bytes after it, or null) }], or null. */
function stringInit(im, m, d) {
    var buf = im.buf, g = leaVa(im, m + d + 10, m + d + 14), src = leaVa(im, m + 3, m + 7), reg = null, end = m + d + 19;
    if (g === null) return null;
    scan(buf, end, Math.min(end + 0x20, im.exec.end), [0x48, 0x8d, 0x35]).some(function (q) {
        if (leaVa(im, q + 3, q + 7) !== g) return false;
        var c = im.calls(q + 7, Math.min(q + 7 + 0x10, im.exec.end))[0];
        reg = c ? c.to : null;
        return true;
    });
    return [g, { at: m, ctor: im.rel(end - 4, end), src: src === null ? null : im.off(src), reg: reg }];
}

/* The STRING_INIT matches: { va of G: [stringInit's entry] }. */
function stringInits(im) {
    var out = {};
    scan(im.buf, im.exec.off, im.exec.end, STRING_INIT).forEach(function (m) {
        var e = stringInit(im, m, 0);
        if (e) (out[e[0]] = out[e[0]] || []).push(e[1]);
    });
    return out;
}

/* The STRING_INIT at `m`, the lea of its source string, with or without the
 * allocator argument set between its leas (mov rdx,r64): stringInit's
 * result, or null. */
function stringInitAt(im, m) {
    var buf = im.buf;
    if (buf[m] !== 0x48 || buf[m + 1] !== 0x8d || buf[m + 2] !== 0x35) return null;
    for (var d = 0; d <= 3; d += 3) {
        if (d && ((buf[m + 7] & 0xfb) !== 0x48 || buf[m + 8] !== 0x89 || (buf[m + 9] & 0xc7) !== 0xc2)) continue;
        if (buf[m + d + 7] === 0x48 && buf[m + d + 8] === 0x8d && buf[m + d + 9] === 0x3d && buf[m + d + 14] === 0xe8) return stringInit(im, m, d);
    }
    return null;
}

/* Whether some global other than `g` is built by `ctor` from a printable C
 * string and registered through `reg`: ctor then builds std::strings from
 * C strings, and reg registers static destructors. */
function builtLikeAString(im, inits, g, ctor, reg) {
    return Object.keys(inits).some(function (k) {
        return Number(k) !== g && inits[k].some(function (e) {
            if (e.ctor !== ctor || e.reg !== reg || e.src === null) return false;
            var t = stringAt(im.buf, e.src);
            return t.length >= 2 && /^[\x20-\x7e]+$/.test(t);
        });
    });
}

/* Both sites (sp: the spare string as spareString found it; r: leaRefs of
 * its every byte; rela: the RELA addends). The initial URL's site: among the
 * globals the cluster display's builder (the one function constructing
 * ICSafeAreaProvider and reading its geometry, Edit 4's) loads by address
 * (a rip-relative lea), the one a STRING_INIT builds, built once, from a
 * NUL byte ("", stock) or the URL of one of the patched forms in the spare
 * string, registered right after (lea rsi,[rip+G] ; call), by a constructor
 * and through a registration call that also build and register another
 * global from a printable C string; the site is that build's `lea rsi`. The
 * spare string's site: the log string (or a patched form) found once, its
 * start loaded by one lea, which logPathWhyNot clears, and nothing else
 * loading inside it but, at the URL it loads, the initial URL's lea; no RELA
 * addend points into it. slotIs and leaIs say which form each site holds:
 * 'stock', or a FORMS name. */
function locateMapUrl(im, res, sp, r, rela, inits) {
    if (!res.ok) return { ok: false, reason: 'map URL: no cluster display builder (' + res.reason + ')' };
    if (res.readers.length !== 1) return { ok: false, reason: 'map URL: ' + res.readers.length + ' cluster display builders' };
    if (sp.err) return { ok: false, reason: sp.err };
    var buf = im.buf;
    var slot = sp.off, fn = res.readers[0], globals = [];
    for (var p = fn.off + 1; p + 6 <= fn.end; p++) {
        if (buf[p] !== 0x8d || (buf[p - 1] & 0xfb) !== 0x48 || (buf[p + 1] & 0xc7) !== 0x05) continue;
        var g = leaVa(im, p + 2, p + 6);
        if (g !== null && inits[g] && globals.indexOf(g) < 0) globals.push(g);
    }
    if (globals.length !== 1) return { ok: false, reason: 'map URL: the cluster display builder loads ' + globals.length + ' string globals (want 1)' };
    var sites = inits[globals[0]];
    if (sites.length !== 1) return { ok: false, reason: 'map URL: initial URL built ' + sites.length + ' times' };
    var lea = sites[0].at, s = sites[0].src;
    var leaForm = FORMS.filter(function (f) { return s === slot + f.at; })[0];
    if (s === null || (!leaForm && buf[s] !== 0)) return { ok: false, reason: 'map URL: initial URL built from neither "" nor the URL' };
    if (sites[0].reg === null) return { ok: false, reason: 'map URL: initial URL global not registered for destruction' };
    if (!builtLikeAString(im, inits, globals[0], sites[0].ctor, sites[0].reg)) return { ok: false, reason: 'map URL: initial URL global not built like the other string globals' };
    function loads(o) { return r[o] || []; }
    if (loads(slot).length !== 1) return { ok: false, reason: 'map URL: log string loaded ' + loads(slot).length + ' times (want 1)' };
    for (var i = 1; i < SPARE_LEN; i++) {
        var want = leaForm && i === leaForm.at ? [lea] : [];
        if (JSON.stringify(loads(slot + i)) !== JSON.stringify(want)) return { ok: false, reason: 'map URL: another string inside the log string' };
    }
    var slotVa = im.va(slot);
    if (rela.some(function (a) { return a >= slotVa && a < slotVa + SPARE_LEN; })) return { ok: false, reason: 'map URL: a data pointer into the log string' };
    var why = logPathWhyNot(im, r[slot][0]);
    if (why) return { ok: false, reason: 'map URL: ' + why };
    var held = buf.slice(slot, slot + SPARE_LEN), slotForm = FORMS.filter(function (f) { return held.equals(f.bytes); })[0];
    var forms = FORMS.map(function (f) {
        return { name: f.name, slotBytes: f.bytes.toString('hex'), leaBytes: '488d35' + hex32(im.va(slot + f.at) - im.va(lea + 7)) };
    });
    return {
        ok: true, slot: slot, len: SPARE_LEN, lea: lea, url: slot + FORMS[0].at, builder: fn.off, log: r[slot][0],
        slotIs: slotForm ? slotForm.name : 'stock', leaIs: leaForm ? leaForm.name : 'stock',
        slotBytes: forms[0].slotBytes, leaBytes: forms[0].leaBytes, forms: forms,
    };
}

/* ---- Edit 6: the ShowUI URL --------------------------------------------- */

/* requestStream sends the phone ShowUI(alternateDisplayUrl().c_str(), uuid):
 * the cluster display's URL, a global std::string built from ALT_URL, read
 * through its getter. The edit hands ShowUI SHOWUI_URL instead, held in the
 * bytes of the log text of that same call's result check: patched, the text
 * up to `ShowUI(`, its NUL, then the URL (SHOWUI_FORM). The call site
 * `call getter ; mov rdi,rN ; mov rsi,[rax]` (either order of the two movs)
 * becomes `mov rdi,rN ; lea rsi,[rip+URL] ; nop`, the same 11 bytes. */
var ALT_URL = 'maps:/car/instrumentcluster';
var SHOWUI_URL = ALT_URL + '?showETA=yes';
var SHOWUI_TEXT = 'mCinemoCarPlay->ShowUI(';
var SHOWUI_FORM = Buffer.from(SHOWUI_TEXT + '\0' + SHOWUI_URL + '\0', 'latin1');
var SHOWUI_LEN = SHOWUI_FORM.length, SHOWUI_AT = SHOWUI_TEXT.length + 1, SHOWUI_CALL = 11;
/* The check's log text as built: the expression the call was written as. */
var SHOWUI_EXPR = /^mCinemoCarPlay->ShowUI\( ::(?:\w+::)*CarPlayConstantsRepository::alternateDisplayUrl\(\)\.c_str\(\), /;
var MOV_RSI_RAX = [0x48, 0x8b, 0x30], LEA_RSI = Buffer.from([0x48, 0x8d, 0x35]);

/* The bytes of `mov rdi,r` (REX.W 89 /r) for register r. */
function movRdi(r) { return [r & 8 ? 0x4c : 0x48, 0x89, 0xc7 | ((r & 7) << 3)]; }
/* The 4 bytes of the rel32 from `next` (the end of its instruction) to file
 * offset `to`. */
function rel32(im, next, to) { var v = (im.va(to) - im.va(next)) | 0; return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/* The function returning the address of the global `g`: a small one whose
 * one rip-relative lea is `lea rax,[rip+g]`, with no call before its ret.
 * { off } or { err }. */
function getterOf(im, g) {
    var buf = im.buf, found = [], base = im.va(im.exec.off) - im.exec.off, lea = Buffer.from([0x48, 0x8d, 0x05]);
    for (var p = buf.indexOf(lea, im.exec.off); p >= 0 && p + 7 <= im.exec.end; p = buf.indexOf(lea, p + 1)) {
        if (((base + p + 7 + buf.readInt32LE(p + 3)) >>> 0) !== g) continue;
        var fn = im.func(p);
        if (!fn || fn.end - fn.off > 0x40 || found.indexOf(fn.off) >= 0) continue;
        var ins = linear(buf, fn.off, fn.end), ret = -1;
        if (!ins) continue;
        for (var k = 0; k < ins.length && ret < 0; k++) {
            if (ins[k].i.kind === 'exit') ret = ins[k].at;
            else if (ins[k].i.kind !== 'op' && ins[k].i.kind !== 'jcc') break;
        }
        if (ret > p) found.push(fn.off);
    }
    return found.length === 1 ? { off: found[0] } : { err: 'ShowUI URL: URL getter ' + (found.length ? 'found ' + found.length + ' times' : 'not found') };
}

/* What the window at `p` holds: 'stock', 'patched', 'mixed' (one form's
 * bytes up to a point and the other's after it, a write cut short), or null;
 * with the stock and patched bytes (Buffers), for `mov rdi,r` with the movs
 * in either order. */
function showUiWindow(im, p, getter, url) {
    var buf = im.buf, call = [0xe8].concat(rel32(im, p + 5, getter)), lea = [0x48, 0x8d, 0x35].concat(rel32(im, p + 10, url), [0x90]);
    /* the longest prefix of the window matching f */
    function prefix(f) { for (var i = 0; i < SHOWUI_CALL && buf[p + i] === f[i]; i++); return i; }
    function suffix(f) { for (var i = SHOWUI_CALL; i > 0 && buf[p + i - 1] === f[i - 1]; i--); return i; }
    for (var r = 0; r < 16; r++) {
        if (r === 0 || r === 4 || r === 6 || r === 7) continue;    /* rax rsp rsi rdi */
        var a = movRdi(r), patched = a.concat(lea);
        for (var o = 0; o < 2; o++) {
            var stock = call.concat(o ? MOV_RSI_RAX.concat(a) : a.concat(MOV_RSI_RAX));
            var ps = prefix(stock), pp = prefix(patched), ss = suffix(stock), sp = suffix(patched);
            var is = ps === SHOWUI_CALL ? 'stock' : pp === SHOWUI_CALL ? 'patched' : pp >= ss || ps >= sp ? 'mixed' : null;
            if (is) return { is: is, stock: Buffer.from(stock), patched: Buffer.from(patched) };
        }
    }
    return null;
}

/* After the window at `p` (end `end` of requestStream): up to 3 `mov r64,r64`
 * that write neither rdi nor rsi and read no rax, then `call reg` (ShowUI,
 * through the object's table) with reg none of rax, rsi, rdi, then, without
 * a branch, its result checked: `mov edi,eax`, the lea of the check's log
 * text `s`, and a direct call. Why not, or null. */
function showUiCallWhyNot(im, p, end, s) {
    var buf = im.buf, q = p + SHOWUI_CALL, n = 0, x;
    for (;; n++) {
        x = X86.decode(buf, q, end);
        if (!x) return 'ShowUI call not decoded';
        var rex = (buf[q] & 0xf0) === 0x40 ? buf[q] : 0, o = rex ? q + 1 : q;
        if (x.kind === 'icall') {
            var reg = (buf[o + 1] & 7) | (rex & 1) << 3;
            if (buf[o] !== 0xff || (buf[o + 1] & 0xf8) !== 0xd0 || reg === 0 || reg === 6 || reg === 7) return 'ShowUI not called through a register';
            break;
        }
        if (n >= 3 || !(rex & 8) || buf[o] !== 0x89 || (buf[o + 1] >> 6) !== 3) return 'ShowUI call not found after the URL';
        var src = ((buf[o + 1] >> 3) & 7) | (rex & 4) << 1, dst = (buf[o + 1] & 7) | (rex & 1) << 3;
        if (src === 0 || dst === 6 || dst === 7) return 'ShowUI arguments changed before the call';
        q += x.len;
    }
    var seen = { edi: false, lea: false };
    for (q += x.len; q < Math.min(end, p + SHOWUI_CALL + 0x40);) {
        x = X86.decode(buf, q, end);
        if (!x) return 'ShowUI result check not decoded';
        if (x.kind === 'call') return seen.edi && seen.lea ? null : 'ShowUI result not checked with its log text';
        if (x.kind !== 'op') return 'ShowUI result check branches';
        if (buf[q] === 0x89 && buf[q + 1] === 0xc7) seen.edi = true;
        if (buf[q] === 0x48 && buf[q + 1] === 0x8d && buf[q + 2] === 0x35 && im.off(leaVa(im, q + 3, q + 7)) === s) seen.lea = true;
        q += x.len;
    }
    return 'ShowUI result check not found';
}

/* Why a branch may land inside (a, b), the call site at a in requestStream
 * (rs), or null: requestStream outside the site not decoded in a row, one of
 * its branches landing there, or a rel32 jmp, jcc or call anywhere in the
 * code landing there. */
function branchIntoWhyNot(im, rs, a, b) {
    var buf = im.buf, ins = linear(buf, rs.off, a), after = linear(buf, b, rs.end);
    if (!ins || !after) return 'requestStream not decoded';
    if (ins.concat(after).some(function (x) { return (x.i.kind === 'jmp' || x.i.kind === 'jcc' || x.i.kind === 'call') && x.i.to > a && x.i.to < b; }) ||
        im.branchesInto(a + 1, b - 1, true).length) return 'a branch into the call site';
    return null;
}

/* Both sites (str: the name strings; refs: leaRefs of their every byte and
 * of ALT_URL's; inits: stringInits; rela: the RELA addends). Not applicable
 * to a build with AlternateDisplays::setShowUiUrl, which builds the ShowUI
 * URL with carplay.conf's SHOW_UI_OPTIONS itself.
 *   The log text: the one string starting `mCinemoCarPlay->ShowUI(`,
 * reading as the check of `ShowUI( …alternateDisplayUrl().c_str(), …`
 * (stock) or as SHOWUI_FORM (patched); without either, a NUL at either of
 * SHOWUI_FORM's NULs (the stock text has none in its first SHOWUI_LEN bytes)
 * is a write of ours cut short ('mixed'). It is loaded by one lea, in
 * requestStream (the function loading its own name at its entry), nothing
 * else loads inside it but, at the URL, the call site's lea, and no RELA
 * addend points into it.
 *   The URL getter: the one small function returning the global std::string
 * built from ALT_URL (its own string, loaded once), built once, by a static
 * initializer that builds other string globals the same way, and registered
 * for destruction.
 *   The call site: the one window in requestStream holding the stock or
 * patched form (or, cut short, a mix of the two), followed by the ShowUI
 * call and its result's check with the log text; no branch lands inside it.
 * strIs and callIs say which form each site holds: 'stock', 'patched' or
 * 'mixed'. */
function locateShowUi(im, str, refs, inits, rela) {
    if (!str.setShowUi.err) return { ok: false, na: true, reason: 'ShowUI URL: not applicable (the build adds carplay.conf\'s SHOW_UI_OPTIONS to it)' };
    if (!im.starts.length) return { ok: false, reason: 'ShowUI URL: no function table' };
    if (str.showUi.err) return { ok: false, reason: 'ShowUI URL: ' + str.showUi.err.replace(/^self-start: ShowUI string/, 'ShowUI log text') };
    var buf = im.buf, s = str.showUi.off;
    var strIs = buf.slice(s, s + SHOWUI_LEN).equals(SHOWUI_FORM) ? 'patched'
        : buf[s + SHOWUI_AT - 1] === 0 || buf[s + SHOWUI_LEN - 1] === 0 ? 'mixed'
        : SHOWUI_EXPR.test(stringAt(buf, s)) ? 'stock' : null;
    if (!strIs) return { ok: false, reason: 'ShowUI URL: ShowUI not called with the alternate display URL' };
    var rs = entryFunc(im, refs, str.rs, 'ShowUI URL: requestStream');
    if (rs.err) return { ok: false, reason: rs.err };
    var loads = refs[s] || [];
    if (loads.length !== 1 || loads[0] < rs.off || loads[0] >= rs.end) return { ok: false, reason: 'ShowUI URL: log text loaded ' + loads.length + ' times (want once, in requestStream)' };
    if (str.alt.err) return { ok: false, reason: str.alt.err };
    var built = (refs[str.alt.off] || []).map(function (m) { return stringInitAt(im, m); });
    if (built.length !== 1 || !built[0]) return { ok: false, reason: 'ShowUI URL: the alternate display URL ' + (built.length === 1 ? 'not built as a global' : 'loaded ' + built.length + ' times (want 1)') };
    var g = built[0][0], init = built[0][1], sinit = im.func(init.at);
    /* Its siblings: the other globals its static initializer builds. */
    var siblings = {};
    if (sinit) for (var q = buf.indexOf(LEA_RSI, sinit.off); q >= 0 && q < sinit.end; q = buf.indexOf(LEA_RSI, q + 1)) {
        var e = q !== init.at && stringInitAt(im, q);
        if (e) (siblings[e[0]] = siblings[e[0]] || []).push(e[1]);
    }
    if (init.reg === null || !builtLikeAString(im, siblings, g, init.ctor, init.reg))
        return { ok: false, reason: 'ShowUI URL: the alternate display URL global not built like the other string globals' };
    /* built once: one `lea rdi,[rip+G]` anywhere */
    var leaRdi = Buffer.from([0x48, 0x8d, 0x3d]), base = im.va(im.exec.off) - im.exec.off, builds = 0;
    for (q = buf.indexOf(leaRdi, im.exec.off); q >= 0 && q + 7 <= im.exec.end; q = buf.indexOf(leaRdi, q + 1))
        if (((base + q + 7 + buf.readInt32LE(q + 3)) >>> 0) === g) builds++;
    if (builds !== 1) return { ok: false, reason: 'ShowUI URL: the alternate display URL global built ' + builds + ' times (want 1)' };
    var getter = getterOf(im, g);
    if (getter.err) return { ok: false, reason: getter.err };
    var url = s + SHOWUI_AT, hits = [];
    for (var p = rs.off; p + SHOWUI_CALL <= rs.end; p++) {
        if (buf[p] !== 0xe8 && buf[p] !== 0x48 && buf[p] !== 0x4c) continue;   /* the first byte of either form */
        var w = showUiWindow(im, p, getter.off, url);
        if (w) hits.push({ at: p, w: w });
    }
    if (hits.length !== 1) return { ok: false, reason: 'ShowUI URL: call site ' + (hits.length ? 'found ' + hits.length + ' times' : 'not found') };
    var at = hits[0].at, win = hits[0].w;
    var why = showUiCallWhyNot(im, at, rs.end, s);
    if (why) return { ok: false, reason: 'ShowUI URL: ' + why };
    why = branchIntoWhyNot(im, rs, at, at + SHOWUI_CALL);
    if (why) return { ok: false, reason: 'ShowUI URL: ' + why };
    for (var i = 1; i < SHOWUI_LEN; i++) {
        var want = i === SHOWUI_AT && win.is !== 'stock' ? [at + 3] : [];
        if (JSON.stringify(refs[s + i] || []) !== JSON.stringify(want) && !(i === SHOWUI_AT && JSON.stringify(refs[s + i] || []) === '[]'))
            return { ok: false, reason: 'ShowUI URL: another string inside the log text' };
    }
    var sVa = im.va(s);
    if (rela.some(function (a) { return a >= sVa && a < sVa + SHOWUI_LEN; })) return { ok: false, reason: 'ShowUI URL: a data pointer into the log text' };
    return {
        ok: true, str: s, len: SHOWUI_LEN, call: at, callLen: SHOWUI_CALL, url: url, getter: getter.off, requestStream: rs.off,
        strIs: strIs, callIs: win.is, strBytes: SHOWUI_FORM.toString('hex'), callBytes: win.patched.toString('hex'), callStock: win.stock.toString('hex'),
    };
}

/* ---- relocations and version -------------------------------------------- */

/* The edits the loader would rewrite: all of them with text relocations or
 * relocations this cannot read (REL, RELR, or a dynamic segment or table
 * outside the file), else
 * those of `regions` ([edit, off, len]) that a relocation's 8 bytes (RELA or
 * PLT) overlap; and the addends of those relocations, the addresses they
 * store. { all: why or null, edits, addends } */
function relocated(im, regions) {
    var out = { all: null, edits: [], addends: [] };
    if (im.dynBad) { out.all = 'relocations not readable'; return out; }
    if (!im.dyn) return out;
    var buf = im.buf, d = {}, rel = [];
    for (var o = im.dyn.off; o + 16 <= im.dyn.off + im.dyn.size; o += 16) {
        var tag = u64(buf, o);
        if (tag === 0) break;
        if (tag !== null) d[tag] = u64(buf, o + 8);
    }
    if (d[22] !== undefined || (d[30] & 4)) { out.all = 'text relocations'; return out; }      /* DT_TEXTREL, DF_TEXTREL */
    if (d[17] !== undefined || d[36] !== undefined) { out.all = 'relocations not readable'; return out; }   /* DT_REL, DT_RELR */
    [[7, 8], [23, 2]].forEach(function (t) {                                  /* DT_RELA/RELASZ, DT_JMPREL/PLTRELSZ */
        if (d[t[0]] === undefined) return;
        var at = d[t[0]] === null ? null : im.off(d[t[0]]), n = d[t[1]] || 0;
        if (at === null || at + n > buf.length) { out.all = 'relocations not readable'; return; }
        for (var r = at; r + 24 <= at + n; r += 24) {
            var v = u64(buf, r), a = u64(buf, r + 16);
            if (v !== null) rel.push(v);
            if (a !== null) out.addends.push(a);
        }
    });
    if (out.all) return out;
    regions.forEach(function (g) {
        var va = im.va(g[1]);
        if (va !== null && rel.some(function (v) { return v + 8 > va && v < va + g[2]; }) && out.edits.indexOf(g[0]) < 0) out.edits.push(g[0]);
    });
    return out;
}

/* The version of package `pkg` (carplay by default) its debug source paths
 * name, or null. */
function version(buf, pkg) {
    var re = new RegExp('/usr/src/debug/' + (pkg || 'carplay') + '/([0-9][0-9.]*)\\+', 'g'), text = buf.toString('latin1'), m, seen = [];
    while ((m = re.exec(text))) if (seen.indexOf(m[1]) < 0) seen.push(m[1]);
    return seen.length === 1 ? seen[0] : null;
}

/* All six sites: { elf: true|false, reason (not an ELF / why), buildId,
 * version, variant, sink, selfstart, res, mapurl, showui }, each edit { ok,
 * reason } plus its offsets and stock/patched values. ok is true when the
 * first four were found; the map URL and ShowUI URL edits are applied where
 * they are found, and their reasons say why not. */
function locate(buf) {
    var elf = parseElf(buf);
    var none = { ok: false, reason: 'not located' };
    if (!elf.load) return { ok: false, elf: false, reason: elf.reason, buildId: null, version: null, variant: none, sink: none, selfstart: none, res: none, mapurl: none, showui: none };
    var im = new Image(buf, elf), str = {}, offs = [], sink = locateSink(buf), spare = spareString(buf);
    Object.keys(NAMES).forEach(function (k) {
        str[k] = namedString(buf, NAMES[k][0], NAMES[k][1], NAMES[k][2]);
        if (!str[k].err) offs.push(str[k].off);
    });
    if (sink.ok) for (var i = 0; i < sink.len; i++) offs.push(sink.offset + i);
    if (!spare.err) for (i = 0; i < SPARE_LEN; i++) offs.push(spare.off + i);
    if (!str.showUi.err) for (i = 1; i < SHOWUI_LEN; i++) offs.push(str.showUi.off + i);
    str.alt = namedString(buf, ALT_URL, /^maps:\/car\/instrumentcluster$/, 'ShowUI URL: alternate display URL');
    if (!str.alt.err) offs.push(str.alt.off);
    var refs = leaRefs(im, offs);
    var out = { elf: true, buildId: buildId(buf, elf.notes), version: version(buf), variant: locateVariant(im, str, refs), sink: sinkRefs(sink, refs),
                selfstart: locateSelfstart(im, str, refs), res: locateRes(im, str, refs) };
    var regions = [];
    if (out.variant.ok) regions.push(['variant', out.variant.slot, 4]);
    if (out.sink.ok) regions.push(['sink', out.sink.offset, out.sink.len]);
    if (out.selfstart.ok) regions.push(['selfstart', out.selfstart.offset, 5]);
    if (out.res.ok) [out.res.mm, out.res.px, out.res.safe1, out.res.safe2].forEach(function (o) { regions.push(['res', o, 8]); });
    var label = { variant: 'variant', sink: 'sink', selfstart: 'self-start', res: 'resolution', mapurl: 'map URL', showui: 'ShowUI URL' };
    function refuse(hit) {
        Object.keys(label).forEach(function (e) {
            if (out[e] && out[e].ok && (hit.all || hit.edits.indexOf(e) >= 0))
                out[e] = { ok: false, reason: label[e] + ': ' + (hit.all || 'a dynamic relocation over the edit') };
        });
    }
    var hit = relocated(im, regions);
    refuse(hit);
    /* The map URL edit builds on the resolution edit's cluster display builder. */
    var inits = stringInits(im);
    out.mapurl = locateMapUrl(im, out.res, spare, refs, hit.addends, inits);
    if (out.mapurl.ok) refuse(relocated(im, [['mapurl', out.mapurl.slot, out.mapurl.len], ['mapurl', out.mapurl.lea, 7]]));
    out.showui = locateShowUi(im, str, refs, inits, hit.addends);
    if (out.showui.ok) refuse(relocated(im, [['showui', out.showui.str, out.showui.len], ['showui', out.showui.call, out.showui.callLen]]));
    var failed = [out.variant, out.sink, out.selfstart, out.res].filter(function (e) { return !e.ok; });
    out.ok = failed.length === 0;
    if (failed.length) out.reason = failed.map(function (e) { return e.reason; }).join('; ');
    return out;
}

/* The proven build `cur` is a copy of, rebuilt from it: the shipped bytes of
 * its entry in `proven` (by build-id: { sha256, stock: [[offset, hex]] })
 * written over every site, when the result is the shipped file whole; else
 * null. */
function stockOriginal(proven, cur) {
    var p = proven[elfBuildId(cur)];
    if (!p) return null;
    var out = Buffer.from(cur);
    p.stock.forEach(function (s) { if (s[0] + s[1].length / 2 <= out.length) Buffer.from(s[1], 'hex').copy(out, s[0]); });
    return require('crypto').createHash('sha256').update(out).digest('hex') === p.sha256 ? out : null;
}

module.exports = {
    locate: locate, buildId: elfBuildId, SINK_STOCK: SINK_STOCK, MAP_URL: MAP_URL, MAP_URL_FORMS: FORMS, SHOWUI_URL: SHOWUI_URL, ALT_URL: ALT_URL,
    stockOriginal: stockOriginal,
    /* the ELF reading aapd_locate.js shares */
    elf: { parseElf: parseElf, Image: Image, noteBuildId: buildId, scan: scan, namedString: namedString, leaRefs: leaRefs,
           funcOfString: funcOfString, relocated: relocated, hex32: hex32, version: version,
           SWITCH: SWITCH, switchSlots: switchSlots },
};
