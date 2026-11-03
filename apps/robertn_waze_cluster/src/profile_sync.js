// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * profile_sync - the map's display (Cluster or HUD) and HUD size per driver
 * profile. Runs from the app's start, page shown or not.
 *
 * Every POLL_MS it reads the head unit's current user account
 * (de.bmw.infotainment.personalization.SessionManager, field
 * currentUserAccountReference: a getter, no notifier) and, when it changes,
 * tells the patch daemon {"cmd":"profile","id"}. patchd keeps each profile's
 * choice (it records every Show map on / HUD map size press for the profile
 * current then) and answers with the one this profile had, saved for the
 * render's next start; this then moves the running render to it at once
 * ({"cmd":"start","target"}, {"cmd":"hud","hud_width_pct"}): through the
 * page's own render connection while the page is open (it owns the render's
 * control socket), else through a short connection of its own.
 *
 * A profile seen for the first time keeps what is set now. Without the
 * SOME/IP binding or the interface (desk runs, a unit that refuses it) it
 * logs why once and does nothing.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { LineSocket, RENDER_PATH, PATCH_PATH } = require('./waze_cluster_control.js');

const POLL_MS = 5000;
const NATIVE_SOMEIP = 'someip';
const IFACE = 'de.bmw.infotainment.personalization.SessionManager';
const INSTANCE = 'de.bmw.infotainment.personalization.SessionManager';
const FIELD = 'currentUserAccountReference';
/* how long a short render connection stays for its two commands */
const RENDER_HOLD_MS = 800;

/* The interface's SOME/IP config, which the installer generates from
 * manifest.json next to (or above) the app's code. */
function loadConfig(dir) {
    const f = `${IFACE.replace(/\./g, '_')}.json`;
    let d = dir;
    for (let i = 0; i < 5; i++) {
        for (const sub of ['someipInterfaces', 'someipdefs']) {
            try {
                return JSON.parse(fs.readFileSync(path.join(d, sub, f), 'utf8'));
            } catch (e) {
                /* next */
            }
        }
        d = path.dirname(d);
    }
    throw new Error(`no SOME/IP config for ${IFACE}`);
}

/* A reader of the current user account: () -> Promise<string|null>. The
 * native binding is called from a fresh tick, one call at a time (inline,
 * next to the SDK's own traffic, it deadlocks). */
function someipReader(log) {
    let proxy = null;
    let failed = null;
    let chain = Promise.resolve();
    const tick = (fn) => {
        const run = () => new Promise((resolve, reject) => setImmediate(() => {
            try {
                Promise.resolve(fn()).then(resolve, reject);
            } catch (e) {
                reject(e);
            }
        }));
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
    };
    const open = () => {
        if (proxy) return Promise.resolve(proxy);
        if (failed) return Promise.reject(failed);
        let someip;
        try {
            /* the unit's native binding, outside the bundle (by name, so the
             * linker leaves it to the runtime) */
            someip = process.mainModule.require(NATIVE_SOMEIP);
        } catch (e) {
            failed = new Error('no SOME/IP binding');
            return Promise.reject(failed);
        }
        let cfg;
        try {
            cfg = loadConfig(path.dirname(process.mainModule.filename));
        } catch (e) {
            failed = e;
            return Promise.reject(failed);
        }
        return tick(() => someip.buildProxy(cfg, INSTANCE).then((px) => px.init().then(() => px)))
            .then((px) => {
                proxy = px;
                return px;
            }, (e) => {
                failed = e;
                throw e;
            });
    };
    return () => open().then((px) => tick(() => px.getValue(FIELD, 3000))).then((v) => {
        const id = typeof v === 'string' ? v : v && (v.value || v[FIELD]);
        return id ? String(id) : null;
    }, (e) => {
        if (log && !open.logged) {
            open.logged = true;
            log.warn(`driver profiles: ${e && e.message}; the display choice is shared`);
        }
        return null;
    });
}

class ProfileSync extends EventEmitter {
    /* options: control (the page's WazeClusterControl), log, readProfile,
     * patchPath, renderPath, pollMs, retryMs. */
    constructor(options) {
        super();
        const o = options || {};
        this._control = o.control || null;
        this._log = o.log || { info() {}, warn() {} };
        this._read = o.readProfile || someipReader(this._log);
        this._renderPath = o.renderPath || RENDER_PATH;
        this._pollMs = o.pollMs || POLL_MS;
        this._retryMs = o.retryMs;
        this.profile = null;
        this._timer = null;
        this._reading = false;
        this.patch = new LineSocket({
            path: o.patchPath || PATCH_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onPatch(msg)
        });
        /* a restarted daemon has forgotten the profile: tell it again */
        this.patch.on('connect', () => {
            if (this.profile) this.patch.send({ cmd: 'profile', id: this.profile });
        });
    }

    start() {
        this.patch.open();
        this._poll();
    }

    stop() {
        clearTimeout(this._timer);
        this._timer = null;
        this.patch.close();
    }

    _poll() {
        if (this._reading) return;
        this._reading = true;
        Promise.resolve().then(() => this._read()).catch(() => null).then((id) => {
            this._reading = false;
            if (id && id !== this.profile) {
                this._log.info(`driver profile now ${id}`);
                this.profile = id;
                this.patch.send({ cmd: 'profile', id });
                this.emit('profile', id);
            }
            this._timer = setTimeout(() => this._poll(), this._pollMs);
        });
    }

    _onPatch(msg) {
        if (!msg || msg.ev !== 'profile-reply' || !msg.ok || msg.id !== this.profile) return;
        /* the profile's choice, now; a first-seen profile's is what is set */
        if (!msg.known) return;
        const cmds = [{ cmd: 'start', target: msg.target },
            { cmd: 'hud', hud_width_pct: String(msg.hud_width_pct || 0), hud_x: String(msg.hud_x || 0), hud_y: String(msg.hud_y || 0) }];
        const c = this._control;
        if (c && c.render && c.render.connected()) {
            cmds.forEach((m) => c.render.send(m));
        } else {
            const s = new LineSocket({ path: this._renderPath, retryMs: this._retryMs, log: this._log });
            s.on('connect', () => {
                cmds.forEach((m) => s.send(m));
                setTimeout(() => s.close(), RENDER_HOLD_MS);
            });
            s.open();
            /* the render down: its next start reads the saved choice anyway */
            setTimeout(() => s.close(), RENDER_HOLD_MS * 5);
        }
        this.emit('applied', msg);
    }
}

module.exports = { ProfileSync, someipReader, IFACE, INSTANCE, FIELD };
