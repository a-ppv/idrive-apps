# Changelog

## Unreleased

Android Auto's cluster map patch is applied in aapd's memory each time it
starts, as CarPlay's is: `/usr/bin/aapd` and `/etc/aapd.conf` stay as they
ship. Updating from an earlier version puts the original files back and
keeps the map, your zoom and turn-card settings included.

## 0.12.1

The rollback tests treat 0.11.0 and later as releases that patch CarPlay in
memory.
A map shown inside another app's scene on the cluster appears as soon as
its picture is ready, including when that app shows it again while the map
is still.

## 0.12.0

While another app's content on the cluster asks for upload bandwidth
(cluster-render's `others_fps`), the map runs at the lower frame rate it
asks for and makes no more pictures than that, and goes back to its own
rate when that app hides its content or exits.

## 0.11.0

CarPlay's cluster map patch is applied in CarPlay's memory each time it
starts, and `/usr/bin/carplay` stays as it ships: no write of the system
partition to patch, remove or recover it. Updating from an earlier version
puts the original file back and keeps the map, with at most one head-unit
restart; where CarPlay already runs the earlier patch, none.

## 0.10.12

The diagnostic journal is kept in memory and written to storage only around
failures and at shutdown, which greatly reduces writes to the head unit's
storage.

