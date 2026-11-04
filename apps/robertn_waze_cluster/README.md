# robertn_waze_cluster

The HMI app for [waze-on-cluster](../../native/waze-on-cluster), which shows
the CarPlay cluster map (Waze, Apple Maps or Google Maps), or Android Auto's,
on the instrument cluster of an iDrive 7 (MGU) head unit. Everything is done from the HMI; no
shell is needed.

Install it from the catalog of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
through the [mgu Store](https://github.com/robertnisipeanu/mgu-store). It requires
waze-on-cluster 0.9.0, which brings the cluster renderer and writes the
CarPlay patch, and the Android Auto patch where the car supports it, as it
installs; one head-unit start activates them. After that
the map is on the cluster whenever CarPlay streams it, whether or not this
app is open.

Set **Instrument cluster > Central display area** to **Map view**: the Waze
map replaces the stock map while CarPlay's cluster stream shows a map, and
the stock map is back when the stream ends or shows none. Until a navigation
app draws on the cluster (in Waze or Google Maps, once a route starts), the
stock map stays and the page shows `Cluster map: Waiting for the phone's map`.
**Off** works too, with an empty centre instead of the stock map. With
Route preview or Assisted Driving View the cluster's own content takes the
centre. After changing the setting, CarPlay may need reconnecting before
the map returns: the change can freeze the phone's cluster stream, and the
page then shows `Cluster map: Frozen` while the stock map (in Off, an
empty centre) shows.

To remove, remove the app in the Store, then the Waze tool, which reverts
the patch.

## Languages

The app is in the head unit's display language, every one the iDrive 7 HMI
offers: English (UK, US), German, Dutch (also Flemish), Danish, Swedish,
Norwegian, Finnish, Polish, Czech, Slovak, Slovenian, Hungarian, Romanian,
French (France, Canada), Italian, Turkish, Spanish (Spain, Latin America),
Portuguese (Portugal, Brazil), Greek, Russian, Ukrainian, Indonesian,
Vietnamese, Japanese, Korean, Simplified Chinese (also Cantonese
simplified), Traditional Chinese (also Cantonese traditional), Arabic,
Hebrew and Thai. A word a language has no translation for is English, as
is every language the HMI reports that the app does not know. A change of
the display language shows at once. Values from the tools (reasons,
addresses, numbers, file names, the cluster map's frame rate) are shown as
they are; CarPlay and Android Auto are names.

A language is one file, `locales/<code>.json`: the HMI's languages it is
for (`CommonTypes.Language`), its RHMI text files (named as the oap-sdk
names those languages) and its words, each keyed by the English (`{0}`,
`{1}` stand for the values):

```json
{ "hmiLanguages": ["DEUTSCH"], "rhmiTexts": ["de_DE"],
  "words": { "Status: {0}": "Status: {0}", "Save logs": "Logs speichern" } }
```

`node tools/build.js` writes them into the app (`src/locales.js`) and into
the RHMI text files, which hold the tile's name and the Logs page's title.
`node tools/test_i18n.js` checks that every language has every word with
the same `{n}`, and every HMI language its text file.

## Where the map shows

**Show on cluster** (on by default) and **Show on HUD (experimental)** (off
by default) choose: the cluster only, the HUD only, both, or neither. HUD
support was contributed by [eroobeeroo](https://github.com/eroobeeroo), and
the choice of both or one follows [wesleyredhat](https://github.com/wesleyredhat)'s.
With both, the HUD gets up to half the upload bandwidth, only what it uses;
alone, all of it. On the HUD the frames are scaled on the head unit to the
size shown, the corners are rounded and a night map's background is made
black, which the HUD shows as nothing, so the roads, route and labels float
in view. The map steps aside while the HUD's media and list pop-ups show.
With the map on the HUD only, the cluster shows BMW's own content. If the
instrument cluster restarts right after the HUD map shows, twice, the HUD
map is disabled; the cluster's map keeps working.

## The page

One `LT_State_Wide` list in four sections, each under a header row
(`LT_Label_Header_1Row`). CarPlay and Android Auto have the same rows with
the same words; no row repeats the header's name. Every info row reads
`Name: Value`, the value starting with a capital (`Zoom: —` while there
is none), and every on/off setting is a checkbox. Every row
stays where it is: one that cannot act now is greyed, and while `patchd`
runs any operation (`busy`), every operation in both sections is. A greyed
row pressed sends nothing; a greyed checkbox keeps its label. The
restart's two rows, the last ones, are the only rows shown and hidden, so
nothing else moves when they come or go. `(after restart)` marks a value
that waits for the next head-unit start.

Both sections' Status row uses the same words: `Patched`, `Not patched`,
`Patching…`, `Removing patch…`, `Patched after restart`, `Removed after
restart`, `Failed`, `Not supported on this car`, `Untested version`,
`Changed by another tool`, `Partly patched`, `Connecting…`,
`Unavailable`; CarPlay also `Update needed` (a patch from an older app,
which Patch brings up to date), and `Removed — head unit kept
restarting` once boot recovery removed a patch, until Patch applies it
again. On a head unit
whose variant the tool cannot read, both read `Not supported on this car`,
also while a patch waits for the next start to be removed. Every variant is
supported, HIGH F included.

| Section | Row | What it does |
|---|---|---|
| **CarPlay** | Status | `Status: <state>`, in the words above |
| | Patch | applies the patch; enabled while it is off, unknown or out of date, the head unit is supported and no change is pending |
| | Remove patch | reverts the patch, which turns the map off; enabled while patched and no change is pending |
| **Android Auto** | Status | `Status: <state>`, in the words above; `Failed` also while the last zoom or turn-card change failed |
| | Patch | applies its patch; enabled while it is off or partly patched, supported and nothing is pending |
| | Remove patch | reverts it; enabled while patched and nothing is pending |
| | Zoom | `Zoom: 180 dpi`, the density on disk, with `(after restart)` while it differs from the one aapd runs until the next head-unit start; `Zoom: —` without the patch |
| | Zoom out / Zoom in | 10 dpi a press (150-400): out shows more map; enabled while patched, nothing is pending and the 10 s between changes has passed |
| | Hide phone's turn card | a checkbox, ticked while the turn card on disk is hidden, or as asked while its change runs: the phone's own turn card cropped off the map; `(after restart)` as for the zoom; enabled as Zoom out and Zoom in |
| **HUD** | HUD map | `HUD map: <state>`, the map on the HUD: `Off`, `Starting…`, `Showing`, `Waiting for the phone`, `Frozen`, `Error`, `Disabled after errors` (the cluster renderer turned it off after the cluster restarted right after it showed, twice), `Unavailable` (the map service is down) |
| | Show on HUD (experimental) | a checkbox, unticked by default: ticked, the map shows on the HUD, beside the cluster's or alone. A press changes it at once and it is kept for the next start. Greyed until the map service reports it |
| | Size | `Size: Standard` (the fitted box, about 57 % of the HUD's width) or `Size: 70 %` |
| | Smaller / Larger | 5 % a press, from 30 % to 85 % of the HUD's width, the picture's shape kept; kept for the next start; greyed while the HUD is off or disabled |
| | Position | `Position: Centre`, or how far the HUD map is moved: `Position: 20 px right, 10 px up` |
| | Move left / Move right / Move up / Move down | 10 px a press, held inside the HUD; kept for the next start; greyed as Smaller and Larger |
| | Centre | puts it back in the middle; enabled while it is moved |
| **General** | Cluster map | `Cluster map: <state>`, the map the shared render draws for either phone: `Off` unless CarPlay's or Android Auto's patch is in effect (on disk with nothing pending, as the last status outside a change said; a running or failed change keeps it), `Starting…`, `Showing Waze map — 16 frames/s`, `Waiting for the phone`, `Waiting for the phone's map`, `Stream lost`, `Frozen`, `Error`, `Unavailable` (the map service is down, or refuses the head unit) |
| | Show on cluster | a checkbox, ticked by default: unticked, no map on the cluster, which shows BMW's own content. A press changes it at once and it is kept for the next start. Greyed until the map service reports it |
| | Hide BMW's turn box | a checkbox: ticked, BMW's turn-by-turn box on the cluster stays hidden while the map shows (the default); unticked, it shows. A press changes it at once and the map service keeps it. Greyed and unticked until the map service reports it and while the cluster renderer keeps the box shown; greyed while the map is not on the cluster |
| | Logs | opens the Logs page |
| | Restart head unit | the Node State Manager's normal head-unit restart; shown while a written change, CarPlay's or Android Auto's, waits for the next head-unit start; enabled while nothing runs and the restart limit (one every 10 minutes) allows it |
| | Restart | shown while it has something to say: `Restart: In progress`, `Restart: Failed, not accepted` (NSM did not take it), `Restart: Failed, the head unit stayed on`, `Restart: Failed, command failed`, each with `— possible in 8 min` while the limit holds, `Restart: Possible in 8 min` |

| | |
|---|---|
| CarPlay | ![](docs/main-carplay.png) |
| Android Auto | ![](docs/main-aa-on.png) |
| General | ![](docs/main-general.png) |
| Map on the cluster only (the default) | ![](docs/main-cluster-only.png) |
| Map on the HUD only | ![](docs/main-hud-only.png) |
| Map on both | ![](docs/main-both.png) |
| HUD disabled after errors | ![](docs/main-hud-disabled.png) |
| Android Auto alone patched, the cluster map showing | ![](docs/main-aa-only.png) ![](docs/main-aa-only-map.png) |
| Android Auto not supported | ![](docs/main-aa-unsupported.png) |
| A change waiting for a restart | ![](docs/main-restart-pending-aa.png) ![](docs/main-restart-pending.png) |
| A restart that failed | ![](docs/main-restart-failed.png) |
| The Logs page | ![](docs/logs-page.png) |

The **Logs** page (`ST_OnlineApps_WazeClusterLogs`, a child of the main
page):

| Row | What it does |
|---|---|
| Start capture / Stop capture | a bounded DLT capture (5 minutes) for diagnostics; start it, then reconnect CarPlay |
| Capture | `Capture: On`, `Off`, `Starting…`, `Stopping…`, `Failed`, `Unavailable` |
| Save logs | saves an archive of the tools' logs, kept journal and status (waze-on-cluster README, "Logs") |
| Saved logs | `Saved logs: None`, the number kept, `Saving…`, `Not enough space`, `Too large to save`, `Save failed`, `Unavailable`, `Connecting…` |
| QR code | the download address, for a phone on the car's Wi-Fi hotspot; blank without one |
| Address | `Address: http://172.16.222.97:8475/<token>/`, `Address: Wi-Fi hotspot off`, or `Address: —` before the logs service answers |
| 5 rows | the saved archives, newest first, with their size |

The app holds the logs socket while the Logs page is visible; the logs
service serves the archives while it is held and for 15 minutes after a
save. The QR code is a PNG in `/dev/shm/robertn_waze_cluster_qr_<uid>/`
(`src/qr.js`, with Project Nayuki's QR code generator, `src/qrcodegen.js`),
replaced when the address changes and removed when the app shuts down.

`Cluster map: Starting…` shows while the cluster renderer starts; an error shows
only when the renderer stays unreachable for 15 s. Before the patch daemon
runs (right after the install), the pending patches are read from
`/dev/shm/waze-on-cluster/activation-pending` (CarPlay) and
`/dev/shm/waze-on-cluster/aa-pending` (Android Auto); a marker with
another boot's id is done, one without a boot id counts.

## The sockets

Unix stream sockets, newline-delimited JSON, group `tm_oap_app`. The app
holds the first two while one of its pages is visible and the third while
the Logs page is, and retries each once a second; the tools keep running
when it closes them.

- **Render** `/dev/shm/waze-on-cluster/ctl.sock`. The app sends
  `{"cmd":"guide","hide":0|1}` (Hide BMW's turn box). The tool sends
  `{"ev":"status","state","target","page","reason","upload_cap_kb_per_s","upload_reason","hide_bmw_guidance","guide_disabled"}`
  (`state` idle, starting, showing, frozen or error; `hide_bmw_guidance` 0
  or 1; `guide_disabled` 1 while the cluster renderer keeps the box shown),
  and `{"ev":"log","line"}`, which the app does not show.
- **Patch daemon** `/dev/shm/waze-on-cluster/patch.sock` (root). The app sends
  `{"cmd":"apply","panel":"high","mode":"avb"}`, `{"cmd":"revert"}`,
  `{"cmd":"aa-apply"}`, `{"cmd":"aa-revert"}`, `{"cmd":"aa-density","value"}`, `{"cmd":"aa-card","value"}`,
  `{"cmd":"reboot"}`, `{"cmd":"capture-start"|"capture-stop"}`. The daemon sends
  `{"ev":"status","state","panel","mode","res","safe","carplay","reason","pending","conflict","busy","restart","aa"}`
  (`aa`: `{"state","reason","conflict","pending","aapd","dpi","diskCard","runDpi","runCard","density","card","densities","changeAt","error"}`;
  `restart`: `{"state","code","reason","possibleAt"}`)
  (`state` original, patched, unknown, busy or error; `carplay: "deferred"`
  while a change waits for the next start), `{"ev":"capture",…}`,
  `{"ev":"reboot-reply","ok","reason"}`, `{"ev":"refused","cmd","reason"}`
  (a command not taken; it changes nothing on the page) and
  `{"ev":"log","line"}`, which the app does not show. waze-on-cluster's
  PATCH.md, "Activation", has the fields.
- **Logs** `/dev/shm/waze-on-cluster/logs.sock`; a connection starts the
  logs service. The app sends `{"cmd":"save"}`. The service sends
  `{"ev":"state","url","saving","error","saved","archives":[{"name","size","mtime"}]}`
  on connect and on each change (`url` null without the hotspot's address;
  `error` `no-space`, `too-large` or `failed`).

A patch with another sink, panel, size (not `1088x480`) or safe area (not
`504x368+286+72`) shows `Status: Update needed`.

## Build and test

```sh
node tools/test_control.js           # the socket client against fake sockets
node tools/test_page.js              # the page against a fake SDK and HMI
node tools/test_i18n.js              # every language: its words, placeholders, RHMI text files
node tools/build.js                  # robertn_waze_cluster@0.6.0.src.tgz
node tools/build.js --sdk <donor>    # also robertn_waze_cluster@0.6.0.tgz
```

The app ships as a source package (`mgu-app.json`; `"build": "unit"` in the
catalog). The repository carries no oap-sdk, which is BMW's: the head unit's
deploy tool links the app against the unit's own oap-sdk and takes the
package's entry point from the unit's own packages. To build the OAP tgz
locally, pass a donor bundle with `--sdk` (or `MGU_SDK_DONOR`), for example
the one `mgu-deploy.sh sdk-donor` takes from the unit. The tests need no
donor.

`node tools/fakes.js <render.sock> <patch.sock>` runs both fakes by hand;
Enter starts or stops a fake CarPlay stream.

| Path | |
|---|---|
| `src/robertn_waze_cluster.js` | the app |
| `src/i18n.js`, `src/locales.js` | the words in the display language; the languages, written from `locales/` |
| `locales/<code>.json` | a language's words (Languages) |
| `src/waze_cluster_control.js` | the render and patch socket clients and the status logic |
| `src/logs_control.js` | the logs socket client |
| `src/qr.js`, `src/qrcodegen.js` | the QR code PNG; Project Nayuki's generator (MIT, `LICENSE-qrcodegen.txt`) |
| `tools/` | build, fakes, tests, icon |
| `robertn_waze_cluster@0.6.0/` | the package tree (manifest, RHMI UI, config) |

## License

GPL-3.0-or-later (`LICENSE`). Third-party files keep their own licenses.
