#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd — the root helper that applies and reverts the carplay patch when the
 * iDrive app asks, so no shell is needed. It is the same model as
 * mgu-updater: a root daemon on a /dev/shm socket (root:tm_oap_app, 0660) that
 * the unprivileged app drives.
 *
 * It does two privileged things. On an apply/revert request it runs the vetted,
 * reversible carplay_patch.js (which refuses an unknown binary and keeps a
 * verified backup), with / remounted read-write only for the write. The new
 * binary takes effect when carplay next starts: patchd restarts carplay only
 * when recmgr loaded a carplay restart entry this boot and systemd loaded the
 * tool's carplay.service drop-in (restartCarplay), else at the next head-unit
 * start. It applies no patch on its own. Explicit
 * capture commands go to a separately supervised DLT helper; reading logs does
 * not change tracing mode.
 *
 * Protocol (newline-delimited JSON, one object per line):
 *   app -> patchd  {"cmd":"status"}
 *                  {"cmd":"apply","panel":"high"|"mid","mode":"fifo"|"udp"|"avb"}
 *                    all modes apply the variant gate + self-start; they differ
 *                    only in the sink. avb = stock avb:// sink (the mode the app
 *                    applies; the render joins the media bus); udp = udp://
 *                    stream sink (the bridge accepts a stream where it rejects a
 *                    file); fifo = file:// FIFO sink
 *                  {"cmd":"revert"}
 *                  {"cmd":"aa-apply"} | {"cmd":"aa-revert"}   the Android Auto patch
 *                  {"cmd":"aa-density","value":n} | {"cmd":"aa-card","value":"shown"|"hidden"}
 *                                   save the choice and, with the patch on disk,
 *                                   apply it (one change per DENSITY_SPACING_MS)
 *                  {"cmd":"reboot"} activate a deferred patch with a normal
 *                                   head-unit restart through NSM (so carplay
 *                                   and aapd next start from the patched
 *                                   binaries). Only while a change, CarPlay's
 *                                   or Android Auto's, is pending; never
 *                                   stops/restarts carplay or aapd.
 *                                   reboot-reply carries ok/reason.
 *                  {"cmd":"logs"}   carplay + marker + avb log lines, dlt-receive health, patchd log
 *                                   (to the asker, read-only)
 *                  {"cmd":"target","target":"map"|"hud"}
 *                                   where the map goes from the next start of the
 *                                   render on: written as "target = ..." into
 *                                   waze-on-cluster.local.conf (the app moves the
 *                                   running render itself with its start command).
 *                                   target-reply carries ok/target/reason
 *                  {"cmd":"profile","id":"<user account>"}
 *                                   the driver profile now: profile-reply carries
 *                                   ok/id/known/target/hud_width_pct, that
 *                                   profile's saved choice (saved as the next
 *                                   start's too) or, first seen, the current one;
 *                                   target and hud-size are kept per profile
 *                  {"cmd":"hud-size","hud_width_pct":0|20..85}
 *                                   the HUD map's size, saved the same way as
 *                                   "hud_width_pct = ..." (0: the default box);
 *                                   hud-size-reply carries ok/hud_width_pct/reason
 *                  {"cmd":"capture-start"|"capture-stop"|"capture-status"}
 *                                   (capture-reply to the asker; every client gets
 *                                   ev capture, also once a second)
 *   patchd -> app  {"ev":"status","state":...,"panel":...,"mode":...,"res":...,"safe":...,"reason":...,"carplay":...,
 *                   "pending":...,"conflict":...,"busy":...,"restart":...,"aa":...}
 *                    state: original | patched | unknown | busy | error
 *                    mode (when patched): fifo | udp | avb
 *                    res, safe (when the IC_HIGH geometry is patched): the
 *                    advertised size "WxH" and its safe area "WxH+X+Y", else null
 *                    carplay (after an apply/revert that changed the binary):
 *                    restarted | deferred (takes effect at the next head-unit
 *                    start; state is unknown with that reason until then)
 *                    pending: apply | revert, while a written change waits for
 *                    the next head-unit start (carplay is then deferred)
 *                    aa: Android Auto's patch, {state, reason, conflict, pending,
 *                    aapd (restarted | deferred), dpi and diskCard (on disk),
 *                    runDpi and runCard (while pending: what aapd runs until
 *                    the next start, null for no patch), density and card
 *                    (chosen), densities [min, max, step], changeAt (while a
 *                    density or card change is refused: when one is taken
 *                    again), error (why the last Android Auto change failed)}
 *                    busy: carplay | aa | restart while an operation runs, else null
 *                    restart: {state: idle | restarting | failed, code (when
 *                    failed: refused, stayed or error), reason, possibleAt
 *                    (while the restart limit holds: when one is taken again)}
 *                    recovered: n, while the original boot recovery restored
 *                    after n failed head-unit starts is on disk (also in aa)
 *                    conflict: why the patch is not applied when the tool is
 *                    installed (a head unit that refuses our parts: "not
 *                    supported on this car (head unit: ...)"; a binary the
 *                    patcher cannot patch, one something else modified, a
 *                    build outside the patcher's proven list that CarPlay's
 *                    Patch button has not patched yet, a carplay.service
 *                    that starts another program)
 *                  {"ev":"refused","cmd":...,"reason":...}   to the asker: a command
 *                                   not taken (another operation runs, the
 *                                   spacing between changes, a bad value, an
 *                                   apply on a head unit that refuses it)
 *                  {"ev":"log","line":...}   the backlog on connect, then each new line
 *
 * Install-time activation (the deploy tool's activate and deactivate hooks,
 * run as root once a version is in place and before it is removed):
 *
 *   patchd.js activate     applies what CarPlay's Patch button applies to an original or
 *                          an older patch of ours, unless the user reverted
 *                          it or a conflict stands; writes only, never stops
 *                          or restarts carplay: the change waits for the next
 *                          head-unit start (pending apply). Once per unit, on
 *                          HIGH F, it also applies it to the original our
 *                          trusted backup holds (highfReset)
 *   patchd.js deactivate   reverts our patch the same way (pending revert)
 *                          and drops our backup
 *
 * Each prints a JSON line last: "status" what it did, "reboot" why a head-unit
 * start is needed. It exits non-zero only when it changed nothing and could
 * not do its job (the install is then rolled back, the removal refused); a
 * refusal of the patcher to touch a binary it does not know is a conflict,
 * not a failure.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var net = require('net');
var path = require('path');
var cp = require('child_process');

var lock = require('./remount_lock.js');
var bootIds = require('./boot_id.js');
var headUnit = require('./head_unit.js');
var record = require('./patch_record.js');

var HERE = __dirname;
var PATCHER = path.join(HERE, 'carplay_patch.js');
var TARGET = process.env.WOC_CARPLAY || '/usr/bin/carplay';
var FIFO = process.env.WOC_FIFO || '/run/waze-on-cluster/alt.h264';
/* The local UDP sink for udp mode. Must match the render's udp_port
 * (waze-on-cluster.conf); the render listens on 127.0.0.1:UDP_PORT. */
var UDP_PORT = process.env.WOC_UDP_PORT || '20557';
var HUD_MAX_PCT = 85;   /* the widest HUD map size: wider is cut off at the HUD's edges */
var SOCK = process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock';
var SOCK_GROUP = process.env.WOC_PATCH_GROUP || 'tm_oap_app';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';

var AA_PATCHER = path.join(HERE, 'aapd_patch.js');
var AAPD = process.env.WOC_AAPD || '/usr/bin/aapd';
var AAPD_CONF = process.env.WOC_AAPD_CONF || '/etc/aapd.conf';
var CODING = process.env.WOC_CODING || '/dev/shm/rawcodingdata';
var aapdConf = require('./aapd_conf.js');
/* The density the owner chose for Android Auto, and the head-unit restarts
 * asked for, kept across updates. */
var STATE_DIR = process.env.WOC_STATE_DIR || '/var/opt/waze-on-cluster';
var AA_DPI_FILE = path.join(STATE_DIR, 'aa-density');
var AA_CARD_FILE = path.join(STATE_DIR, 'aa-card');
/* With the turn card hidden, the crop waze-on-cluster.service passes to the
 * render (EnvironmentFile): the card's rows grow with the density. The
 * shipped waze-on-cluster.conf holds the crop for the card shown. */
var AA_CROP_ENV = path.join(STATE_DIR, 'aa-crop.env');
var REBOOTS_FILE = path.join(STATE_DIR, 'reboots.json');
/* The targets the HIGH F reset is done with (highfReset): { carplay, aa },
 * each "applied", "left" or "user". */
var HIGHF_MARKER = path.join(STATE_DIR, 'highf-repatched');
/* The boot a restart was asked for in: boot recovery takes the end of that
 * boot for an orderly one. */
var RESTART_FILE = path.join(STATE_DIR, 'restart-requested');
/* A density or turn-card change rewrites aapd.conf on / and can restart
 * aapd: at most one per DENSITY_SPACING_MS. A head-unit restart at most one per
 * REBOOT_SPACING_MS, across patchd restarts too. */
var DENSITY_SPACING_MS = parseInt(process.env.WOC_DENSITY_SPACING_MS, 10) || 10000;
var REBOOT_SPACING_MS = 10 * 60 * 1000;
/* The deploy tool SIGKILLs a hook after 120 s (mgu-deploy hookTimeoutMs).
 * A hook ends by HOOK_DEADLINE_MS: every command it runs is cut to what is
 * left, keeping RO_RESERVE_MS for putting / back read-only, and Android
 * Auto's step starts only with AA_HOOK_MIN_MS left. */
var HOOK_DEADLINE_MS = parseInt(process.env.WOC_HOOK_DEADLINE_MS, 10) || 105000;
var RO_RESERVE_MS = 22000;
var AA_HOOK_MIN_MS = 40000;
var hookDeadline = 0;
function tmo(ms) { return hookDeadline ? Math.max(1000, Math.min(ms, hookDeadline - Date.now() - RO_RESERVE_MS)) : ms; }
function roTmo(ms) { return hookDeadline ? Math.max(1000, Math.min(ms, hookDeadline - Date.now())) : ms; }
/* A user's change waits this long for the shared remount lock, then gives
 * up: nothing writes / without it. */
var OP_LOCK_WAIT_MS = parseInt(process.env.WOC_OP_LOCK_WAIT_MS, 10) || 15000;

var clients = [];
var logLines = [];
var busy = null;             /* the target an operation runs for: 'carplay' | 'aa' */
var rebooting = false;       /* a reboot was requested; ignore further requests */
var quitting = false;        /* SIGTERM: finish the active patch operation */
var lastDensityAt = -Infinity;
var aaError = null;          /* why the last Android Auto change failed, until one succeeds */
var restartFail = null;      /* the last restart that failed: {code, reason}, until the next is taken */

/* A deferred patch is activated by a normal head-unit restart, which makes
 * carplay and aapd start from the patched binaries. Never a systemctl
 * stop/restart of either (that power-cycles the unit via the crash
 * handler). The restart is the Node State Manager's, the request the HMI's
 * own restart sends (reason 7, Application; a normal shutdown), so every
 * shutdown client gets its shutdown event; systemd's reboot stops BMW's
 * services by their KillSignal (SIGABRT for many). nsm_control exits 0
 * also when NSM did not take the request, and then prints
 * "[Error. <why>]". */
var REBOOT_CMD = (process.env.WOC_REBOOT_CMD || '/usr/bin/nsm_control --requestRestart 7 --normal').split(' ');
var REBOOT_CMD_TIMEOUT_MS = 30000;
/* A restart NSM took that has not taken the unit down by then failed. */
var REBOOT_WAIT_MS = parseInt(process.env.WOC_REBOOT_WAIT_MS, 10) || 180000;
/* The unit's own render settings, which updates keep: the display choice
 * (Cluster, HUD, both) is saved there as the render's "target". */
var LOCAL_CONF = process.env.WOC_LOCAL_CONF || '/var/opt/waze-on-cluster/waze-on-cluster.local.conf';
/* one or the other: the cluster or the HUD */
var DISPLAY_TARGETS = ['map', 'hud'];
/* The display choice and HUD map size per driver profile (the app reports the
 * head unit's current user account): { "<account>": { target, hud_width_pct } }.
 * Each change of either is kept for the profile current at the time; a
 * profile seen again gets its own back. */
var PROFILES_FILE = process.env.WOC_PROFILES || path.join(path.dirname(LOCAL_CONF), 'profiles.json');
var currentProfile = null;

/* Writes key = value into the local conf, replacing any line of that key;
 * the other lines stay as they are. Atomic: a temporary file renamed over it. */
function saveSetting(key, value, done) {
    var lines = [];
    try { lines = fs.readFileSync(LOCAL_CONF, 'utf8').split('\n'); } catch (e) { if (e.code !== 'ENOENT') { done(e); return; } }
    var re = new RegExp('^\\s*' + key + '\\s*=');
    lines = lines.filter(function (l) { return !re.test(l); });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(key + ' = ' + value);
    var tmp = LOCAL_CONF + '.tmp';
    try {
        fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 420 });
        fs.renameSync(tmp, LOCAL_CONF);
    } catch (e) { done(e); return; }
    done(null);
}
/* The local conf's value of key, or undefined. */
function readSetting(key) {
    var text = '';
    try { text = fs.readFileSync(LOCAL_CONF, 'utf8'); } catch (e) { return undefined; }
    var m = new RegExp('^\\s*' + key + '\\s*=\\s*(\\S*)\\s*$', 'm').exec(text);
    return m ? m[1] : undefined;
}
function readProfiles() {
    try { var p = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); return p && typeof p === 'object' ? p : {}; } catch (e) { return {}; }
}
function writeProfiles(p) {
    var tmp = PROFILES_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(p) + '\n', { mode: 420 }); fs.renameSync(tmp, PROFILES_FILE); } catch (e) { log('saving the profiles failed: ' + e.message); }
}
/* The current settings, as the render starts with them. */
function currentSettings() {
    var t = readSetting('target'), pct = Number(readSetting('hud_width_pct'));
    return { target: DISPLAY_TARGETS.indexOf(t) >= 0 ? t : 'map', hud_width_pct: isFinite(pct) ? Math.min(pct, HUD_MAX_PCT) : 0 };
}
/* A change of key kept for the current profile too. */
function rememberForProfile(key, value) {
    if (!currentProfile) return;
    var p = readProfiles();
    var e = p[currentProfile] || currentSettings();
    e[key] = value;
    p[currentProfile] = e;
    writeProfiles(p);
}
var statusInFlight = false;  /* coalesce the carplay_patch status spawns */
var MAX_LINE = 64 * 1024;    /* drop a client that floods without a newline */

/* A ring of recent carplay log lines (carplay.service's journal and, by marker,
 * DLT), so the remote diagnostic endpoint can say why "no map" happened without
 * an HMI screenshot. The lines that matter are flagged (the verified carplay
 * 22.28.3 strings; on DLT any app's line with one of them counts). */
var CARPLAY_RING = 600;
var carplayLines = [];
/* The marker lines alone, in their own ring, so the few projection-config
 * markers are not evicted from carplayLines by journal volume over a long
 * capture window before the diagnostics are pulled. */
var MARKER_RING = 500;   /* generous: markers are small, and some patterns are broad */
var markerLines = [];
function pushCarplay(entry) {
    carplayLines.push(entry);
    if (carplayLines.length > CARPLAY_RING) carplayLines.shift();
    if (entry.marker) {
        markerLines.push(entry);
        if (markerLines.length > MARKER_RING) markerLines.shift();
    }
}
var CARPLAY_MARKERS = [
    /* start() preconditions: the variant gate and the advert run only after
     * ConfigCollector has every required property and configInitialized fires;
     * without these lines the gate/advert lines below never appear. */
    'Not all required properties present',                         /* ConfigCollector waiting */
    'configInitialized',                                            /* start() about to run */
    'setupDisplaysConfiguration',                                  /* the /info advert builder */
    'Kombi variant is =',                                           /* Edit 1 took effect */
    'Head-Unit does not support Alternate Displays feature.',       /* patch not active */
    'Adding display:',                                              /* 2 = alt display advertised */
    'The provided IC variant does not support 2nd video screen',    /* ICSafeArea refused */
    'Resolution =',                                                 /* ICSafeArea built a config */
    'Alternate Displays feature not supported by Mobile Device.',   /* the phone declined */
    'Projection Bridge successfully configured',                   /* sink accepted */
    'Projection Bridge configuration failed',                      /* sink rejected/open failed */
    'ShowUI', 'instrumentcluster', 'StopUI', 'ForceKeyframe', 'setStreamStatus',
];
function isMarker(line) {
    for (var i = 0; i < CARPLAY_MARKERS.length; i++)
        if (line.indexOf(CARPLAY_MARKERS[i]) >= 0) return true;
    return false;
}

/* AVB log lines (the streamhandler's journal and, by marker, DLT), for the "avb"
 * test mode (stock sink): does
 * the CarPlay->Kombi video talker (AVB_MGU_CarPlay_Kombi, stream 0x301a9ee108e)
 * appear/activate? Talker active with 0 FIFO bytes means the phone IS sending
 * and our file:// sink was the culprit; silent means the phone never streams. */
var avbLines = [];
var AVB_MARKERS = [
    '301a9ee',             /* the CarPlay->Kombi video stream id */
    'CarPlay', 'D14_1722', 'Talker', 'talker', 'TalkerActive',
];
function isAvbMarker(line) {
    for (var i = 0; i < AVB_MARKERS.length; i++)
        if (line.indexOf(AVB_MARKERS[i]) >= 0) return true;
    return false;
}

function log(line) {
    var l = '[' + new Date().toISOString() + '] ' + line;
    logLines.push(l);
    if (logLines.length > 60) logLines.shift();
    send({ ev: 'log', line: l });
    process.stdout.write(l + '\n');
}

function send(obj) {
    var s = JSON.stringify(obj) + '\n';
    clients.forEach(function (c) { try { c.write(s); } catch (e) {} });
}

function groupId(name) {
    try {
        var line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(function (l) { return l.split(':')[0] === name; });
        if (line) return parseInt(line.split(':')[2], 10);
    } catch (e) {}
    return -1;
}

var cachedState = { state: 'unknown', panel: null, mode: null, res: null, safe: null };   /* last good readState */

/* Why the patch should not be written without the user asking, or null: a
 * unit that starts another program than its binary (another tool's drop-in,
 * which the patch would switch off or which would bypass it). The stock unit
 * and drop-ins that only set an environment are fine. */
var UNIT_DIRS = (process.env.WOC_UNIT_DIRS || '/etc/systemd/system,/run/systemd/system').split(',');
function foreignStart(t) {
    var files = [];
    UNIT_DIRS.forEach(function (d) {
        files.push(path.join(d, t.unit));
        var dd = path.join(d, t.unit + '.d');
        try {
            fs.readdirSync(dd).sort().forEach(function (n) { if (/\.conf$/.test(n)) files.push(path.join(dd, n)); });
        } catch (e) {}
    });
    for (var i = 0; i < files.length; i++) {
        var text = readText(files[i]);
        if (text === null) continue;
        var lines = text.split('\n');
        for (var j = 0; j < lines.length; j++) {
            var m = /^\s*ExecStart\s*=\s*[-@:+!]*\s*(\S+)/.exec(lines[j]);
            if (m && m[1] !== t.target) return t.unit + ' starts ' + m[1] + ' (' + files[i] + ')';
        }
    }
    return null;
}

/* This boot's id, or null where the kernel has none. */
function bootId() { return bootIds.bootId() || null; }

/* A marker written in an earlier boot, whose start activated its change: its
 * boot id is another one. One without a boot id (an older patchd's) is
 * trusted: /dev/shm, where the markers live, starts empty at every boot. */
function markerStale(m) {
    var boot = bootId();
    return !!(m && m.boot && boot && m.boot !== boot);
}

/* The written change waiting for the next head-unit start, or null:
 * { action: "apply" | "revert" | null (a marker without one), reason, by:
 * "removal" for the tool's removal, else null, run: Android Auto's
 * {dpi, card} running until then (null: no patch), when the marker has it }.
 * A marker from an earlier boot is removed: its change is in effect. */
function readPending(t) {
    var text = readText(t.pending);
    if (text === null) return null;
    var p = null;
    try { p = JSON.parse(text); } catch (e) {}
    if (markerStale(p)) {
        unlinkQuiet(t.pending);
        log(t.name + ': the pending marker is from an earlier boot; its change is in effect');
        return null;
    }
    if (p && (p.action === 'apply' || p.action === 'revert')) {
        return { action: p.action, reason: t.reasons[p.action], by: p.by === 'removal' ? 'removal' : null,
                 run: p.hasOwnProperty('run') ? p.run : undefined };
    }
    return { action: null, reason: t.reasons.apply, by: null };
}

/* Who writes the change: "removal" while deactivate runs. */
var markBy = null;

/* World-readable, so the app can read it while patchd is not running yet (a
 * fresh install waits for the next head-unit start to start it). run:
 * Android Auto's {dpi, card} running until then (null: no patch), when
 * known (aaRunning). */
function writePending(t, action, run) {
    try {
        var m = { action: action, reason: t.reasons[action], boot: bootId() };
        if (markBy) m.by = markBy;
        if (t === AA && run !== undefined) m.run = run;
        fs.writeFileSync(t.pending, JSON.stringify(m) + '\n', { mode: 0o644 });
        fs.chmodSync(t.pending, 0o644);
    } catch (e) { log('pending marker: ' + e.message); }
}

/* Read the patcher's state of the target binary. Only one hashing subprocess
 * runs at a time; a caller that arrives while one is in flight gets the last
 * known state (never null), so the status/logs ops always carry a real value. */
function readState(cb) {
    if (statusInFlight) { cb(cachedState); return; }
    statusInFlight = true;
    cp.execFile(process.execPath, [PATCHER, 'status', '--target', TARGET], { timeout: tmo(15000) }, function (err, out) {
        statusInFlight = false;
        var text = (out || '') + '';
        var variant = /variant:\s+PATCHED -> IC_(HIGH|MID)/.exec(text);
        var redirect = /sink:\s+REDIRECTED -> (\S+)/.exec(text);
        var sinkRedirected = !!redirect;
        var sinkOriginal = /sink:\s+ORIGINAL/.test(text);
        var selfstart = /selfstart:\s+SELF-START/.test(text);
        var resMatch = /res:\s+PATCHED \(IC_HIGH advertises (\d+x\d+)/.exec(text);
        var safeMatch = /res:\s+PATCHED \(IC_HIGH advertises [^,\n]*, safe (\d+x\d+) at (\d+),(\d+)\)/.exec(text);
        var resOriginal = /res:\s+ORIGINAL/.test(text);
        var known = /known:\s+NO/.test(text) ? false : true;
        var unknownWhy = /known:\s+NO — (.*)/.exec(text);
        var pristine = /known:\s+yes, pristine/.test(text);
        var proven = !/proven:\s+no/.test(text);
        var restorable = /^restorable:\s+yes$/m.test(text);
        var backup = /backup:\s+(\S+)/.exec(text);
        var hasBackup = !!backup && backup[1] !== 'none';
        /* "patched" requires every edit: the variant gate, a known sink
         * (redirected to this tool, or stock in avb mode), self-start, and —
         * on the high panel — the resolution geometry. A binary missing one
         * (variant+sink but stock self-start; or self-start but the stock
         * 1920x900 geometry) reports "unknown" with a reason — the app then
         * offers CarPlay's Patch button, and apply adds the missing edit. The mid panel
         * keeps the stock geometry by design. mode distinguishes the capture
         * sink: stock avb:// the media bus the render joins, udp:// the
         * stream sink the bridge accepts, file:// the FIFO. */
        var state, mode = null, reason = null;
        var res = resMatch ? resMatch[1] : null;
        /* The advertised safe area as "WxH+X+Y". A patched binary with another
         * safe area than the one CarPlay's Patch button writes is still
         * patched; the app compares the two and offers that button. */
        var safe = safeMatch ? safeMatch[1] + '+' + safeMatch[2] + '+' + safeMatch[3] : null;
        var resOk = !variant || variant[1] !== 'HIGH' || !!resMatch;
        if (!known) state = 'unknown';
        else if (variant && selfstart && resOk && (sinkRedirected || sinkOriginal)) {
            state = 'patched';
            mode = !sinkRedirected ? 'avb' : /^file:\/\//.test(redirect[1]) ? 'fifo'
                : /^udp:\/\//.test(redirect[1]) ? 'udp' : redirect[1].replace(/:.*/, '');
        }
        else if (variant && !selfstart && (sinkRedirected || sinkOriginal)) {
            state = 'unknown';
            reason = 'self-start edit missing (older patch); CarPlay\'s Patch button applies it';
        }
        else if (variant && selfstart && resOriginal && (sinkRedirected || sinkOriginal)) {
            state = 'unknown';
            reason = 'resolution edit missing (older patch); CarPlay\'s Patch button applies it';
        }
        else if (/variant:\s+ORIGINAL/.test(text) && sinkOriginal) state = 'original';
        else state = 'unknown';
        /* What keeps the tool from writing the patch by itself: a head unit
         * that refuses our parts, a binary the patcher cannot patch (an edit
         * site not found, or one it does not recognise), one something else
         * modified (no backup of ours, not the pristine build), a build
         * outside the proven list that CarPlay's Patch button has not
         * patched (no backup of ours), or another program started as
         * carplay. */
        var hu = headUnit.refused();
        var conflict = hu ? notSupported(hu)
            : err && !text ? 'carplay status unreadable: ' + err.message
            : !known ? 'not patchable' + (unknownWhy ? ': ' + unknownWhy[1] : '')
            : !hasBackup && !pristine ? 'carplay was modified by something else'
            : !hasBackup && !proven ? 'untested carplay build'
            : foreignStart(CP);
        /* A change waiting for the next head-unit start: the running carplay is
         * not the binary on disk, so neither state applies to it yet. */
        var carplay = null, binary = state;
        var pending = readPending(CP);
        if (pending) { state = 'unknown'; mode = null; reason = pending.reason; carplay = 'deferred'; }
        cachedState = { state: state, panel: variant ? variant[1].toLowerCase() : null, mode: mode, res: res, safe: safe, reason: reason, carplay: carplay,
                        pending: pending ? pending.action || 'apply' : null, pendingBy: pending ? pending.by : null,
                        conflict: conflict, binary: binary, known: known, backup: hasBackup, restorable: restorable, proven: proven, recovered: recovered(TARGET) };
        cb(cachedState);
    });
}

/* The failed head-unit starts after which boot recovery restored the
 * original that is on disk now, or null (patch_record.js). */
function recovered(target) {
    var rec = record.current(target);
    return rec && rec.by === 'recovery' ? rec.fails || 1 : null;
}

/* The Android Auto patch as aapd_patch.js status reads it: { state:
 * original | patched | unknown | absent, reason, conflict, pending, dpi (the
 * density on disk), density (the chosen one), restorable, backup, known,
 * binary }. Only one read runs at a time; a caller meanwhile gets the last,
 * or with fresh, a read that starts after it (one an operation takes, so
 * nothing read before its command arrived decides it). */
var aaState = { state: 'unknown', density: aaDensity(), card: aaCard() };
var aaInFlight = false;
var aaFresh = [];     /* callers waiting for a read that starts after the one in flight */
function readAaState(cb, fresh) {
    if (aaInFlight) {
        if (fresh) aaFresh.push(cb); else cb(aaState);
        return;
    }
    aaInFlight = true;
    function done(st) {
        aaState = st; cb(st);
        var waiting = aaFresh.splice(0);
        if (waiting.length) readAaState(function (next) { waiting.forEach(function (w) { w(next); }); }, true);
    }
    cp.execFile(process.execPath, [AA_PATCHER, 'status', '--target', AAPD, '--conf', AAPD_CONF, '--coding', CODING], { timeout: tmo(15000) }, function (err, out, errOut) {
        aaInFlight = false;
        var text = (out || '') + '';
        function get(k) { var m = new RegExp('^' + k + ':\\s+(.*)$', 'm').exec(text); return m ? m[1] : ''; }
        var st = { state: 'unknown', reason: null, conflict: null, dpi: null, density: aaDensity(), card: aaCard(), restorable: /^yes$/.test(get('restorable')) };
        if (!/^size:/m.test(text)) {
            var gone = !fs.existsSync(AAPD);
            st.state = gone ? 'absent' : 'unknown';
            st.conflict = gone ? 'no Android Auto on this head unit' : 'aapd status unreadable: ' + (((errOut || '') + '').trim() || (err && err.message));
            st.unreadable = !gone;
            done(st);
            return;
        }
        var edits = ['gate', 'selfstart-call', 'selfstart-guard', 'screen'].map(get), geom = get('geometry');
        var dpi = /^PATCHED \((\d+) dpi, card (\w+)/.exec(geom), coding = /^KI_KOMBI_VARIANT (\d+)$/.exec(get('coding'));
        var backup = get('backup') !== 'none', known = !/^NO/.test(get('known')), pristine = /^yes, pristine/.test(get('known'));
        st.dpi = dpi ? Number(dpi[1]) : null;
        st.diskCard = dpi ? dpi[2] : null;
        st.known = known;
        st.backup = backup;
        st.undo = get('undo');
        /* Our backups beside another aapd (a firmware update): not ours to
         * undo, so a removal leaves it, as carplay's does. */
        st.otherBuild = backup && !st.restorable && /another build/.test(get('restorable'));
        if (edits.every(function (e) { return e === 'PATCHED'; }) && dpi) st.state = 'patched';
        else if (edits.every(function (e) { return e === 'ORIGINAL'; }) && geom === 'ORIGINAL') st.state = 'original';
        else if (known) st.reason = 'partly patched; Android Auto\'s Patch button applies the rest';
        st.binary = st.state;
        var hu = headUnit.refused();
        st.conflict = hu ? notSupported(hu)
            : !coding ? 'cluster coding unreadable'
            : Number(coding[1]) !== AA_CODING ? 'not supported on this car (KI_KOMBI_VARIANT ' + coding[1] + ')'
            : st.otherBuild ? 'aapd is another build than our backup'
            : !known && !backup ? 'untested aapd build'
            : !backup && !pristine ? 'aapd was modified by something else'
            : /^UNKNOWN/.test(geom) && !backup ? 'aapd.conf is not the known original'
            : foreignStart(AA);
        st.recovered = recovered(AAPD);
        var pending = readPending(AA);
        if (pending) {
            st.state = 'unknown'; st.reason = pending.reason; st.aapd = 'deferred'; st.pending = pending.action || 'apply'; st.pendingBy = pending.by;
            st.run = pending.run;
        }
        done(st);
    });
}
var AA_CODING = require('./aapd_patch.js').CODING.proven;

/* The conflict of a head unit that refuses our parts, in the words the
 * app shows as not supported. */
function notSupported(why) { return 'not supported on this car (' + why + ')'; }

/* The density and turn-card setting the owner chose, else the defaults. */
function aaDensity() {
    var n = parseInt(readText(AA_DPI_FILE), 10);
    return aapdConf.DENSITIES.indexOf(n) >= 0 ? n : aapdConf.DEFAULT_DPI;
}
function aaCard() {
    var c = (readText(AA_CARD_FILE) || '').trim();
    return aapdConf.CARDS.indexOf(c) >= 0 ? c : aapdConf.DEFAULT_CARD;
}

/* The crop override for card and dpi, null for the shipped one. */
function cropEnv(card, dpi) { return card === 'hidden' ? 'WOC_SRC_CROP=-s src_crop=' + aapdConf.srcCrop(card, dpi) + '\n' : null; }

function aaMsg(st) {
    var m = { state: busy === 'aa' ? 'busy' : st.state, density: st.density, card: st.card, densities: [aapdConf.DENSITY_MIN, aapdConf.DENSITY_MAX, aapdConf.DENSITY_STEP] };
    /* While a change runs, the line says so; the values on disk stay. */
    if (busy !== 'aa') ['reason', 'conflict', 'aapd', 'recovered'].forEach(function (k) { if (st[k]) m[k] = st[k]; });
    ['pending', 'dpi', 'diskCard'].forEach(function (k) { if (st[k]) m[k] = st[k]; });
    if (st.pending && st.run !== undefined) { m.runDpi = st.run ? st.run.dpi : null; m.runCard = st.run ? st.run.card : null; }
    if (lastDensityAt + DENSITY_SPACING_MS > Date.now()) m.changeAt = lastDensityAt + DENSITY_SPACING_MS;
    if (aaError) m.error = aaError;
    return m;
}

/* The restart's state for the app: restarting, or the last one that failed,
 * and while the limit holds, when a request is taken again. */
function restartMsg() {
    var m = { state: rebooting ? 'restarting' : restartFail ? 'failed' : 'idle' };
    if (!rebooting && restartFail) { m.code = restartFail.code; m.reason = restartFail.reason; }
    var recent = recentReboots(Date.now());
    if (recent.length) m.possibleAt = recent[recent.length - 1] + REBOOT_SPACING_MS;
    return m;
}

function status(extra, aaExtra) {
    readState(function (st) {
        readAaState(function (aa) {
            var cpBusy = busy === 'carplay';
            var msg = { ev: 'status', state: cpBusy ? 'busy' : st.state, panel: st.panel, mode: st.mode, res: st.res, safe: st.safe,
                        busy: busy || (rebooting ? 'restart' : null), restart: restartMsg() };
            if (!cpBusy && st.reason) msg.reason = st.reason;
            if (!cpBusy && st.carplay) msg.carplay = st.carplay;
            if (!cpBusy && st.pending) msg.pending = st.pending;
            if (!cpBusy && st.conflict) msg.conflict = st.conflict;
            if (!cpBusy && st.recovered) msg.recovered = st.recovered;
            if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
            msg.aa = aaMsg(aa);
            if (aaExtra) Object.keys(aaExtra).forEach(function (k) { msg.aa[k] = aaExtra[k]; });
            send(msg);
        });
    });
}

function remount(rw, cb) {
    cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: rw ? tmo(15000) : roTmo(15000) }, function (err) { cb(err); });
}

/* / is read-only on / per /proc/mounts. */
function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n');
        var opts = null;
        /* The last `/` entry is the effective root mount (mgu-deploy.js scans
         * from the end too). */
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].split(' ');
            if (p[1] === '/') opts = p[3];
        }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}

/* Remount read-only and confirm it took, retrying a few times. */
function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 0 && (!hookDeadline || Date.now() < hookDeadline)) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}

/* Restarting carplay or aapd is safe only while nothing takes its SIGKILL
 * for a failure: recmgr loaded its entry this boot (recmgr_list.js), and,
 * for carplay, systemd loaded the tool's drop-in, whose
 * SuccessExitStatus=SIGKILL keeps the kill from failing carplay.service and
 * so from running its OnFailure=mediaddpserver_kill.service, which restarts
 * the head unit. aapd.service has no OnFailure=, so its failure matters only
 * to recmgr (PATCH.md "Activation"). Otherwise a change is left to take
 * effect at the next head-unit start. */
var recmgrLoaded = require('./recmgr_list.js').recmgrLoaded;
var parseShow = require('./recovery.js').parseShow;
var DROPIN = process.env.WOC_CARPLAY_DROPIN || '/etc/systemd/system/carplay.service.d/50-waze-on-cluster.conf';

/* cb(null) when t's service may be restarted, else cb(why not). */
function restartBlocked(t, cb) {
    if (!recmgrLoaded(t.name)) { cb('recmgr did not load a ' + t.name + ' restart entry this boot'); return; }
    if (!t.dropin) { cb(null); return; }
    cp.execFile('systemctl', ['show', t.unit, '-p', 'DropInPaths'], { timeout: 15000 }, function (err, out) {
        var m = /^DropInPaths=(.*)$/m.exec((out || '') + '');
        cb(m && m[1].split(' ').indexOf(t.dropin) >= 0 ? null : 'systemd has not loaded ' + t.dropin);
    });
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

/* A change written while the service could not be restarted, and which one:
 * {"action":"apply"|"revert","reason":...}. The markers sit next to the
 * socket in /dev/shm, which the next head-unit start clears; until then
 * status reports them instead of the files' state. */
var PENDING = path.join(path.dirname(SOCK), 'activation-pending');
var PENDING_REASON = {
    apply: 'patch written; takes effect at the next head-unit start',
    revert: 'patch removed; the original carplay runs from the next head-unit start'
};
/* Each target: its unit, binary, patcher, the running binary's link, its
 * pending marker, the run restartUnit kills (for recovery.js), the drop-in
 * a restart needs, and files besides the binary read at start (extra). */
var CP = { name: 'carplay', unit: 'carplay.service', target: TARGET, patcher: PATCHER, running: TARGET + '.woc-running',
           pending: PENDING, killed: path.join(path.dirname(SOCK), 'carplay-killed'), dropin: DROPIN, reasons: PENDING_REASON, extra: [] };
var AA = { name: 'aapd', unit: 'aapd.service', target: AAPD, patcher: AA_PATCHER, running: AAPD + '.woc-running',
           pending: path.join(path.dirname(SOCK), 'aa-pending'), killed: path.join(path.dirname(SOCK), 'aapd-killed'), dropin: null,
           /* aapd reads aapd.conf when it starts: a change there needs a start too. */
           extra: [AAPD_CONF],
           reasons: { apply: 'Android Auto patch written; takes effect at the next head-unit start',
                      revert: 'Android Auto patch removed; the original aapd runs from the next head-unit start' } };

/* Restart t's service: SIGKILL its main process, wait until systemd has
 * reaped it, `systemctl start` it, and confirm the unit is active. A systemd
 * stop or restart power-cycles the head unit (carplay dumps core on SIGTERM;
 * aapd is BMW's like it), so neither is used, not even as a fallback: no
 * main PID, a failed start or a unit that never becomes active is an error.
 * Each wait is bounded (RESTART_TRIES x RESTART_POLL_MS). Only called when
 * restartBlocked found nothing. */
var RESTART_POLL_MS = parseInt(process.env.WOC_RESTART_POLL_MS, 10) || 250;
var RESTART_TRIES = 40;
function restartUnit(t, cb) {
    cp.execFile('systemctl', ['show', t.unit, '-p', 'MainPID', '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic'],
        { timeout: 15000 }, function (err, out) {
        if (err) { cb(new Error(t.name + ' restart: reading MainPID failed: ' + err.message)); return; }
        var run = parseShow((out || '') + ''), pid = run.pid;
        if (!(pid > 0)) { cb(new Error(t.name + ' restart: ' + t.unit + ' has no main PID (MainPID=' + pid + '); not restarted')); return; }
        log('restarting ' + t.name + ': SIGKILL main PID ' + pid + ', then systemctl start');
        /* The boot-recovery watcher takes the end of this run for patchd's
         * kill, not a crash. */
        try { fs.writeFileSync(t.killed, run.run + '\n'); } catch (e) { log('recording the killed run failed: ' + e.message); }
        try { process.kill(pid, 'SIGKILL'); }
        catch (e) { if (e.code !== 'ESRCH') { cb(new Error(t.name + ' restart: SIGKILL ' + pid + ': ' + e.message)); return; } }
        waitGone(t, pid, RESTART_TRIES, function (gErr) {
            if (gErr) { cb(gErr); return; }
            cp.execFile('systemctl', ['start', t.unit], { timeout: 30000 }, function (sErr) {
                if (sErr) { cb(new Error(t.name + ' restart: systemctl start failed: ' + sErr.message)); return; }
                waitActive(t, RESTART_TRIES, function (aErr) {
                    if (!aErr) try { fs.unlinkSync(t.pending); } catch (e) {}
                    cb(aErr);
                });
            });
        });
    });
}

/* The killed PID is gone once systemd has reaped it (a zombie still answers
 * signal 0), so the start below never lands on the dying instance. */
function waitGone(t, pid, tries, cb) {
    try { process.kill(pid, 0); }
    catch (e) { if (e.code === 'ESRCH') { cb(null); return; } }
    if (tries <= 0) { cb(new Error(t.name + ' restart: PID ' + pid + ' still present after SIGKILL; not started')); return; }
    setTimeout(function () { waitGone(t, pid, tries - 1, cb); }, RESTART_POLL_MS);
}

function waitActive(t, tries, cb) {
    cp.execFile('systemctl', ['is-active', t.unit], { timeout: 15000 }, function (err, out) {
        var st = ((out || '') + '').trim();
        if (st === 'active') { cb(null); return; }
        if (tries <= 0) { cb(new Error(t.name + ' restart: ' + t.unit + ' is ' + (st || 'unknown') + ' after start')); return; }
        setTimeout(function () { waitActive(t, tries - 1, cb); }, RESTART_POLL_MS);
    });
}

/* Follow one or more units' journals; onLine(text) decides what to keep. oformat
 * is journalctl's -o value: "cat" is the message only (so content matching does
 * not trip on the unit identifier in the prefix). Respawns if journalctl exits;
 * root reads the journal directly. */
function followJournal(units, oformat, onLine) {
    var args = [];
    units.forEach(function (u) { args.push('-u', u); });
    args.push('-f', '-o', oformat, '-n', '0');
    var j;
    try {
        j = cp.spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { log('journalctl spawn failed: ' + e.message); return; }
    var buf = '';
    j.stdout.setEncoding('utf8');
    j.stdout.on('data', function (d) {
        buf += d;
        if (buf.length > 1 << 20) buf = buf.slice(-(1 << 16));
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line) onLine(line);
        }
    });
    j.on('close', function () { setTimeout(function () { followJournal(units, oformat, onLine); }, 5000); });
    j.on('error', function (e) { log('journalctl error: ' + e.message); });
}

/* Keep carplay's journal lines (timestamped), flagging the "no map" markers;
 * the LD_PRELOAD scheduler shim's lines carry nothing about CarPlay. */
function followCarplayJournal() {
    followJournal(['carplay.service'], 'short-iso', function (line) {
        if (line.indexOf('libschedconfig') >= 0) return;
        pushCarplay({ t: Date.now(), msg: line.slice(0, 4096), marker: isMarker(line) });
    });
}

/* Keep only marker lines of the AVB talker's messages (otherwise noisy); -o cat
 * so the match is on the message, not the avbstreamhandler identifier. */
function followAvbJournal() {
    followJournal(['avbstreamhandler.service', 'avbsourcesinkcontroller.service'], 'cat', function (line) {
        if (!isAvbMarker(line)) return;
        avbLines.push({ t: Date.now(), msg: line.slice(0, 4096) });
        if (avbLines.length > 400) avbLines.shift();
    });
}

/* carplay and the AVB streamhandler log to DLT (BMW's logging bus), not to the
 * journal — the journal carries only the LD_PRELOAD shim's noise — so the gate
 * and advert lines ("Kombi variant is =", "Adding display:", ...) are only on
 * DLT. dlt-receive -a connects to the DLT daemon over TCP and prints each
 * message's ASCII payload (prefixed with its app/context id); root may connect.
 * Lines are routed by content, not app id: carplay's marker strings to
 * carplayLines; the CarPlay->Kombi stream's ids and any AVB talker message to
 * avbLines. Kept lines are copied, so they do not pin the chunk they came from. */
var DLT_AVB_MARKERS = ['301a9ee', 'CarPlay_Kombi', 'D14_1722', 'alker'];
function isDltAvbMarker(line) {
    for (var i = 0; i < DLT_AVB_MARKERS.length; i++)
        if (line.indexOf(DLT_AVB_MARKERS[i]) >= 0) return true;
    return false;
}
var dltErrorLogged = false;
function own(s) { return Buffer.from(s, 'utf8').toString('utf8'); }

/* dlt-receive's health, so an empty DLT capture can be told apart from no
 * CarPlay activity. Each start of dlt-receive is a run: its DLT lines, when the
 * first and last arrived, and the last DLT_TAIL chars of its own messages
 * (stderr, and the "[..]~DLT~" / "DLT| " lines its logger may print on stdout,
 * which are not DLT data). failed_runs counts the runs in a row that ended
 * without a DLT line; a DLT line resets it. last_exit is the previous run as it
 * ended. The "logs" reply carries it all as "dlt". The patchd log gets a line
 * when DLT_FAIL_LOG_AFTER runs in a row fail, and when DLT lines arrive for the
 * first time or after such a streak; never one per retry. */
var DLT_RECEIVE = process.env.WOC_DLT_RECEIVE || 'dlt-receive';
var DLT_RETRY_MS = parseInt(process.env.WOC_DLT_RETRY_MS, 10) || 5000;
var DLT_RETRY_MAX_MS = parseInt(process.env.WOC_DLT_RETRY_MAX_MS, 10) || 60000;
var DLT_TAIL = 1024;
var DLT_FAIL_LOG_AFTER = 3;
var dlt = { state: 'starting', runs: 0, failed_runs: 0, run: null, last_exit: null };
var dltEverReceived = false;
var dltRetryTimer = null;      /* the pending dlt-receive restart */
var dltStreakLogged = false;   /* a failure streak was logged; log the recovery */
function isDltClientMsg(line) { return /^\[[\d. ]+\]~DLT~/.test(line) || line.indexOf('DLT| ') === 0; }
function dltMessage(run, s) { run.messages = own((run.messages + s).slice(-DLT_TAIL)); }
function dltHow(run) {
    var how = run.error || (run.signal ? 'signal ' + run.signal : 'exit code ' + run.code);
    var m = run.messages.replace(/\s+$/, '');
    m = m.slice(m.lastIndexOf('\n') + 1);
    return m ? how + ': ' + m.slice(-200) : how;
}
function dltReceiving(run, now) {
    run.first_data = now;
    dlt.state = 'receiving';
    if (!dltEverReceived || dltStreakLogged)
        log('dlt-receive: receiving DLT' + (dltStreakLogged ? ' after ' + dlt.failed_runs + ' failed starts' : ''));
    dltEverReceived = true;
    dltStreakLogged = false;
    dlt.failed_runs = 0;
}
function dltEnded(run, code, signal) {
    run.ended = Date.now();
    run.code = code;
    run.signal = signal;
    dlt.run = null;
    dlt.last_exit = run;
    if (run.lines) return;
    dlt.failed_runs++;
    if (dlt.failed_runs === DLT_FAIL_LOG_AFTER) {
        log('dlt-receive: no DLT data from ' + DLT_FAIL_LOG_AFTER + ' starts in a row (last: ' + dltHow(run) +
            '); backing off, see "dlt" in the logs reply');
        dltStreakLogged = true;
    }
}

/* How long to wait before the next dlt-receive start. A capped doubling delay
 * over consecutive failed starts, from DLT_RETRY_MS up to DLT_RETRY_MAX_MS, so a
 * DLT daemon that never accepts a local client (its socket is not opened at
 * startup) is not respawned every few seconds for the life of the unit; a run
 * that carries DLT data resets failed_runs and so the delay to the base. */
function dltRetryDelay() {
    var n = dlt.failed_runs > 0 ? dlt.failed_runs - 1 : 0;
    var d = DLT_RETRY_MS * Math.pow(2, n < 20 ? n : 20);
    return d < DLT_RETRY_MAX_MS ? d : DLT_RETRY_MAX_MS;
}

function followDlt() {
    var j;
    var run = { started: Date.now(), first_data: null, last_data: null, lines: 0, messages: '', error: null };
    dlt.runs++;
    dlt.run = run;
    dlt.state = 'starting';
    try {
        j = cp.spawn(DLT_RECEIVE, ['-a', 'localhost'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        log('dlt-receive spawn failed: ' + e.message + ' (DLT markers unavailable)');
        run.error = e.message;
        dltEnded(run, null, null);
        dlt.state = 'stopped';
        return;
    }
    var buf = '';
    j.stderr.setEncoding('utf8');
    j.stderr.on('data', function (d) { dltMessage(run, d); });
    j.stdout.setEncoding('utf8');
    j.stdout.on('data', function (d) {
        buf += d;
        if (buf.length > 1 << 20) buf = buf.slice(-(1 << 16)); /* a stuck partial line cannot grow unbounded */
        var now = Date.now();
        var had = run.lines;
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i).replace(/\s+$/, '');
            buf = buf.slice(i + 1);
            if (!line) continue;
            if (isDltClientMsg(line)) dltMessage(run, line + '\n');
            else run.lines++;
            if (isMarker(line)) {
                pushCarplay({ t: Date.now(), msg: own('DLT ' + line.slice(0, 4096)), marker: true });
            } else if (isDltAvbMarker(line)) {
                avbLines.push({ t: Date.now(), msg: own('DLT ' + line.slice(0, 4096)) });
                if (avbLines.length > 400) avbLines.shift();
            }
        }
        if (run.lines > had) {
            run.last_data = now;
            if (!run.first_data) dltReceiving(run, now);
        }
    });
    j.on('close', function (code, signal) {
        dltEnded(run, code, signal);
        dlt.state = 'retrying';
        dltRetryTimer = setTimeout(function () { dltRetryTimer = null; followDlt(); }, dltRetryDelay());
    });
    j.on('error', function (e) {
        run.error = e.message;
        if (!dltErrorLogged) log('dlt-receive: ' + e.message + ' (DLT markers unavailable)');
        dltErrorLogged = true;
    });
}

var CAPTURE_SOCK = process.env.WOC_CAPTURE_SOCK || '/run/woc-dlt-capture/control.sock';
function captureCommand(command, cb) {
    var socket = net.connect(CAPTURE_SOCK), buf = '', done = false;
    var timer = setTimeout(function () { finish(new Error('capture service timed out')); }, 3000);
    function finish(err, result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        var state = err ? { state: 'unavailable', error: err.message } : result;
        if (state.state === 'open') dltRetryNow();
        cb(state);
    }
    socket.on('connect', function () { socket.write(JSON.stringify({ cmd: command }) + '\n'); });
    socket.on('error', function (err) { finish(err); });
    socket.on('end', function () { finish(new Error('capture service closed without a reply')); });
    socket.on('data', function (data) {
        buf += data;
        if (buf.length > 8192) return finish(new Error('capture reply too large'));
        var i = buf.indexOf('\n');
        if (i < 0) return;
        try { finish(null, JSON.parse(buf.slice(0, i))); } catch (err) { finish(err); }
    });
}
function dltRetryNow() {
    if (!dltRetryTimer || quitting) return;
    clearTimeout(dltRetryTimer);
    dltRetryTimer = null;
    followDlt();
}
function quit() {
    if (quitting) return;
    quitting = true;
    quitWhenIdle();
}
function quitWhenIdle() {
    if (quitting && !busy) process.exit(0);
}

/* Restore / to read-only, and never leave it writable: if the remount keeps
 * failing (the old, now-unlinked binary is still held open), restart t's
 * service to drop it and try once more, whatever made the patch step fail —
 * when it is restartable (an install never restarts it). */
function finalizeRo(t, errSoFar, done, restartable) {
    remountRo(3, function (roErr) {
        if (!roErr || !restartable) { done(errSoFar, roErr); return; }
        log('/ still writable; restarting ' + t.name + ' to release the old binary, then retrying');
        restartUnit(t, function () {
            remountRo(3, function (roErr2) { done(errSoFar, roErr2); });
        });
    });
}

/* The running binary, kept linked (t.running) while a process still
 * executes it: the patcher replaces t.target by rename, and an unlinked file
 * still held open keeps / from going read-only again. Once nothing executes
 * it (after the next head-unit start, or a restart of the service) it is
 * removed: by the next write window, by patchd when it starts, and after the
 * tool's removal by the deploy tool (deactivate's "removeWhenUnused"). */
function needed(t) { return lock.holds(t.running, t.target); }
function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) {} }

/* Removes the links nothing executes, / read-write only for that. */
function dropUnusedRunning(cb) {
    var stale = [CP, AA].filter(function (t) { return fs.existsSync(t.running) && !needed(t); });
    if (!stale.length) { cb(); return; }
    lock.acquire(5000, function (got) {
        if (!got) { log('remount lock busy; unused links wait for the next write window'); cb(); return; }
        remount(true, function (mErr) {
            stale.forEach(function (t) { if (!mErr && !needed(t)) { unlinkQuiet(t.running); log('removed ' + t.running + ': nothing runs it'); } });
            remountRo(3, function (roErr) {
                if (roErr) log('WARNING: ' + roErr.message);
                lock.release();
                cb();
            });
        });
    });
}

function sameFile(a, b) {
    try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (e) { return false; }
}
function sameInode(a, b) {
    try { var x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch (e) { return false; }
}

/* One apply/revert (action) of t: remount rw, run the patcher; when a file
 * changed, restart the service unless the caller forbids it or
 * restartBlocked names a reason (so the new one takes effect and the old one
 * is dropped), else leave the change for the next head-unit start; then
 * finalizeRo. A change that writes the bytes the service runs (a pending
 * change undone), and nothing else it reads at start (t.extra), moves the
 * running binary's own file back into place, so
 * nothing is pending and no unlinked file stays open. done(err, roErr,
 * activation, patcherErr): "restarted", "deferred", or null for nothing to
 * activate; patcherErr is the patcher's own error line. */
function runPatch(t, args, action, noRestart, done, run) {
    (noRestart ? function (cb) { cb('installing'); } : function (cb) { restartBlocked(t, cb); })(function (blocked) { patchWith(t, args, action, blocked, done, run); });
}
function patchWith(t, args, action, blocked, done, run) {
    var restartable = !blocked;
    function fin(err, activation, why) { finalizeRo(t, err, function (e, r) { done(e, r, activation, why); }, restartable); }
    remount(true, function (mErr) {
        if (mErr) { fin(new Error('remount rw: ' + mErr.message), null); return; }
        if (!needed(t)) unlinkQuiet(t.running);
        var linked = false;
        if (!restartable && !fs.existsSync(t.running)) {
            try { fs.linkSync(t.target, t.running); linked = true; } catch (e) { log('keeping the running ' + t.name + ' linked failed: ' + e.message); }
        }
        var extraBefore = t.extra.map(sha).join();
        cp.execFile(process.execPath, [t.patcher].concat(args), { timeout: tmo(60000) }, function (pErr, out, errOut) {
            var text = (out || '') + '';
            text.split('\n').forEach(function (l) { if (l.trim()) log(l.trim()); });
            if (errOut) (errOut + '').split('\n').forEach(function (l) { if (l.trim()) log(l.trim()); });
            var why = /^error: (.*)$/m.exec((errOut || '') + '');
            why = why ? why[1] : null;
            var changed = !pErr && !/nothing to do|already at the original/i.test(text);
            if (changed && restartable) {
                restartUnit(t, function (rErr) {
                    if (!rErr) unlinkQuiet(t.running);
                    finalizeRo(t, pErr || rErr || null, function (e, r) { done(e, r, 'restarted'); });
                });
            } else if (changed && sameFile(t.running, t.target) && t.extra.map(sha).join() === extraBefore) {
                try { fs.renameSync(t.running, t.target); }
                catch (e) {
                    log('putting the running ' + t.name + ' back failed: ' + e.message + '; ' + t.reasons[action]);
                    writePending(t, action, run);
                    fin(null, 'deferred');
                    return;
                }
                log(t.name + ' runs these bytes already; its binary is back in place and nothing waits for a head-unit start');
                unlinkQuiet(t.pending);
                fin(null, null);
            } else if (changed) {
                log(t.name + ' not restarted (' + blocked + '); ' + t.reasons[action]);
                if (!needed(t)) unlinkQuiet(t.running);
                writePending(t, action, run);
                fin(null, 'deferred');
            } else if (linked && !sameInode(t.running, t.target)) {
                /* The patcher failed after replacing the binary: the running
                 * one stays linked and the change waits like any other. */
                log(action + ' failed after writing; ' + t.reasons[action]);
                if (!needed(t)) unlinkQuiet(t.running);
                writePending(t, action, run);
                fin(pErr || null, 'deferred', why);
            } else {
                if (linked) unlinkQuiet(t.running);
                fin(pErr || null, null, why);
            }
        });
    });
}

/* Every mode applies Edit 1 (variant gate) + Edit 3 (self-start) — without
 * self-start the phone never streams. The modes differ only in the sink:
 * "avb": the stock avb:// sink, the media bus the render joins (the mode the
 * app applies). "udp": Edit 2 sink -> udp://127.0.0.1:UDP_PORT, the stream
 * sink the projection bridge accepts, which this tool receives. "fifo": sink
 * -> the file:// FIFO (the bridge rejects it on the car). `unproven`: the
 * press of CarPlay's Patch button, which also patches a build outside the proven list;
 * install-time activation never does. */
function apply(panel, mode, noRestart, unproven, done) {
    if (panel !== 'high' && panel !== 'mid') { done(new Error('panel must be high or mid')); return; }
    var args = ['apply', '--panel', panel, '--target', TARGET, '--yes'].concat(unproven ? ['--unproven'] : []);
    if (mode === 'avb') {
        log('apply IC_' + panel.toUpperCase() + ', stock AVB sink (the render joins the media bus)');
    } else if (mode === 'udp') {
        var url = 'udp://127.0.0.1:' + UDP_PORT + '?mime_type=video/H264';
        log('apply IC_' + panel.toUpperCase() + ' + capture to ' + url);
        args.splice(3, 0, '--sink', url);
    } else {
        log('apply IC_' + panel.toUpperCase() + ' + capture to ' + FIFO);
        args.splice(3, 0, '--capture', FIFO);
    }
    runPatch(CP, args, 'apply', noRestart, done);
}

function revert(noRestart, dropBackup, done) {
    log('revert');
    runPatch(CP, ['revert', '--target', TARGET, '--yes'].concat(dropBackup ? ['--drop-backup'] : []), 'revert', noRestart, done);
}

var AA_FILES = ['--target', AAPD, '--conf', AAPD_CONF];

/* Writes or removes the crop override; true when it changed. */
function setCrop(text) {
    if (readText(AA_CROP_ENV) === text) return false;
    if (text === null) { unlinkQuiet(AA_CROP_ENV); return true; }
    saveFile(AA_CROP_ENV, text);
    return true;
}

/* What aapd runs, from a read that starts once the change's command has
 * arrived and before the change writes anything: a pending marker's run
 * (undefined when the marker has none), else the patch on disk, null
 * without one. A status read later in the change cannot alter it. */
function aaRunning(cb) {
    readAaState(function (st) {
        cb(st.pending ? st.run : st.binary === 'patched' ? { dpi: st.dpi, card: st.diskCard } : null);
    }, true);
}

/* Applies the chosen density and card. The render reads its crop when it
 * starts, so a change of the crop override is left, with the aapd.conf it
 * goes with, for the next head-unit start; otherwise the change takes
 * effect as any other. done(err, roErr, activation, why, run): run, what
 * aapd runs, for a marker the caller writes. */
function aaApply(noRestart, done) {
    var dpi = aaDensity(), card = aaCard(), crop = cropEnv(card, dpi), cropChange = readText(AA_CROP_ENV) !== crop;
    log('Android Auto: apply at ' + dpi + ' dpi, card ' + card);
    aaRunning(function (run) {
        runPatch(AA, ['apply', '--dpi', String(dpi), '--card', card, '--coding', CODING, '--yes'].concat(AA_FILES), 'apply', noRestart || cropChange,
            function (pErr, roErr, activation, why) {
                if (!pErr) {
                    try {
                        if (setCrop(crop) && activation !== 'deferred') { writePending(AA, 'apply', run); activation = 'deferred'; }
                    } catch (e) { pErr = new Error('writing ' + AA_CROP_ENV + ': ' + e.message); }
                }
                done(pErr, roErr, activation, why, run);
            }, run);
    });
}

function aaRevert(noRestart, dropBackup, done) {
    log('Android Auto: revert');
    aaRunning(function (run) {
        runPatch(AA, ['revert', '--yes'].concat(AA_FILES, dropBackup ? ['--drop-backup'] : []), 'revert', noRestart, function (pErr, roErr, activation, why) {
            if (!pErr) unlinkQuiet(AA_CROP_ENV);
            done(pErr, roErr, activation, why, run);
        }, run);
    });
}

/* A file in STATE_DIR, written whole by rename. */
function saveFile(f, text) {
    try { fs.mkdirSync(STATE_DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    var fd = fs.openSync(f + '.tmp', 'w', 0o644);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(f + '.tmp', f);
}

/* The head-unit restarts asked for in the last REBOOT_SPACING_MS. */
function recentReboots(now) {
    var at = [];
    try { at = JSON.parse(fs.readFileSync(REBOOTS_FILE, 'utf8')).at; } catch (e) {}
    return (Array.isArray(at) ? at : []).filter(function (t) { return isFinite(t) && t <= now && now - t < REBOOT_SPACING_MS; });
}
function recordReboots(times) {
    try { fs.mkdirSync(STATE_DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.writeFileSync(REBOOTS_FILE + '.tmp', JSON.stringify({ at: times }) + '\n');
    fs.renameSync(REBOOTS_FILE + '.tmp', REBOOTS_FILE);
}

function reply(sock, obj) { try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) {} }

/* Activate a deferred change with a normal head-unit restart. Guarded so a stray or
 * repeated press cannot reboot at the wrong time: only when a change is
 * actually pending, not while an operation runs, once, and at most once per
 * REBOOT_SPACING_MS, recorded on disk before the command runs. A failed
 * command takes out only its own record. */
function rebootCmd(sock) {
    var now = Date.now(), recent = null;
    var deny = rebooting ? 'a restart is already in progress'
        : busy ? 'another operation is running'
        : quitting ? 'patchd is stopping'
        : !readPending(CP) && !readPending(AA) ? 'no restart is pending'
        : null;
    if (!deny) {
        recent = recentReboots(now);
        if (recent.length) deny = 'a restart was asked for ' + Math.round((now - recent[recent.length - 1]) / 1000) + ' s ago; possible again in ' +
            Math.max(1, Math.ceil((recent[recent.length - 1] + REBOOT_SPACING_MS - now) / 60000)) + ' min';
    }
    if (!deny) try { recordReboots(recent.concat(now)); } catch (e) { deny = 'cannot record the restart: ' + e.message; }
    if (deny) { reply(sock, { ev: 'reboot-reply', ok: false, reason: deny }); return; }
    try { saveFile(RESTART_FILE, (bootId() || '') + '\n'); } catch (e) { log('recording the restart for boot recovery failed: ' + e.message); }
    rebooting = true;
    restartFail = null;
    log('restart requested: head-unit restart to activate the pending change (' + REBOOT_CMD.join(' ') + ')');
    reply(sock, { ev: 'reboot-reply', ok: true });
    status();
    /* code: refused (NSM did not take it), stayed (NSM took it, the unit
     * stayed up; its record keeps counting against the limit) or error */
    function failed(code, why) {
        if (!rebooting) return;
        clearTimeout(timer);
        rebooting = false;
        restartFail = { code: code, reason: why };
        if (code !== 'stayed') try { recordReboots(recentReboots(Date.now()).filter(function (t) { return t !== now; })); } catch (e) {}
        try { fs.unlinkSync(RESTART_FILE); } catch (e) {}
        log('reboot failed: ' + why);
        send({ ev: 'reboot-reply', ok: false, reason: why });
        status();
    }
    var timer = setTimeout(function () { failed('stayed', 'the head unit did not restart'); }, REBOOT_WAIT_MS);
    cp.execFile(REBOOT_CMD[0], REBOOT_CMD.slice(1), { timeout: REBOOT_CMD_TIMEOUT_MS }, function (err, stdout, stderr) {
        var refused = /\[Error\.\s*([^\]]*)\]/.exec((stdout || '') + '');
        if (refused) failed('refused', refused[1].trim());
        else if (err) failed('error', ((stderr || '') + '').trim().split('\n').pop() || err.message.split('\n')[0]);
    });
}

/* Runs one user operation for target ('carplay' | 'aa') under the shared
 * remount lock; busy is set before anything asynchronous, so no second
 * operation or reboot starts meanwhile. Without the lock within
 * OP_LOCK_WAIT_MS it gives up and writes nothing. */
function operate(target, label, fn) {
    busy = target;
    if (target === 'aa') status(null, { reason: label }); else status({ reason: label });
    lock.acquire(OP_LOCK_WAIT_MS, function (got) {
        if (!got) {
            busy = null;
            var why = 'another change to / is running; try again';
            log(label + ': ' + why);
            if (target === 'aa') { aaError = why; status(null, { state: 'error', reason: why }); } else status({ state: 'error', reason: why });
            quitWhenIdle();
            return;
        }
        fn(function (pErr, roErr, activation) {
            lock.release();
            busy = null;
            if (roErr) log('WARNING: ' + roErr.message + ' — run: mount -o remount,ro /');
            var t = target === 'aa' ? AA : CP;
            if (pErr || roErr) {
                var reason = [pErr && pErr.message, roErr && roErr.message].filter(Boolean).join('; ');
                log(label + ' failed: ' + reason);
                if (target === 'aa') { aaError = reason; status(null, { state: 'error', reason: reason }); }
                else status({ state: 'error', reason: reason });
            } else {
                if (target === 'aa') aaError = null;
                var pend = activation === 'deferred' ? readPending(t) : null;
                log(label + ' done' + (activation === 'restarted' ? '' : activation === 'deferred' ? ' (' + (pend ? pend.reason : t.reasons.apply) + ')' : ' (no change)'));
                if (target === 'aa') status(null, activation ? { aapd: activation } : null);
                else status(activation ? { carplay: activation } : {});
            }
            quitWhenIdle();
        });
    });
}

function handle(line, sock) {
    var msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'status') { status(); return; }
    if (msg.cmd === 'logs') {
        /* The captured carplay and AVB lines (markers flagged), dlt-receive's
         * health and patchd's own log, for the remote diagnostic endpoint; now
         * is patchd's clock, to read the times against. Reply only to the
         * asking client. */
        captureCommand('status', function (capture) {
            dlt.window = capture;
            readState(function (st) {
                readAaState(function (aa) {
                    reply(sock, { ev: 'logs', now: Date.now(), patch: st.state, panel: st.panel, mode: st.mode, res: st.res, safe: st.safe,
                                  aa: aaMsg(aa), carplay: carplayLines.slice(), markers: markerLines.slice(),
                                  avb: avbLines.slice(), dlt: dlt, patchd: logLines.slice() });
                });
            });
        });
        return;
    }
    if (quitting && msg.cmd === 'capture-start') return;
    if (msg.cmd === 'capture-start' || msg.cmd === 'capture-stop' || msg.cmd === 'capture-status') {
        captureCommand(msg.cmd.slice(8), function (state) {
            reply(sock, { ev: 'capture-reply', capture: state });
            send({ ev: 'capture', capture: state });
        });
        return;
    }
    if (msg.cmd === 'target') {
        /* Only a known display choice, and only the target line: the render
         * reads it at its next start. Not an operation on carplay, so it is
         * not held back by one. */
        var t = String(msg.target || '');
        if (DISPLAY_TARGETS.indexOf(t) < 0) {
            try { sock.write(JSON.stringify({ ev: 'target-reply', ok: false, reason: 'unknown target ' + t }) + '\n'); } catch (e) {}
            return;
        }
        saveSetting('target', t, function (err) {
            if (!err) rememberForProfile('target', t);
            if (err) log('saving the display choice failed: ' + err.message);
            else log('display: ' + t + ' (saved for the next start)');
            try { sock.write(JSON.stringify({ ev: 'target-reply', ok: !err, target: t, reason: err ? err.message : undefined }) + '\n'); } catch (e) {}
        });
        return;
    }
    if (msg.cmd === 'profile') {
        /* The driver profile now (the app reads the head unit's current user
         * account). A profile with saved settings gets them back: saved for
         * the render's next start, and in the reply for the app to apply now.
         * One seen for the first time keeps the current settings as its own. */
        var id = String(msg.id || '').slice(0, 200);
        if (!id) {
            try { sock.write(JSON.stringify({ ev: 'profile-reply', ok: false, reason: 'no profile id' }) + '\n'); } catch (e) {}
            return;
        }
        var profiles = readProfiles(), cur = currentSettings(), saved = profiles[id];
        var changed = id !== currentProfile;
        currentProfile = id;
        var want = cur;
        if (saved && DISPLAY_TARGETS.indexOf(saved.target) >= 0) {
            want = { target: saved.target, hud_width_pct: Math.min(Number(saved.hud_width_pct) || 0, HUD_MAX_PCT) };
            if (want.target !== cur.target) saveSetting('target', want.target, function () {});
            if (want.hud_width_pct !== cur.hud_width_pct) saveSetting('hud_width_pct', String(want.hud_width_pct), function () {});
        } else {
            profiles[id] = cur;
            writeProfiles(profiles);
        }
        if (changed) log('driver profile ' + id + ': ' + want.target + (want.target === 'hud' ? ', HUD map ' + (want.hud_width_pct || 'standard') + (want.hud_width_pct ? ' %' : '') : '') + (saved ? '' : ' (first seen: the current settings kept for it)'));
        try { sock.write(JSON.stringify({ ev: 'profile-reply', ok: true, id: id, known: !!saved, target: want.target, hud_width_pct: want.hud_width_pct }) + '\n'); } catch (e) {}
        return;
    }
    if (msg.cmd === 'hud-size') {
        var pct = Number(msg.hud_width_pct);
        if (!(pct === 0 || (pct >= 20 && pct <= 100 && pct === Math.floor(pct)))) {
            try { sock.write(JSON.stringify({ ev: 'hud-size-reply', ok: false, reason: 'HUD width must be 0 or 20-85 %' }) + '\n'); } catch (e) {}
            return;
        }
        if (pct > HUD_MAX_PCT) pct = HUD_MAX_PCT;   /* the widest the HUD shows whole (an older app asks for 100) */
        saveSetting('hud_width_pct', String(pct), function (err) {
            if (!err) rememberForProfile('hud_width_pct', pct);
            if (err) log('saving the HUD map size failed: ' + err.message);
            else log('HUD map size: ' + (pct ? pct + ' %' : 'default') + ' (saved for the next start)');
            try { sock.write(JSON.stringify({ ev: 'hud-size-reply', ok: !err, hud_width_pct: pct, reason: err ? err.message : undefined }) + '\n'); } catch (e) {}
        });
        return;
    }
    if (msg.cmd === 'reboot') { rebootCmd(sock); return; }

    /* A command not taken changes no state: only the asker hears why. */
    function refuse(why) { reply(sock, { ev: 'refused', cmd: msg.cmd, reason: why }); }
    if (busy || quitting || rebooting) {
        refuse(quitting ? 'patchd is stopping' : rebooting ? 'a restart is in progress' : 'another operation is running');
        return;
    }

    var hu = (msg.cmd === 'apply' || msg.cmd === 'aa-apply') && headUnit.refused();
    if (hu) { log(msg.cmd + ' refused: ' + hu); refuse(hu); return; }
    if (/^(aa-)?(apply|revert)$/.test(msg.cmd) && headUnit.variant() === 'HIGHF') highfMark(/^aa-/.test(msg.cmd) ? AA : CP, 'user');

    if (msg.cmd === 'apply' || msg.cmd === 'revert') {
        var panel = msg.panel;
        var mode = (msg.mode === 'avb' || msg.mode === 'udp') ? msg.mode : 'fifo';   /* capture mode; default fifo */
        operate('carplay', msg.cmd === 'apply' ? 'applying' : 'reverting',
            msg.cmd === 'apply' ? function (cb) { apply(panel, mode, false, true, cb); } : function (cb) { revert(false, false, cb); });
    } else if (msg.cmd === 'aa-apply') {
        operate('aa', 'applying', function (cb) { aaApply(false, cb); });
    } else if (msg.cmd === 'aa-revert') {
        operate('aa', 'reverting', function (cb) { aaRevert(false, false, cb); });
    } else if (msg.cmd === 'aa-density' || msg.cmd === 'aa-card') {
        var density = msg.cmd === 'aa-density', v = density ? Number(msg.value) : String(msg.value), now = Date.now();
        if ((density ? aapdConf.DENSITIES : aapdConf.CARDS).indexOf(v) < 0) {
            refuse(density ? 'density must be ' + aapdConf.DENSITY_MIN + '-' + aapdConf.DENSITY_MAX + ' in steps of ' + aapdConf.DENSITY_STEP
                : 'card must be ' + aapdConf.CARDS.join(' or '));
            return;
        }
        if (now - lastDensityAt < DENSITY_SPACING_MS) { refuse('changed moments ago; try again in a few seconds'); return; }
        lastDensityAt = now;
        try { saveFile(density ? AA_DPI_FILE : AA_CARD_FILE, v + '\n'); } catch (e) {
            aaError = 'saving the choice failed: ' + e.message;
            status(null, { state: 'error', reason: aaError });
            return;
        }
        log('Android Auto: ' + (density ? 'density ' + v + ' dpi' : 'turn card ' + v) + ' chosen');
        /* A patch of ours on disk gets the new geometry; otherwise the choice
         * waits for the next apply. Busy from here on. */
        busy = 'aa';
        readAaState(function (aa) {
            if ((aa.binary === 'patched' || aa.pending === 'apply') && !headUnit.refused()) { operate('aa', 'applying', function (cb) { aaApply(false, cb); }); return; }
            busy = null;
            status();
            quitWhenIdle();
        }, true);
    }
}

function accept(sock) {
    clients.push(sock);
    sock.setEncoding('utf8');
    var buf = '';
    sock.on('data', function (d) {
        buf += d;
        if (buf.length > MAX_LINE) { try { sock.destroy(); } catch (e) {} return; }
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) handle(line.trim(), sock);
        }
    });
    sock.on('error', function () {});
    sock.on('close', function () { clients = clients.filter(function (c) { return c !== sock; }); });
    /* The backlog, then the current state. */
    logLines.forEach(function (l) { reply(sock, { ev: 'log', line: l }); });
    status();
}

/* Make the socket's directory exist and be a real directory this process's
 * user (root on the unit) owns, not a symlink or a folder another user planted
 * in the sticky, world-writable /dev/shm (the guard mgu-updater uses). Refuse
 * rather than chown/chmod through someone else's symlink. The
 * waze-on-cluster.socket unit normally creates it as root at boot before this
 * runs; a fresh install's activate creates it before that. */
function ensureDir(dir) {
    var st;
    try { st = fs.lstatSync(dir); } catch (e) { st = null; }
    if (st) {
        if (!st.isDirectory() || st.uid !== (process.getuid ? process.getuid() : 0)) {
            throw new Error(dir + ' is not a directory of uid ' + (process.getuid ? process.getuid() : 0) + '; refusing (uid ' + (st.uid) + ', symlink ' + st.isSymbolicLink() + ')');
        }
    } else {
        fs.mkdirSync(dir, 0o755);
    }
    fs.chmodSync(dir, 0o755);
}

/* ---- install-time activation (patchd.js activate | deactivate) ---------- */

/* What activate and deactivate do with a target as its state reads: { op:
 * "apply" | "revert", or none and why }. activate applies the patch
 * CarPlay's Patch button applies to
 * a known file without a conflict: a proven original (no backup of ours) or
 * a patch of ours, any configuration of it, which the patcher brings up to
 * date or leaves as it is; an original with our backup was reverted by the
 * user and stays so (reset applies it: highfReset), a patch boot recovery
 * removed stays so whatever is left of it, as does a pending change other
 * than a removal's revert. After a removal's revert an install patches a proven build again;
 * a build outside the proven list, its backup dropped, stays reverted (a
 * conflict). deactivate reverts a patch of ours, a pending one too, also one
 * the patcher no longer recognises when our verified backup of the same
 * build differs from it (restorable), and drops our backup, so a later
 * install starts from the original as a fresh one does. */
function plan(which, st, name, reset) {
    if (st.pending && which === 'activate' && !(st.pending === 'revert' && st.pendingBy === 'removal')) {
        return { why: 'a change already waits for the next head-unit start' };
    }
    if (which === 'deactivate' && st.restorable) return { op: 'revert' };
    if (which === 'activate' && st.recovered) {
        return { why: 'boot recovery removed the patch after ' + st.recovered + ' failed head-unit start' + (st.recovered === 1 ? '' : 's') + '; its Patch button applies it' };
    }
    if (st.conflict && (which === 'activate' || !st.known || st.otherBuild)) return { conflict: st.conflict };
    if (which === 'deactivate') return st.binary === 'original' && !st.backup ? { why: name + ' is the original' } : { op: 'revert' };
    if (st.binary === 'original' && st.backup) return reset ? { op: 'apply', reset: true } : { why: 'the patch was turned off; its Patch button applies it' };
    return { op: 'apply' };
}

/* waze-on-cluster 0.8.2 refused HIGH F head units, and its boot recovery
 * put every patch of ours there back to the original, keeping the backup,
 * as a Remove patch does; nothing on disk tells the two apart. So an install
 * on a HIGH F unit applies the patch to a target HIGHF_MARKER does not name
 * that is exactly the original its trusted backup records: every file of t
 * with a backup has a record whose SHA-256 is the backup's and the file's,
 * and carplay's build is a proven one. The marker names a target once an
 * install applied it this way ("applied") or found nothing to put back
 * ("left"), or once its Patch or Remove patch button was used ("user"). */
var highfInstall = false;
function highfKey(t) { return t === AA ? 'aa' : 'carplay'; }
function highfMarked() {
    try { return JSON.parse(fs.readFileSync(HIGHF_MARKER, 'utf8')) || {}; } catch (e) { return {}; }
}
function highfMark(t, how) {
    var m = highfMarked();
    if (m[highfKey(t)]) return;
    m[highfKey(t)] = how;
    try { saveFile(HIGHF_MARKER, JSON.stringify(m) + '\n'); } catch (e) { log(HIGHF_MARKER + ': ' + e.message); }
}
function highfReset(t, st) {
    if (!highfInstall || highfMarked()[highfKey(t)] || (t === CP && !st.proven)) return false;
    var files = (t === AA ? [AAPD, AAPD_CONF] : [TARGET]).filter(function (f) { return fs.existsSync(f + '.woc-orig'); });
    return files.indexOf(t.target) >= 0 && files.every(function (f) {
        var meta = null;
        try { meta = JSON.parse(fs.readFileSync(f + '.woc-orig.json', 'utf8')); } catch (e) {}
        return !!meta && !!meta.sha256_original && sha(f + '.woc-orig') === meta.sha256_original && sha(f) === meta.sha256_original;
    });
}

function sha(f) {
    try { return require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return null; }
}

/* One target's hook step: cb(code, { status, conflict }). Exit code 1 only
 * when it changed nothing and could not do its job. */
/* After a removal, nothing of Android Auto's may be left to undo: each file
 * is at its original, has no backup of ours, or is another build. */
function aaUndone(st) {
    var m = /^aapd (\w+), aapd\.conf (\w+)$/.exec(st.undo || '');
    return !st.unreadable && !st.restorable && !!m && [m[1], m[2]].every(function (u) { return /^(none|original|other)$/.test(u); });
}

function hookStep(which, t, read, run, done) {
    var label = t === AA ? 'Android Auto' : 'map';
    function cb(code, r) {
        if (code || t !== AA || which !== 'deactivate') { done(code, r); return; }
        read(function (st) {
            if (st.state === 'absent' || aaUndone(st)) { done(0, r); return; }
            r = { status: 'Android Auto not undone (' + (st.unreadable ? st.conflict : st.undo) + '): the tool stays to guard it', conflict: r.conflict };
            log(which + ': ' + r.status);
            done(1, r);
        });
    }
    read(function (st) {
        if (t === AA && st.state === 'absent') { cb(0, { status: st.conflict }); return; }
        /* A removal leaves Android Auto only when it knows aapd is not ours
         * to undo; an unreadable state keeps the tool and its recovery. */
        if (t === AA && which === 'deactivate' && st.unreadable) {
            log(which + ': ' + st.conflict);
            cb(1, { status: 'Android Auto state unreadable: the tool stays to guard it', conflict: st.conflict });
            return;
        }
        var p = plan(which, st, t.name, highfReset(t, st)), off = st.binary === 'original' && !!st.backup;
        /* A HIGH F install is done with a target it applied, or with one that
         * has nothing to put back; a turned-off one it left is tried again. */
        function settle(r) { if (highfInstall && !r.conflict && (r.reset || !off)) highfMark(t, r.reset ? 'applied' : 'left'); }
        if (!p.op) {
            var r = { status: p.conflict ? t.name + ' left as it is: ' + p.conflict : p.why };
            if (p.conflict) r.conflict = p.conflict;
            log(which + ': ' + r.status);
            settle(r);
            cb(0, r);
            return;
        }
        var files = t === AA ? [AAPD, AAPD_CONF] : [TARGET];
        var before = files.map(sha).join();
        log(which + ': ' + (p.op === 'apply' ? 'applying' : 'reverting') + ' the ' + label + ' patch');
        run(p.op, function (pErr, roErr, activation, refused, aaRun) {
            var written = files.map(sha).join() !== before;
            if (roErr) log('WARNING: ' + roErr.message + ' — the next head-unit start mounts / read-only again');
            if (written && pErr) writePending(t, p.op, aaRun);
            var r = {};
            if (written || !pErr) {
                if (p.reset && written) r.reset = true;
                r.status = activation === 'deferred' || written ? label + ' patch ' + (p.op === 'apply' ? 'written' : 'removed') +
                    (pErr ? ' (' + pErr.message + ')' : '') : t.name + ' already as wanted';
                log(which + ': ' + r.status);
                settle(r);
                cb(0, r);
                return;
            }
            /* The patcher would not touch it: left as it is, for the user. */
            if (refused && /refusing|requires the pristine|not a proven build|not a recognised|no backup/.test(refused)) {
                r.status = t.name + ' left as it is: ' + refused;
                r.conflict = refused;
                log(which + ': ' + r.status);
                cb(0, r);
                return;
            }
            r.status = (p.op === 'apply' ? 'applying' : 'reverting') + ' the ' + label + ' patch failed: ' + pErr.message;
            log(which + ': ' + r.status);
            cb(1, r);
        });
    });
}

/* Runs activate or deactivate once and exits; the last stdout line is its
 * JSON result. Never stops or restarts carplay or aapd. CarPlay first: when
 * its step fails, Android Auto's does not run, so the install's rollback or
 * the refused removal finds Android Auto as it was. Android Auto's outcome
 * never fails an install: a refused or unsupported aapd is a conflict, and
 * one that could not be written is retried by the next install or Android
 * Auto's Patch button.
 * A removal that could not undo Android Auto's patch is refused, so the
 * boot recovery that guards it stays. */
function oneShot(which) {
    var result = {};
    hookDeadline = Date.now() + HOOK_DEADLINE_MS;
    function finish(code) {
        lock.release();
        /* After the removal nothing of this tool is left to remove the links:
         * one that holds nothing goes now; one left (a process runs it, or
         * dropping it failed) goes to the deploy tool, which removes it once
         * nothing runs it. A target's own file is not a link to hand over. */
        (which === 'deactivate' && Date.now() < hookDeadline - RO_RESERVE_MS ? dropUnusedRunning : function (cb) { cb(); })(function () {
            [CP, AA].forEach(function (t) {
                var p = readPending(t);
                if (p && !result.reboot) result.reboot = p.reason;
                if (which === 'deactivate' && fs.existsSync(t.running) && !sameInode(t.running, t.target))
                    (result.removeWhenUnused = result.removeWhenUnused || []).push(t.running);
                /* A revert pending when the tool goes is the removal's: an
                 * install before the next start patches again. */
                if (which === 'deactivate' && p && p.action === 'revert' && p.by !== 'removal') writePending(t, 'revert', p.run);
            });
            process.stdout.write(JSON.stringify(result) + '\n');
            process.exit(code);
        });
    }
    if (which === 'deactivate') markBy = 'removal';
    highfInstall = which === 'activate' && headUnit.variant() === 'HIGHF';
    try { ensureDir(path.dirname(SOCK)); } catch (e) { result.status = e.message; finish(1); return; }
    lock.acquire(20000, function (got) {
        if (!got) {
            result.status = 'the remount lock stayed held; nothing changed';
            log(which + ': ' + result.status);
            finish(1);
            return;
        }
        hookStep(which, CP, readState, function (op, cb) {
            if (op === 'apply') apply('high', 'avb', true, false, cb); else revert(true, true, cb);
        }, function (code, r) {
            result.status = r.status;
            if (r.conflict) result.conflict = r.conflict;
            if (r.reset) result.reset = true;
            if (code) { finish(code); return; }
            if (hookDeadline - Date.now() < AA_HOOK_MIN_MS) {
                result.aa = { status: which === 'deactivate' ? 'Android Auto not undone: out of time; the tool stays to guard it'
                    : 'Android Auto left as it is: out of time; the next install or Android Auto\'s Patch button applies it' };
                log(which + ': ' + result.aa.status);
                finish(which === 'deactivate' ? 1 : 0);
                return;
            }
            hookStep(which, AA, readAaState, function (op, cb) {
                if (op === 'apply') aaApply(true, cb); else aaRevert(true, true, cb);
            }, function (aaCode, aaR) {
                result.aa = aaR;
                finish(which === 'deactivate' ? aaCode : 0);
            });
        });
    });
}

function main() {
    var dir = path.dirname(SOCK);
    ensureDir(dir);
    try { if (fs.lstatSync(SOCK)) fs.unlinkSync(SOCK); } catch (e) {}

    var server = net.createServer(accept);
    /* Links left from before the last head-unit start go before the socket
     * opens. */
    dropUnusedRunning(function () { server.listen(SOCK, function () {
        if (process.getuid && process.getuid() === 0 && SOCK_GROUP) {
            var gid = groupId(SOCK_GROUP);
            if (gid >= 0) try { fs.chownSync(SOCK, 0, gid); } catch (e) {}
        }
        try { fs.chmodSync(SOCK, 0o660); } catch (e) {}
        log('patchd listening on ' + SOCK);
        followCarplayJournal();
        followAvbJournal();
        followDlt();
        setInterval(function () {
            captureCommand('status', function (state) { send({ ev: 'capture', capture: state }); });
        }, 1000);
    }); });
    server.on('error', function (e) { process.stderr.write('patchd: ' + e.message + '\n'); process.exit(1); });
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
}

if (process.argv[2] === 'activate' || process.argv[2] === 'deactivate') oneShot(process.argv[2]);
else main();
