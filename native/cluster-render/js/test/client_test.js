// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The Node client (../cluster_render_client.js) against the service on the
 * host with fake display backends (test/host_service.cpp): hello; a video
 * layer stalled until its first frame, then shown; an image overlay of a
 * second client in the same target; the stock HMI taking the slot and a
 * contending layer winning it back; the budget event; refusals; an asset
 * sampled by an effect with the renderer's u_time and a uniform array; a
 * mesh layer with a part, its geometry and an animation; the service
 * restarting under the client, whose layers, assets, parts and binds come
 * back by themselves; a synthetic scene file on the panel, shown with the
 * layers there waiting, its edit lines kept by key, a malformed one and one
 * changing nothing reported, and dropped; one with layers, the layers drawn
 * over it, hosting the map, shown and hidden, the other client told, and the
 * host ended when it is dropped; a host from a theme's layers (no scene),
 * kept before the connection and sent after the hello, live while a layer
 * of it is visible (the hosting event saying so, and why not), refused, a
 * refused move ending it on both sides, a host sent after a refused move
 * kept on both, unhosted, kept but not sent to an older service, ended when
 * the theme closes; a layer's hosted mark; a hidden preload layer keeping its target
 * loaded, shown when made visible and loaded again after the linger, made
 * again with preload after the restart, and preload 0 releasing the target;
 * an effect layer's look set with a preset or none, kept as the service
 * keeps it and made again so after the restart;
 * a layer's others_fps holding the other client (fps_cap) and releasing it
 * when set to 0, dropped, or the held client closes; render state and
 * samplers: an effect layer's blending set and changed, a part's depth
 * test, an rgba8 asset whose mip levels the service makes and an etc2rgba
 * one sent with its chain, and a factor the service lacks refused;
 * close() and connect() in one tick making one connection. */
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ClusterRender } = require('../cluster_render_client.js');

const bin = process.argv[2];
const sock = '/tmp/crs-js-test-' + process.pid + '.sock';
let failures = 0;
function ok(name, cond) {
    console.log((cond ? 'ok   ' : 'FAIL ') + name);
    if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) {
    for (let t = 0; t < ms; t += 20) {
        if (cond()) return true;
        await sleep(20);
    }
    return cond();
}

/* Scene files come from here; a synthetic gauge (fake_graph.h FakeFileScene). */
const scenes = fs.mkdtempSync('/tmp/crs-js-scenes-');
const GAUGE = 'scene 0x010004f8\nnode gauge -\nnode needle_pivot gauge\nmesh needle needle_pivot u_color\n' +
    'mesh quad - u_color\n';

function startService() {
    const p = spawn(bin, [sock, scenes], { stdio: ['pipe', 'pipe', 'ignore'] });
    return new Promise((resolve) => p.stdout.once('data', () => resolve(p)));
}

function track(c) {
    const s = { layer: {}, target: {}, holder: {}, refused: [], budget: null, ready: 0, gone: 0 };
    c.on('ready', () => s.ready++);
    c.on('disconnected', () => s.gone++);
    c.on('layer', (ref, state) => { s.layer[ref] = state; });
    c.on('target', (t, state, holder) => { s.target[t] = state; s.holder[t] = holder; });
    c.on('refused', (op, ref, why) => s.refused.push(op + ': ' + why));
    c.on('budget', (cap, max, why) => { s.budget = { cap, max, why }; });
    return s;
}

async function main() {
    let svc = await startService();
    const waze = new ClusterRender('waze', sock), ovl = new ClusterRender('overlay', sock);
    const ew = track(waze), eo = track(ovl);
    waze.connect();
    ovl.connect();
    ok('hello: ready, backend and targets', await until(() => ew.ready && eo.ready, 2000) &&
        waze.backend === 'host' && waze.targets.indexOf('map:1088x480') === 0);
    ok('the budget event: 5500 KB/s of 5500', await until(() => ew.budget, 1000) &&
        ew.budget.cap === 5500 && ew.budget.max === 5500);

    const map = waze.video({ target: 'map', contend: true, stall_ms: 1000 });
    ok('a video layer without frames is stalled', await until(() => ew.layer[map] === 'stalled', 1000));
    const atlas = Buffer.alloc(waze.frameBytes(map), 128);
    ok('a frame of the wrong size is refused here', !waze.frame(map, Buffer.alloc(10), 1));
    const feed = setInterval(() => waze.frame(map, atlas, Date.now()), 40);
    ok('its first frames: shown', await until(() => ew.layer[map] === 'shown' && ew.target.map === 'shown', 2000));

    const badge = ovl.image({ target: 'map', klass: 'overlay', x: 900, y: 400, w: 64, h: 64, iw: 64, ih: 64 });
    ovl.pixels(badge, null, Buffer.alloc(64 * 64 * 4, 255));
    ok('another client\'s overlay in the same target: shown', await until(() => eo.layer[badge] === 'shown', 1000));
    ok('a partial update is accepted', ovl.pixels(badge, [{ x: 0, y: 0, w: 8, h: 8 }], Buffer.alloc(256, 9)));
    ok('one outside the image is not', !ovl.pixels(badge, [{ x: 60, y: 60, w: 8, h: 8 }], Buffer.alloc(256)));

    svc.stdin.write('steal map\n');
    ok('the stock HMI takes the slot: waiting, held by the stock HMI',
        await until(() => eo.layer[badge] === 'waiting' && eo.holder.map === 'stock', 1000));
    ok('the contending video wins it back after 2 s', await until(() => eo.layer[badge] === 'shown', 3500));

    ovl.effect({ target: 'nowhere', fs: 'x' });
    ok('a layer on an unknown target is refused with the reason',
        await until(() => eo.refused.some((r) => r.indexOf('unknown target') >= 0), 1000));

    const font = ovl.asset({ target: 'panel', format: 'r8', w: 64, h: 32, sampling: 'bilinear' });
    ok('an asset takes its pixels', font > 0 && ovl.pixels(font, null, Buffer.alloc(64 * 32, 200)) &&
        ovl.frameBytes(font) === 64 * 32);
    ok('an etc2rgba asset is 4x4 blocks', ovl.asset({ target: 'panel', format: 'etc2rgba', w: 250, h: 8 }) === 0);
    const tex = ovl.asset({ target: 'panel', format: 'etc2rgba', w: 2048, h: 1024 });
    ok('a 2048x1024 one takes its blocks whole, 16 bytes each, and no rects',
        tex > 0 && !ovl.pixels(tex, null, Buffer.alloc(2048 * 1024 - 16)) &&
        !ovl.pixels(tex, [{ x: 0, y: 0, w: 4, h: 4 }], Buffer.alloc(16)) &&
        ovl.pixels(tex, null, Buffer.alloc(2048 * 1024, 7)) && ovl.frameBytes(tex) === 2048 * 1024);
    const opaque = ovl.asset({ target: 'panel', format: 'etc2rgb', w: 2048, h: 1024 });
    ok('an etc2rgb one takes 8 bytes a block', opaque > 0 && !ovl.pixels(opaque, null, Buffer.alloc(2048 * 1024)) &&
        ovl.pixels(opaque, null, Buffer.alloc(1024 * 1024, 7)) && ovl.frameBytes(opaque) === 1024 * 1024);
    const label = ovl.effect({ target: 'panel', klass: 'overlay', x: 40, y: 600, w: 128, h: 64, time: true,
        fs: '#version 100\nprecision mediump float;\nuniform sampler2D u_atlas;\nuniform vec4 u_cells[2];\n' +
            'uniform float u_time;\nvarying vec2 v_uv;\n' +
            'void main(){gl_FragColor=texture2D(u_atlas,v_uv)*u_cells[0]*u_time;}' });
    ovl.bind(label, 'u_atlas', font);
    ovl.uniform(label, 'u_cells', [1, 1, 1, 1, 0, 0, 0, 1], { type: 'vec4' });
    ok('an effect sampling it is shown', await until(() => eo.layer[label] === 'shown', 1000));
    const car = ovl.mesh({ target: 'panel', x: 700, y: 200, w: 400, h: 300, cz: 6 });
    ok('a mesh layer\'s part', ovl.part(car, 1, {
        vs: '#version 100\nattribute vec3 a_position;\nuniform mat4 u_mvp;\n' +
            'void main(){gl_Position=u_mvp*vec4(a_position,1.0);}',
        fs: '#version 100\nprecision mediump float;\nvoid main(){gl_FragColor=vec4(1.0);}' }));
    ok('geometry with an index past its vertices is refused here',
        !ovl.geometry(car, 1, { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] }));
    ok('a mesh layer waits for its geometry', await until(() => eo.layer[car] === 'stalled', 1000));
    ovl.geometry(car, 1, { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] });
    ovl.transform(car, 1, { ry: 30 });
    ovl.transform(car, 1, { tx: 2 });
    const replay = ovl.layers.get(car).parts.get(1).transform;
    ok('transforms merge into what a reconnect replays', replay.ry === 30 && replay.tx === 2);
    ok('a transform out of the service\'s range is refused here and not kept',
        !ovl.transform(car, 1, { ry: 40000 }) && ovl.transform(car, 1, { tz: 1 }) &&
        ovl.layers.get(car).parts.get(1).transform.ry === 30);
    ok('an animation is numbered', ovl.animate(car, { part: 1, property: 'rotate', keys: [[0, 0, 0, 0], [4000, 0, 360, 0]],
        loop: true }) === 1);
    ok('then is shown', await until(() => eo.layer[car] === 'shown', 1000));
    ovl.drop(font);
    ok('an asset an effect samples is not dropped',
        await until(() => eo.refused.some((r) => r === 'drop: asset in use'), 1000));
    let status = '';
    ovl.on('status', (t) => { status = t; });
    ovl.status();
    ok('the status names the asset', await until(() => status.indexOf('asset') >= 0 && status.indexOf('r8 64x32') >= 0, 1000));

    ok('the hello says the service knows preload', ovl.preload === true);
    const pre = ovl.image({ target: 'hud', visible: false, preload: true, w: 32, h: 32, iw: 32, ih: 32 });
    ovl.pixels(pre, null, Buffer.alloc(32 * 32 * 4, 77));
    ok('a hidden preload layer: its target loaded, the layer hidden',
        await until(() => eo.target.hud === 'loaded', 2000) && eo.layer[pre] === 'hidden');
    status = '';
    ovl.status();
    ok('the status names the target loaded', await until(() => status.indexOf('target hud') >= 0, 1000) &&
        /target hud: [^\n]*: loaded/.test(status));
    ovl.set(pre, { visible: true });
    ok('made visible: shown', await until(() => eo.layer[pre] === 'shown' && eo.target.hud === 'shown', 3000));
    ovl.set(pre, { visible: false });
    ok('hidden again: loaded after the linger', await until(() => eo.target.hud === 'loaded', 5000));

    /* An effect layer's look kept as the service keeps it: a preset sent
     * with set replaces custom factors, blend none drops them; both made
     * again so after the restart below. */
    const plain = 'precision mediump float;void main(){gl_FragColor=vec4(1.0);}';
    const custom = { target: 'panel', klass: 'overlay', y: 600, w: 8, h: 8, fs: plain, blend_src: 'one', blend_dst: 'one' };
    const toPre = ovl.effect(Object.assign({ x: 10 }, custom));
    const toNone = ovl.effect(Object.assign({ x: 30 }, custom));
    ovl.set(toPre, { blend: 'premultiplied' });
    ovl.set(toNone, { blend: 'none' });
    const kept = (ref) => ovl._layerMsg(ref, ovl.layers.get(ref));
    ok('look: a preset sent with set drops the custom factors the client keeps',
        kept(toPre).blend === 'premultiplied' && kept(toPre).blend_src === undefined && kept(toPre).blend_dst === undefined);
    ok('look: so does blend none', kept(toNone).blend === 'none' && kept(toNone).blend_src === undefined &&
        kept(toNone).blend_dst === undefined);

    svc.kill();
    await new Promise((r) => svc.once('exit', r));
    ok('the service gone: both clients notice', await until(() => eo.gone === 1 && ew.gone === 1, 1000));
    eo.layer = {};
    ew.layer = {};
    eo.target = {};
    svc = await startService();
    ok('it comes back: both clients reconnect and their layers are shown again',
        await until(() => eo.layer[badge] === 'shown' && ew.layer[map] === 'shown', 5000) && eo.ready >= 2);
    ok('the asset, its effect, the mesh part and its geometry are made again',
        await until(() => eo.layer[label] === 'shown' && eo.layer[car] === 'shown', 2000));
    ok('look: both layers made again with the look set last, shown, neither refused',
        await until(() => eo.layer[toPre] === 'shown' && eo.layer[toNone] === 'shown', 3000) &&
        !eo.refused.some((r) => r.indexOf('blend none takes no') >= 0));
    ovl.drop(toPre);
    ovl.drop(toNone);
    ok('the preload layer is made again with preload: its target loaded',
        await until(() => eo.target.hud === 'loaded', 3000) && eo.layer[pre] === 'hidden');
    ovl.set(pre, { preload: false });
    ok('preload 0: the target released', await until(() => eo.target.hud === 'idle', 2000));

    const file = path.join(scenes, 'gauge.scene');
    fs.writeFileSync(file, GAUGE);
    fs.chmodSync(file, 0o644);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    ok('a scene needs its file and hash', ovl.scene({ target: 'panel', file: file }) === 0);
    const gauge = ovl.scene({ target: 'panel', file: file, sha256: [sha256] });
    ovl.edit(gauge, '--rotate ^needle_pivot$=0,0,30\n--hide ^quad$\r\n');
    ovl.edit(gauge, '--rotate ^needle_pivot$=0,0,45');
    ok('a scene file on the panel: shown, the layers there waiting for it',
        await until(() => eo.layer[gauge] === 'shown' && eo.layer[label] === 'waiting', 3000));
    ok('its edits kept by key, the latest last',
        Array.from(ovl.layers.get(gauge).edits.values()).join('|') === '--hide ^quad$|--rotate ^needle_pivot$=0,0,45');
    ovl.edit(gauge, '--spin x\n--show ^nothing$');
    ok('a malformed line refused, one that changes nothing reported, both named',
        await until(() => eo.refused.some((r) => r.indexOf('edit: \'--spin x\'') === 0) &&
            eo.refused.some((r) => r.indexOf('edit: \'--show ^nothing$\' changed nothing') === 0), 1000));
    ovl.drop(gauge);
    ok('dropped: the layers there shown again', await until(() => eo.layer[label] === 'shown', 3000));
    const hosted = [];
    waze.on('host', (t, ev) => hosted.push(t + ':' + (ev.into || '-') + (ev.into ? ':' + ev.shown + ':' + ev.w : '')));
    const over = ovl.scene({ target: 'panel', file: file, sha256: [sha256], layers: true });
    ok('a scene with layers: shown, the layers there drawn over it',
        await until(() => eo.layer[over] === 'shown' && eo.layer[label] === 'shown', 3000));
    ok('a host needs a scene with layers and another target', !ovl.host(badge, { target: 'map' }) &&
        !ovl.host(over, {}) && !ovl.host(over, { target: 'panel', x: 0, y: 0, w: 10, h: 10 }));
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400, src_x: 264 });
    ok('a part goes with src_w and src_h only, all four (as the C++ client): none here, all of the map',
        !('src_x' in ovl.layers.get(over).hosts.get('map')));
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400, src_x: 264, src_w: 560, src_h: 400, src_y: 40 });
    const sent = ovl.layers.get(over).hosts.get('map');
    ok('with them, all four', sent.src_x === 264 && sent.src_y === 40 && sent.src_w === 560 && sent.src_h === 400);
    ok('no edge unless edge_top or edge_bottom is set; the hello says the service takes one', !('edge_fade' in sent) &&
        ovl.hostEdge === true);
    ok('it hosts the map: the other client told', await until(() => hosted.indexOf('map:panel:1:560') >= 0, 2000));
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400, edge_top: 40, edge_blur: 9 });
    const edged = ovl.layers.get(over).hosts.get('map');
    ok('an edge: all five sent, kept', edged.edge_top === 40 && edged.edge_bottom === 0 && edged.edge_fade === 0 &&
        edged.edge_dim === 0 && edged.edge_blur === 9);
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400, src_x: 264, src_w: 560, src_h: 400, src_y: 40, edge_top: 40, edge_blur: 33 });
    ok('an edge out of range refused', await until(() =>
        eo.refused.some((r) => r.indexOf('host: edge_blur must be a number from 0 to 32') === 0), 2000));
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400, src_x: 264, src_w: 560, src_h: 400, src_y: 40 });
    ok('hosted again', await until(() => hosted[hosted.length - 1] === 'map:panel:1:560', 2000));
    ovl.host(over, { target: 'map', x: 1800, y: 160, w: 560, h: 400 });
    ok('a host refused: the client forgets it, the service ends it', await until(() =>
        !ovl.layers.get(over).hosts.has('map') && hosted[hosted.length - 1] === 'map:-' &&
        eo.refused.some((r) => r.indexOf('host: x, y, w, h must lie inside panel') === 0), 2000));
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400, shown: false });
    ok('hidden: told', await until(() => hosted.indexOf('map:panel:0:560') >= 0, 2000));
    ovl.replace(over, { target: 'panel', file: file, sha256: [sha256], layers: true });
    ok('the file replaced: its hosts forgotten and ended', ovl.layers.get(over).hosts.size === 0 &&
        await until(() => hosted[hosted.length - 1] === 'map:-', 2000));
    ovl.host(over, { target: 'map', x: 700, y: 160, w: 560, h: 400 });
    ok('hosted again', await until(() => hosted[hosted.length - 1] === 'map:panel:1:560', 2000));
    ovl.drop(over);
    ok('dropped: the map not hosted any more', await until(() => hosted[hosted.length - 1] === 'map:-', 2000));

    /* A host from layers: a theme drawing the panel with layers only. */
    const thm = new ClusterRender('theme', sock), et = track(thm);
    const hostingThm = [];
    thm.on('hosting', (t, ev) => hostingThm.push(t + ':' + ev.state + (ev.reason ? ':' + ev.reason : '')));
    const sentByThm = [];
    const send = thm._send.bind(thm);
    thm._send = (m) => { sentByThm.push(m); send(m); };
    ok('layer host: kept before the connection, nothing sent yet',
        thm.host('panel', { target: 'map', x: 700, y: 160, w: 560, h: 400 }) && sentByThm.length === 0);
    thm.connect();
    ok('layer host: needs a target other than its own', !thm.host('panel', {}) && !thm.host('panel', { target: 'panel' }));
    ok('layer host: the hello says the service takes it; sent after the hello, with into and no ref',
        await until(() => et.ready === 1, 2000) && thm.hostLayers === true &&
        sentByThm.some((m) => m.op === 'host' && m.into === 'panel' && !('ref' in m)));
    ok('layer host: no visible layer of the theme on the panel yet: the map not hosted',
        hosted[hosted.length - 1] === 'map:-');
    /* an effect: the overlay's assets above leave no pixel memory for a whole-panel image */
    const art = thm.effect({ target: 'panel', fs: '#version 100\nvoid main(){gl_FragColor=vec4(0.0);}' });
    ok('layer host: its layer shown: the map hosted in the panel, the other client told, the theme told it is live',
        await until(() => et.layer[art] === 'shown' && hosted[hosted.length - 1] === 'map:panel:1:560', 3000) &&
        await until(() => hostingThm[hostingThm.length - 1] === 'map:live', 2000));
    thm.set(art, { visible: false });
    ok('layer host: its only layer hidden: not hosted, the theme told why',
        await until(() => hosted[hosted.length - 1] === 'map:-', 2000) &&
        await until(() => hostingThm[hostingThm.length - 1] === 'map:waiting:no layer of the client is drawn over its rect on panel', 2000));
    thm.set(art, { visible: true });
    ok('layer host: shown again: hosted again',
        await until(() => hosted[hosted.length - 1] === 'map:panel:1:560', 2000));
    thm.host('panel', { target: 'map', x: 1800, y: 160, w: 560, h: 400 });
    ok('layer host: refused: the client forgets it, the service ends it', await until(() =>
        !thm.layerHosts.has('map') && hosted[hosted.length - 1] === 'map:-' &&
        et.refused.some((r) => r.indexOf('host: x, y, w, h must lie inside panel') === 0), 2000));
    thm.host('panel', { target: 'map', x: 700, y: 160, w: 560, h: 400, edge_top: 30 });
    ok('layer host: hosted again, with an edge',
        await until(() => hosted[hosted.length - 1] === 'map:panel:1:560', 2000) &&
        thm.layerHosts.get('map').msg.edge_top === 30);
    thm.host('nowhere', { target: 'map', x: 700, y: 160, w: 560, h: 400 });
    ok('layer host: a move to an unknown target refused: the service ends the host, the client forgets it', await until(() =>
        !thm.layerHosts.has('map') && hosted[hosted.length - 1] === 'map:-' &&
        et.refused.some((r) => r.indexOf('host: unknown target nowhere') === 0), 2000));
    thm.host('panel', { target: 'map', x: 700, y: 160, w: 560, h: 400 });
    await until(() => hosted[hosted.length - 1] === 'map:panel:1:560', 2000);
    /* a refused move and, before its refusal comes, a host into the panel
     * again: the service ends the first and takes the second; the client
     * keeps the second */
    const refusedMove = et.refused.length;
    thm.host('nowhere', { target: 'map', x: 700, y: 160, w: 560, h: 400 });
    thm.host('panel', { target: 'map', x: 704, y: 160, w: 560, h: 400 });
    ok('layer host: a host sent after a refused move is kept by the client and taken by the service', await until(() =>
        et.refused.length > refusedMove && hosted[hosted.length - 1] === 'map:panel:1:560', 2000) &&
        thm.layerHosts.has('map') && thm.layerHosts.get('map').into === 'panel' &&
        thm.layerHosts.get('map').msg.x === 704);
    const marked = thm.video({ target: 'panel', hosted: 'map', vw: 64, vh: 32 });
    ok('layer host: a layer\'s hosted mark is sent', sentByThm.some((m) => m.op === 'layer' && m.ref === marked &&
        m.hosted === 'map'));
    thm.drop(marked);
    thm.unhost('map');
    ok('layer host: unhost: not hosted, forgotten', await until(() => hosted[hosted.length - 1] === 'map:-', 2000) &&
        !thm.layerHosts.has('map') && sentByThm.some((m) => m.op === 'unhost' && m.into === 'panel' && m.target === 'map'));
    const liveBefore = hostingThm.length;
    thm.host('panel', { target: 'map', x: 700, y: 160, w: 560, h: 400 });
    ok('layer host: hosted again after unhost: told it is live again', await until(() =>
        hosted[hosted.length - 1] === 'map:panel:1:560' && hostingThm.length > liveBefore &&
        hostingThm[hostingThm.length - 1] === 'map:live', 2000));
    /* An older service (its hello without host_layers): kept, nothing sent. */
    const n = sentByThm.length;
    thm._event({ ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720' });
    thm.host('panel', { target: 'map', x: 700, y: 160, w: 560, h: 400, shown: false });
    thm.unhost('hud');
    ok('layer host: to an older service nothing is sent, the host kept',
        thm.hostLayers === false && sentByThm.length === n && thm.layerHosts.has('map'));
    thm._event({ ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720', host_layers: 1 });
    ok('layer host: a service that takes it: the kept host sent',
        sentByThm.length === n + 1 && sentByThm[n].op === 'host' && sentByThm[n].shown === 0);
    await until(() => hosted[hosted.length - 1] === 'map:panel:0:560', 2000);
    thm.host('panel', { target: 'map', x: 700, y: 160, w: 560, h: 400 });
    ok('layer host: shown', await until(() => hosted[hosted.length - 1] === 'map:panel:1:560', 2000));
    thm.close();
    ok('layer host: the theme closed: the map not hosted', await until(() => hosted[hosted.length - 1] === 'map:-', 2000));

    /* others_fps: the overlay's layer asks for the others' bandwidth. */
    const caps = [];
    waze.on('fps_cap', (fps, app) => caps.push(fps + ':' + app));
    ok('the hello says the service knows others_fps', ovl.othersFps === true && waze.othersFps === true);
    const ask = ovl.image({ target: 'panel', klass: 'overlay', others_fps: 20, w: 16, h: 16, iw: 16, ih: 16 });
    ovl.pixels(ask, null, Buffer.alloc(16 * 16 * 4, 255));
    ok('shown with others_fps 20: the other client told who asks, the asking one nothing',
        await until(() => waze.fpsCap === 20, 3000) && waze.fpsCapApp === 'overlay' && ovl.fpsCap === 0 &&
        caps.join() === '20:overlay');
    ovl.set(ask, { others_fps: 0 });
    ok('others_fps 0: released', await until(() => waze.fpsCap === 0, 2000) && caps.join() === '20:overlay,0:');
    ovl.set(ask, { others_fps: 20 });
    const held = await until(() => waze.fpsCap === 20, 2000);
    ovl.drop(ask);
    ok('dropped: released', held && await until(() => waze.fpsCap === 0, 2000));
    const ask2 = ovl.image({ target: 'panel', klass: 'overlay', others_fps: 20, w: 16, h: 16, iw: 16, ih: 16 });
    ovl.pixels(ask2, null, Buffer.alloc(16 * 16 * 4, 255));
    const again = await until(() => waze.fpsCap === 20, 3000);
    const before = caps.length;
    waze.close();
    ok('the held client closing: released here, told 0', again && waze.fpsCap === 0 && caps.length === before + 1 &&
        caps[caps.length - 1] === '0:');
    waze.connect();
    ok('connected again: held again', await until(() => waze.fpsCap === 20, 3000));
    ovl.drop(ask2);
    ok('the request dropped: released', await until(() => waze.fpsCap === 0, 2000));

    /* Render state and samplers (PROTOCOL.md "Render state", "Mipmaps"). */
    const refusedBefore = eo.refused.length;
    ok('render state: the hello says the service takes render state and samplers',
        ovl.renderState === true && ovl.samplers === true);
    const dial = ovl.asset({ target: 'panel', w: 64, h: 32, sampling: 'trilinear', wrap: 'repeat', wrap_u: 'mirror',
        anisotropy: 4 });
    ovl.pixels(dial, null, Buffer.alloc(64 * 32 * 4, 200));
    const sheet = ovl.asset({ target: 'panel', format: 'etc2rgba', w: 16, h: 8, sampling: 'bilinear_mips' });
    const chain = (8 + 2) * 16;   /* 16x8 and 8x4: the levels of whole blocks */
    ovl.pixels(sheet, null, Buffer.alloc(chain, 7));
    const glow = ovl.effect({ target: 'panel', klass: 'overlay', x: 0, y: 0, w: 64, h: 32, blend: 'premultiplied',
        color_mask: 'rgb', fs: 'precision mediump float;uniform sampler2D u_dial;varying vec2 v_uv;' +
            'void main(){gl_FragColor=texture2D(u_dial,v_uv);}' });
    ovl.bind(glow, 'u_dial', dial);
    const gear = ovl.mesh({ target: 'panel', x: 100, y: 0, w: 200, h: 200, cz: 5 });
    ovl.part(gear, 1, { vs: 'attribute vec3 a_position;uniform mat4 u_mvp;void main(){gl_Position=u_mvp*vec4(a_position,1.0);}',
        fs: 'void main(){gl_FragColor=vec4(1.0);}', depth_func: 'greater', depth_write: false, blend: 'max' });
    ovl.geometry(gear, 1, { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] });
    ok('render state: the effect layer and the part shown', await until(() => eo.layer[glow] === 'shown' &&
        eo.layer[gear] === 'shown', 3000));
    ovl.set(glow, { blend: 'subtract', color_mask: 'rgba' });
    const a1 = ovl.animate(glow, { property: 'rotate', keys: '0:0 1000:90' });
    const a2 = ovl.animate(glow, { property: 'rotate', keys: '0:90 1000:45', anim: a1 });
    const a3 = ovl.animate(glow, { property: 'rotate', keys: '0:0 1000:45', anim: 99 });
    ok('render state: an animation replaced by its number, an unknown number a new one',
        a1 > 0 && a2 === a1 && a3 !== a1 && ovl.layers.get(glow).anims.size === 2 &&
        ovl.layers.get(glow).anims.get(a1).keys === '0:90 1000:45');
    status = '';
    ovl.status();
    ok('render state: the assets with their mip levels', await until(() => status.indexOf('64x32 (7 mip levels)') >= 0, 1000) &&
        status.indexOf('etc2rgba 16x8 (2 mip levels)') >= 0);
    ok('render state: nothing refused', eo.refused.length === refusedBefore);
    const bad = ovl.effect({ target: 'panel', fs: 'void main(){}', blend_dst: 'one_minus_src_color' });
    ok('render state: a factor the service lacks refused',
        await until(() => eo.refused.some((r) => r.indexOf('layer: blend_dst must be') === 0), 1000));
    [glow, gear, bad, dial, sheet].forEach((r) => ovl.drop(r));
    eo.refused.length = refusedBefore;   /* the bad one's refusal, expected */

    clearInterval(feed);
    ok('frames stopping: the video is stalled after its stall time',
        await until(() => ew.layer[map] === 'stalled', 3000));
    let opens = 0;
    const open = waze._open.bind(waze);
    waze._open = () => { opens++; open(); };
    waze.close();
    waze.connect();   /* in the same tick: the old socket's close comes later */
    await sleep(750);
    ok('closed and connected again at once: one connection, ready', opens === 1 && waze.ready && waze.sock);
    waze.close();
    ovl.close();
    svc.kill();
    try { fs.unlinkSync(sock); } catch (e) { /* the service removed it */ }
    fs.unlinkSync(file);
    fs.rmdirSync(scenes);
    console.log(failures ? failures + ' FAILED' : 'all ok');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
