// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the map feed (map_feed.h) against the shared cluster renderer
 * (cluster-render, the CR tree) on fake display backends, over its socket:
 * - the map is a contending content layer on the map target, covering the
 *   1088x480 slot; before a frame the app sees idle, with the first frames
 *   the slot is asked for (starting) and the map shown with the frames as
 *   they were decoded;
 * - the stock map taking the slot shows as starting with that reason; the
 *   contending map asks again, parks behind it, takes it over and is shown,
 *   the stock map parked behind it;
 * - a control start moves it to the whole panel, centred at 416,120, and an
 *   unknown target is refused;
 * - frames stopping: idle after stall_ms, the slot released;
 * - the renderer restarting: starting while it is gone, an error once it
 *   stays gone 15 s, then the map again with the next frames;
 * - a lowered shared upload cap shows on the status line, with its reason in
 *   the status, and leaves the line once it is back at the ceiling;
 * - frames offered faster than they can be written are newest-wins;
 * - the stream not live: the layer hidden, idle, the slot released and the
 *   stock map back; live again: shown with the frames; frozen: hidden, the
 *   status says so; no longer frozen: shown again;
 * - before the stream is live the layer is made hidden;
 * - the stream's pictures through the change sampler and freeze watch, as
 *   the service runs them: a stream blank from its start (the car's burst,
 *   then a pause) never asks for the slot, the stock map stays and the app
 *   is told it waits for the phone's map; the first non-blank frame, with no frame
 *   after it, takes the slot over and shows that frame; blank spells
 *   shorter than blank_ms between pictures keep the map up without asking
 *   for the slot again; a picture blank for blank_ms gives the slot back to
 *   the stock map, and the next picture takes it again; a stream blank at
 *   full rate from its start is frozen, the stock map showing; live
 *   through a recent frame (no connection to read), a static map's frame
 *   every 10 s takes the slot over each time it makes the stream live;
 *   a frame of the ended stream decoded after it ended, seconds before the
 *   next stream is live, does not take the slot for it, while one decoded
 *   just before it is live does; the stream ending is logged once, whatever
 *   frames still come;
 * - the status is logged when its state, reason or target changes, not for
 *   the frame rate, the page or the upload cap;
 * - BMW's turn box (the layer's guide_hold): hidden by default, the hold of
 *   its slot following the map; the switch off releases it and the box
 *   shows, the map still showing; on again, held; off from the start,
 *   never held; the hold disabled by cluster-render's guard: never held,
 *   and the status says so. */
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <fstream>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

/* cluster-render's service and fakes, from its tree (-I$(CR)) */
#include "src/service.h"
#include "test/fake_graph.h"
#include "test/fake_port.h"
#include "../src/map_feed.h"
#include "src/log.h"
#include "../src/map_feeds.h"
#include "../src/atlas_scale.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static int rigs;
static const uint64_t kBox = 0x01000310, kGuide = 0x010004f1;

struct Rig {
    std::string path = "/tmp/woc-feed-test-" + std::to_string(getpid()) + "-" + std::to_string(++rigs) + ".sock";
    crs::FakeGpu gpu;
    crs::FakePort port;
    crs::ServiceConfig sc;
    std::unique_ptr<crs::Service> svc;
    std::unique_ptr<MapFeed> feed;
    int64_t now = 200000;
    std::vector<uint8_t> spare;   /* the buffer handed to the feed, as the producer's */
    /* watched: the frames' pictures drive the stream state, as in the
     * service's loop; otherwise the stream is live with a picture */
    bool watched;
    /* watched and > 0: live while a frame came within this long, as the
     * service decides without the stream's connection; 0: live while live
     * is set, as the stream's connection says */
    int64_t live_stall_ms = 0;
    bool live = true;
    int64_t last_frame_ms = -1;
    FreezeWatch watch{FreezeConfig()};
    ChangeSampler sampler{1088, 480};

    /* w: watched (above); hold: with the guide hold of the turn box's slot
     * following the map, as cluster-render.conf ships it; guide_hold: the
     * feed's setting; hud: the HUD target too. */
    explicit Rig(bool w = false, unsigned stall_ms = 6000, bool hold = false, bool guide_hold = true, bool hud = false)
        : watched(w)
    {
        crs::TargetSpec m, p, g, u;
        m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 1500;
        m.take_over_stock = true;   /* as cluster-render.conf ships it */
        p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 3000;
        g.name = "guide_0x105"; g.slot = 0x105; g.scene_id = kGuide; g.width = g.height = 16; g.linger_ms = 0;
        g.take_over_stock = true; g.follows = "map"; g.take_over_contents = {kBox};
        g.strike_limit = 2;
        u.name = "hud"; u.slot = 0x323; u.scene_id = 0x01000400; u.width = 800; u.height = 480; u.linger_ms = 3000;
        sc.targets = {m, p};
        if (hud)
            sc.targets.push_back(u);
        if (hold)
            sc.targets.push_back(g);
        sc.socket_path = path;
        sc.backend = "fake";
        start();
        FeedConfig fc;
        fc.socket = path;
        fc.video.level_bits = 0;
        fc.video.stall_ms = stall_ms;
        fc.guide_hold = guide_hold;
        feed.reset(new MapFeed(fc));
        watch.live(true, now);
        feed->set_stream(true, false, watched ? watch.picture(now) : Picture::Shown);
    }
    void start()
    {
        svc.reset(new crs::Service(&gpu, &port, sc));
        port.m = &svc->slots();
        port.pending.clear();
        std::string err;
        if (!svc->start(&err))
            std::printf("start: %s\n", err.c_str());
    }
    /* Simulated time; each step runs the socket exchange until idle. */
    void pump(int64_t ms, const std::vector<uint8_t> *frame = nullptr, int64_t frame_every = 65)
    {
        for (int64_t t = 0; t < ms; t += 5) {
            now += 5;
            if (frame && t % frame_every == 0) {
                spare.assign(frame->begin(), frame->end());
                feed->offer(&spare, (uint64_t)now, now);
                if (watched) {
                    const bool changed = sampler.changed(frame->data());
                    watch.frame(now, changed, sampler.blank());
                    last_frame_ms = now;
                }
            }
            if (watched) {
                const bool on = live_stall_ms ? last_frame_ms >= 0 && now - last_frame_ms <= live_stall_ms : live;
                watch.live(on, now);
                feed->set_stream(on, watch.frozen(now), watch.picture(now));
            }
            for (int round = 0; round < 400; round++) {
                std::vector<pollfd> fds;
                size_t first = 0;
                if (svc)
                    first = svc->poll_fds(&fds);
                const int n = ::poll(fds.data(), fds.size(), 0);
                if (svc) {
                    port.tick(now);
                    svc->after_poll(fds, first, now);
                }
                const bool pending = feed->wants_write();
                feed->poll(now);
                if (round > 0 && n <= 0 && !pending)
                    break;
            }
        }
    }
    FeedStatus st() { return feed->status("decode"); }
    /* The map status of content in the turn box's slot; -1: not mapped. */
    int in_box_slot(uint64_t content) const
    {
        const crs::SlotInfo *s = port.row(0x105, content);
        return s ? (int)s->map_status : -1;
    }
    const crs::Layer *map_layer()
    {
        for (const crs::Layer *l : svc->compositor().layers())
            return l;
        return nullptr;
    }
};

static std::vector<uint8_t> atlas(int seed)
{
    std::vector<uint8_t> f(1088 * 720);
    for (size_t i = 0; i < f.size(); i++)
        f[i] = (uint8_t)(i < 1088 * 480 ? (i / 5 + seed * 17) & 0xff : 128);
    return f;
}

/* The app's switch for BMW's turn box: on by default, the hold following
 * the map and the box taken over; off, the hold released and the box
 * shown, the map still showing; on again, held. */
static void guide_hold()
{
    const std::vector<uint8_t> f = atlas(7);
    Rig h(false, 6000, true);
    h.port.stock_map(0x105, kBox);
    h.pump(1500, &f);
    ok("turn box: hidden by default, the hold shown in its slot with the box parked behind it",
       h.st().state == "showing" && h.st().guide_hold && h.in_box_slot(kGuide) == 1 && h.in_box_slot(kBox) == 3);
    h.feed->set_guide_hold(false);
    h.pump(500, &f);
    const size_t taken = h.port.taken_over.size();
    ok("turn box: the switch off releases the hold, the box shown, the map still showing, the status says so",
       h.in_box_slot(kGuide) == -1 && h.in_box_slot(kBox) == 1 && h.st().state == "showing" && !h.st().guide_hold);
    h.pump(5000, &f);
    ok("turn box: off, no take-over and no hold", h.port.taken_over.size() == taken && h.in_box_slot(kGuide) == -1);
    h.feed->set_guide_hold(true);
    h.pump(500, &f);
    ok("turn box: on again, held, the box taken over",
       h.in_box_slot(kGuide) == 1 && h.in_box_slot(kBox) == 3 && h.port.taken_over.back() == kBox);

    Rig off(false, 6000, true, false);
    off.port.stock_map(0x105, kBox);
    off.pump(3000, &f);
    ok("turn box: set off before the map is made, never held",
       off.st().state == "showing" && off.in_box_slot(kGuide) == -1 && off.in_box_slot(kBox) == 1);
    ok("turn box: the hold not disabled, the status says so", !h.st().guide_disabled);

    const std::string path = "/tmp/woc-feed-guard-" + std::to_string(getpid()) + ".txt";
    std::ofstream(path) << "version t\nboot b\nguide_0x105 0x105 0x10004f1 0 1 0 2\n";
    Rig d(false, 6000, true);
    d.sc.guard_path = path;
    d.sc.version = "t";
    d.sc.boot_id = "b";
    d.start();
    d.port.stock_map(0x105, kBox);
    d.pump(3000, &f);
    ok("turn box: the hold disabled by cluster-render's guard: never held, the status says so",
       d.st().state == "showing" && d.st().guide_disabled && d.in_box_slot(kGuide) == -1 && d.in_box_slot(kBox) == 1);
    unlink(path.c_str());
}

int main()
{
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, nullptr, _IONBF, 0);
    Rig r;
    r.pump(100);
    const crs::Layer *l = r.map_layer();
    ok("connected: one contending content layer on the map target, covering the 1088x480 slot",
       l && l->target() == 0 && l->params.contend && l->params.klass == crs::Klass::Content && l->params.rect.x == 0 &&
           l->params.rect.y == 0 && l->params.rect.w == 1088 && l->params.rect.h == 480);
    ok("no frame yet: idle, and the slot is not asked for", r.st().state == "idle" && r.port.requests == 0);

    const std::vector<uint8_t> f1 = atlas(1);
    r.pump(20, &f1);
    ok("the first frame asks for the slot: starting", r.st().state == "starting" && r.port.requests == 1);
    r.pump(1100, &f1);
    crs::FakeGraph *g = r.gpu.graph("map");
    bool drawn = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            drawn = drawn || (kv.second.f == crs::TexFormat::R8 && kv.second.px == f1);
    ok("granted: showing, with the decoded frame in the slot's scene",
       r.st().state == "showing" && drawn && r.st().page.find("Waze map — ") == 0);
    ok("the status line counts the frames handed over", r.st().page.find("15 frames/s") != std::string::npos);
    const std::string lost = "Stream lost";   /* until the layer stalls */
    ok("showing carries the stream's reason", r.feed->status("decode", lost).state == "showing" &&
                                                  r.feed->status("decode", lost).reason == lost &&
                                                  r.feed->status("decode", lost).stream_reason);

    r.port.steal(r.sc.targets[0]);
    r.pump(20, &f1);
    ok("the stock map takes the slot: starting, with that reason",
       r.st().state == "starting" && r.st().reason == "the stock map holds the slot");
    r.pump(2200, &f1);
    const crs::SlotInfo *ours = r.port.row(0x100, 0x010004f0), *stock = r.port.row(0x100, 0x01000101);
    ok("the map contends: it takes the stock map over and is shown, the stock map parked behind it",
       r.st().state == "showing" && r.port.requests == 2 && r.port.taken_over.size() == 1 &&
           r.port.taken_over[0] == 0x01000101 && ours && ours->map_status == 1 && stock && stock->map_status == 3);

    /* Many frames between two writes: only the newest is drawn. */
    const std::vector<uint8_t> f2 = atlas(2), f3 = atlas(3);
    std::vector<uint8_t> b2 = f2, b3 = f3;
    r.feed->offer(&b2, 2, r.now);
    r.feed->offer(&b3, 3, r.now);
    ok("a frame is taken without a copy: a same-size buffer comes back for each",
       b2.size() == f2.size() && b3.size() == f3.size() && b3 == f2);
    r.pump(200);
    g = r.gpu.graph("map");
    bool newest = false, stale = false;
    for (const auto &kv : g->shown.buffers)
        if (kv.second.f == crs::TexFormat::R8) {
            newest = newest || kv.second.px == f3;
            stale = stale || kv.second.px == f2;
        }
    ok("frames faster than the writes: the newest is drawn", newest && !stale);

    ok("an unknown target is refused", !r.feed->set_target("cockpit"));
    ok("a control start moves the map to the whole panel", r.feed->set_target("panel"));
    r.pump(1200, &f3);
    l = r.map_layer();
    ok("centred in the 1920x720 panel at 416,120, showing",
       l && l->target() == 1 && l->params.rect.x == 416 && l->params.rect.y == 120 && l->params.rect.w == 1088 &&
           r.st().state == "showing" && r.st().target == "panel");
    r.pump(1600);
    ok("the map target, no longer wanted, is released after its linger",
       r.port.releases >= 1 && !r.port.row(0x100, 0x010004f0));
    r.feed->set_target("sail");
    r.pump(1200, &f3);
    ok("sail is the map slot", r.map_layer() && r.map_layer()->target() == 0 && r.st().state == "showing");

    const int releases = r.port.releases;
    r.pump(6100);
    ok("frames stop: idle after stall_ms", r.st().state == "idle");
    const std::string waiting = "Stream lost";
    ok("idle while the stream is live carries the stream's reason", r.feed->status("decode", waiting).reason == waiting);
    r.pump(2000);   /* the fade out, then the linger */
    ok("and the slot is released after the linger",
       r.port.releases > releases && !r.port.row(0x100, 0x010004f0));

    r.svc.reset();
    r.pump(100);
    ok("the renderer gone: starting while it may be starting", r.st().state == "starting" &&
                                                               r.st().reason == "waiting for the cluster renderer");
    r.pump(15000);
    ok("still gone 15 s on: an error the app shows", r.st().state == "error" &&
                                                     r.st().reason == "cluster renderer not reachable");
    r.start();
    r.pump(3000, &f1);
    ok("it comes back: the map layer made again, showing with the next frames",
       r.map_layer() && r.st().state == "showing");

    /* the governor counts evidence seen while writes go */
    r.svc->compositor().governor().activity(r.now);
    r.svc->compositor().governor().evidence(crs::Evidence::LinkStall, r.now);
    r.svc->compositor().governor().evidence(crs::Evidence::LinkStall, r.now);
    r.pump(100, &f1);
    ok("a lowered shared upload cap shows on the status line",
       r.st().page.find("upload cap 5000 KB/s") != std::string::npos);
    ok("the status carries the cap and why",
       r.st().upload_cap_kb == 5000 && r.st().upload_reason.find("lowered from 5500 KB/s") == 0 &&
           r.st().upload_reason.find("heartbeat replies silent") != std::string::npos);
    /* A minute of healthy upload raises it back to the ceiling, which the
     * status line leaves out. */
    for (int s = 0; s < 62; s++) {
        r.svc->compositor().governor().activity(r.now);
        r.pump(1000, &f1);
    }
    ok("back at the ceiling after healthy upload: the cap leaves the status line, its reason stays",
       r.st().upload_cap_kb == 5500 && r.st().page.find("upload cap") == std::string::npos &&
           r.st().upload_reason.find("raised from 5000 KB/s") == 0);
    /* the stream's liveness drives the layer, whatever the frames do */
    const int before = r.port.releases;
    r.feed->set_stream(false, false, Picture::Shown);
    r.pump(2000, &f1);   /* the fade out, then the linger */
    stock = r.port.row(0x100, 0x01000101);
    ok("the stream not live: the layer hidden, idle, and the slot released, the parked stock map shown",
       r.map_layer() && !r.map_layer()->params.visible && r.st().state == "idle" && r.port.releases > before &&
           !r.port.row(0x100, 0x010004f0) && stock && stock->map_status == 1);
    ok("and no stream reason", r.feed->status("decode", waiting).reason.empty());
    r.feed->set_stream(true, false, Picture::Shown);
    r.pump(1200, &f1);
    ok("live again: visible and showing with the frames", r.map_layer()->params.visible && r.st().state == "showing");
    r.feed->set_stream(true, true, Picture::Blank);
    r.pump(100, &f1);
    ok("frozen: hidden, and the status says why",
       !r.map_layer()->params.visible && r.st().state == "frozen" && r.st().reason == "the phone's cluster stream froze");
    r.feed->set_stream(true, false, Picture::Shown);
    r.pump(1200, &f1);
    ok("no longer frozen: shown again", r.map_layer()->params.visible && r.st().state == "showing");

    Rig h;
    h.feed->set_stream(false, false, Picture::None);
    h.svc.reset();
    h.start();
    h.pump(3000, &f1);
    ok("a layer made while the stream is not live is hidden: idle, the slot not asked for",
       h.map_layer() && !h.map_layer()->params.visible && h.st().state == "idle" && h.port.requests == 0);

    /* The stream's own pictures, from a stream start with the stock map up. */
    std::vector<uint8_t> black(1088 * 720, 128);
    std::fill(black.begin(), black.begin() + 1088 * 480, 16);
    Rig b(true, 60000);
    b.port.stock_map(0x100, 0x01000101);
    b.pump(100);
    ok("blank start: live, no frame yet: idle, no reason, the slot not asked for",
       b.st().state == "idle" && b.st().reason.empty() && b.port.requests == 0);
    b.pump(2000, &black, 20);   /* the car's start: about 100 blank frames in 2 s */
    b.pump(60000);              /* then a pause */
    const crs::SlotInfo *stock_b = b.port.row(0x100, 0x01000101);
    ok("blank start: the burst and a minute's pause never ask for the slot; the stock map stays",
       b.port.requests == 0 && !b.port.row(0x100, 0x010004f0) && stock_b && stock_b->map_status == 1 &&
           b.map_layer() && !b.map_layer()->params.visible);
    ok("blank start: idle, and the app told it waits for the phone's map",
       b.st().state == "idle" && b.st().reason == MapFeed::kWaiting && !b.st().stream_reason &&
           b.st().reason == "Waiting for the phone's map");
    ok("blank start: a lost stream's reason comes first",
       b.feed->status("decode", lost).reason == lost && b.feed->status("decode", lost).stream_reason);
    b.pump(5, &f1);   /* one non-blank frame, then nothing */
    b.pump(1500);
    g = b.gpu.graph("map");
    drawn = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            drawn = drawn || (kv.second.f == crs::TexFormat::R8 && kv.second.px == f1);
    stock_b = b.port.row(0x100, 0x01000101);
    ok("first picture: the slot asked for once, the stock map taken over, that frame shown",
       b.st().state == "showing" && drawn && b.port.requests == 1 && b.port.taken_over.size() == 1 && stock_b &&
           stock_b->map_status == 3);
    for (int spell = 0; spell < 6; spell++) {
        b.pump(9000, &black, 1000);   /* a blank frame a second for 9 s */
        b.pump(5, &f1);
    }
    ok("blank spells of 9 s between pictures: showing throughout, the slot not asked for again",
       b.st().state == "showing" && b.port.requests == 1 && b.map_layer()->params.visible);
    const int rel_b = b.port.releases;
    b.pump(5, &black);   /* one blank frame, then nothing */
    b.pump(9900);
    ok("one blank frame, then nothing: the map stays until blank_ms",
       b.st().state == "showing" && b.port.releases == rel_b);
    b.pump(2500);   /* blank_ms, then the fade out and the linger */
    stock_b = b.port.row(0x100, 0x01000101);
    ok("blank for blank_ms: hidden, the slot given back, the stock map shown, the app told it waits for the phone's map",
       !b.map_layer()->params.visible && b.port.releases > rel_b && !b.port.row(0x100, 0x010004f0) && stock_b &&
           stock_b->map_status == 1 && b.st().state == "idle" && b.st().reason == MapFeed::kWaiting);
    b.pump(5, &f1);
    b.pump(1500);
    ok("the next picture takes the slot again", b.st().state == "showing" && b.port.requests == 2);

    Rig fz(true, 60000);
    fz.port.stock_map(0x100, 0x01000101);
    fz.pump(31000, &black, 65);   /* blank at 15 fps from the start */
    ok("blank at full rate from the start: frozen after 30 s, the slot never asked for",
       fz.st().state == "frozen" && fz.port.requests == 0 && !fz.map_layer()->params.visible);

    Rig lf(true, 60000);
    lf.live_stall_ms = 6000;
    lf.port.stock_map(0x100, 0x01000101);
    lf.pump(100);
    bool every = true;
    for (int k = 0; k < 3; k++) {
        lf.pump(5, &f1);   /* one frame, then nothing for 10 s */
        lf.pump(1500);
        every = every && lf.st().state == "showing" && lf.map_layer()->params.visible;
        lf.pump(8500);
        every = every && lf.st().state == "idle";
    }
    ok("live through a recent frame: a static map's frame every 10 s is shown each time it makes the stream live",
       every && lf.port.requests == 3);

    Rig nl(true, 60000);
    nl.port.stock_map(0x100, 0x01000101);
    nl.pump(1500, &f1);
    ok("reconnect: the first stream shows", nl.st().state == "showing" && nl.port.requests == 1);
    uint64_t seq = 0;
    std::vector<std::string> lines;
    cld::log_lines_since(&seq, &lines);
    lines.clear();
    nl.live = false;   /* the connection ends */
    nl.pump(2000);
    nl.pump(5, &f1);   /* the ended stream's last frame, still on its way */
    nl.pump(200, &black, 20);
    nl.pump(3500);
    nl.live = true;   /* the next connection */
    nl.pump(1500);
    const crs::SlotInfo *stock_nl = nl.port.row(0x100, 0x01000101);
    ok("reconnect: a frame decoded after the end, the next stream live seconds later: idle, hidden, the stock map shown",
       nl.st().state == "idle" && nl.st().reason.empty() && !nl.map_layer()->params.visible &&
           nl.port.requests == 1 && stock_nl && stock_nl->map_status == 1);
    cld::log_lines_since(&seq, &lines);
    int not_live = 0;
    for (const std::string &line : lines)
        not_live += line.find("cluster stream is not live") != std::string::npos;
    ok("reconnect: the stream ending is logged once, whatever frames still come", not_live == 1);
    nl.live = false;
    nl.pump(2000);
    nl.pump(5, &f1);
    nl.pump(500);
    nl.live = true;   /* a new stream's first frame, decoded before its connection is read */
    nl.pump(1500);
    ok("reconnect: a frame decoded just before the stream is live takes the slot",
       nl.st().state == "showing" && nl.port.requests == 2);

    StatusLog sl;
    FeedStatus a;
    a.state = "showing";
    a.target = "map";
    a.page = "Waze map — 15 frames/s";
    int64_t t = 1000000;
    ok("status log: the first status", sl.due(a, t));
    a.page = "Waze map — 14 frames/s";
    a.upload_cap_kb = 5500;
    a.upload_reason = "slow flushes";
    ok("status log: not for the page or the upload cap", !sl.due(a, t));
    a.reason = "Stream lost";
    a.stream_reason = true;
    ok("status log: the stream's reason", sl.due(a, t));
    a.reason.clear();
    a.stream_reason = false;
    ok("status log: the stream whole again within 10 s waits", !sl.due(a, t + 2000));
    a.reason = "Stream lost";
    a.stream_reason = true;
    ok("status log: so does its next loss; the logged reason is the same, nothing to log",
       !sl.due(a, t + 4000) && !sl.due(a, t + 10000));
    a.reason.clear();
    a.stream_reason = false;
    ok("status log: a change still standing 10 s after the last such line is logged",
       !sl.due(a, t + 9000) && sl.due(a, t + 10500));
    a.state = "idle";
    a.reason = "Stream lost";
    a.stream_reason = true;
    ok("status log: a state change is logged at once, with its reason", sl.due(a, t + 11000));
    a.state = "starting";
    a.reason = "the stock map holds the slot";
    a.stream_reason = false;
    ok("status log: a state and reason", sl.due(a, t + 11100));
    ok("status log: the same again is not", !sl.due(a, t + 11200));
    a.reason = "another app holds the slot";
    ok("status log: a reason of the feed's own alone, at once", sl.due(a, t + 11300));
    a.target = "panel";
    ok("status log: a target alone", sl.due(a, t + 11400));

    guide_hold();
    {   /* (its own scope: the names of the rest of main) */
    /* ---- MapFeeds: the cluster, and the HUD's copy when it is on ---- */
    Rig b(false, 6000, false, true, true);
    b.feed.reset();   /* the rig's single feed is not used here */
    b.sc.targets[2].spare = true;
    b.sc.targets[2].strike_limit = 2;   /* as cluster-render's main sets the iDrive 7 HUD */
    b.start();
    FeedConfig bfc;
    bfc.socket = b.path;
    bfc.video.level_bits = 0;
    MapFeeds feeds(bfc, false, 10);
    feeds.set_stream(true, false, Picture::Shown);
    std::vector<uint8_t> bspare;
    bool hud_asked = false;
    /* vary: each frame differs from the one before (a moving map) */
    const auto bpump = [&](int64_t ms, const std::vector<uint8_t> *frame, bool vary = false) {
        for (int64_t t = 0; t < ms; t += 5) {
            b.now += 5;
            if (frame && t % 65 == 0) {
                bspare.assign(frame->begin(), frame->end());
                if (vary)
                    bspare[(size_t)(t / 65) % 1088] ^= 0x80;
                feeds.offer(&bspare, (uint64_t)b.now, b.now);
            }
            for (int round = 0; round < 400; round++) {
                std::vector<pollfd> fds;
                const size_t first = b.svc->poll_fds(&fds);
                const int n = ::poll(fds.data(), fds.size(), 0);
                b.port.tick(b.now);
                b.svc->after_poll(fds, first, b.now);
                const bool pending = feeds.cluster().wants_write() || (feeds.hud_feed() && feeds.hud_feed()->wants_write());
                const int64_t w = feeds.wake_in_ms(b.now);
                if (w > 0 && w <= MapFeed::kScaleWaitMs)
                    usleep(1000);   /* the HUD's worker scaling */
                feeds.poll(b.now);
                hud_asked = hud_asked || b.svc->slots().requested(2);
                if (round > 0 && n <= 0 && !pending && w != MapFeed::kScaleWaitMs)
                    break;
            }
        }
    };
    const auto layer_on = [&](int target) -> const crs::Layer * {
        for (const crs::Layer *x : b.svc->compositor().layers())
            if (x->target() == target)
                return x;
        return nullptr;
    };
    const auto shown_r8 = [&](const char *target, const std::vector<uint8_t> &px) {
        crs::FakeGraph *g = b.gpu.graph(target);
        bool on = false;
        if (g)
            for (const auto &kv : g->shown.buffers)
                on = on || (kv.second.f == crs::TexFormat::R8 && kv.second.px == px);
        return on;
    };
    bpump(1500, &f1);
    ok("HUD off (the default): the map on the cluster, no HUD feed, layer or request",
       layer_on(0) && shown_r8("map", f1) && !feeds.hud_feed() && !layer_on(2) && !hud_asked &&
           feeds.status("decode").state == "showing" && feeds.status("decode").hud_state == "off" && !feeds.status("decode").hud);
    ok("HUD off: no hud scene ever published", !b.gpu.graph("hud"));

    feeds.set_hud(true);
    bpump(1500, &f1);
    /* the HUD shows the map smaller: its frame is scaled on the head unit */
    AtlasScaler ref;
    std::vector<uint8_t> f1_hud;
    ref.configure(1088, 480, 452, 200, 2);   /* FeedConfig::scaled_level_bits */
    ref.set_corner_radius(200 / 12);         /* FeedConfig::hud_round_corners */
    ref.set_black_background(true);          /* FeedConfig::hud_black_background */
    ref.scale(f1.data(), &f1_hud);
    const crs::Layer *bh = layer_on(2);
    ok("HUD on: a layer on each target, the frame on the cluster whole and on the HUD scaled to 452x200, showing",
       layer_on(0) && bh && shown_r8("map", f1) && shown_r8("hud", f1_hud) && feeds.status("decode").state == "showing" &&
           feeds.status("decode").hud_state == "showing" && feeds.status("decode").target == "map");
    ok("HUD on: its map fitted inside its 800x480 scene",
       bh && bh->params.rect.w <= 800 && bh->params.rect.h <= 480 && bh->params.rect.x + bh->params.rect.w <= 800);
    {
        const uint64_t before = feeds.hud_feed()->scaled_frames();
        bpump(2000, &f2, true);
        const uint64_t scaled = feeds.hud_feed()->scaled_frames() - before;
        char name[160];
        std::snprintf(name, sizeof name, "HUD on: at most 10 frames a second while the cluster takes 15 (%llu in 2 s)",
                      (unsigned long long)scaled);
        ok(name, scaled >= 15 && scaled <= 21);
        /* one more frame right after a HUD frame went, then none: it is not
         * due yet, and still reaches the HUD */
        const auto hud_px = [&]() {
            crs::FakeGraph *g = b.gpu.graph("hud");
            std::vector<uint8_t> px;
            if (g)
                for (const auto &kv : g->shown.buffers)
                    if (kv.second.f == crs::TexFormat::R8)
                        px = kv.second.px;
            return px;
        };
        const std::vector<uint8_t> before_last = hud_px(), f3 = atlas(3);
        bspare.assign(f3.begin(), f3.end());
        feeds.offer(&bspare, (uint64_t)b.now, b.now);
        bpump(600, nullptr);
        ok("HUD on: the newest frame, offered between two HUD frames, reaches the HUD once the stream stops",
           shown_r8("map", f3) && !before_last.empty() && hud_px() != before_last);
        const uint64_t still_from = feeds.hud_feed()->scaled_frames();
        bpump(8000, &f3);   /* past the layers' stall_ms (6 s) */
        const crs::Layer *hs = layer_on(2);
        std::string why;
        ok("HUD on, a still map: the same frame not scaled again, the HUD layer kept fed past its stall time",
           feeds.hud_feed()->scaled_frames() == still_from && shown_r8("map", f3) && hs &&
               b.svc->compositor().state(hs->id(), &why) == crs::LayerState::Shown &&
               feeds.status("decode").hud_state == "showing");
    }

    ok("start: the HUD alone is no cluster target", !feeds.set_target("hud") && feeds.cluster().target() == "map");
    ok("start: panel (the HUD's scene id) drops the HUD's feed", feeds.set_target("panel") && !feeds.hud_feed());
    bpump(2500, &f2);
    ok("on panel: no HUD layer, the HUD reported off", !layer_on(2) && feeds.status("decode").hud_state == "off" &&
                                                         feeds.status("decode").hud);
    ok("start: back on map, the HUD's feed again", feeds.set_target("map") && feeds.hud_feed());
    bpump(2500, &f2);

    /* ---- the HUD map's size ---- */
    const crs::Layer *hl = layer_on(2);
    const unsigned default_w = hl ? hl->params.rect.w : 0;
    ok("the default HUD map is the kit's fitted box, narrower than the HUD", hl && default_w > 0 && default_w < 800);
    feeds.set_hud_width(100);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("100 %: held to the widest, 85 % (680x300), the picture's shape kept, centred",
       hl && hl->params.rect.w == 680 && hl->params.rect.h == 300 && hl->params.rect.x == 60 && hl->params.rect.y == 90 &&
           feeds.status("decode").hud_width_pct == 85);
    feeds.set_hud_width(40);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("40 %: resized live, centred", hl && hl->params.rect.w == 320 && hl->params.rect.h == 140 &&
                                      hl->params.rect.x == 240 && hl->params.rect.y == 169);
    /* the frame goes at the size it is shown: 320x140, 67,200 B instead of 783,360 */
    crs::FakeGraph *g40 = b.gpu.graph("hud");
    bool small = false;
    if (g40)
        for (const auto &kv : g40->shown.buffers)
            small = small || (kv.second.f == crs::TexFormat::R8 && kv.second.px.size() == 320u * 210);
    ok("40 %: the HUD's texture is the scaled frame, 320x140 (67,200 B)", small);
    ok("the size leaves the cluster's map alone", layer_on(0) && layer_on(0)->params.rect.w == 1088);
    feeds.set_hud(false);
    bpump(2500, &f2);
    ok("HUD off again: its layer gone, the cluster's map as it was", !layer_on(2) && layer_on(0) && shown_r8("map", f2));
    feeds.set_hud(true);
    bpump(2500, &f2);
    ok("a HUD feed made later takes the size", layer_on(2) && layer_on(2)->params.rect.w == 320);
    feeds.set_hud_width(0);
    bpump(300, &f2);
    ok("0: back to the default box", layer_on(2) && layer_on(2)->params.rect.w == default_w);

    /* ---- where the HUD map is ---- */
    feeds.set_hud_width(40);
    bpump(300, &f2);
    const crs::Layer *at40 = layer_on(2);
    const uint32_t ref40 = at40 ? at40->id() : 0;
    feeds.set_hud_offset(100, -50);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("moved: 100 right, 50 up from the centre (240,169 -> 340,119)", hl && hl->params.rect.x == 340 && hl->params.rect.y == 119 &&
                                                                          hl->params.rect.w == 320 && hl->params.rect.h == 140);
    ok("moved: the same layer, only its place changed (no new texture)", hl && hl->id() == ref40);
    ok("moved: the status carries the offset", feeds.status("decode").hud_offset_x == 100 && feeds.status("decode").hud_offset_y == -50);
    feeds.set_hud_offset(800, 800);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("moved too far: held inside the HUD (its bottom right corner)",
       hl && hl->params.rect.x + hl->params.rect.w == 800 && hl->params.rect.y + hl->params.rect.h >= 479 && hl->params.rect.y + hl->params.rect.h <= 480);
    ok("moved too far: the offset reported as far as it goes (240,170 for 320x140)",
       feeds.status("decode").hud_offset_x == 240 && feeds.status("decode").hud_offset_y == 170);
    feeds.set_hud_offset(-800, -800);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("moved too far the other way: the top left corner", hl && hl->params.rect.x == 0 && hl->params.rect.y == 0);
    feeds.set_hud_offset(-30, 20);
    feeds.set_hud_width(60);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("resized while moved: the new size, still moved (60 %: 480x211 centred at 160,134, so 130,154)",
       hl && hl->params.rect.w == 480 && hl->params.rect.x == 130 && hl->params.rect.y == 154);
    feeds.set_hud_offset(200, 0);
    feeds.set_hud_width(85);
    bpump(300, &f2);
    feeds.set_hud_width(40);
    bpump(300, &f2);
    hl = layer_on(2);
    ok("moved, made larger (held to 60 px) and smaller again: back where it was asked (240+200 = 440)",
       hl && hl->params.rect.x == 440 && feeds.status("decode").hud_offset_x == 200);
    feeds.set_hud_offset(-30, 20);
    feeds.set_hud_width(60);
    bpump(300, &f2);
    ok("the offset leaves the cluster's map alone", layer_on(0) && layer_on(0)->params.rect.x == 0 && layer_on(0)->params.rect.y == 0);
    feeds.set_hud_offset(0, 0);
    feeds.set_hud_width(0);

    feeds.set_stream(false, false, Picture::None);
    bpump(200, &f2);
    ok("the stream not live reaches both feeds: idle", feeds.status("decode").state == "idle" &&
                                                      feeds.status("decode").hud_state == "idle");
    }

    {   /* ---- before the renderer: the HUD's place as saved ---- */
    FeedConfig nfc;
    nfc.socket = "/tmp/woc-feed-no-renderer-" + std::to_string(getpid()) + ".sock";
    nfc.hud_offset_x = 30;
    nfc.hud_offset_y = -20;
    MapFeeds none(nfc, true, 10);
    none.poll(1000);
    ok("HUD on, no renderer yet: the status has the saved place, not the centre",
       none.status("decode").hud_offset_x == 30 && none.status("decode").hud_offset_y == -20);
    none.set_hud_offset(40, -20);
    ok("and a move then is taken as asked", none.status("decode").hud_offset_x == 40);
    }

    {   /* ---- the HUD disabled by cluster-render's mapping guard ---- */
    const std::string path = "/tmp/woc-feed-hud-guard-" + std::to_string(getpid()) + ".txt";
    std::ofstream(path) << "version t\nboot b\nhud 0x323 0x1000400 0 1 0 2\n";
    Rig d(false, 6000, false, true, true);
    d.feed.reset();
    d.sc.targets[2].spare = true;
    d.sc.targets[2].strike_limit = 2;
    d.sc.guard_path = path;
    d.sc.version = "t";
    d.sc.boot_id = "b";
    d.start();
    FeedConfig dfc;
    dfc.socket = d.path;
    dfc.video.level_bits = 0;
    MapFeeds feeds(dfc, true, 10);
    feeds.set_stream(true, false, Picture::Shown);
    std::vector<uint8_t> dspare;
    bool hud_asked = false;
    for (int64_t t = 0; t < 3000; t += 5) {
        d.now += 5;
        if (t % 65 == 0) {
            dspare.assign(f1.begin(), f1.end());
            feeds.offer(&dspare, (uint64_t)d.now, d.now);
        }
        for (int round = 0; round < 50; round++) {
            std::vector<pollfd> fds;
            const size_t first = d.svc->poll_fds(&fds);
            const int n = ::poll(fds.data(), fds.size(), 0);
            d.port.tick(d.now);
            d.svc->after_poll(fds, first, d.now);
            feeds.poll(d.now);
            hud_asked = hud_asked || d.svc->slots().requested(2);
            if (round > 0 && n <= 0)
                break;
        }
    }
    const FeedStatus ds = feeds.status("decode");
    ok("HUD disabled by the guard: never asked for, reported disabled, its frames not scaled; the cluster's map showing",
       !hud_asked && ds.hud_state == "disabled" && ds.state == "showing" && feeds.hud_feed() &&
           feeds.hud_feed()->scaled_frames() == 0);
    feeds.set_hud(false);
    feeds.set_hud(true);
    for (int64_t t = 0; t < 1000; t += 5) {
        d.now += 5;
        std::vector<pollfd> fds;
        const size_t first = d.svc->poll_fds(&fds);
        ::poll(fds.data(), fds.size(), 0);
        d.port.tick(d.now);
        d.svc->after_poll(fds, first, d.now);
        feeds.poll(d.now);
        hud_asked = hud_asked || d.svc->slots().requested(2);
    }
    ok("HUD disabled: off and on again from the app, still disabled", !hud_asked && feeds.status("decode").hud_state == "disabled");
    unlink(path.c_str());
    }

    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
