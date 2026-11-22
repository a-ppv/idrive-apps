// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Robert Nisipeanu
/**
 * Node 8 client for the cluster render service (../PROTOCOL.md): an app's
 * layers on the instrument cluster and the HUD. Copy this file into an app's
 * src/ and bundle it like any other module; it needs only the `net` and
 * `events` builtins.
 *
 *   const { ClusterRender } = require('./cluster_render_client.js');
 *   const cr = new ClusterRender('robertn_myapp');
 *   const badge = cr.image({ target: 'panel', klass: 'overlay', x: 1700, y: 40, w: 160, h: 64, iw: 160, ih: 64 });
 *   cr.on('layer', (ref, state, reason) => { ... });   // shown, waiting, suspended, stalled, hidden, error
 *   cr.on('target', (name, state, holder, reason, guideDisabled, disabled) => { ... });
 *   cr.on('budget', (capKb, maxKb, reason) => { ... });
 *   cr.on('fps_cap', (fps, app) => { ... });   // another app holds this one's videos (0: released)
 *   cr.on('ready', () => cr.pixels(badge, null, rgba));   // after every (re)connect
 *   cr.connect();
 *   ...
 *   cr.pixels(badge, [{ x: 0, y: 0, w: 40, h: 64 }], changedRows);   // only what changed
 *   cr.set(badge, { visible: false, rotate: 15 });
 *
 *   const font = cr.asset({ target: 'panel', format: 'r8', w: 256, h: 128 });
 *   cr.pixels(font, null, glyphs);
 *   const label = cr.effect({ target: 'panel', x: 40, y: 600, w: 300, h: 60, fs: GLYPH_FS, time: true });
 *   cr.bind(label, 'u_atlas', font);
 *   cr.uniform(label, 'u_cells', cells, { type: 'vec4' });
 *   const car = cr.mesh({ target: 'panel', x: 700, y: 200, w: 520, h: 400, cz: 6 });
 *   cr.part(car, 1, { vs: LIT_VS, fs: LIT_FS });
 *   cr.geometry(car, 1, { positions, normals, indices });
 *   cr.animate(car, { part: 1, property: 'rotate', keys: '0:0,0,0 4000:0,360,0', loop: true });
 *   const gauge = cr.scene({ target: 'panel', file: '/var/opt/my-tool/gauge.ramses',
 *       res: ['/var/opt/my-tool/gauge.ramres'], sha256: [sceneSha, resSha] });
 *   cr.edit(gauge, '--rotate ^needle$=0,0,-30\n--uniform ^bar$:u_level=0.5');
 *   cr.host('panel', { target: 'map', x: 600, y: 120, w: 720, h: 480 });   // the map under this app's panel layers
 *   cr.on('host', (target, ev) => { ... });   // ev.into: where target is drawn now ('' : its own slot)
 *   cr.close();
 *
 * Nothing blocks and nothing queues without bound. The client reconnects
 * whenever the service goes, makes every asset and layer again with its last
 * settings: uniforms, mesh parts with their geometry and transforms, binds
 * and animations, every scene file with its kept edits, and sends each image
 * layer and asset whole; 'ready' then
 * asks the app for anything else. An image layer or asset is kept here
 * whole: what changed since it last went is sent as one update when the
 * socket takes it. A video frame not yet sent is replaced by the next
 * (newest wins).
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_PATH = '/dev/shm/cluster-render/render.sock';
const PROTO = 1;
const JSON_T = 0x4a;    /* 'J' */
const FRAME_T = 0x46;   /* 'F' */
const MESH_T = 0x4d;    /* 'M' */
const MAX_DIRTY = 16;
const BACKOFF_MS = [250, 500, 1000, 2000];
const SET_KEYS = ['klass', 'z', 'x', 'y', 'w', 'h', 'visible', 'exclusive', 'prewarm', 'preload', 'contend',
    'guide_hold', 'yield', 'others_fps', 'opacity', 'rotate', 'sx', 'sy', 'px', 'py'];
const MESH_KEYS = ['projection', 'fov', 'ortho_h', 'near', 'far', 'cx', 'cy', 'cz', 'crx', 'cry', 'crz'];
/* An effect layer's or mesh part's render state (PROTOCOL.md "Render
 * state"); a part's also takes PART_LOOK_KEYS. */
const LOOK_KEYS = ['blend', 'blend_src', 'blend_dst', 'blend_src_alpha', 'blend_dst_alpha', 'blend_op',
    'blend_op_alpha', 'color_mask'];
const PART_LOOK_KEYS = ['depth_func', 'depth_write', 'cull'];
const BLEND_KEYS = LOOK_KEYS.filter((k) => k.indexOf('blend_') === 0);

/* An effect layer's kept look takes a set's look fields as the service
 * does: a blend preset replaces the custom factors and operations (they go),
 * and blend none takes none (the service refuses them). */
function setLook(kept, opts) {
    if (opts.blend !== undefined) BLEND_KEYS.forEach((k) => { delete kept[k]; });
    LOOK_KEYS.forEach((k) => { if (opts[k] !== undefined) kept[k] = opts[k]; });
    if (kept.blend === 'none') BLEND_KEYS.forEach((k) => { delete kept[k]; });
}
const MIPMAPPED = ['nearest_mips', 'bilinear_mips', 'trilinear'];

/* Bytes of an asset's pixels: with mips, its mip levels too, a compressed
 * one's down to the last level of whole 4x4 blocks (PROTOCOL.md
 * "Mipmaps"). */
function assetBytes(w, h, bpp, block, mips) {
    let n = 0;
    for (let lw = w, lh = h; ; lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) {
        n += block ? (lw / 4) * (lh / 4) * block : lw * lh * bpp;
        if (!mips || (lw === 1 && lh === 1)) return n;
        if (block && ((lw >> 1) % 4 || (lh >> 1) % 4 || !(lw >> 1) || !(lh >> 1))) return n;
    }
}
const UNIFORM_WIDTH = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat4: 16 };

function message(type, body) {
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = type;
    body.copy(m, 5);
    return m;
}

function jsonMessage(obj) {
    return message(JSON_T, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/* A frame message: u32 ref, u64 id, u16 rect count, rects, pixels. */
function frameMessage(ref, id, rects, pixels) {
    const head = 14 + rects.length * 8;
    const body = Buffer.alloc(head + pixels.length);
    body.writeUInt32LE(ref >>> 0, 0);
    body.writeUInt32LE(id % 0x100000000, 4);
    body.writeUInt32LE(Math.floor(id / 0x100000000), 8);
    body.writeUInt16LE(rects.length, 12);
    rects.forEach((r, i) => {
        body.writeUInt16LE(r.x, 14 + i * 8);
        body.writeUInt16LE(r.y, 16 + i * 8);
        body.writeUInt16LE(r.w, 18 + i * 8);
        body.writeUInt16LE(r.h, 20 + i * 8);
    });
    pixels.copy(body, head);
    return message(FRAME_T, body);
}

/* A mesh message: u32 ref, part, vertices, indices, u8 mask, then the
 * float32 arrays and the u16 indices. */
function meshMessage(ref, part, g) {
    const v = g.positions.length / 3;
    const arrays = [g.positions, g.normals, g.texcoords, g.colors].filter((a) => a && a.length);
    const floats = arrays.reduce((n, a) => n + a.length, 0);
    const body = Buffer.alloc(17 + floats * 4 + g.indices.length * 2);
    body.writeUInt32LE(ref >>> 0, 0);
    body.writeUInt32LE(part >>> 0, 4);
    body.writeUInt32LE(v, 8);
    body.writeUInt32LE(g.indices.length, 12);
    body[16] = (g.normals && g.normals.length ? 1 : 0) | (g.texcoords && g.texcoords.length ? 2 : 0) |
        (g.colors && g.colors.length ? 4 : 0);
    let off = 17;
    arrays.forEach((a) => { for (let i = 0; i < a.length; i++, off += 4) body.writeFloatLE(a[i], off); });
    for (let i = 0; i < g.indices.length; i++, off += 2) body.writeUInt16LE(g.indices[i], off);
    return message(MESH_T, body);
}

function flag(v) { return v ? 1 : 0; }

/* A scene edit line's key (../PROTOCOL.md "edit", cr::edit_key): its kind,
 * --show as --hide and --pass-on as --pass-off, and the rest, up to the last
 * '=' for the kinds that take a value. */
const VALUED = ['--uniform', '--move', '--scale', '--rotate', '--viewport', '--set'];
function editKey(line) {
    const sp = line.indexOf(' ');
    let kind = sp < 0 ? line : line.slice(0, sp);
    let rest = sp < 0 ? '' : line.slice(sp + 1);
    if (kind === '--show') kind = '--hide';
    else if (kind === '--pass-on') kind = '--pass-off';
    else if (VALUED.indexOf(kind) >= 0 && rest.lastIndexOf('=') >= 0) rest = rest.slice(0, rest.lastIndexOf('='));
    return kind + ' ' + rest;
}

class ClusterRender extends EventEmitter {
    constructor(app, socketPath) {
        super();
        this.app = app;
        this.path = socketPath || DEFAULT_PATH;
        this.sock = null;
        this.ready = false;
        this.closed = true;
        this.backoff = 0;
        this.timer = null;
        this.layers = new Map();     /* ref -> { kind, opts, uniforms, parts, binds, anims, image, dirty, whole } */
        this.nextRef = 1;
        this.pendingFrames = new Map();   /* ref -> frame message waiting for the socket */
        this.blocked = false;
        this.inbuf = Buffer.alloc(0);
        this.backend = '';
        this.targets = '';
        this.fpsCap = 0;        /* another app's others_fps holding this one's videos (fps_cap); 0: none */
        this.fpsCapApp = '';
        this.hostLayers = false;
        this.layerHosts = new Map();   /* hosts from this app's layers: hosted target -> { into, msg } */
    }

    connect() {
        this.closed = false;
        this._open();
    }

    close() {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.sock) this.sock.destroy();
        this.sock = null;
        this.ready = false;
        this._releaseFpsCap();
    }

    _open() {
        if (this.closed || this.sock) return;
        const sock = net.connect(this.path);
        this.sock = sock;
        this.blocked = false;
        this.connected = false;
        this.inbuf = Buffer.alloc(0);
        sock.on('connect', () => {
            /* Everything made before now goes in the replay below. */
            this.connected = true;
            this._send({ op: 'hello', app: this.app, proto: PROTO });
            /* Assets first, so binds find them; binds and animations once
             * every layer and part is made. */
            [true, false].forEach((assets) => this.layers.forEach((l, ref) => {
                if ((l.kind === 'asset') !== assets) return;
                this._send(this._layerMsg(ref, l));
                if (l.edits.size) this._send({ op: 'edit', ref: ref, lines: Array.from(l.edits.values()).join('\n') });
                l.hosts.forEach((m) => this._send(m));
                l.parts.forEach((p) => {
                    this._send(p.msg);
                    if (p.geometry) this._write(p.geometry);
                    if (p.transform) this._send(p.transform);
                });
                Object.keys(l.uniforms).forEach((k) => this._send(l.uniforms[k]));
                if ((l.kind === 'image' || l.kind === 'asset') && l.have) { l.whole = true; l.dirty = []; l.dirtyBytes = 0; }
            }));
            this.layers.forEach((l) => Object.keys(l.binds).forEach((k) => this._send(l.binds[k].msg)));
            this.layers.forEach((l) => l.anims.forEach((m) => this._send(m)));
        });
        /* A socket close() let go is not this.sock any more: its late events
         * are ignored. */
        sock.on('data', (d) => { if (this.sock === sock) this._data(d); });
        sock.on('drain', () => { if (this.sock === sock) { this.blocked = false; this._pump(); } });
        sock.on('error', () => {});
        sock.on('close', () => {
            if (this.sock !== sock) return;
            const wasReady = this.ready;
            this.sock = null;
            this.ready = false;
            this.connected = false;
            this.pendingFrames.clear();
            this._releaseFpsCap();
            if (wasReady) this.emit('disconnected');
            if (this.closed) return;
            const ms = BACKOFF_MS[Math.min(this.backoff, BACKOFF_MS.length - 1)];
            this.backoff++;
            this.timer = setTimeout(() => { this.timer = null; this._open(); }, ms);
        });
    }

    _data(d) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
        let off = 0;
        while (this.inbuf.length - off >= 5) {
            const len = this.inbuf.readUInt32LE(off);
            if (len < 1 || len > 8 * 1024 * 1024) { this.sock.destroy(); return; }
            if (this.inbuf.length - off < 4 + len) break;
            const type = this.inbuf[off + 4];
            const body = this.inbuf.slice(off + 5, off + 4 + len);
            off += 4 + len;
            if (type !== JSON_T) continue;
            let ev;
            try { ev = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
            this._event(ev);
        }
        this.inbuf = this.inbuf.slice(off);
    }

    _event(ev) {
        if (ev.ev === 'hello') {
            this.backend = ev.backend;
            this.targets = ev.targets;
            this.hostEdge = ev.host_edge === 1;   /* takes a host's edge_* */
            this.preload = ev.preload === 1;      /* knows a layer's preload */
            this.othersFps = ev.others_fps === 1;   /* knows a layer's others_fps */
            this.renderState = ev.render_state === 1;   /* takes blend factors, depth_func, color_mask */
            this.samplers = ev.samplers === 1;   /* takes mipmapped sampling, mirror, wrap_u/v, anisotropy */
            this.hostLayers = ev.host_layers === 1;   /* takes a host from layers (host('panel', ...)) */
            this.ready = true;
            this.backoff = 0;
            /* after the layers, which went at connect */
            if (this.hostLayers) this.layerHosts.forEach((h) => this._send(h.msg));
            this._pump();
            this.emit('ready');
        } else if (ev.ev === 'layer') {
            this.emit('layer', ev.ref, ev.state, ev.reason);
        } else if (ev.ev === 'target') {
            this.emit('target', ev.target, ev.state, ev.holder, ev.reason, ev.guide_disabled === 1, ev.disabled === 1);
        } else if (ev.ev === 'budget') {
            this.emit('budget', ev.cap_kb_per_s, ev.max_kb_per_s, ev.reason);
        } else if (ev.ev === 'fps_cap') {
            this.fpsCap = ev.fps || 0;
            this.fpsCapApp = this.fpsCap ? ev.app || '' : '';
            this.emit('fps_cap', this.fpsCap, this.fpsCapApp);
        } else if (ev.ev === 'error') {
            /* a host refused is not sent again after a reconnect */
            const l = ev.op === 'host' && !ev.into ? this.layers.get(ev.ref) : null;
            if (l && l.hosts) l.hosts.delete(ev.target);
            const lh = ev.op === 'host' && ev.into ? this.layerHosts.get(ev.target) : null;
            if (lh && lh.into === ev.into) this.layerHosts.delete(ev.target);
            this.emit('refused', ev.op, ev.ref, ev.reason, ev.line);
        } else if (ev.ev === 'status') {
            this.emit('status', ev.text);
        } else if (ev.ev === 'host') {
            this.emit('host', ev.target, ev);   /* ev.into empty: not hosted any more */
        }
    }

    /* The connection gone: no other app's request holds this one any more. */
    _releaseFpsCap() {
        if (!this.fpsCap) return;
        this.fpsCap = 0;
        this.fpsCapApp = '';
        this.emit('fps_cap', 0, '');
    }

    _send(obj) { this._write(jsonMessage(obj)); }

    _write(m) {
        if (!this.sock || !this.connected) return;
        if (!this.sock.write(m)) this.blocked = true;
    }

    /* Writes frames while the socket takes them: image changes first, then
     * the newest video frame of each layer. */
    _pump() {
        if (!this.sock || !this.ready) return;
        this.layers.forEach((l, ref) => {
            if (this.blocked || (l.kind !== 'image' && l.kind !== 'asset') || !(l.whole || l.dirty.length)) return;
            const rects = l.whole ? [] : l.dirty;
            let px;
            if (l.whole) {
                px = l.image;
            } else {
                const parts = [];
                rects.forEach((r) => {
                    for (let y = 0; y < r.h; y++) {
                        const start = ((r.y + y) * l.iw + r.x) * l.bpp;
                        parts.push(l.image.slice(start, start + r.w * l.bpp));
                    }
                });
                px = Buffer.concat(parts);
            }
            l.whole = false;
            l.dirty = [];
            l.dirtyBytes = 0;
            if (!this.sock.write(frameMessage(ref, 0, rects, px))) this.blocked = true;
        });
        for (const ref of Array.from(this.pendingFrames.keys())) {
            if (this.blocked) break;
            const m = this.pendingFrames.get(ref);
            this.pendingFrames.delete(ref);
            if (!this.sock.write(m)) this.blocked = true;
        }
    }

    _layerMsg(ref, l) {
        const o = l.opts;
        if (l.kind === 'scene') {
            const m = { op: 'scene', ref: ref, target: o.target, file: o.file, res: (o.res || []).join(' '),
                sha256: [].concat(o.sha256).join(' '), contend: flag(o.contend) };
            if (o.layers) m.layers = 1;
            if (o.layers && o.layers_order !== undefined) m.layers_order = o.layers_order;
            return m;
        }
        if (l.kind === 'asset') {
            const m = { op: 'asset', ref: ref, target: o.target, format: o.format || 'rgba8', w: o.w, h: o.h,
                sampling: o.sampling || 'nearest', wrap: o.wrap || 'clamp' };
            ['wrap_u', 'wrap_v', 'anisotropy'].forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
            return m;
        }
        const m = { op: 'layer', ref: ref, target: o.target, kind: l.kind };
        this._setFields(m, o);
        if (l.kind === 'video') {
            ['vw', 'vh', 'fps', 'level_bits', 'dirty_threshold', 'settle_ms', 'stall_ms'].forEach((k) => {
                if (o[k] !== undefined) m[k] = o[k];
            });
            if (o.pan_blocks !== undefined) m.pan_blocks = flag(o.pan_blocks);
        } else if (l.kind === 'image') {
            m.iw = o.iw;
            m.ih = o.ih;
            if (o.fps !== undefined) m.fps = o.fps;
            if (o.sampling) m.sampling = o.sampling;
        } else if (l.kind === 'mesh') {
            MESH_KEYS.forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
        } else {
            m.fs = o.fs;
            if (o.vs) m.vs = o.vs;
            if (o.time_fps !== undefined) m.time_fps = o.time_fps;
            if (o.time) m.time = 1;
            LOOK_KEYS.forEach((k) => { if (o[k] !== undefined) m[k] = o[k]; });
        }
        return m;
    }

    _setFields(m, o) {
        SET_KEYS.forEach((k) => {
            if (o[k] === undefined) return;
            const key = k === 'klass' ? 'class' : k;
            m[key] = typeof o[k] === 'boolean' ? flag(o[k]) : o[k];
        });
    }

    _uniformMsg(ref, name, v) {
        return { op: 'uniform', ref: ref, name: name, v: v.join(' ') };
    }

    _add(kind, opts) {
        const o = Object.assign({}, opts);
        const l = { kind: kind, opts: o, uniforms: {}, parts: new Map(), binds: {}, anims: new Map(), nextAnim: 1,
            dirty: [], dirtyBytes: 0, whole: false, have: false, edits: new Map(), hosts: new Map() };
        if (kind === 'scene' && !(o.file && [].concat(o.sha256 || []).length === (o.res || []).length + 1)) return 0;
        if (kind === 'image') {
            o.iw = o.iw || o.w;
            o.ih = o.ih || o.h;
            if (!(o.iw > 0 && o.ih > 0 && o.iw <= 1920 && o.ih <= 720)) return 0;
            l.iw = o.iw;
            l.ih = o.ih;
            l.bpp = 4;
        } else if (kind === 'asset') {
            /* etc2rgba: 16 bytes a 4x4 block, etc2rgb: 8; sent whole. */
            const block = o.format === 'etc2rgba' ? 16 : o.format === 'etc2rgb' ? 8 : 0;
            l.compressed = block > 0;
            l.bpp = o.format === 'r8' || l.compressed ? 1 : 4;
            if (!(o.w > 0 && o.h > 0 && o.w <= 2048 && o.h <= 2048)) return 0;
            if (l.compressed && (o.w % 4 || o.h % 4)) return 0;
            /* A compressed asset sampled with mipmaps is sent with every
             * level; the service makes an uncompressed one's. */
            l.bytes = assetBytes(o.w, o.h, l.bpp, block, l.compressed && MIPMAPPED.indexOf(o.sampling) >= 0);
            if (l.bytes > 1920 * 720 * 4) return 0;
            l.iw = o.w;
            l.ih = o.h;
        }
        if (l.bpp) l.image = Buffer.alloc(l.bytes || l.iw * l.ih * l.bpp);
        const ref = this.nextRef++;
        this.layers.set(ref, l);
        if (this.sock) this._send(this._layerMsg(ref, l));
        return ref;
    }

    /* opts: target, klass, z, x, y, w, h, visible, exclusive, prewarm,
     * preload, contend, guide_hold, yield, others_fps, opacity, rotate, sx, sy, px, py, then per kind (see
     * PROTOCOL.md); an image's iw and ih default to its w and h; an
     * effect's time: true takes u_time from the renderer's clock, and its
     * render state blend, blend_src, blend_dst, blend_src_alpha,
     * blend_dst_alpha, blend_op, blend_op_alpha, color_mask (to a service
     * whose hello has render_state; set() changes them). A mesh's:
     * projection, fov, ortho_h, near, far and its camera cx, cy, cz, crx,
     * cry, crz (degrees, right-handed). Returns the layer's ref, 0 when
     * refused. */
    video(opts) { return this._add('video', opts); }
    image(opts) { return this._add('image', opts); }
    effect(opts) { return this._add('effect', opts); }
    mesh(opts) { return this._add('mesh', opts); }
    /* opts: target, format ('rgba8', 'r8'; 'etc2rgba', 'etc2rgb', w and h
     * multiples of 4, its blocks sent whole), w, h (up to 2048), sampling
     * ('nearest', 'bilinear'; with mipmaps, to a service whose hello has
     * samplers: 'nearest_mips', 'bilinear_mips', 'trilinear', and
     * 'min_linear_mag_nearest', 'min_nearest_mag_linear'), wrap ('clamp',
     * 'repeat'; 'mirror'), wrap_u, wrap_v, anisotropy (1-16). Sampled with
     * mipmaps, a compressed asset's frame carries every level after its
     * picture (PROTOCOL.md "Mipmaps"). */
    asset(opts) { return this._add('asset', opts); }
    /* A scene file as the target's scene (PROTOCOL.md "Scene files"): opts
     * target, file (an absolute path), res (its resource files' paths),
     * sha256 (an array of hex SHA-256s: the file's, then each resource
     * file's), contend; layers: true draws the target's layers over the
     * file, layers_order the render order their passes start at. */
    scene(opts) { return this._add('scene', opts); }

    /* The scene (made with layers) hosts another target (PROTOCOL.md
     * "host"): opts target, x, y, w, h (in the scene's target), src_x,
     * src_y, src_w, src_h (in the hosted target's pixels; sent, all four,
     * when src_w and src_h are set, else all of it), shown; edge_top,
     * edge_bottom, edge_fade, edge_dim, edge_blur (the edge drawn on the
     * hosted picture; sent, all five, when edge_top or edge_bottom is set).
     * Kept by target and sent again after a reconnect, until the service
     * refuses it or the scene is replaced; false, nothing sent, for a scene
     * without layers or a host of its own target.
     *
     * With a target's name in place of ref (host('panel', opts)): this
     * app's layers there host opts.target, no scene needed (PROTOCOL.md
     * "Hosting from layers"); the hosted video is drawn under them while
     * one of them is visible. Kept by opts.target, sent to a service whose
     * hello has host_layers 1 (this.hostLayers), now or once one is
     * connected, until unhost() or the service refuses it; false, nothing
     * kept, without opts.target or for that target itself. */
    host(ref, opts) {
        if (typeof ref === 'string') return this._hostFromLayers(ref, opts);
        const l = this.layers.get(ref);
        /* what the service refuses whatever it holds is not sent or kept */
        if (!l || l.kind !== 'scene' || !l.opts.layers || !opts.target || opts.target === l.opts.target) return false;
        const m = this._hostMsg({ op: 'host', ref: ref }, opts);
        l.hosts.set(opts.target, m);
        this._send(m);
        return true;
    }

    _hostFromLayers(into, opts) {
        if (!into || !opts.target || opts.target === into) return false;
        const m = this._hostMsg({ op: 'host', into: into }, opts);
        this.layerHosts.set(opts.target, { into: into, msg: m });   /* into another target: the service moves it */
        /* to an older service nothing: it would refuse it (no such scene) */
        if (this.ready && this.hostLayers) this._send(m);
        return true;
    }

    /* This app's layers host target no more. */
    unhost(target) {
        const h = this.layerHosts.get(target);
        if (!h) return;
        this.layerHosts.delete(target);
        if (this.ready && this.hostLayers) this._send({ op: 'unhost', into: h.into, target: target });
    }

    _hostMsg(m, opts) {
        m.target = opts.target;
        m.x = opts.x;
        m.y = opts.y;
        m.w = opts.w;
        m.h = opts.h;
        m.shown = flag(opts.shown !== false);
        /* the part: all four with src_w and src_h, else none (all of it), as the C++ client */
        if (opts.src_w && opts.src_h) {
            m.src_x = opts.src_x || 0;
            m.src_y = opts.src_y || 0;
            m.src_w = opts.src_w;
            m.src_h = opts.src_h;
        }
        if (opts.edge_top || opts.edge_bottom)
            ['edge_top', 'edge_bottom', 'edge_fade', 'edge_dim', 'edge_blur'].forEach((k) => { m[k] = opts[k] || 0; });
        return m;
    }

    /* Another file for a scene, in place (opts as scene()'s, the target
     * kept): its kept edits go. */
    replace(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'scene' || !opts.file ||
            [].concat(opts.sha256 || []).length !== (opts.res || []).length + 1) return false;
        l.opts = Object.assign({}, opts, { target: l.opts.target });
        l.edits = new Map();
        l.hosts = new Map();   /* the service ends them with the file it replaces */
        this._send(this._layerMsg(ref, l));
        return true;
    }

    /* Edit lines for a scene (PROTOCOL.md "edit"), separated by newlines:
     * kept by their key, each replacing the kept line of its key, and sent
     * again after a reconnect in the order last sent. */
    edit(ref, lines) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'scene') return;
        lines.split('\n').forEach((line) => {
            line = line.replace(/\r$/, '');
            if (!line) return;
            const key = editKey(line);
            l.edits.delete(key);
            l.edits.set(key, line);
        });
        this._send({ op: 'edit', ref: ref, lines: lines });
    }

    set(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind === 'asset' || l.kind === 'scene') return;
        const own = l.kind === 'mesh' ? MESH_KEYS : l.kind === 'effect' ? LOOK_KEYS : [];
        SET_KEYS.concat(l.kind === 'mesh' ? MESH_KEYS : []).forEach((k) => { if (opts[k] !== undefined) l.opts[k] = opts[k]; });
        if (l.kind === 'effect') setLook(l.opts, opts);
        const m = { op: 'set', ref: ref };
        this._setFields(m, opts);
        own.forEach((k) => { if (opts[k] !== undefined) m[k] = opts[k]; });
        this._send(m);
    }

    /* values: 1-4 numbers; or, with opts.type ('float', 'vec2', 'vec3',
     * 'vec4', 'mat4'), whole elements of it, up to 1024 numbers: an array
     * uniform. opts.part: a mesh layer's part. */
    uniform(ref, name, values, opts) {
        const l = this.layers.get(ref);
        const o = opts || {};
        if (!l || !values.length) return;
        const m = this._uniformMsg(ref, name, values);
        if (o.type) {
            const w = UNIFORM_WIDTH[o.type];
            if ((l.kind !== 'effect' && l.kind !== 'mesh') || !w || values.length > 1024 || values.length % w) return;
            m.type = o.type;
        } else if ((l.kind !== 'effect' && l.kind !== 'mesh') || values.length > 4) return;
        if (o.part) m.part = o.part;
        l.uniforms[(o.part || 0) + ':' + name] = m;
        this._send(m);
    }

    /* The effect layer's (or mesh part's) sampler samples the asset. */
    bind(ref, sampler, asset, part) {
        const l = this.layers.get(ref), a = this.layers.get(asset);
        if (!l || !a || a.kind !== 'asset') return;
        const m = { op: 'bind', ref: ref, sampler: sampler, asset: asset };
        if (part) m.part = part;
        l.binds[(part || 0) + ':' + sampler] = { asset: asset, msg: m };
        this._send(m);
    }

    /* A mesh layer's part, numbered from 1: opts vs, fs, depth, cull
     * ('back', 'front', 'none'), blend ('alpha', 'add', 'none'), and, to a
     * service whose hello has render_state, the rest of its render state
     * (PROTOCOL.md "Render state"): blend 'premultiplied', 'max', 'min',
     * 'subtract', blend_src, blend_dst, blend_src_alpha, blend_dst_alpha,
     * blend_op, blend_op_alpha, color_mask, depth_func, depth_write. */
    part(ref, part, opts) {
        const l = this.layers.get(ref);
        if (!l || l.kind !== 'mesh' || !(part > 0) || l.parts.has(part)) return false;
        const m = { op: 'part', ref: ref, part: part, vs: opts.vs, fs: opts.fs };
        if (opts.depth !== undefined) m.depth = flag(opts.depth);
        if (opts.depth_write !== undefined) m.depth_write = flag(opts.depth_write);
        LOOK_KEYS.concat(PART_LOOK_KEYS).forEach((k) => {
            if (opts[k] !== undefined && m[k] === undefined) m[k] = opts[k];
        });
        l.parts.set(part, { msg: m, geometry: null, transform: null });
        this._send(m);
        return true;
    }

    /* g: positions (xyz), normals (xyz), texcoords (uv), colors (rgba) per
     * vertex, the last three optional, and indices (triangles). The service
     * takes a part's new geometry at most once a second. */
    geometry(ref, part, g) {
        const l = this.layers.get(ref);
        const p = l && l.parts.get(part);
        const v = g.positions.length / 3;
        const per = (a, n) => !a || !a.length || a.length === v * n;
        if (!p || !(v >= 1 && v <= 65535 && Number.isInteger(v)) || !per(g.normals, 3) || !per(g.texcoords, 2) ||
            !per(g.colors, 4) || !(g.indices.length >= 3 && g.indices.length % 3 === 0 && g.indices.length <= 196605)) {
            return false;
        }
        for (let i = 0; i < g.indices.length; i++) if (!(g.indices[i] < v)) return false;
        p.geometry = meshMessage(ref, part, g);
        this._write(p.geometry);
        return true;
    }

    /* t: tx, ty, tz, rx, ry, rz (degrees, right-handed), sx, sy, sz.
     * False, and nothing sent, when a value is out of the service's range. */
    transform(ref, part, t) {
        const l = this.layers.get(ref);
        const p = l && l.parts.get(part);
        if (!p) return false;
        const keys = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'].filter((k) => t[k] !== undefined);
        if (!keys.every((k) => typeof t[k] === 'number' && Math.abs(t[k]) <= (k[0] === 'r' ? 36000 : 1000000)))
            return false;
        /* The service merges each transform into the part's pose, so the
         * replay carries every field set so far. */
        p.transform = p.transform || { op: 'transform', ref: ref, part: part };
        keys.forEach((k) => { p.transform[k] = t[k]; });
        this._send(p.transform);
        return true;
    }

    /* opts: part, property ('rotate', 'translate', 'scale', 'uniform'),
     * name (the uniform's), keys ("t:v[,v,v] ..." or [[t, v...], ...], t in
     * ms), loop, interp ('linear', 'step'), anim (a number this returned:
     * that animation replaced). Returns the animation's number, 0 when
     * refused here. */
    animate(ref, opts) {
        const l = this.layers.get(ref);
        if (!l || !opts.property || !opts.keys) return 0;
        const keys = typeof opts.keys === 'string' ? opts.keys
            : opts.keys.map((k) => k[0] + ':' + k.slice(1).join(',')).join(' ');
        /* opts.anim: that animation of the layer's (one animate() returned)
         * replaced, so a needle sent to new values keeps one animation;
         * its first key is where the needle is now. */
        const anim = opts.anim > 0 && l.anims.has(opts.anim) ? opts.anim : l.nextAnim++;
        const m = { op: 'animate', ref: ref, anim: anim, property: opts.property, keys: keys,
            loop: flag(opts.loop), interp: opts.interp || 'linear' };
        if (opts.part) m.part = opts.part;
        if (opts.name) m.name = opts.name;
        l.anims.set(anim, m);
        this._send(m);
        return anim;
    }

    stop(ref, anim) {
        const l = this.layers.get(ref);
        if (!l || !l.anims.delete(anim)) return;
        this._send({ op: 'stop', ref: ref, anim: anim });
    }

    /* A layer or an asset; an asset a layer samples stays (the service
     * refuses it). */
    drop(ref) {
        if (!this.layers.has(ref)) return;
        let sampled = false;
        this.layers.forEach((l) => Object.keys(l.binds).forEach((k) => { sampled = sampled || l.binds[k].asset === ref; }));
        if (!sampled) this.layers.delete(ref);
        this.pendingFrames.delete(ref);
        this._send({ op: 'drop', ref: ref });
    }

    frameBytes(ref) {
        const l = this.layers.get(ref);
        if (!l) return 0;
        if (l.kind === 'video') {
            const w = l.opts.vw || 1088, h = l.opts.vh || 480;
            return w * (h + (h >> 1));
        }
        return l.image ? l.image.length : 0;
    }

    /* A video frame: the whole 4:2:0 atlas. False while not connected. */
    frame(ref, atlas, id) {
        const l = this.layers.get(ref);
        if (!this.ready || !l || l.kind !== 'video' || atlas.length !== this.frameBytes(ref)) return false;
        this.pendingFrames.set(ref, frameMessage(ref, id || 0, [], atlas));
        this._pump();
        return true;
    }

    /* An image or asset update: rects ([{x, y, w, h}]) with their rows
     * packed one rect after another in px, or no rects (null) and the whole
     * image. */
    pixels(ref, rects, px) {
        const l = this.layers.get(ref);
        if (!l || !l.image) return false;
        const iw = l.iw, ih = l.ih, bpp = l.bpp;
        if (l.compressed && rects && rects.length) return false;
        if (!rects || !rects.length) {
            if (px.length !== l.image.length) return false;
            px.copy(l.image);
            l.whole = true;
            l.dirty = [];
            l.dirtyBytes = 0;
        } else {
            let need = 0;
            for (const r of rects) {
                if (!(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= iw && r.y + r.h <= ih)) return false;
                need += r.w * r.h * bpp;
            }
            if (need !== px.length) return false;
            let off = 0;
            for (const r of rects) {
                for (let y = 0; y < r.h; y++) {
                    px.copy(l.image, ((r.y + y) * iw + r.x) * bpp, off, off + r.w * bpp);
                    off += r.w * bpp;
                }
                if (l.whole) continue;
                /* An update of rects (8 bytes of header each) never outgrows
                 * the whole image, which is within the service's message
                 * limit. */
                l.dirtyBytes += r.w * r.h * bpp;
                if (l.dirty.length >= MAX_DIRTY || l.dirtyBytes + 8 * (l.dirty.length + 1) >= l.image.length) {
                    l.whole = true;
                    l.dirty = [];
                    l.dirtyBytes = 0;
                } else l.dirty.push(r);
            }
        }
        l.have = true;
        this._pump();
        return true;
    }

    status() { this._send({ op: 'status' }); }
}

module.exports = { ClusterRender, DEFAULT_PATH };
