# Changelog

## Unreleased

A cluster theme app that draws with layers only can show the map inside its
theme, under its frame and readouts, with a cluster-render release after 0.8.0. The
map goes back to its own place when the theme hides, ends it or exits.
Nothing else changes.

## 0.14.3

The patch checks the places it edits, not the whole file: a carplay or
aapd of a known version whose file differs only elsewhere, as on another
firmware image, gets the cluster map like any other. Save logs shows which
part of such a file differs.
A patch you removed with Remove patch stays removed after a car software
update too, until you press Patch. A version whose patch fails its own
check is not tried again at each head-unit start.

## 0.14.2

Installing or updating turns the CarPlay and Android Auto map patches on
by itself for every car software version it can check, with no Patch press
and no more `Untested version`; a version new to your car is removed again
by itself if the head unit then fails to start. A patch you removed stays
removed.

## 0.14.1

The Wi-Fi band test waits for each sample to finish, so it passes on a
busy machine too.

## 0.14.0

Android Auto: the cluster map starts at every connection, also after you
leave the car and get back in, without a route planned.

## 0.13.0

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

