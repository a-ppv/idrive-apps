# cluster-render

Cluster renderer draws apps' content, such as the
[Maps on cluster](../../apps/robertn_waze_cluster) map, on the instrument
cluster and the head-up display of a BMW with iDrive 7 or iDrive 8.

You don't install or use it on its own. The Store installs it with the apps
that need it, and there is nothing to set up. If something an app draws doesn't
show, follow that app's instructions; for Maps on cluster, see
[If the map doesn't show](../../apps/robertn_waze_cluster/README.md#if-the-map-doesnt-show).

## For developers

The one renderer every app on a BMW iDrive 7 or iDrive 8 head unit (MGU)
draws through on the instrument cluster and the HUD: maps and video,
widgets, overlays, 2D and 3D, and whole-cluster content. Apps and native
producers are its clients ([PROTOCOL.md](PROTOCOL.md)); it is the head
unit's one custom RAMSES participant and display client (Dcsm2 on
iDrive 7, RAMSES 27's DCSM on iDrive 8, "iDrive 8"), shares the display
slots between its clients, and spends one upload budget for all of them.
`kit/` is the pixel path it shares with producers that prepare frames.

| Part | What | Who links it |
|---|---|---|
| `kit/` | the pixel path: 4:2:0 atlas, dirty tiles, packed blocks, SIMD conversion and rounding, pacer, frame clock, map geometry | the service, and any producer that prepares frames |
| `src/` | the service: slot arbitration, the layer stack, layers, the upload governor, the iDrive 7 and iDrive 8 backends, the socket | — (one process, `hmi_5000`) |
| `include/`, `client/` | the C++ client and protocol, `libcluster_render_client.a` on the unit | native producers |
| `js/cluster_render_client.js` | the Node 8 client | OAP apps |
| `dcsm/`, `abi/`, `tools/`, `docker/` | the Dcsm2 client ([dcsm/DCSM.md](dcsm/DCSM.md)), the units' RAMSES 19, RAMSES 27 and vsomeip ABI ([abi/ABI.md](abi/ABI.md), [abi/ABI27.md](abi/ABI27.md)), the ABI checks and the unit's toolchain | the service's build |

Frames cross a socket: a whole 1088x480 video frame is 783 KB. An app's
content is made of the layer kinds and assets below, or, on a target that
takes them, a whole scene file a root install put in place ("Layers").

### Clients

- **Native producers** link `libcluster_render_client.a` and include
  `include/cluster_render/client.h`.
- **OAP apps** copy `js/cluster_render_client.js` into their sources (Node 8,
  only the `net` and `events` builtins). The installed copy is
  `/var/opt/cluster-render/current/cluster_render_client.js`.
- Any other language speaks [PROTOCOL.md](PROTOCOL.md) over the socket.

A client needs only the socket's group, `tm_oap_app`, which every OAP app
has: no participant, no Dcsm2 client and no `hmi_5000`. A tool or app that
draws through the service requires `cluster-render` in its catalog entry
(`"requires"`).

`js/showcase.js` puts content of every layer kind on a target through the
service and prints every event: a 3D cube in a mesh layer the renderer
turns, plasma in an effect, labels in effects over a glyph-atlas asset, a
needle, an alert and a video:

```sh
node showcase.js [--socket PATH] [all|cube|text|needle|plasma|alert|video|glow] \
    [--target panel|map|hud|guide|widget] [--size WxH]   # iDrive 8's map: --size 874x749
```

`js/example_gauges.js` is a small custom cluster built only from layers, to
copy from: a background a shader draws, two dials sampling one mipmapped
asset, two needles the renderer turns, and a seven-segment readout over an
`r8` font. It prints the bytes it sends while idle (none), while the
needles sweep (one message each, once) and while new values come 4 times a
second (about 1.2 KB/s), and what the service wrote for it:

```sh
node example_gauges.js [--socket PATH] [--target panel] [--phase-ms 10000]
```

### Targets

A **target** is one slot with one scene. On iDrive 7:

| Target | Slot | Size | Where |
|---|---|---|---|
| `map` | 0x100 | 1088x480 | the central map area, under the gauges |
| `panel` | 0x203 | 1920x720 | the whole cluster, over the gauges |
| `hud` | 0x323 | 800x480 | the head-up display |

iDrive 8's targets are in "iDrive 8". The service's `hello` event names the
targets and their sizes.

### Arbitration

Every client's layers on a target are drawn in that target's scene.

- **Order.** Every layer is drawn at once, bottom to top by class
  (ambient, content, overlay, alert), then the client's `z`, then the newest
  on top. A layer marked `exclusive` hides the layers below it while it is
  drawn, from the flush after its first write went; they are suspended, not
  removed, and come back when it goes.
- **Slots.** A target is requested while at least one visible layer has
  content (or is `prewarm`) and released when none has for
  `<target>_linger_ms` (`map` 0, `panel` and `hud` 3 s), after a fade-out.
  A client that comes back within the linger is shown at once.
- **Preloading** (iDrive 7). While a layer on a target has `preload` 1,
  visible or not, the cluster keeps the target's scene loaded without
  showing it (`loaded`), and the service keeps drawing into it. A layer
  that then wants the target is shown with no load of the scene, which
  otherwise takes the cluster a moment before anything shows. When nothing
  wants it any more, after the linger, the scene goes off screen and stays
  loaded; with no `preload` layer left, it is released. A loaded scene is
  not on screen: its slot shows other content. While `panel` is shown the
  cluster takes the stock HMI's media widget (slot 0x200) off screen, and
  puts it back as soon as `panel` goes off screen, before its scene is
  released (seen on the car). On iDrive 8 `preload` has no effect.
- **Fades.** A target's video and image layers fade in over `fade_ms`
  (250) once it is shown and out the same way when nothing wants it. Effect
  and mesh layers do not fade. A layer a client drops, or whose client goes,
  goes at once.
- **Other content.** The KOMBI shows one content per slot; a later one waits
  behind it (`parked`). Content of the stock HMI or another app is waited
  for, unless the layer has `contend` 1: then the service asks for the
  slot again after the stock HMI takes it, and on `map` takes the slot from
  the stock map (`map_take_over_stock`). Each `target` event says the
  target's state and who holds the slot (PROTOCOL.md "Service to client").
- **Warnings** (iDrive 7). During a warning or with a door open, the cluster
  locks a group of slots (the middle, the right side or the HUD), takes
  everything in it off screen and keeps what it has loaded. A shown target
  taken off by a lock (or a parked `contend` one) keeps its scene loaded
  and stops drawing; nothing is asked for while the slot is locked. When
  the slot unlocks, the scene is put back at once, so it can show before
  the stock HMI's, and drawing resumes once it shows. If the cluster
  refuses that or has dropped the scene, it is asked for in full. So is a
  scene locked out for over 3 minutes, or when the cluster stops answering
  heartbeats. If the stock map still shows first, `map` takes over from it
  at once, then on its usual steps.
- **The HUD** and **giving way.** `hud` gives way while the stock HMI shows its lists on the
  HUD (the media source list, playlists, recent calls), and comes back
  `hud_yield_ms` (1500) after they go; never for route guidance. A layer
  with `yield` 0 keeps it shown over them. `hud_yield_slots = 0x321,0x322`
  also gives way to calls and other pop-ups.
- **Guide hold** (iDrive 7, `guide_hold = 1`, the default). While `map` is
  shown and the stock HMI's CarPlay turn box (content 0x01000310) is in its
  slot (0x105 or 0x103, found by itself with `guide_slots = auto`), the
  service covers that slot with an empty scene, so the box is hidden while
  the map shows. A layer on `map` with `guide_hold` 0 keeps the box shown.
  A car that needs a fixed slot sets `guide_slots = 0x103` (or any slot) in
  `cluster-render.local.conf`.
- **Scene ids** come from `scene_ids_allowed`: `map` 0x010004f0, the guide
  hold 0x010004f1, `hud` 0x01000400 and `panel` 0x010004f8. When the KOMBI
  refuses the panel's id as unknown, the panel falls back to
  `panel_fallback_scene_id` (0x01000400, the HUD's) until the service
  restarts; `hud` and such a panel are never shown at once.
- **Restarts.** On iDrive 7, if the service dies, the KOMBI drops its
  content within about 10 s (its per-client watchdog) and systemd starts
  the service again; clients reconnect by themselves and send their layers
  again ("Lifecycle").
- **Start-up** (iDrive 7). When the KOMBI's display service comes up, the
  first request waits until the KOMBI reports the stock HMI's content
  mapped, 10 s at most: a request racing the KOMBI's own first fetches can
  be accepted and never fetched. When the service restarts with the car
  running, the KOMBI already shows the HMI's content and the request goes
  at once.
- **Stalled fetches** (iDrive 7). A fetch the KOMBI accepts and does not
  complete within 5 s, or a request after one that gets no answer, is asked
  for again on the retry steps. From the second in a row the scene is published again, and every third in a row
  the service reconnects to RAMSES, at most once a minute. Each is logged
  as an `INCIDENT` line.

### Upload budget

Every head-unit participant shares one link to the KOMBI, and too much
upload makes the cluster drop scenes. Every layer of every client writes
within one budget (`src/governor.h`, `kit/upload_pacer.h`):

- The cap starts at the ceiling: `upload_kb_per_s` (5500 KB/s), or the
  remembered ceiling below it. When the link shows congestion (a shown
  scene removed, heartbeat replies stalling, refused or slow flushes) it
  steps down by 500 KB/s, to 2000 KB/s at the least, and recovers slowly, up
  to the ceiling. A shown scene the KOMBI removes while the cap is above
  4000 KB/s lowers the ceiling for the rest of the drive. Clients get a
  `budget` event when the cap changes.
- **Remembered ceiling.** A removal also lowers the ceiling for later
  drives to one step below the level it came at, kept in
  `/var/opt/cluster-render/state/upload-ceiling`. After 3 clean drives at
  it (each with a target shown 10 min in all and no removal) the next drive
  tries one step higher, and keeps it if that drive is clean; a removal
  there keeps the old ceiling and starts the count over. A firmware update
  or another KOMBI variant forgets it. `upload_kb_per_s` set in the local
  conf is the ceiling, and the remembered one is not used.
- **What the log keeps.** One `INCIDENT` line each time a shown target is
  lost (why, the cap and ceiling, how long it was shown) and when it is
  back (put back after a lock, asked for in full, or shown again by the
  cluster). On a removal, the 30 s before it second by second: KB written,
  budget holds, offer-to-flush time and the deepest TCP send queue on the
  head unit with its peer; once a minute, a summary of the same. In the car
  logs none of these rose reliably before a removal, so none steers the
  cap.
- Within the cap the top layers write first. A video frame whose exact
  write the budget cannot cover goes as packed 4x4 blocks (with
  `pan_blocks`), the exact picture follows when the budget allows, and only
  the newest frame waits.
- **Always packed.** A video layer sent with `always_packed` 1 (optional,
  PROTOCOL.md; only to a service whose hello has `always_packed` 1) writes
  every update as packed 4x4 blocks, never the exact atlas, for about a
  third of the bytes. Updates are planned as exact ones (the tiles,
  `dirty_threshold`, `settle_ms`), and only the blocks in them that changed
  are written, in place, in at most 64 rects. The whole packed buffer goes
  with the layer's first write in a scene and after a failed write; a still
  picture writes nothing. waze-on-cluster's `always_packed` key uses it
  (its README, "Experimental: hosted_vpp_scale and always_packed"). Layers
  without it write as above.
- **Bandwidth for a layer.** A layer sent with `others_fps` (PROTOCOL.md
  "Bandwidth for a layer"; only to a service whose hello has `others_fps`
  1) holds every other client's videos to at most that many writes a
  second, 15 at the least, while it is shown, so a client drawing its own
  cluster gets the bandwidth a map at 30 a second would take. The hold
  ends as soon as the layer is hidden, waits, goes or its client goes, and
  nothing of it is kept. The held clients get an `fps_cap` event; the
  status lists who asks.
- **The HUD's share.** While `hud` has a layer, its layers and assets write
  from up to half of the budget, only as much as they spend; what the HUD
  leaves goes to the cluster. With the cluster idle the HUD gets the whole
  cap. Together they never exceed it.
- Video tiles wholly covered by opaque layers drawn above them are not
  written while they stay hidden (`src/occlusion.h`). Opaque means a video,
  or an image where its pixels have alpha 255, drawn unturned, unanimated
  and at full opacity, not fading; effect and mesh layers never cover.

`cluster-render status` and `/run/cluster-render/status.txt` show the cap,
why it is what it is, and the remembered ceiling.

### Layers

| Kind | What the client sends | What the service does |
|---|---|---|
| video | 4:2:0 atlases (`w*h*3/2` bytes) | one persistent buffer; only 64x64 tiles that changed past a noise filter are written, settled after `settle_ms`; packed 4x4 blocks for motion the budget cannot cover; newest frame only |
| image | RGBA rectangles that changed | one persistent RGBA8 buffer, written in those rectangles at most `fps` a second |
| effect | a GLSL ES 1.00 fragment shader, uniforms (arrays too), binds to assets, its blending and colour mask | a quad drawn by it; `u_time` at `time_fps`, or from the renderer's own clock |
| mesh | parts: shaders, geometry (`M`), transforms, uniforms, binds to assets, each part's depth test, blending and colour mask | a render pass of its own over its rect, with its own perspective or orthographic camera; geometry replaced at most once a second within the budget; depth cleared, never colour |

Beside the layers:

- **Assets:** RGBA8, R8, `etc2rgba` or `etc2rgb` textures a client uploads
  once and its effect layers and mesh parts on the same target sample, such
  as a glyph atlas or sprites. Not drawn, so they never make a target
  wanted. A compressed asset is sent whole once: a 2048x1024 atlas takes
  2 MiB as `etc2rgba` and 1 MiB as `etc2rgb`. On iDrive 7 the KOMBI draws
  `etc2rgba` atlases up to 2048x2048 on the cluster and the HUD
  ([TEST-ETC2.md](TEST-ETC2.md)); `etc2rgb`, and both on iDrive 8, have not
  been tried on a car. `tools/etc2_test/etc2_encode.py encode IN.rgba W H
  OUT.etc2 [etc2rgb]` encodes them. Which format to use: PROTOCOL.md
  "Choosing a pixel format"; artwork sent once animates with no more pixels
  sent: PROTOCOL.md "Animating preloaded assets". An asset sampled with
  mipmaps has its mip levels, made by the service for `rgba8` and `r8`
  and sent with a compressed one; its sampler may mirror, wrap each axis
  its own way and sample anisotropically (PROTOCOL.md "Mipmaps and
  samplers").
- **Render state:** an effect layer or mesh part blends by a preset
  (`alpha`, `add`, `none`, `premultiplied`, `max`, `min`, `subtract`) or
  by its own factors and operations, writes only the colour channels it
  names, and a part tests depth its own way (PROTOCOL.md "Render state").
  Every value and shader is checked before the display sees it; a shader is
  at most 64 KB.
- **Several videos:** clients have up to 8 video layers together, and the
  display holds the buffers of at most two. Past two, the videos on a
  target drawn unturned, at their frame's size and at even x and y are
  composed on the head unit into one video; a turned, scaled or odd-placed
  video always takes a buffer of its own (PROTOCOL.md "Client to service").
- **Turns:** video, image and effect quads rotate and scale about a pivot
  (a needle).
- **Animations:** keys the renderer plays by itself on a quad's rotation,
  offset and scale, a part's pose, a mesh camera, or a uniform; nothing is
  sent per frame.
- **Scene files** (PROTOCOL.md "Scene files"): on a target with
  `<target>_scene_files` 1, a RAMSES scene file and its resource files,
  authored beforehand, loaded as the target's whole scene and changed live
  by edit lines (`--hide`, `--rotate`, `--uniform`, `--set`, ...). Taken
  only from under `/var/opt/`, owned by root and writable by no one else,
  with the SHA-256 the client gives. With `layers` 1 the target's layers
  are drawn over the file (RAMSES 19 only), and the scene may host another
  target's content (PROTOCOL.md "Hosting another target"), with an
  optional edge: the hosted picture's top and bottom rows drawn on past its
  rect, blurred and darkened, for a picture shorter than the shape it shows
  in.
- **Hosting from layers** (PROTOCOL.md "Hosting from layers"): an app that
  draws a target with layers only, a cluster theme on `panel` for example,
  hosts another target there with no scene file (`host` with `into`): the
  hosted picture (Waze's map, for example, which marks its layer `hosted`)
  is drawn at the rect it names, just under the app's lowest drawn layer
  (over it when that one is exclusive), so its frame and readouts sit over
  it. The picture goes back to its own target while none of the app's
  layers over the rect is drawn, the panel is not on screen, or a scene
  hosts it, and when the app ends the host or exits. Of several apps
  hosting the same target the one drawn highest over the picture wins, so
  a background app's early host loses to the visible theme; the `hosting`
  event tells each whether it is live and why not. Both backends.

Each target's changes are flushed together once a tick, so the cluster never
shows a half-written frame: a video or exclusive image left half written
holds its target until its whole rewrite goes.

### Lifecycle

- `cluster-render.socket` listens from boot; the first client starts the
  service. Clients reconnect by themselves (0.25, 0.5, 1, then every 2 s)
  and make their assets and layers again with their last settings, images
  and assets sent whole, a video layer's last frame sent whole.
- A client's layers go with its connection, then its assets. A video layer
  whose frames (or repeats) stop for `stall_ms` stops wanting its slot.
- On SIGTERM every target is released.

### Identity and packaging

`hmi_5000` (the one uid allowed Dcsm2 and the RAMSES offers), participant
801, vsomeip application `cluster-demo` and clientID `"\0cluster"`, on
iDrive 7 and iDrive 8. A standalone renderer with the same identity
(`cluster-demo.service`) cannot run beside it, so the service conflicts
with it (`Conflicts=`). One systemd unit serves both generations: it runs
`cluster-render`, which starts `cluster-render-idrive7` or
`cluster-render-idrive8` in its place.

### Supported head units

Every iDrive 7 and iDrive 8 head-unit variant. On a head unit whose variant
cannot be read (a kernel command line with no `hwvariant=`, or two that
disagree) the service draws nothing: it stays up holding only its socket, a
status request gets `not supported on this car (head unit: ...)` and any
other message an `error` event with that reason.

### Install

From the Store ([robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store)),
as a requirement of the apps that use it: the binaries, its settings and
the Node client in `/var/opt/cluster-render/`, `cluster-render.socket`
enabled. The same kit installs on iDrive 7 and iDrive 8; `cluster-render`
starts `cluster-render-idrive7` or `cluster-render-idrive8`.

To install a kit built from the working tree over SSH, with mgu-store's
deploy tool (from this repository's root):

```sh
node release/tool_artifact.js native/cluster-render --out /tmp/kit   # runs make target, writes /tmp/kit/cluster-render@<version>.tgz
<mgu-store>/deploy/hu install --artifact /tmp/kit/cluster-render@<version>.tgz
```

### Configure

[`cluster-render.conf`](cluster-render.conf) lists every setting with its
default: the generation (`auto`, `7` or `8`), the identity, the targets
(slot, content class, scene id, size, linger; on iDrive 8 the `id8_` ones),
the targets that take scene files, the guide hold, the upload budget and
the tick. A unit's own settings go in
`/var/opt/cluster-render/cluster-render.local.conf`, which updates keep;
each key there replaces the shipped value, and `key += a,b` adds to a list.
`-s key=value` on the command line overrides both. An error in the shipped
file, local_conf or the command line stops the service (exit 2).

`cluster-render status` prints the targets, the display service's state,
every client's layers and the upload cap. The log is in
`/var/opt/cluster-render/log/cluster-render.log` (and `.log.1`), in UTC.

### iDrive 8

iDrive 8 draws its cluster and HUD with RAMSES 27, which has DCSM built in:
the head unit offers content in a category and the cluster decides when to
show it ([abi/ABI27.md](abi/ABI27.md)). A target's slot is a category and
`id8_<target>_content` the content offered in it. An offered target is
`parked` until the cluster shows it; the cluster shows some categories by
itself (the middle, the HUD, and the head unit's own guiding panel) and a
widget once it is picked in its widget menu. It takes a shown widget back on every layout
change and shows it again 1 to 7 s later. There is no take-over and no
guide hold, and `panel` does not exist (a layer on it is refused).

| Target | Category | Content | Size | Where |
|---|---|---|---|---|
| `map` | `Ca_ComCenter_IC` 43100201 | 43204041 | 874x749, all shown | the middle of the cluster, between the gauges; the cluster draws its media placeholder over it |
| `hud` | `Ca_ComCenter_HUD` 43100202 | 43204012 | 353x203, all shown | the HUD, above its speed bar |
| `guide` | `Ca_GuidingPanel_IC` 43100401 | 43204051, a dynamic content | 702x213, all shown | the top centre of the cluster, over the map in the normal layout |
| `widget` | `Ca_Widget_IC` 43100301 | 43204001, a dynamic widget (43202001-43205000) | canvas 2240x896, most of it shown (below) | the middle of the cluster once picked in its widget menu, with the entry `id8_widget_description`, `_order` and `_preview` |
| `popup` | `Ca_Widget_IC` 43100301 | 43204003, a dynamic widget | canvas 2240x896, as `widget` | the middle of the cluster, on a black middle, by itself while a client draws on it: a focus request with the offer |

- **The widget's canvas** is the whole cluster. Shown, in canvas
  coordinates: about x 400-1720, y 143-765 in the normal layout and x
  690-1530, y 185-700 in the M layout, with a black notch at the top middle
  down to about y 167, dimmed behind the gauge panels and the bottom bar. A
  big picture fits best at 1140x480 at 550,220 in layout 4. The safe rect
  moves with the layout (layout 4: 630x570 at 805,125; layout 5: 612x527 at
  814,170); clients are not told it.
- **Widget options:** `id8_<target>_background_id` (43400001, 43400004,
  43400005 or 43400006 black out the cluster's own artwork behind the
  widget), `_layouts` (a mask of the cluster views it is shown in; 1 is
  ROAD) and `_focus` 1 (the cluster switches to the widget by itself
  when it is offered).
- **Your own widget.** A target is its keys: `id8_<name>_<field>` for any
  name of lowercase letters and digits, with the fields `category`,
  `content`, `scene_id`, `size`, `linger_ms`, `description`, `order`,
  `preview`, `background_id`, `layouts` and `focus`. A tool installed under
  `/var/opt/<id>/current` adds one with a drop-in there,
  `cluster-render.d/<name>.conf`, which goes with the tool on uninstall;
  the unit's own drop-ins go in `/var/opt/cluster-render/conf.d/`
  (`cluster-render.conf` has an example). A drop-in adds its targets and
  scene ids with `+=` (`id8_targets += mywidget`, `id8_scene_ids_allowed +=
  0x4d4755000020`) and sets only those targets' keys. Each target it adds
  is a widget: category `Ca_Widget_IC` 43100301, a dynamic widget content
  (43202001-43205000, never the head unit's own 43202020-43202120) and a
  scene id `0x4d4755……`, none of them another target's; the drop-ins
  together add at most 8 targets. `_preview` is a regular file of at most
  1 MB. A drop-in is read only as a regular file owned by root and writable
  by no one else; a bad one is skipped whole, with a warning in the log,
  and the service runs without it. `cluster-render status` lists each
  drop-in, `loaded` or `skipped` and why.
- Whether the cluster shows `guide`'s content, and which content it shows
  there during route guidance while the head unit offers its own guiding
  panel in the same category, is not known yet.
- What the head unit does when `cluster-render.service` exits or is
  restarted on iDrive 8 is not known: don't stop or restart it on an
  iDrive 8 car.
- Content ids the head unit offers itself (`C_NaviMap_IC` 43200501,
  `C_GuidingPanels_IC` 43201101, `C_Media_IC` 43202120, ...) are never
  offered: two providers of one content fight.

### Building and testing

In `native/cluster-render`:

```sh
make test                       # every host test
make test-x86                   # the C++ tests with the unit's gcc 7.5 in Docker (SSE2 paths)
make target                     # build/target/cluster-render, cluster-render-idrive7, cluster-render-idrive8
                                # and libcluster_render_client.a, every import checked against the units' libraries
make test-ramses ROOTFS=…       # every layer kind and a scene file on the unit's own libramses
make test-ramses27 ROOTFS=…     # the same on an iDrive 8 unit's libramses 27
```

The host tests need a C++14 compiler and Node; the rest need Docker
(linux/amd64, the image `cluster-render-build` from `docker/Dockerfile`).
`ROOTFS` is a copy of the unit's root filesystem, which is not part of this
repository.

Releases: [release/README.md](../../release/README.md).

### License

The service is GPL-3.0-or-later ([LICENSE](LICENSE)). What apps compile in
or copy, `include/`, `client/`, `kit/`, `js/cluster_render_client.js`,
`js/example_gauges.js` and [PROTOCOL.md](PROTOCOL.md), is MPL-2.0
([LICENSES/MPL-2.0.txt](LICENSES/MPL-2.0.txt)), so apps under any license
can use them; they reach the service over a socket. `abi/include/ramses19/`
declares the API of RAMSES (BMW Car IT, MPL-2.0) and the symbol lists name
the exports of RAMSES and vsomeip, so they are MPL-2.0 too;
`abi/include/ramses27/` is RAMSES 27.0.116's own headers, unchanged, with
their notices (BMW Car IT, MPL-2.0);
`dcsm/third_party/vsomeip/` is COVESA's vsomeip, MPL-2.0, with its own
notices. Source, script and build files name their license in an SPDX
header; the rest is GPL-3.0-or-later.
