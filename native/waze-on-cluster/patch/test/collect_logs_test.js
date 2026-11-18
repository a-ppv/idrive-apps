#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* collect-logs.sh, run from a copy of the installed folder (the script
 * beside the patch tools): wifi.txt with stand-in /proc/net/dev, patchd's
 * band file, journalctl and dmesg; what logs_extra.js adds; patchd's
 * diagnostics; incidents.txt; and every file of the archive scrubbed, from
 * fixtures shaped as the car's logs (synthesized). */
'use strict';
var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-collect-'));
var CUR = path.join(dir, 'current');
fs.mkdirSync(CUR);
fs.copyFileSync(path.join(__dirname, '..', '..', 'tools', 'collect-logs.sh'), path.join(CUR, 'collect-logs.sh'));
fs.readdirSync(path.join(__dirname, '..')).filter(function (n) { return /\.js$/.test(n); }).forEach(function (n) {
    fs.copyFileSync(path.join(__dirname, '..', n), path.join(CUR, n));
});
var SCRIPT = path.join(CUR, 'collect-logs.sh');
var bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
var DEV = path.join(dir, 'net-dev'), BAND = path.join(dir, 'wifi-band.json');
var KERNEL = path.join(dir, 'journal-kernel'), DMESG = path.join(dir, 'dmesg-out');

/* journalctl -k prints KERNEL; other journalctl calls print nothing */
fs.writeFileSync(path.join(bin, 'journalctl'), '#!/bin/sh\ncase " $* " in *" -k "*) cat ' + KERNEL + ' 2>/dev/null ;; esac\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'dmesg'), '#!/bin/sh\ncat ' + DMESG + ' 2>/dev/null\n', { mode: 0o755 });

var ENV = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, WOC_PROC_NET_DEV: DEV, WOC_WIFI_FILE: BAND,
    WOC_PATCH_LOGS_SOCK: path.join(dir, 'none.sock') });

function collect() {
    var out = path.join(dir, 'out-' + Date.now() + Math.random().toString(16).slice(2));
    fs.mkdirSync(out);
    var archive = cp.execFileSync('sh', [SCRIPT, '-o', out], { env: ENV, encoding: 'utf8' }).trim();
    cp.execFileSync('tar', ['-xzf', archive, '-C', out]);
    var name = path.basename(archive).replace(/\.tar\.gz$/, '');
    return fs.readFileSync(path.join(out, name, 'wifi.txt'), 'utf8');
}

var lines = [];
for (var i = 0; i < 70; i++) lines.push('Nov 05 06:53:' + String(i % 60).padStart(2, '0') + '.000000 mgu kernel: DHCP[p2p-wlan0-1] - REQUEST [TX] ' + i);
fs.writeFileSync(KERNEL, '[   11.575296] wlan_bridge: port 2(p2p-wlan0-0) entered forwarding state\n' +
    'Nov 05 06:53:00.000000 mgu kernel: ETHER_TYPE_802_1X[p2p-wlan0-1] [TX]: ver 2, type 3, replay 1\n' +
    'Nov 05 06:53:00.100000 mgu kernel: DHCP[wlan0] - DISCOVER [TX]\n' + lines.join('\n') + '\n');
fs.writeFileSync(DEV, 'Inter-|   Receive\n face |bytes packets\n    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n' +
    '  wlan0: 5 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0\n  p2p-wlan0-0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n' +
    '  p2p-wlan0-1: 9000000 1 0 0 0 0 0 0 400000 1 0 0 0 0 0 0\n');
fs.writeFileSync(BAND, '{"band":"2.4","iface":"p2p-wlan0-1","freq":2462}\n');

var w = collect();
var sections = w.split(/^-- /m).slice(1);
assert.strictEqual(sections.length, 3, w);
assert(/^CarPlay Wi-Fi band \(patchd, .*wifi-band\.json\)\n\{"band":"2\.4","iface":"p2p-wlan0-1","freq":2462\}\n$/.test(sections[0]), sections[0]);
assert.deepStrictEqual(sections[1].split('\n').slice(1, -1).map(function (l) { return l.trim().split(':')[0]; }), ['p2p-wlan0-0', 'p2p-wlan0-1'],
    'the P2P interfaces only');
var k = sections[2].split('\n').slice(1, -1);
assert.strictEqual(k.length, 60, 'the last 60');
assert(/REQUEST \[TX\] 69$/.test(k[59]) && /REQUEST \[TX\] 10$/.test(k[0]), k[0]);
assert(!/DHCP\[wlan0\]|entered forwarding/.test(sections[2]), 'only the P2P interfaces\' 802.1X and DHCP lines');
console.log('ok   wifi.txt: patchd\'s band, the P2P interfaces\' counters, their last 60 802.1X and DHCP lines from the journal');

fs.writeFileSync(KERNEL, '');
fs.writeFileSync(DMESG, '[   29.966111] ETHER_TYPE_802_1X[p2p-wfd0-1] [TX]: ver 2, type 3, replay 1\n[   30.111144] DHCP[p2p-wfd0-1] - REQUEST [TX]\n');
w = collect();
assert(/802\.1X and DHCP lines.*\n\[   29\.966111\] ETHER_TYPE_802_1X\[p2p-wfd0-1\].*\n\[   30\.111144\] DHCP\[p2p-wfd0-1\] - REQUEST \[TX\]\n$/.test(w), w);
console.log('ok   none in the journal: dmesg\'s, NXP\'s p2p-wfd0-N');

fs.unlinkSync(BAND);
fs.unlinkSync(DMESG);
fs.writeFileSync(DEV, 'Inter-|   Receive\n face |bytes packets\n  eth0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n');
w = collect();
assert.strictEqual(w.replace(/\(patchd, [^)]*\)/, '(patchd)').replace(/in \S+\n/, 'in DEV\n'),
    '-- CarPlay Wi-Fi band (patchd)\n(none)\n-- P2P interfaces in DEV\n(none)\n-- 802.1X and DHCP lines for P2P interfaces (the last 60)\n(none)\n');
console.log('ok   no band file, no P2P interface, no kernel line: each "(none)"');

/* The evidence logs_extra.js adds, from a stand-in unit (WOC_LOGS_ROOT) whose
 * files hold fake secrets: a GitHub token, a Wi-Fi passphrase, a private
 * key, a VIN and its short form, and a position. collect-logs.sh runs from
 * a copy of the installed folder (the script beside the patch tools). Not
 * root: the root-only part comes from the firewall unit's snapshot; as root
 * it takes it itself. Either way the archive holds the patch records, the
 * aapd recovery's state, the coding's variant, the aapd status, the deploy
 * tool's versions and state, the restart records, recmgr's crash table and
 * the list of kept core dumps, and none of the secrets. */
var SECRETS = ['ghp_FAKEtoken0123456789abcdefghijklmnop', 'hunter2-wifi-passphrase', 'BEGIN PRIVATE KEY', 'WBA8E9C50GK123456',
    'GK12345', '48.137154', '11.576124', 'CORE-DUMP-BYTES'];
var VINS = ['WBA8E9C50GK123456', 'GK12345'];
var U = path.join(dir, 'unit'), SNAP = path.join(dir, 'snapshot');
function mk(rel, text) {
    var f = path.join(U, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
}
mk('usr/bin/carplay.woc-patch.json', '{"patched":true,"proven":true,"trial":false,"ino":5,"size":3484912,"mtime":1794170822000}\n');
mk('usr/bin/aapd.woc-patch.json', '{"patched":false,"proven":true,"ino":6,"size":7367952,"mtime":1794170823000}\n');
mk('var/opt/waze-on-cluster/aa-boot-recovery.json', '{"fails":1,"unknown":0,"arm":null,"prev":"b1","starts":null,"ended":null}\n');
/* the coding image: KI_KOMBI_VARIANT 7, a VIN elsewhere in it */
var coding = Buffer.alloc(0x1030);
coding[0x28] = 0x09;
coding[0x2c + 0x75a] = 7 << 1;
coding.write('WBA8E9C50GK123456', 0x100);
mk('dev/shm/rawcodingdata', coding);
/* the deploy tool: its version, the tools, state.json with what must stay */
fs.mkdirSync(path.join(U, 'var/opt/mgu-deploy/versions/0.8.9'), { recursive: true });
fs.symlinkSync('versions/0.8.9', path.join(U, 'var/opt/mgu-deploy/current'));
['waze-on-cluster@0.9.7', 'cluster-render@0.4.3'].forEach(function (t) {
    var id = t.split('@')[0], v = t.split('@')[1];
    mk('var/opt/' + id + '/versions/' + v + '/component.json', JSON.stringify({ id: id, kind: 'tool', version: v, token: 'ghp_FAKEtoken0123456789abcdefghijklmnop' }));
    fs.symlinkSync('versions/' + v, path.join(U, 'var/opt', id, 'current'));
});
mk('var/opt/mgu-deploy/state.json', JSON.stringify({
    tools: { 'waze-on-cluster': { version: '0.9.7', firmware: 'S18A-23-07-550', token: 'ghp_FAKEtoken0123456789abcdefghijklmnop' } },
    apps: { robertn_store: { uid: 12001, version: '1.4.0', passphrase: 'hunter2-wifi-passphrase' } },
    pending_reboot: [{ id: 'waze-on-cluster', reason: 'new units', boot: 'boot-now' }, { id: 'cluster-render', reason: 'done', boot: 'boot-old' }],
    lastBounceAt: 1794170000,
    vin: 'WBA8E9C50GK123456', position: { lat: 48.137154, lon: 11.576124 }, data_stash: { a: [{ path: '/var/opt/x' }] } }));
mk('var/opt/mgu-deploy/config.json', '{"token":"ghp_FAKEtoken0123456789abcdefghijklmnop"}\n');
mk('var/opt/mgu-updater/credentials/token-0a1b2c3d', 'ghp_FAKEtoken0123456789abcdefghijklmnop\n');
mk('var/opt/mgu-updater/sources.json', '{"wifi":{"psk":"hunter2-wifi-passphrase"},"key":"-----BEGIN PRIVATE KEY-----"}\n');
/* BMW's records: restart records, recmgr's database, kept core dumps */
mk('var/opt/public/sin/recmgr/restartInfo.xml', '<RestartInfo><name>carplay</name><crashID>WBA8E9C50GK123456-carplay</crashID>' +
    '<vin7>GK12345</vin7><resets>3</resets></RestartInfo>\n');
mk('var/opt/public/sin/crashhandler/restartInfo.xml', '<RestartInfo>' + 'x'.repeat(200000) + '</RestartInfo>\n');
var DB = mk('var/opt/public/sin/recmgr/recmgr_stats.db', 'SQLite format 3\0');
fs.utimesSync(DB, 1794298365, 1794298365);
/* restart records the boot step kept */
mk('var/opt/waze-on-cluster/restart-records/1-boot-old-recmgr.xml', '<RestartInfo><crashID>WBA8E9C50GK123456</crashID></RestartInfo>\n');
mk('var/opt/waze-on-cluster/restart-records/1-boot-old-crashhandler.xml', '<RestartInfo><name>carplay</name></RestartInfo>\n');
mk('boot_id', 'boot-now\n');
mk('var/opt/public/sin/crashhandler/coredumps/20261108204714_000_carplay/core.gz', 'CORE-DUMP-BYTES');
mk('var/opt/public/sin/crashhandler/coredumps/20261108204714_000_carplay/context_WBA8E9C50GK123456.txt', 'CORE-DUMP-BYTES');
mk('var/opt/public/sin/dlt-cdh/core.1794170822.carplay.4222.gz', 'CORE-DUMP-BYTES');
for (i = 0; i < 130; i++) mk('var/opt/kerneldump/dump-' + i, 'CORE-DUMP-BYTES');
/* the crash handler's records of aapd's crashes, the newest 3 of 4 kept */
function aapdContext(t, pid) {
    return 'ProcName:aapd\nThreadName:aapd\nPID:' + pid + '\nsignal:6\n\n' +
        '==== Dumping file </proc/' + pid + '/cmdline> ====\n/usr/bin/aapd\n\n' +
        '==== Dumping file </proc/' + pid + '/stack> ====\n[<0>] do_exit+0x74/0x468\n\n' +
        '==== Dumping file </proc/' + pid + '/environ> ====\nSECRET_ENV=WBA8E9C50GK123456\n\n' +
        '==== Dumping file </proc/' + pid + '/maps> ====\n555555554000-555555c31000 r-xp 00000000 00:46 578286 /usr/bin/aapd\n' +
        '555555e5a000-555555e5b000 rw-p 00706000 00:46 578286 /usr/bin/aapd\n\n' +
        '==== Listing directory </proc/' + pid + '/fd> ====\n0 -> /dev/null\n===========================\n\n' +
        '==== Dumping file </proc/' + pid + '/smaps> ====\nRss: 4 kB\n\n' +
        '==== Crash ID ====\n7F86D72813C6DB0D\n\n==== Summary ====\nCrash in "aapd", thread="aapd", pid=' + pid + ', sigid=6, RIP=0x7ffff78cea40\n';
}
[[1794170000, 11], [1794170100, 12], [1794170200, 13], [1794170300, 14]].forEach(function (c) {
    mk('var/opt/public/sin/dlt-cdh/context.' + c[0] + '.aapd.' + c[1] + '.txt', aapdContext(c[0], c[1]));
});
/* sqlite3: records its arguments; rows as the firmware's would print them */
var SQL_ARGS = path.join(dir, 'sqlite-args');
fs.writeFileSync(path.join(bin, 'sqlite3'), '#!/bin/sh\nprintf "%s\\n" "$@" > ' + SQL_ARGS + '\n' +
    'printf "CrashKey|Timestamp|Name|CrashID|LC\\n2|2026-11-05 06:53:00|carplay|WBA8E9C50GK123456-7|41\\n1|2026-11-05 06:51:00|carplay|c1|40\\n"\n', { mode: 0o755 });

var XENV = Object.assign({}, ENV, { WOC_LOGS_ROOT: U, WOC_LOGS_SNAPSHOT: SNAP, WOC_BOOT_ID: path.join(U, 'boot_id') });
var asRoot = process.getuid && process.getuid() === 0;
if (!asRoot) {
    fs.mkdirSync(SNAP);
    cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', SNAP], { env: XENV });
}
var out = path.join(dir, 'out-extra');
fs.mkdirSync(out);
var archive = cp.execFileSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', out], { env: XENV, encoding: 'utf8' }).trim();
cp.execFileSync('tar', ['-xzf', archive, '-C', out]);
var A = path.join(out, path.basename(archive).replace(/\.tar\.gz$/, ''));
function get(n) { return fs.readFileSync(path.join(A, n), 'utf8'); }

assert.strictEqual(get('patch-record-carplay.json'), fs.readFileSync(path.join(U, 'usr/bin/carplay.woc-patch.json'), 'utf8'));
assert.strictEqual(get('patch-record-aapd.json'), fs.readFileSync(path.join(U, 'usr/bin/aapd.woc-patch.json'), 'utf8'));
assert.strictEqual(get('aa-boot-recovery.json'), fs.readFileSync(path.join(U, 'var/opt/waze-on-cluster/aa-boot-recovery.json'), 'utf8'));
assert.strictEqual(get('coding.txt'), 'KI_KOMBI_VARIANT 7\n');
assert(/^target: +\/usr\/bin\/aapd$|^error: /m.test(get('aapd-status.txt')), get('aapd-status.txt'));
assert(/^file: +\/usr\/bin\/aapd$|^error: /m.test(get('aapd-probe.txt')), get('aapd-probe.txt'));
assert.strictEqual(get('deploy.txt'), 'mgu-deploy 0.8.9\ntools installed (/var/opt/<id>/current):\n  tool cluster-render 0.4.3\n' +
    '  tool waze-on-cluster 0.9.7\nstate.json:\n  tool waze-on-cluster 0.9.7 firmware S18A-23-07-550\n  app robertn_store 1.4.0\n' +
    '  pending restart: waze-on-cluster - new units\n  last bounce: 2026-11-08T20:33:20Z\n');
assert.strictEqual(get('restartInfo-recmgr.xml'), '<RestartInfo><name>carplay</name><crashID><VIN>-carplay</crashID>' +
    '<vin7><VIN></vin7><resets>3</resets></RestartInfo>\n');
var big = fs.statSync(path.join(A, 'restartInfo-crashhandler.xml')).size;
assert(big <= 64 * 1024, 'capped: ' + big);
assert.strictEqual(get('restartInfo-crashhandler.xml').match(/\(cut at/g).length, 1, 'one note for the cut');
assert(/^<RestartInfo>x+\n\.\.\. \(cut at 65472 bytes\)\n$/.test(get('restartInfo-crashhandler.xml')));
assert.strictEqual(get('restart-record-1-boot-old-recmgr.xml'), '<RestartInfo><crashID><VIN></crashID></RestartInfo>\n');
assert.strictEqual(get('restart-record-1-boot-old-crashhandler.xml'), '<RestartInfo><name>carplay</name></RestartInfo>\n');
assert.strictEqual(get('recmgr-crashes.txt'), '-- /var/opt/public/sin/recmgr/recmgr_stats.db, modified 2026-11-10T08:12:45Z\n' +
    '-- Crash, newest first (at most 200)\n' +
    'CrashKey|Timestamp|Name|CrashID|LC\n2|2026-11-05 06:53:00|carplay|<VIN>-7|41\n1|2026-11-05 06:51:00|carplay|c1|40\n');
var sqlArgs = fs.readFileSync(SQL_ARGS, 'utf8').split('\n');
assert.strictEqual(sqlArgs[1], 'file:' + path.join(U, 'var/opt/public/sin/recmgr/recmgr_stats.db') + '?mode=ro', 'opened read-only');
assert(/^SELECT /.test(sqlArgs[2]) && !/UserID/.test(sqlArgs[2]) && /LIMIT 200;$/.test(sqlArgs[2]), sqlArgs[2]);
var dumps = get('core-dumps.txt').split('\n');
assert(dumps.indexOf('-- /var/opt/public/sin/crashhandler/coredumps') >= 0 && dumps.indexOf('-- /var/opt/public/sin/dlt-cdh') >= 0);
assert(dumps.some(function (l) { return /Z  20261108204714_000_carplay\/context_<VIN>\.txt$/.test(l); }), 'two levels, the VIN in a name hidden');
assert(dumps.some(function (l) { return /Z  core\.1794170822\.carplay\.4222\.gz$/.test(l); }));
assert(dumps.indexOf('-- /var/opt/kerneldump (the newest 100 of 130)') >= 0, 'at most 100 a folder');
assert.strictEqual(dumps.filter(function (l) { return / {2}dump-\d+$/.test(l); }).length, 100);
var ac = get('aapd-crashes.txt');
assert(/^-- the newest 3 of 4\n-- context\.1794170300\.aapd\.14\.txt \(2026-11-08T20:38:20Z\)\nProcName:aapd\n/.test(ac), ac);
assert(ac.indexOf('aapd.11.txt') < 0 && /signal:6/.test(ac) && /do_exit/.test(ac) && / r-xp .*\/usr\/bin\/aapd/.test(ac) &&
    /==== Summary ====\nCrash in "aapd".*RIP=0x7ffff78cea40/.test(ac) && /7F86D72813C6DB0D/.test(ac), ac);
assert(ac.indexOf('SECRET_ENV') < 0 && ac.indexOf(' rw-p ') < 0 && ac.indexOf('/dev/null') < 0 && ac.indexOf('Rss:') < 0 && ac.indexOf('cmdline') < 0, ac);
/* a VIN across the cap is scrubbed whole before the cut */
var edge = path.join(dir, 'edge');
fs.mkdirSync(edge);
mk('var/opt/public/sin/crashhandler/restartInfo.xml', 'y'.repeat(65472 - 8) + ' WBA8E9C50GK123456 ' + 'y'.repeat(300));
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', edge], { env: XENV });
var cut = fs.readFileSync(path.join(edge, 'restartInfo-crashhandler.xml'), 'utf8');
assert(cut.indexOf('WBA8E9') < 0 && / <VIN/.test(cut) && /\(cut at 65472 bytes\)\n$/.test(cut), cut.slice(-120));
/* a source past what is read that scrubbing shrinks under the cap still says it was cut */
mk('var/opt/public/sin/crashhandler/restartInfo.xml', new Array(5000).join('WBA8E9C50GK123456 '));
var edge2 = path.join(dir, 'edge2');
fs.mkdirSync(edge2);
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', edge2], { env: XENV });
var shrunk = fs.readFileSync(path.join(edge2, 'restartInfo-crashhandler.xml'), 'utf8');
assert(shrunk.length < 30000 && shrunk.indexOf('WBA') < 0 && /\n\.\.\. \(cut at \d+ bytes\)\n$/.test(shrunk), shrunk.slice(-80));
var everything = fs.readdirSync(A).map(get).join('\n');
SECRETS.forEach(function (x) { assert(everything.indexOf(x) < 0, 'the archive holds ' + x); });
console.log('ok   the archive adds the patch records, aapd recovery, coding, aapd status, deploy state, restart records, ' +
    'recmgr crashes, aapd\'s crash records and core-dump names (' + (asRoot ? 'as root' : 'from the snapshot') + '), capped, no secret or VIN');

/* sqlite3 that hangs is killed at 2 s; a missing database or folder is left out */
fs.writeFileSync(path.join(bin, 'sqlite3'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
var snap2 = path.join(dir, 'snap2');
fs.mkdirSync(snap2);
var t0 = Date.now();
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', snap2], { env: XENV });
assert(Date.now() - t0 < 6000, 'bounded: ' + (Date.now() - t0) + ' ms');
assert(/\(sqlite3 killed after 2000 ms\)\n$/.test(fs.readFileSync(path.join(snap2, 'recmgr-crashes.txt'), 'utf8')));
cp.execFileSync('rm', ['-rf', path.join(U, 'var/opt/public/sin/recmgr'), path.join(U, 'var/opt/kerneldump')]);
var snap3 = path.join(dir, 'snap3');
fs.mkdirSync(snap3);
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', snap3], { env: XENV });
assert.deepStrictEqual(fs.readdirSync(snap3).sort(), ['aapd-crashes.txt', 'core-dumps.txt', 'restartInfo-crashhandler.xml']);
assert(fs.readFileSync(path.join(snap3, 'core-dumps.txt'), 'utf8').indexOf('kerneldump') < 0);
console.log('ok   a hung sqlite3 is killed at 2 s; what is absent is left out');


/* ---- scrubbing, from identifiers shaped as the car logs them -------------- */
var lx = require(path.join(CUR, 'logs_extra.js'));
(function () {
    var sc = new lx.Scrubber(Buffer.from('test-key'));
    var VIN = 'WBA5R1C50KAB12345';
    sc.learn('<crashID>' + VIN + '-carplay</crashID>');
    var IDS = {
        vin: VIN, vin7: 'AB12345', vinInName: 'context_' + VIN + 'x.txt', vin7Glued: 'reportAB12345.bin',
        macMasked: 'HostMlme Auth received from c6:XX:XX:XX:69:22', macGlued: 'Send Flow Create Req flow ID 40 for peer 4e:56:8d:d6:ba:f4ffffb5 prio 7',
        macAfterWord: 'connecting with46:4e:d0:11:e1:11 ssid "Alex Home WiFi", len (14)', macDash: 'peer 4E-56-8D-D6-BA-F5 joined',
        ssidJson: '{"ssid":"Cafe Guest 5G","band":"5"}', ssidPlain: 'network name=MyHotspot',
        ip4: 'OUT=vlan77 SRC=160.48.199.99 DST=18.197.20.31 LEN=71', ip4Phone: 'tether gateway 203.0.113.77 up',
        ip6: 'SRC=fe80:0000:0000:0000:4c56:8dff:fed6:baf4 DST=ff02:0000:0000:0000:0000:0000:0000:0016', ip6Short: 'peer 2001:db8::1c up',
        phone1: 'device name: Alex\'s iPhone 15', phone2: 'Connected to Maria’s Galaxy S23 over Wi-Fi', phone3: '{"deviceName":"Pixel of Sam"}',
        phone4: 'iPhone de Pierre joined', token: 'ghp_FAKEtoken0123456789abcdefghijklmnop', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2',
        secret: 'psk=correct-horse-battery', bearer: 'Authorization: Bearer abcDEF123456ghiJKL', b64: 'key blob Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZg9Kx',
    };
    var KEEP = {
        sha: 'sha256:    035c35a40fae0af00ef4bd5ff69d3ce7ff00202d6ad99d770d8b6f1fdc8bed05', build: 'build-id:  5de62156575d737391ea42254e778a97dbbb51f8',
        fw: 'Firmware: wl0: Oct 25 2019 02:27:16 version 9.40.94.25 (r709529 CY)', internal: 'SRC=172.16.222.97 DST=224.0.0.22 via 160.48.199.96 127.0.0.1 10.0.0.2',
        time: '2026-11-13T18:28:13.181577Z 06:53:00.000000', pcpu: 'pcpu-alloc: s138344 r8192 d30704 u262144',
        p2p: 'wlan_bridge: port 2(p2p-wlan0-0) entered forwarding state', name: 'AVB_MGU_CarPlay_Kombi exe="/usr/bin/MGU_HmiProxy_Swc123_ServiceRunnerMain.out"',
        oid: 'PKCS7: Unknown OID: [159] 0.9.2342.19200300.100.1.25', cpp: 'ramses::RamshCommand std::string 0x7f00aa',
    };
    var all = Object.keys(IDS).map(function (k) { return IDS[k]; }).concat(Object.keys(KEEP).map(function (k) { return KEEP[k]; })).join('\n');
    var out = sc.text(all);
    [VIN, 'AB12345', 'c6:XX:XX:XX:69:22', '4e:56:8d:d6:ba:f4', '46:4e:d0:11:e1:11', '4E-56-8D-D6-BA-F5', 'Alex Home WiFi', 'Cafe Guest 5G', 'MyHotspot',
        '18.197.20.31', '203.0.113.77', 'fe80:0000', '4c56:8dff', '2001:db8::1c', 'Alex', 'Maria', 'Sam', 'Pierre', 'ghp_FAKE', 'eyJhbGci',
        'correct-horse', 'abcDEF123456', 'Zm9vYmFy'].forEach(function (x) { assert(out.indexOf(x) < 0, 'scrubbed: ' + x + '\n' + out); });
    Object.keys(KEEP).forEach(function (k) { assert(out.indexOf(KEEP[k]) >= 0, 'kept: ' + KEEP[k] + '\n' + out); });
    assert(out.indexOf('ff02:0000:0000:0000:0000:0000:0000:0016') >= 0, 'multicast kept');
    /* the same address, the same tag; another key, another tag */
    var a = sc.text('peer 4e:56:8d:d6:ba:f4 left; peer 4E:56:8D:D6:BA:F4 back'), tags = a.match(/<MAC-[0-9a-f]{6}>/g);
    assert(tags.length === 2 && tags[0] === tags[1], a);
    assert.notStrictEqual(new lx.Scrubber().text('4e:56:8d:d6:ba:f4'), tags[0], 'a tag of this archive only');
    console.log('ok   scrub: VINs (and the one found, wherever it stands), MACs, public IPs, network and device names, keys, tokens; ' +
        'hashes, firmware versions, the car\'s own addresses, times and names kept');

    /* addresses after words ending in "v", IPv6 after a colon, IPv4 in IPv6;
     * quoted secrets with spaces; USB serial numbers */
    var more = sc.text('nameserver 203.0.113.78\nDNS server: 198.51.100.7\ndev 203.0.113.9 up\naddr:2001:db8::1\n::ffff:203.0.113.79\n' +
        'passphrase="correct horse battery"\npsk=\'abc def\'\npassword="cut off mid-value\nusb 1-3: SerialNumber: 00008030001234560E12802E\n' +
        'kept: v9.40.94.25 version 9.40.94.26 ver=9.40.94.27');
    ['203.0.113.78', '198.51.100.7', '203.0.113.9', '2001:db8::1', '0.113.79', 'horse', 'abc def', 'mid-value', '00008030001234560E12802E'].forEach(function (x) {
        assert(more.indexOf(x) < 0, 'scrubbed: ' + x + '\n' + more);
    });
    assert(/kept: v9\.40\.94\.25 version 9\.40\.94\.26 ver=9\.40\.94\.27$/.test(more), more);
    /* JSON: each string on its own, so escaped quotes hide nothing; still JSON */
    var j = sc.json(JSON.stringify({ ev: 'logs', ssid: 'Plain Net', access_token: 'Opaque Value 1', carplay: [{ msg: 'DLT cfg {"ssid":"Cafe Guest 5G","psk":"hunter22 x"} ' +
        '{"deviceName":"Robert Phone"} with Alex\'s iPhone and Pixel of Sam' }], patchd: ['[t] peer 4e:56:8d:d6:ba:f4'] }, null, 1));
    var parsed = JSON.parse(j);
    ['Plain Net', 'Opaque Value', 'Cafe Guest', 'hunter22', 'Robert Phone', 'Alex', 'Sam', '4e:56:8d'].forEach(function (x) { assert(j.indexOf(x) < 0, 'scrubbed: ' + x + '\n' + j); });
    assert(parsed.ssid === '<SSID>' && parsed.ev === 'logs' && /<DEVICE>/.test(parsed.carplay[0].msg), j);
    assert.strictEqual(sc.json('not json'), null);
    /* a long line without a break: scrubbed in linear time */
    var t0 = Date.now();
    sc.text('x'.repeat(200000) + ' ' + 'y,'.repeat(100000));
    assert(Date.now() - t0 < 2000, 'a 400 KB line in ' + (Date.now() - t0) + ' ms');
    console.log('ok   scrub: addresses after any word, IPv6 after a colon, quoted secrets, USB serials; JSON string by string; linear time');
})();

/* incidents.txt: the tools' INCIDENT lines, the boots and the export, oldest first */
(function () {
    var d = path.join(dir, 'incidents');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'cluster-render.log'), '2026-11-14 21:04:38.551 I dcsm: heartbeat\n2026-11-14 21:05:00.100 W INCIDENT map lost: slot unmapped\n');
    fs.writeFileSync(path.join(d, 'cluster-render.log.1'), '2026-11-14 18:00:00.000 W INCIDENT map lost: render restarted\n');
    fs.writeFileSync(path.join(d, 'waze-on-cluster.log'), '2026-11-14 21:04:59.900 W INCIDENT no frames for 5 s\nno time INCIDENT odd\n');
    fs.writeFileSync(path.join(d, 'kept-journal.log.1'), '2026-11-14T17:50:10.000000Z waze-on-cluster-journal.service node[900]: journal-keep: boot 0a1b2c3d, up 10 s\n' +
        '2026-11-14T19:00:00.000000Z waze-on-cluster-journal.service node[901]: journal-keep: boot 0a1b2c3d, up 4210 s\n');
    fs.writeFileSync(path.join(d, 'kept-journal.log'), '2026-11-14T20:59:12.500000Z waze-on-cluster-journal.service node[700]: journal-keep: boot 99ffee00, up 12 s\n');
    fs.writeFileSync(path.join(d, 'other.log'), '2026-11-14 20:00:00.000 W INCIDENT not a tool log\n');
    var t = lx.incidentsText(d, Date.UTC(2026, 10, 14, 21, 10));
    assert.strictEqual(t, '-- INCIDENT lines of cluster-render.log* and waze-on-cluster.log*, the boots the kept journal saw and this export; ' +
        'oldest first, UTC (~: no time)\n' +
        '2026-11-14 17:49:50.000 -- boot 0a1b2c3d\n2026-11-14 18:00:00.000 cluster-render: W INCIDENT map lost: render restarted\n' +
        '2026-11-14 20:59:00.500 -- boot 99ffee00\n2026-11-14 21:04:59.900 waze-on-cluster: W INCIDENT no frames for 5 s\n' +
        '2026-11-14 21:05:00.100 cluster-render: W INCIDENT map lost: slot unmapped\n~ waze-on-cluster: no time INCIDENT odd\n' +
        '2026-11-14 21:10:00.000 -- this export\n', t);
    console.log('ok   incidents.txt: the tools\' INCIDENT lines, each boot once, the export, oldest first');
})();

/* The whole export from a stand-in unit: the tools' logs and the kept
 * journal holding identifiers, patchd answering on its logs socket; every
 * file of the archive scrubbed, patchd-logs.json and incidents.txt in it. */
(function () {
    var R = path.join(dir, 'root2');
    function put(rel, text) { var f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
    var IDS = ['WBA5R1C50KAB12345', 'AB12345', '4e:56:8d:d6:ba:f4', 'Alex Home WiFi', '203.0.113.77', 'Alex\'s iPhone', 'ghp_FAKEtoken0123456789abcdefghijklmnop'];
    put('var/opt/cluster-render/log/cluster-render.log', '2026-11-14 21:05:00.100 W INCIDENT map lost for WBA5R1C50KAB12345\n');
    put('var/opt/waze-on-cluster/log/waze-on-cluster.log', '2026-11-14 21:04:59.900 W INCIDENT peer 4e:56:8d:d6:ba:f4 gone\n');
    put('var/opt/waze-on-cluster/journal/journal.log', '2026-11-14T20:59:12.500000Z waze-on-cluster-journal.service node[700]: journal-keep: boot 99ffee00, up 12 s\n' +
        '2026-11-14T21:00:00.000000Z kernel: connecting with4e:56:8d:d6:ba:f4 ssid "Alex Home WiFi", len (14)\n' +
        '2026-11-14T21:00:01.000000Z carplay.service carplay[812]: device name: Alex\'s iPhone\n');
    put('var/opt/waze-on-cluster/journal/journal.log.1', '2026-11-14T20:00:00.000000Z recmgr.service recmgr[600]: AB12345 restart, gw 203.0.113.77\n');
    put('var/opt/waze-on-cluster/waze-on-cluster.local.conf', 'token = ghp_FAKEtoken0123456789abcdefghijklmnop\n');
    /* the car's VIN known from the coding image only, its last 7 glued to a name in a log */
    var codingImage = Buffer.alloc(0x1030);
    codingImage.write('WBS3R9C51LCD67890', 0x100);
    put('dev/shm/rawcodingdata', codingImage);
    put('var/opt/cluster-render/log/cluster-render.log.1', '2026-11-14 20:00:00.000 I upload reportCD67890.bin done\n');
    IDS.push('CD67890');
    var sock = path.join(dir, 'p.sock'), server = path.join(dir, 'fake-patchd.js');
    fs.writeFileSync(server, "var net = require('net'), mode = process.argv[3];\n" +
        "net.createServer(function (c) { c.on('data', function () { if (mode === 'hang') return; c.end(JSON.stringify({ ev: 'logs', now: 1, " +
        "carplay: [{ t: 1, msg: 'DLT CarPlay session with Alex\\'s iPhone (4e:56:8d:d6:ba:f4)', marker: true }], markers: [], avb: [], " +
        "dlt: { state: 'receiving' }, patchd: ['[t] vin WBA5R1C50KAB12345'] }) + '\\n'); }); }).listen(process.argv[2]);\n");
    function serve(mode) {
        try { fs.unlinkSync(sock); } catch (e) { /* none */ }
        var p = cp.spawn(process.execPath, [server, sock, mode], { stdio: 'ignore' });
        var t0 = Date.now();
        while (!fs.existsSync(sock) && Date.now() - t0 < 5000) cp.execFileSync('sleep', ['0.05']);
        return p;
    }
    function run(extra) {
        var out = path.join(dir, 'out-' + Date.now() + Math.random().toString(16).slice(2));
        fs.mkdirSync(out);
        var t0 = Date.now();
        var archive = cp.execFileSync('sh', [SCRIPT, '-o', out], { env: Object.assign({}, ENV, { WOC_LOGS_ROOT: R,
            WOC_LOGS_SNAPSHOT: path.join(dir, 'no-snapshot'), WOC_PATCH_LOGS_SOCK: sock }, extra || {}), encoding: 'utf8' }).trim();
        var ms = Date.now() - t0;
        cp.execFileSync('tar', ['-xzf', archive, '-C', out]);
        var A = path.join(out, path.basename(archive).replace(/\.tar\.gz$/, ''));
        var files = {};
        fs.readdirSync(A).forEach(function (n) { files[n] = fs.readFileSync(path.join(A, n), 'utf8'); });
        return { files: files, ms: ms };
    }
    var srv = serve('answer'), r;
    try { r = run(); } finally { srv.kill(); }
    var f = r.files;
    ['cluster-render.log', 'waze-on-cluster.log', 'kept-journal.log', 'kept-journal.log.1', 'waze-on-cluster.local.conf', 'patchd-logs.json',
        'incidents.txt', 'wifi.txt', 'time.txt'].forEach(function (n) { assert(f[n] !== undefined, n + ' in the archive: ' + Object.keys(f)); });
    Object.keys(f).forEach(function (n) {
        IDS.forEach(function (x) { assert(f[n].indexOf(x) < 0, n + ' holds ' + x + ':\n' + f[n]); });
    });
    var pl = JSON.parse(f['patchd-logs.json']);
    assert(pl.ev === 'logs' && pl.dlt.state === 'receiving' && /CarPlay session with <DEVICE> \(<MAC-[0-9a-f]{6}>\)/.test(pl.carplay[0].msg), f['patchd-logs.json']);
    assert(/^2026-11-14 20:59:00\.500 -- boot 99ffee00\n2026-11-14 21:04:59\.900 waze-on-cluster: W INCIDENT peer <MAC-[0-9a-f]{6}> gone\n2026-11-14 21:05:00\.100 cluster-render: W INCIDENT map lost for <VIN>\n\S+ \S+ -- this export\n$/m
        .test(f['incidents.txt'].split('\n').slice(1).join('\n')), f['incidents.txt']);
    assert(f['left-out.txt'] === undefined, 'nothing left out: ' + f['left-out.txt']);
    console.log('ok   the export: patchd\'s diagnostics, incidents.txt, every file scrubbed (' + r.ms + ' ms)');

    /* patchd that never answers: the export goes on after PATCHD_MS; no patchd at all: said so */
    srv = serve('hang');
    try { r = run(); } finally { srv.kill(); }
    assert(/did not answer in 3000 ms/.test(r.files['patchd-logs.json']) && r.ms < 3000 + 8000, r.ms + ' ms');
    try { fs.unlinkSync(sock); } catch (e) { /* none */ }
    r = run();
    assert(/"error":"patchd: (ENOENT|ECONNREFUSED)"/.test(r.files['patchd-logs.json']), r.files['patchd-logs.json']);
    console.log('ok   patchd silent or absent: the export goes on, patchd-logs.json says why');

    /* the scrub out of time: what it did not write is left out, never sent unscrubbed */
    r = run({ WOC_SCRUB_MS: '1' });
    assert(/^-- left out of the archive, not scrubbed\n/.test(r.files['left-out.txt'] || ''), JSON.stringify(Object.keys(r.files)));
    Object.keys(r.files).forEach(function (n) { IDS.forEach(function (x) { assert(r.files[n].indexOf(x) < 0, n + ' holds ' + x); }); });
    /* no scrubber beside the script: nothing but the note */
    var bare = path.join(dir, 'bare');
    fs.mkdirSync(bare);
    fs.copyFileSync(SCRIPT, path.join(bare, 'collect-logs.sh'));
    var out = path.join(dir, 'out-bare');
    fs.mkdirSync(out);
    var archive = cp.execFileSync('sh', [path.join(bare, 'collect-logs.sh'), '-o', out], { env: Object.assign({}, ENV, { WOC_LOGS_ROOT: R }), encoding: 'utf8' }).trim();
    var listing = cp.execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').map(function (l) { return l.replace(/^[^/]*\/?/, ''); }).filter(Boolean);
    assert.deepStrictEqual(listing, ['left-out.txt'], listing.join(' '));
    console.log('ok   a scrub out of time or missing: the archive holds only what was scrubbed, and says what is left out');
})();

try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) { /* left in tmp */ }
