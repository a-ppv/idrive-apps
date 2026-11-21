// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* carplay's or aapd's process in a fake /proc (WOC_PROC), for the host
 * tests of the patches in memory: <proc>/<pid>/exe is a hard link to the
 * file it runs (its inode), maps maps that file at BASE from offset 0, and
 * mem holds each loaded segment of the file at BASE plus its address, as
 * inmem.js's memory check reads it. A start the boot step armed
 * (<run>/<name>.env, with the plan at <run>/<name>.plan) holds the plan's
 * bytes at its sites, as libwocpatch.so writes them, environ holds the env
 * file's variables, and its result (<run>/<name>.result, when the boot step
 * made that file) names the pid. The service is one process: a start ends
 * any other in the fake /proc.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var BASE = 0x1000;

/* Ends every process of the fake /proc. */
function stop(proc) {
    var pids = [];
    try { pids = fs.readdirSync(proc).filter(function (n) { return /^\d+$/.test(n); }); } catch (e) {}
    pids.forEach(function (p) { cp.execFileSync('rm', ['-rf', path.join(proc, p)]); });
}

/* The bytes at the process's addresses: buf's loaded segments at their
 * addresses (the whole file at 0 where buf is no ELF). */
function writeMem(memFile, buf) {
    var elf = require('../carplay_locate.js').elf.parseElf(buf), fd = fs.openSync(memFile, 'w');
    try {
        if (!elf.load || !elf.load.length) fs.writeSync(fd, buf, 0, buf.length, BASE);
        else elf.load.forEach(function (s) { fs.writeSync(fd, buf, s.off, s.size, BASE + s.va); });
    } finally { fs.closeSync(fd); }
}

/* The service `name` (default carplay) started as process pid from file;
 * runDir: the boot step's folder (WOC_PRELOAD_DIR). 'patched' when the start
 * was armed and the library applied the plan, 'refused' when it was armed
 * and the library refused it, else 'stock'. */
function start(proc, pid, file, runDir, name) {
    name = name || 'carplay';
    stop(proc);
    var pd = path.join(proc, String(pid)), buf = fs.readFileSync(file), how = 'stock';
    fs.mkdirSync(pd);
    fs.linkSync(file, path.join(pd, 'exe'));
    fs.writeFileSync(path.join(pd, 'maps'), '00000800-00000900 r--p 00000000 00:01 1 /lib/ld-linux-x86-64.so.2\n' +
        BASE.toString(16).padStart(8, '0') + '-00400000 r-xp 00000000 fd:00 ' + fs.statSync(file).ino + ' /usr/bin/' + name + '\n');
    var env = runDir ? path.join(runDir, name + '.env') : null, plan = runDir ? path.join(runDir, name + '.plan') : null;
    fs.writeFileSync(path.join(pd, 'environ'), env && fs.existsSync(env) ? fs.readFileSync(env, 'utf8').split('\n').filter(Boolean).join('\0') + '\0' : 'PATH=/bin\0');
    if (env && fs.existsSync(env) && fs.existsSync(plan)) {
        var o = require('../carplay_patch.js').overlay(buf, fs.readFileSync(plan, 'utf8')), result = path.join(runDir, name + '.result');
        if (o.err) how = 'refused';
        else { buf = o.buf; how = 'patched'; }
        if (fs.existsSync(result)) {
            fs.writeFileSync(result, JSON.stringify(o.err ? { v: 1, pid: pid, applied: false, why: o.err } : { v: 1, pid: pid, applied: true, edits: o.edits }) + '\n');
        }
    }
    writeMem(path.join(pd, 'mem'), buf);
    return how;
}

module.exports = { start: start, stop: stop, BASE: BASE };
