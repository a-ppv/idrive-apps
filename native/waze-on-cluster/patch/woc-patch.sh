#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# woc-patch.sh — read the carplay and aapd patches' state on the unit, and
# undo them by hand without the app. Both patches are applied in the
# services' memory (PATCH.md "In memory"): `off` and `aa-off` turn them off;
# `revert` and `aa-revert` put back files an earlier release patched, with /
# remounted read-write for the write, then read-only again on any exit. Run
# it deliberately, with the car parked and on stable power.
#
#   woc-patch.sh status
#   woc-patch.sh probe [<file>]                 # where the edit sites are, read-only
#   woc-patch.sh off                            # turn carplay's patch in memory off (its next start runs stock)
#   woc-patch.sh revert
#   woc-patch.sh verify
#   woc-patch.sh aa-status                      # Android Auto's patch: aapd and aapd.conf on disk
#   woc-patch.sh aa-probe [<file>]              # where its edit sites are in aapd, read-only
#   woc-patch.sh aa-off                         # turn Android Auto's patch in memory off (aapd's next start runs stock)
#   woc-patch.sh aa-revert                      # restore both files
#
# revert and aa-revert restore from our verified backups; on carplay
# 22.28.3, aapd 22.39.3 and its aapd.conf they also work without them, from
# each file's own shipped content.
#
# After a revert, carplay must start again to load the original. This
# script does NOT stop or start carplay (recmgr and MainApp timing are the
# unit's to manage); it prints how. The running carplay keeps the old binary
# until then, so nothing changes mid-session.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PATCHER="$HERE/carplay_patch.js"
AA_PATCHER="$HERE/aapd_patch.js"
TARGET=${WOC_CARPLAY:-/usr/bin/carplay}
AA_FILES="--target ${WOC_AAPD:-/usr/bin/aapd} --conf ${WOC_AAPD_CONF:-/etc/aapd.conf} --coding ${WOC_CODING:-/dev/shm/rawcodingdata}"
NODE=$(command -v node || echo /usr/bin/node)
MOUNT=$(command -v mount || echo /bin/mount)

[ -f "$PATCHER" ] || { echo "error: $PATCHER not found" >&2; exit 2; }

# How a written binary takes effect: carplay must start again. A systemd stop or
# restart of carplay.service power-cycles the head unit, and so does any carplay
# death unless recmgr loaded "carplay" in both [Whitelist] and
# [WhitelistExitSuccess] of /etc/recmgr-restartlist.conf at this boot.
activation() {
    echo "It takes effect at the next head-unit start. Only if recmgr loaded carplay"
    echo "in both restart lists at this boot, it can start now (car parked):"
    echo '    pid=$(systemctl show carplay.service -p MainPID --value)'
    echo '    [ "$pid" -gt 0 ] && kill -9 "$pid" && systemctl start carplay.service'
    echo "Never systemctl stop/restart carplay.service."
}
aa_activation() {
    echo "It takes effect at the next head-unit start. Only if recmgr loaded aapd"
    echo "in both restart lists at this boot, it can start now (car parked):"
    echo '    pid=$(systemctl show aapd.service -p MainPID --value)'
    echo '    [ "$pid" -gt 0 ] && kill -9 "$pid" && systemctl start aapd.service'
    echo "Never systemctl stop/restart aapd.service."
}

cmd=${1:-}; [ $# -gt 0 ] && shift || true

case "$cmd" in
  status)  exec "$NODE" "$PATCHER" status --target "$TARGET" ;;
  verify)  exec "$NODE" "$PATCHER" verify --target "$TARGET" ;;
  probe)   exec "$NODE" "$PATCHER" probe "${1:-$TARGET}" ;;
  off)
    # The patch in memory off, as CarPlay's Remove patch button turns it off:
    # this boot's next start and every later one run carplay as it ships.
    # Only /var/opt and /run are written.
    "$NODE" -e 'var m = require(process.argv[1]); m.disarm("carplay"); if (m.readRecord("carplay")) m.disable("carplay", { by: "user" }); console.log("carplay patch in memory off");' "$HERE/inmem.js"
    echo "carplay runs as it ships from its next start (a head-unit restart)."
    ;;
  revert)
    # Pass through extra flags (e.g. --force to restore over another carplay
    # build; the patcher refuses that without it).
    trap 'sync; "$MOUNT" -o remount,ro / 2>/dev/null || true' EXIT INT TERM HUP
    "$MOUNT" -o remount,rw /
    "$NODE" "$PATCHER" revert --target "$TARGET" --yes "$@"
    echo
    echo "Reverted. $(activation)"
    ;;
  aa-status)
    # shellcheck disable=SC2086
    exec "$NODE" "$AA_PATCHER" status $AA_FILES ;;
  aa-probe) exec "$NODE" "$AA_PATCHER" probe "$@" ;;
  aa-off)
    # As Android Auto's Remove patch button turns it off: this boot's next
    # aapd start and every later one run aapd as it ships. Only /var/opt and
    # /run are written.
    "$NODE" -e 'var m = require(process.argv[1]); m.disarm("aapd"); if (m.readRecord("aapd")) m.disable("aapd", { by: "user" }); console.log("aapd patch in memory off");' "$HERE/inmem.js"
    echo "aapd runs as it ships from its next start (a head-unit restart)."
    ;;
  aa-revert)
    # Extra flags pass through (--force restores over another aapd build).
    trap 'sync; "$MOUNT" -o remount,ro / 2>/dev/null || true' EXIT INT TERM HUP
    "$MOUNT" -o remount,rw /
    # shellcheck disable=SC2086
    "$NODE" "$AA_PATCHER" revert $AA_FILES --yes "$@"
    echo
    echo "Reverted. $(aa_activation)"
    ;;
  *)
    echo "usage: woc-patch.sh status|probe [<file>]|off|revert|verify|aa-status|aa-probe [<file>]|aa-off|aa-revert" >&2
    exit 2 ;;
esac
