// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';

var fs = require('fs');
var net = require('net');
var path = require('path');

var DIR = process.env.WOC_CAPTURE_DIR || '/run/woc-dlt-capture';
// dlt-daemon's compiled-in default; /etc/dlt.conf leaves ControlSocketPath unset.
var CTRL = process.env.WOC_DLT_SOCKET || '/run/dlt-files/dlt-ctrl.sock';
var PORT = Number(process.env.WOC_DLT_PORT || 3490);
var TRACE = process.env.WOC_TRACE_DIR || '/run/logntrace';
var TIMEOUT = 2000;
/* The capture window spans a whole map test: disconnect the phone,
 * reconnect, the CarPlay handshake and the projection config — the markers only
 * exist over DLT for the few seconds of that config, so a short window misses
 * them. Still bounded and auto-restored. */
var DURATION = Math.min(Number(process.env.WOC_CAPTURE_MS) || 300000, 300000);
var RETRY = Number(process.env.WOC_CAPTURE_RETRY_MS) || 5000;
var STATE = path.join(DIR, 'state.json');
var PROC = process.env.WOC_DLT_PROC || '/proc';
// The capture's default log level, INFO: the level the log-and-trace manager
// sets when it turns tracing on. A lower one is raised for the window only.
var LEVEL = 4;

// The firmware control dispatcher dereferences its application table before
// dispatching any request. An app FIFO held by the daemon proves registration;
// an empty daemon must receive no control requests (including restores).
function registeredClient() {
    return fs.readdirSync(PROC).filter(function (pid) { return /^\d+$/.test(pid); }).some(function (pid) {
        try {
            if (fs.readFileSync(path.join(PROC, pid, 'comm'), 'utf8').trim() !== 'dlt-daemon') return false;
            var dir = path.join(PROC, pid, 'fd');
            return fs.readdirSync(dir).some(function (fd) {
                try { return /\/dltpipes\/dlt\d+$/.test(fs.readlinkSync(path.join(dir, fd))); }
                catch (err) { return false; }
            });
        } catch (err) { return false; }
    });
}

// A control request on the daemon's socket, as libdlt's dlt-control sends it
// (UEH/WEID/WTMS, ECU MGHS, APP/CON). Resolves with the response payload after
// its service id: the status byte, then the service's own data.
function request(service, data) {
    return new Promise(function (resolve, reject) {
        if (!registeredClient()) return reject(new Error('No registered DLT client; control request refused'));
        var socket = net.connect(CTRL), buf = Buffer.alloc(0), finished = false;
        var timer = setTimeout(function () { done(new Error('DLT acknowledgement timed out')); }, TIMEOUT);
        function done(err, reply) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.destroy();
            if (err) reject(err); else resolve(reply);
        }
        socket.on('error', done);
        socket.on('end', function () { done(new Error('DLT closed without acknowledgement')); });
        socket.on('connect', function () {
            var head = Buffer.from('3500001b4d47485300000000160141505000434f4e00', 'hex');
            var id = Buffer.alloc(4);
            id.writeUInt32LE(service, 0);
            head.writeUInt16BE(head.length + 4 + data.length, 2);
            socket.write(Buffer.concat([head, id, Buffer.from(data)]));
        });
        socket.on('data', function (data) {
            buf = Buffer.concat([buf, data]);
            if (buf.length > 65536) return done(new Error('DLT response too large'));
            while (buf.length >= 4) {
                var htyp = buf[0], length = buf.readUInt16BE(2);
                var extra = ((htyp & 4) ? 4 : 0) + ((htyp & 8) ? 4 : 0) + ((htyp & 16) ? 4 : 0);
                var ext = 4 + extra, payload = ext + ((htyp & 1) ? 10 : 0);
                if ((htyp >> 5) !== 1 || length < payload) return done(new Error('Invalid DLT header'));
                if (buf.length < length) return;
                var frame = buf.slice(0, length);
                buf = buf.slice(length);
                if (!(htyp & 1) || frame[ext] !== 0x26 || length < payload + 5) continue;
                var id = (htyp & 2) ? frame.readUInt32BE(payload) : frame.readUInt32LE(payload);
                if (id !== service) continue;
                done(null, frame.slice(payload + 4));
                return;
            }
        });
    });
}

// BMW's 0xf13 service uses OFF=0, ON=1, BUFFER=2. This is a control request,
// not the similarly named persistent user LoggingMode service.
function setMode(mode) {
    return request(0xf13, [mode]).then(function (reply) {
        if (reply[0] !== 0) throw new Error('DLT rejected mode: ' + reply[0]);
    });
}

// The default log level (OFF=0 .. VERBOSE=6) applies to every context that
// has no level of its own; at OFF those send nothing even while tracing is ON.
function getLevel() {
    return request(0x04, []).then(function (reply) {
        if (reply[0] !== 0) throw new Error('DLT rejected default log level read: ' + reply[0]);
        if (reply.length < 2 || reply[1] > 6) throw new Error('Invalid DLT default log level');
        return reply[1];
    });
}

function setLevel(level) {
    return request(0x11, [level, 0x72, 0x65, 0x6d, 0x6f]).then(function (reply) {
        if (reply[0] !== 0) throw new Error('DLT rejected default log level: ' + reply[0]);
    });
}

async function listening() {
    // Connecting a probe client would drain the daemon's buffered startup logs.
    var read = false, open = false;
    ['tcp', 'tcp6'].forEach(function (name) {
        try {
            var text = fs.readFileSync(path.join(PROC, 'net', name), 'utf8');
            read = true;
            text.split('\n').forEach(function (line) {
                var fields = line.trim().split(/\s+/);
                if (fields[3] === '0A' && parseInt((fields[1] || '').split(':')[1], 16) === PORT) open = true;
            });
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
    });
    if (!read) throw new Error('Cannot read DLT listener state from procfs');
    return open;
}

function secureDir() {
    try { fs.mkdirSync(DIR, 0o700); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    var st = fs.lstatSync(DIR);
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077))
        throw new Error('Capture directory must be owned by the service user, mode 0700');
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
    catch (err) {
        if (err.code === 'ENOENT') return { state: 'closed', owned: false, closes_at: null, error: null };
        throw err;
    }
}

function writeState(state) {
    fs.writeFileSync(STATE + '.tmp', JSON.stringify(state) + '\n', { mode: 0o600 });
    fs.renameSync(STATE + '.tmp', STATE);
}

// The daemon has no mode getter; its iDLT records name the mode. Each
// lifecycle (a resume included) starts a new <lifecycle>_dltd.idlt from the
// daemon and <lifecycle>_LTM.idlt from the log-and-trace manager, and an
// older lifecycle's files may be gone. Lines read "<date> <time> <monotonic
// ms> <text>"; both writers use CLOCK_MONOTONIC.
var DAEMON_RECORDS = [
    // Its state changes. A client closing also writes "buffer state", but only
    // while the listener is open or within a mode request that records itself.
    [/Tracing OFF: Switched to log mode off state/, 0],
    [/Tracing ON: Switched to buffer state for socket connections/, 2],
    [/Tracing ON: Switched to send direct state/, null],
    // Every 0xf13 request it handled, also one that changed nothing.
    [/Control message received: Log mode set: OFF\s*$/, 0],
    [/Control message received: Log mode set: BUFFER\s*$/, 2],
    [/Control message received: Log mode set: ON\s*$/, 1]
];
// The manager runs dlt-control -z only when its own last mode differs, and
// writes "successful" also when it sent nothing. Such a record therefore says
// what the daemon was last told, and has no daemon record of its own.
var LTM_RECORD = /Sending logmode (OFF|ON|BUFFER) to daemon (successful|unsuccessful)\s*$/;
var LTM_MODES = { OFF: 0, ON: 1, BUFFER: 2 };

// The newest mode record of one file, as { time, mode } (mode null: refuse).
function newestRecord(file, read) {
    var st;
    try { st = fs.statSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    // A file at either writer's 500-line cap may have dropped a newer record.
    if (st.size > 256 * 1024) throw new Error('DLT state record too large');
    var lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (lines.length >= 500) throw new Error('DLT state record saturated; starting mode unknown');
    var found = null;
    lines.forEach(function (line) {
        var mode = read(line);
        if (mode === undefined) return;
        var time = /^\S+ \S+ (\d+) /.exec(line);
        found = { time: time ? Number(time[1]) : NaN, mode: mode };
    });
    return found;
}

function daemonMode(line) {
    for (var i = 0; i < DAEMON_RECORDS.length; i++) if (DAEMON_RECORDS[i][0].test(line)) return DAEMON_RECORDS[i][1];
}

function ltmMode(line) {
    var m = LTM_RECORD.exec(line);
    if (m) return m[2] === 'successful' ? LTM_MODES[m[1]] : null;
}

// The starting mode, from the newest record that names one. A daemon record
// newer than the manager's decides. A manager record that is newer must agree
// with the daemon's newest: had it sent its mode, the daemon would have
// recorded that request after its own older record. A closed TCP listener
// tells BUFFER from ON. Anything else refuses.
function baseline() {
    var numbers = {};
    fs.readdirSync(TRACE).forEach(function (name) {
        var m = /^(\d+)_(?:dltd|LTM)\.idlt$/.exec(name);
        if (m) numbers[m[1]] = Number(m[1]);
    });
    var order = Object.keys(numbers).map(function (k) { return numbers[k]; }).sort(function (a, b) { return b - a; });
    var daemon = null, ltm = null;
    for (var i = 0; i < order.length && !daemon; i++) {
        var n = order[i];
        daemon = newestRecord(path.join(TRACE, n + '_dltd.idlt'), daemonMode);
        if (daemon) daemon.lifecycle = n;
        if (!ltm) {
            ltm = newestRecord(path.join(TRACE, n + '_LTM.idlt'), ltmMode);
            if (ltm) ltm.lifecycle = n;
        }
    }
    var mode;
    if (ltm && (!daemon || ltm.lifecycle > daemon.lifecycle ||
        (ltm.lifecycle === daemon.lifecycle && !(ltm.time < daemon.time)))) {
        if (daemon && daemon.mode !== ltm.mode) throw new Error('DLT state records disagree; capture refused');
        mode = ltm.mode;
    } else if (daemon) mode = daemon.mode;
    if (mode === 0 || mode === 2) return mode;
    throw new Error('Starting DLT mode unknown; capture refused');
}

function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function restore() {
    var state = readState();
    if (!state.owned) return state;
    if (state.restore_mode !== 0 && state.restore_mode !== 2) throw new Error('Invalid saved DLT restore mode');
    var level = state.restore_level;
    if (level !== undefined && level !== null && !(Number.isInteger(level) && level >= 0 && level < LEVEL))
        throw new Error('Invalid saved DLT restore level');
    state.state = 'closing';
    state.closes_at = null;
    writeState(state);
    var last;
    for (var i = 0; i < 3; i++) {
        try {
            await setMode(state.restore_mode);
            if (level !== undefined && level !== null) await setLevel(level);
            if (await listening()) throw new Error('DLT listener still open after restore');
            state.state = 'closed';
            state.owned = false;
            state.error = null;
            writeState(state);
            return state;
        } catch (err) {
            last = err;
            if (i < 2) await delay(200);
        }
    }
    state.state = 'restore_failed';
    state.error = last.message;
    writeState(state);
    return state;
}

/* The capture service: its control socket (start, stop, status), the
 * capture window of at most DURATION and the restore retried every RETRY.
 * fault(err) is called once with what would end the standalone process (a
 * failed start, a restore that throws, a socket error); the service is down
 * then: socket closed, timers cleared. Returns { stop(cb) }: takes the
 * service down, waits for a step in progress (an opening capture, a
 * restore) to end, restores a capture it owns, then cb(err). */
function serve(fault) {
    var state = null, busy = false, timer = null, stopping = false, server = null, retry = null;
    var down = false, running = 0, idle = [], stopped = null;
    function end(err) {
        if (down) return;
        down = true;
        clearTimeout(timer);
        timer = null;
        clearInterval(retry);
        if (server) try { server.close(); } catch (e) {}
        if (err) fault(err);
    }
    /* Each asynchronous step; one that fails takes the service down. */
    function step(fn) {
        running++;
        fn().then(settled, function (err) { settled(); end(err); });
    }
    function settled() { if (--running === 0) idle.splice(0).forEach(function (f) { f(); }); }
    function whenIdle(f) { if (running) idle.push(f); else f(); }
    function closeLater() { if (!down) step(close); }
    (async function () {
        secureDir();
        state = await restore();
        if (down) return;
        server = net.createServer(accept);
        server.on('error', end);
        var sock = path.join(DIR, 'control.sock');
        try { fs.unlinkSync(sock); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        server.listen(sock, function () { try { fs.chmodSync(sock, 0o600); } catch (err) { end(err); } });
        retry = setInterval(function () { if (state.owned && state.state === 'restore_failed' && !busy) closeLater(); }, RETRY);
    })().catch(end);
    function accept(socket) {
        var buf = '';
        socket.setTimeout(3000, function () { socket.destroy(); });
        socket.on('error', function () {});
        socket.on('data', function (data) {
            if (down) return socket.destroy();
            buf += data;
            if (buf.length > 256) return socket.destroy();
            var i = buf.indexOf('\n');
            if (i < 0) return;
            socket.removeAllListeners('data');
            var command;
            try { command = JSON.parse(buf.slice(0, i)).cmd; } catch (err) { return socket.destroy(); }
            if (command === 'start' && !busy && !stopping && !state.owned) {
                busy = true;
                state = { state: 'opening', owned: false, closes_at: null, error: null };
                step(function () { return begin().then(function () { busy = false; if (stopping) closeLater(); }); });
            } else if (command === 'stop') closeLater();
            socket.end(JSON.stringify(state) + '\n');
        });
    }
    async function begin() {
        try {
            if (await listening()) throw new Error('Existing DLT listener active; capture refused');
            if (!registeredClient()) throw new Error('No registered DLT client; capture refused');
            var mode = baseline();
            var level = await getLevel();
            if (down) throw new Error('Capture service stopping; capture refused');
            state = { state: 'opening', owned: true, restore_mode: mode,
                restore_level: level < LEVEL ? level : null, closes_at: Date.now() + DURATION, error: null };
            // Record ownership before a change can reach the daemon.
            writeState(state);
            timer = setTimeout(closeLater, DURATION);
            if (state.restore_level !== null) await setLevel(LEVEL);
            await setMode(1);
            if (!(await listening())) throw new Error('DLT acknowledged ON but listener did not open');
            state.state = 'open';
            writeState(state);
        } catch (err) {
            clearTimeout(timer);
            timer = null;
            state.error = err.message;
            if (state.owned) {
                var openingError = err.message;
                state = await restore();
                state.error = openingError;
            } else state.state = 'refused';
            writeState(state);
        }
    }
    async function close() {
        clearTimeout(timer);
        timer = null;
        if (busy) { stopping = true; return; }
        busy = true;
        state = await restore();
        busy = false;
        stopping = false;
    }
    return {
        stop: function (cb) {
            if (stopped) { stopped.push(cb); return; }
            stopped = [cb];
            end(null);
            whenIdle(function () {
                function done(err) { stopped.forEach(function (f) { f(err || null); }); }
                restore().then(function (s) { done(s.owned ? new Error('restore failed: ' + s.error) : null); }, done);
            });
        }
    };
}

/* The capture service inside another daemon (patchd.js --dlt-capture), as
 * waze-on-cluster-capture.service ran it on its own: what would end that
 * process ends this service only, which then restores a capture it owns (as
 * that unit's ExecStopPost did) and starts again RESTART_MS later, at most
 * RESTART_BURST times in RESTART_WINDOW_MS (the unit's start limit), then
 * stays down until the daemon starts again. It never exits the process or
 * throws. log(line). Returns { stop(cb) }: takes it down and restores a
 * capture it owns, then cb(err), within STOP_MS whatever hangs. */
var RESTART_MS = Number(process.env.WOC_CAPTURE_RESTART_MS) || 5000;
var RESTART_BURST = 20;
var RESTART_WINDOW_MS = 600000;
var STOP_MS = 15000;
function host(log) {
    var part = null, starts = [], timer = null, quit = false, settling = null;
    function start() {
        timer = null;
        var now = Date.now();
        starts = starts.filter(function (t) { return now - t < RESTART_WINDOW_MS; });
        if (starts.length >= RESTART_BURST) {
            log('dlt-capture: ' + starts.length + ' starts in ' + RESTART_WINDOW_MS / 60000 + ' min; the capture stays off until patchd starts again');
            return;
        }
        starts.push(now);
        var me = part = serve(function (err) {
            log('dlt-capture: ' + err.message + '; it starts again in ' + RESTART_MS / 1000 + ' s');
            settling = me;
            me.stop(function (e) {
                if (e) log('dlt-capture: ' + e.message);
                settling = null;
                if (part === me) part = null;
                if (!quit) timer = setTimeout(start, RESTART_MS);
            });
        });
    }
    start();
    return {
        stop: function (cb) {
            var done = false, bound = setTimeout(function () { finish(new Error('capture stop out of time')); }, STOP_MS);
            function finish(err) { if (done) return; done = true; clearTimeout(bound); cb(err || null); }
            quit = true;
            clearTimeout(timer);
            var p = part || settling;
            if (p) p.stop(finish); else finish(null);
        }
    };
}

if (require.main === module) {
    var action = process.argv[2];
    var fail = function (err) { process.stderr.write('dlt-capture: ' + err.message + '\n'); process.exit(1); };
    if (action === 'restore') {
        Promise.resolve().then(function () { secureDir(); return restore(); }).then(function (s) {
            if (s.owned) throw new Error(s.error);
        }).catch(fail);
    } else {
        // waze-on-cluster-capture.service (earlier versions' unit, which a
        // downgrade lays again); systemd runs restore in its ExecStopPost,
        // including after SIGKILL or a failed start.
        serve(fail);
        process.on('unhandledRejection', fail);
        process.on('SIGTERM', function () { process.exit(0); });
        process.on('SIGINT', function () { process.exit(0); });
    }
}
module.exports = { listening: listening, getLevel: getLevel, host: host, RESTART_MS: RESTART_MS };
