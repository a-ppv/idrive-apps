// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A fake DLT daemon for the capture tests, in a folder of its own: its
 * control socket (acknowledges the default log level read, INFO, and each
 * mode change: ON opens its TCP listener, OFF and BUFFER close it and write
 * the iDLT record of the mode), its /proc entries (a registered client, the
 * listener's state) and the capture's folder. It answers from the calling
 * process, so a capture run against it must not block that process
 * (spawn, not spawnSync).
 *
 *   var dlt = await require('./fake_dlt.js')(dir);
 *   dlt.env        WOC_* for dlt_capture.js (and patchd's WOC_CAPTURE_SOCK)
 *   dlt.modes      the modes set, in order
 *   dlt.open()     the TCP listener is open
 *   dlt.trace(m)   the daemon's record of mode m (0 OFF, 2 BUFFER)
 *   dlt.state()    the capture's state.json, {} when unreadable
 *   dlt.command(c) one command on the capture's socket: its reply, or null
 *   dlt.close()
 */
'use strict';

var fs = require('fs');
var net = require('net');
var path = require('path');

function listen(server, address) { return new Promise(function (r) { server.listen(address, r); }); }

module.exports = async function fakeDlt(dir) {
    var CAP = path.join(dir, 'capture'), PROC = path.join(dir, 'proc'), TRACE = path.join(dir, 'trace');
    var env = { WOC_CAPTURE_DIR: CAP, WOC_DLT_SOCKET: path.join(dir, 'ctrl'), WOC_TRACE_DIR: TRACE, WOC_DLT_PROC: PROC,
        WOC_CAPTURE_SOCK: path.join(CAP, 'control.sock') };
    var modes = [], tcp = null, conns = [];
    fs.mkdirSync(path.join(PROC, '9', 'fd'), { recursive: true });
    fs.mkdirSync(path.join(PROC, 'net'));
    fs.mkdirSync(TRACE);
    fs.writeFileSync(path.join(PROC, '9', 'comm'), 'dlt-daemon\n');
    fs.symlinkSync('/run/dlt-files/dltpipes/dlt99', path.join(PROC, '9', 'fd', '10'));
    var reserve = net.createServer();
    await listen(reserve, { host: '127.0.0.1', port: 0 });
    env.WOC_DLT_PORT = String(reserve.address().port);
    await new Promise(function (r) { reserve.close(r); });
    function netState(open) {
        fs.writeFileSync(path.join(PROC, 'net', 'tcp'), open ? '0: 0100007F:' + Number(env.WOC_DLT_PORT).toString(16).toUpperCase() +
            ' 00000000:0000 0A\n' : 'sl local_address rem_address st\n');
    }
    async function openTCP() {
        if (tcp) return;
        tcp = net.createServer(function (c) { conns.push(c); c.on('error', function () {}); });
        await listen(tcp, { host: '127.0.0.1', port: Number(env.WOC_DLT_PORT) });
        netState(true);
    }
    async function closeTCP() {
        if (!tcp) return;
        netState(false);
        conns.forEach(function (c) { c.destroy(); });
        conns = [];
        var old = tcp;
        tcp = null;
        await new Promise(function (r) { old.close(r); });
    }
    function trace(mode) {
        fs.writeFileSync(path.join(TRACE, '12_dltd.idlt'), mode === 0 ? '2026/10/26 12:00:00 1 Tracing OFF: Switched to log mode off state \n'
            : '2026/10/26 12:00:00 1 Tracing ON: Switched to buffer state for socket connections \n');
    }
    var ctrl = net.createServer(function (c) {
        var buf = Buffer.alloc(0);
        c.on('error', function () {});
        c.on('data', async function (d) {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 4 || buf.length < buf.readUInt16BE(2)) return;
            var req = buf.slice(0, buf.readUInt16BE(2)), reply;
            buf = Buffer.alloc(0);
            var service = req.readUInt32LE(22);
            if (service === 0x04) reply = '3500001c4d47485300000000260141505000434f4e00040000000004';
            else if (service === 0xf13) {
                var mode = req[26];
                modes.push(mode);
                if (mode === 1) await openTCP(); else { await closeTCP(); trace(mode); }
                reply = '3500001b4d47485300000000260141505000434f4e00130f000000';
            } else return;
            c.end(Buffer.from(reply, 'hex'));
        });
    });
    netState(false);
    trace(2);
    await listen(ctrl, env.WOC_DLT_SOCKET);
    return {
        env: env,
        modes: modes,
        open: function () { return !!tcp; },
        trace: trace,
        state: function () { try { return JSON.parse(fs.readFileSync(path.join(CAP, 'state.json'), 'utf8')); } catch (e) { return {}; } },
        command: function (cmd) {
            return new Promise(function (resolve) {
                var c = net.connect(env.WOC_CAPTURE_SOCK), buf = '';
                var t = setTimeout(function () { c.destroy(); resolve(null); }, 2000);
                c.on('error', function () { clearTimeout(t); resolve(null); });
                c.on('connect', function () { c.write(JSON.stringify({ cmd: cmd }) + '\n'); });
                c.on('data', function (d) {
                    buf += d;
                    if (buf.indexOf('\n') < 0) return;
                    clearTimeout(t);
                    c.destroy();
                    try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
                });
            });
        },
        close: async function () { await closeTCP(); await new Promise(function (r) { ctrl.close(r); }); },
    };
};
