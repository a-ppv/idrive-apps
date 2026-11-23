/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test of the whole service over its socket (service.h, server.h,
 * PROTOCOL.md) with the C++ client (cluster_render/client.h), on fake
 * display backends: the hello; a video layer stalled until its first frame,
 * then mapped and shown with that frame; a second client's overlay in the
 * same scene with no second request; the stock HMI taking the slot from a
 * contending layer and the retry; a client going away taking its layers
 * and nothing else; the last one going releasing the slot after the linger;
 * the service restarting under a client, which makes its layers again and
 * sends its image whole; refusals reported to the client; the status;
 * assets, binds, uniform arrays, a turned image, a mesh layer with a part,
 * its geometry and transform, and animations, all made again after a
 * restart; malformed and oversized mesh messages and bad animation keys
 * refused without harm; on a KOMBI that parks a map behind the one it
 * shows: the map parked behind the stock map, which is unmapped as the HMI,
 * then shown and faded in, the stock map parked behind it; when the stream
 * ends the map fades out, is released and the stock map is shown again; the
 * stream back at once, the map is asked for again in the same scene as soon
 * as the KOMBI confirms the release; a target that does not take over stays parked, with no timeout, reported
 * as parked behind the stock HMI, and is shown when the stock content goes.
 * A hold of the guidance slot (slots.h): no client's target; held, with
 * the box taken over and parked behind it, while the map is shown, and with
 * the seat-belt panel parked there; released with the map and at stop; the
 * map's layer choosing it with guide_hold, and a client without the field
 * getting it. Cluster restarts right after the hold's mapping, again and
 * again: the map and the hold shown again after each. A video frame repeated: a few bytes
 * that keep the layer from stalling, to a service that takes repeats; the
 * last frame whole again to one that does not, to one that restarted and
 * after the service refuses the layer; a refused layer's still map answered
 * with one error; repeats waiting behind a whole frame sent as one, or not
 * at all once a newer frame is queued. The service's reads: a frame split
 * across reads, several messages in one, one of the largest length, and one
 * longer or empty disconnecting only its client. Scene files: refused on a
 * target that takes none, with a resource file's hash not its, from outside
 * the root and without a hash for each file; a synthetic one parked behind
 * the stock content, loaded with its edits, an edit held while parked and
 * flushed once shown; made again with its edits by the client after a
 * service restart; layers there waiting for it, named by its client or its
 * ref, and a second scene refused; unpublished for the HUD's shared scene
 * id and loaded again with every kept edit; dropped, the layers back; a
 * file of another scene id in error, the layers back; edit lines refused or
 * changing nothing reported; another file in place, the slot neither
 * released nor asked for again; its client gone, kept through the linger
 * and then released. The HUD's layers choose whether it gives way to the
 * stock pop-ups (yield), a client without the field getting it. A scene
 * with layers and a host of the map (layers_and_hosting); a host from a
 * client's layers, with no scene (hosting_from_layers, hosting_from_layers_more). A layer's
 * preload, end to end (preload). A layer's others_fps holding another
 * client's video and releasing it (others_fps). Render state and samplers
 * (render_state_and_samplers). */
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "../kit/yuv_atlas.h"
#include "../src/log.h"
#include "../src/service.h"
#include "cluster_render/client.h"
#include "fake_graph.h"
#include "fake_port.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

struct Events {
    std::map<uint32_t, std::string> layer;    /* ref -> last state */
    std::map<std::string, std::string> target, holder;
    std::vector<std::string> errors;
    int ready = 0;
    void wire(cr::Client &c)
    {
        c.on_ready = [this] { ready++; };
        c.on_layer = [this](uint32_t r, const std::string &s, const std::string &) { layer[r] = s; };
        c.on_target = [this](const std::string &t, const std::string &s, const std::string &h, const std::string &) {
            target[t] = s;
            holder[t] = h;
        };
        c.on_error = [this](const std::string &op, uint32_t, const std::string &why) {
            errors.push_back(op + ": " + why);
        };
    }
};

static int next_rig()
{
    static int rigs;
    return ++rigs;
}

struct Rig {
    std::string path = "/tmp/crs-service-test-" + std::to_string(getpid()) + "-" + std::to_string(next_rig()) + ".sock";
    FakeGpu gpu;
    FakePort port;
    ServiceConfig sc;
    std::unique_ptr<Service> svc;
    std::vector<cr::Client *> clients;
    int64_t now = 100000;

    explicit Rig(uint64_t budget_bps = 0)
    {
        TargetSpec m;
        m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 1500;
        m.take_over_stock = true;
        TargetSpec p;
        p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 3000;
        sc.targets = {m, p};
        sc.socket_path = path;
        sc.backend = "fake";
        sc.budget.max_bps = budget_bps;
        sc.budget.floor_bps = budget_bps / 3;
        start();
    }
    ~Rig() { svc.reset(); }
    void start()
    {
        port.m = nullptr;
        port.watchdog();
        svc.reset(new Service(&gpu, &port, sc));
        port.m = &svc->slots();
        std::string err;
        if (!svc->start(&err))
            std::printf("start: %s\n", err.c_str());
    }
    /* Each step of simulated time runs the socket exchange until it is
     * idle, as the event-driven loops on the unit do within a few ms. */
    void pump(int64_t ms, int64_t step = 5)
    {
        for (int64_t t = 0; t < ms; t += step) {
            now += step;
            for (int round = 0; round < 400; round++) {
                bool pending = false;
                for (cr::Client *c : clients)
                    pending = pending || c->wants_write();
                std::vector<pollfd> fds;
                size_t first = 0;
                if (svc)
                    first = svc->poll_fds(&fds);
                const int n = ::poll(fds.data(), fds.size(), 0);
                if (svc) {
                    port.tick(now);
                    svc->after_poll(fds, first, now);
                }
                for (cr::Client *c : clients)
                    c->poll(now);
                if (round > 0 && n <= 0 && !pending)
                    break;
            }
        }
    }
};

/* A client that writes protocol bytes as given, to send what the clients
 * never would. */
struct Raw {
    int fd = -1;
    std::string in;
    explicit Raw(const std::string &path)
    {
        struct sockaddr_un a;
        std::memset(&a, 0, sizeof a);
        a.sun_family = AF_UNIX;
        std::snprintf(a.sun_path, sizeof a.sun_path, "%s", path.c_str());
        fd = socket(AF_UNIX, SOCK_STREAM, 0);
        connect(fd, (struct sockaddr *)&a, sizeof a);
    }
    ~Raw() { close(fd); }
    void send(const std::string &json) { send_message(cr::encode(cr::kJson, json)); }
    void send_message(const std::string &m)
    {
        if (write(fd, m.data(), m.size()) != (ssize_t)m.size())
            std::printf("raw write failed\n");
    }
    std::string events()
    {
        char b[4096];
        pollfd p{fd, POLLIN, 0};
        while (::poll(&p, 1, 0) > 0) {
            ssize_t n = read(fd, b, sizeof b);
            if (n <= 0)
                break;
            in.append(b, (size_t)n);
        }
        return in;
    }
};

/* A mesh message body: header and then raw bytes as given. */
static std::string mesh_body(uint32_t ref, uint32_t part, uint32_t vertices, uint32_t indices, uint8_t mask,
                             const std::string &rest)
{
    std::string b;
    for (uint32_t v : {ref, part, vertices, indices})
        for (int i = 0; i < 4; i++)
            b.push_back((char)(v >> (8 * i)));
    b.push_back((char)mask);
    return cr::encode(cr::kMesh, b + rest);
}

static cr::Geometry cube()
{
    static const float n[6][3] = {{0, 0, 1}, {0, 0, -1}, {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}};
    cr::Geometry g;
    for (int f = 0; f < 6; f++) {
        const float *N = n[f];
        const float a[3] = {N[1], N[2], N[0]};
        const float b[3] = {N[1] * a[2] - N[2] * a[1], N[2] * a[0] - N[0] * a[2], N[0] * a[1] - N[1] * a[0]};
        const uint16_t base = (uint16_t)(g.positions.size() / 3);
        for (int v = 0; v < 4; v++) {
            const float sa = (v & 1) ? 1.0f : -1.0f, sb = (v & 2) ? 1.0f : -1.0f;
            for (int c = 0; c < 3; c++) {
                g.positions.push_back(N[c] + sa * a[c] + sb * b[c]);
                g.normals.push_back(N[c]);
            }
        }
        for (uint16_t k : {0, 1, 2, 2, 1, 3})
            g.indices.push_back((uint16_t)(base + k));
    }
    return g;
}

static std::vector<uint8_t> atlas(int seed)
{
    std::vector<uint8_t> f(1088 * 720);
    for (size_t i = 0; i < f.size(); i++)
        f[i] = (uint8_t)(i < 1088 * 480 ? (i / 7 + seed * 13) & 0xff : 128);
    return f;
}

/* The atlas quad's opacity as shown; -1: no such quad. */
static float atlas_opacity(FakeGraph *g)
{
    if (!g)
        return -1.0f;
    for (auto &kv : g->shown.quads) {
        auto t = kv.second.textures.find("u_image");
        if (t != kv.second.textures.end() && g->shown.buffers.at(t->second).f == TexFormat::R8)
            return kv.second.uniforms["u_opacity"].empty() ? -1.0f : kv.second.uniforms["u_opacity"][0];
    }
    return -1.0f;
}

static void take_over_and_fall_back()
{
    Rig r;
    r.sc.targets[0].linger_ms = 0;   /* as the map's default */
    r.start();
    const uint64_t kHmiMap = 0x01000300;
    r.port.stock_map(0x100, kHmiMap);   /* Map view: the HMI's map shown */
    cr::Client a("waze", r.path);
    Events ea;
    ea.wire(a);
    std::vector<std::string> states;
    a.on_target = [&](const std::string &t, const std::string &st, const std::string &h, const std::string &why) {
        ea.target[t] = st;
        ea.holder[t] = h;
        if (t == "map")
            states.push_back(st + (why.empty() ? "" : " (" + why + ")"));
    };
    r.clients = {&a};
    r.pump(50);
    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = a.video(lo, cr::VideoOptions());
    const std::vector<uint8_t> f = atlas(1);
    a.frame(map, f.data(), f.size(), 1);
    r.pump(100);
    bool parked = false;
    for (const std::string &st : states)
        parked = parked || st.find("parked") == 0;
    const SlotInfo *ours = r.port.row(0x100, 0x010004f0), *hmi = r.port.row(0x100, kHmiMap);
    ok("the map parked behind the stock map, which is unmapped as the HMI: ours shown, the HMI's parked behind",
       parked && r.port.taken_over == std::vector<uint64_t>{kHmiMap} && ea.target["map"] == "shown" && ours &&
           ours->map_status == 1 && hmi && hmi->map_status == 3);
    const float early = atlas_opacity(r.gpu.graph("map"));
    r.pump(300);
    ok("shown: faded in", early >= 0.0f && early < 1.0f && atlas_opacity(r.gpu.graph("map")) == 1.0f &&
                              ea.layer[map] == "shown");
    for (int k = 0; k < 20; k++) {
        a.frame(map, f.data(), f.size(), 2 + k);
        r.pump(500);
    }
    ok("the HMI's map parked behind ours: no more take-overs", r.port.taken_over.size() == 1 &&
                                                                   ea.target["map"] == "shown");

    /* The stream ends: the app hides the map. */
    lo.visible = false;
    a.set(map, lo);
    r.pump(150);
    const float mid = atlas_opacity(r.gpu.graph("map"));
    ok("the stream ended: the map fades out, the slot still ours", ea.target["map"] == "shown" && mid > 0.0f &&
                                                                       mid < 1.0f);
    for (int k = 0; k < 60 && ea.target["map"] != "idle"; k++)
        r.pump(5);
    hmi = r.port.row(0x100, kHmiMap);
    ok("then released: idle, the stock map shown again", ea.target["map"] == "idle" && hmi && hmi->map_status == 1 &&
                                                             !r.port.row(0x100, 0x010004f0));
    const int scenes = r.gpu.scenes, requests = r.port.requests;
    lo.visible = true;
    a.set(map, lo);
    a.frame(map, f.data(), f.size(), 100);
    r.pump(100);
    const int64_t after = r.port.last_request_ms - r.port.last_release_ms;
    ok("the stream back at once: asked for again in the same scene once the KOMBI confirms the release",
       r.port.requests == requests + 1 && r.gpu.scenes == scenes && after >= r.port.confirm_ms &&
           after < r.port.confirm_ms + 20);
    lo.visible = false;
    a.set(map, lo);
    r.pump(500);
    ok("and released again", ea.target["map"] == "idle");
    const size_t overs = r.port.taken_over.size();

    /* The panel does not take over: parked until the stock content goes. */
    cr::LayerOptions pl;
    pl.target = "panel";
    pl.contend = true;
    a.effect(pl, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
    r.pump(10);   /* requested; the HMI maps its speech dialog before the answer */
    r.port.stock_map(0x203, 0x01000401);
    r.pump(7000);
    const std::string text = r.svc->server().status_text(r.now);
    ok("a target that does not take over: parked, no timeout, in the events and the status",
       ea.target["panel"] == "parked" && ea.holder["panel"] == "stock" && r.port.taken_over.size() == overs &&
           text.find("target panel: slot 0x203 scene 0x1000400 1920x720: parked (stock) parked behind stock") !=
               std::string::npos);
    ok("the status: the map's released scene still published, subscriptions not observable",
       text.find("target map: slot 0x100 scene 0x10004f0 1088x480: idle; scene published") != std::string::npos &&
           text.find("renderer: subscription not observable") != std::string::npos);
    r.port.stock_unmap(0x203, 0x01000401);
    r.pump(50);
    ok("the stock content gone: shown", ea.target["panel"] == "shown");
}

static const uint64_t kHmiMap = 0x01000300, kBox = 0x01000310, kGuide = 0x010004f1;

/* The rig with a hold of the guidance slot following the map (slots.h), on
 * a KOMBI that shows the HMI's map and its turn-by-turn box. */
static void hold_rig(Rig &r)
{
    r.sc.targets[0].linger_ms = 0;
    TargetSpec g;
    g.name = "guide_0x105"; g.slot = 0x105; g.scene_id = kGuide; g.width = g.height = 16; g.linger_ms = 0;
    g.take_over_stock = true; g.follows = "map"; g.take_over_contents = {kBox};
    r.sc.targets.push_back(g);
    r.start();
    r.port.stock_map(0x100, kHmiMap);
    r.port.stock_map(0x105, kBox);
}

static bool has(const std::string &text, const std::string &line)
{
    return text.find(line) != std::string::npos;
}

/* The box's map status in the guidance slot; -1: not mapped. */
static int box_status(const Rig &r)
{
    const SlotInfo *box = r.port.row(0x105, kBox);
    return box ? (int)box->map_status : -1;
}

/* The map shown by a's video layer, its frames never stalling. */
static uint32_t show_map(Rig &r, cr::Client &a, const cr::LayerOptions &lo)
{
    cr::VideoOptions vo;
    vo.stall_ms = 600000;
    const uint32_t map = a.video(lo, vo);
    const std::vector<uint8_t> f = atlas(1);
    a.frame(map, f.data(), f.size(), 1);
    r.pump(400);
    return map;
}

/* A hold of the guidance slot following the map. */
static void guide_hold()
{
    const uint64_t kBelt = 0x01000314;
    Rig r;
    hold_rig(r);
    cr::Client a("waze", r.path);
    Events ea;
    ea.wire(a);
    r.clients = {&a};
    r.pump(50);
    cr::LayerOptions gl;
    gl.target = "guide_0x105";
    a.effect(gl, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
    r.pump(20);
    ok("hold: not one of the clients' targets, and no layer can go on it",
       a.targets == "map:1088x480,panel:1920x720" && !ea.errors.empty() &&
           ea.errors.back() == "layer: unknown target guide_0x105" && r.port.requests == 0);

    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = a.video(lo, cr::VideoOptions());
    const std::vector<uint8_t> f = atlas(1);
    a.frame(map, f.data(), f.size(), 1);
    r.pump(400);
    const SlotInfo *ours = r.port.row(0x105, kGuide), *box = r.port.row(0x105, kBox);
    ok("the map shown: the hold shown in the guidance slot, the box parked behind it",
       ea.target["map"] == "shown" && ours && ours->map_status == 1 && box && box->map_status == 3 &&
           r.port.taken_over == std::vector<uint64_t>{kHmiMap, kBox});
    ok("its scene never drawn, its state in no client's events",
       r.gpu.graph("guide_0x105") && r.gpu.graph("guide_0x105")->visible().empty() && !ea.target.count("guide_0x105"));

    lo.visible = false;
    a.set(map, lo);
    for (int k = 0; k < 100 && ea.target["map"] != "idle"; k++)
        r.pump(5);
    r.pump(20);
    box = r.port.row(0x105, kBox);
    ok("the map gone: the hold released with it, the box shown again",
       ea.target["map"] == "idle" && !r.port.row(0x105, kGuide) && box && box->map_status == 1);

    lo.visible = true;
    a.set(map, lo);
    a.frame(map, f.data(), f.size(), 2);
    r.pump(4000);
    ours = r.port.row(0x105, kGuide);
    ok("the map back: held again", ea.target["map"] == "shown" && ours && ours->map_status == 1);
    r.port.stock_map(0x105, kBelt);   /* the seat-belt panel parked behind ours, as the HMI keeps it */
    r.pump(20);
    ours = r.port.row(0x105, kGuide);
    ok("the seat-belt panel parked there: still held, the panel never taken over",
       ea.target["map"] == "shown" && ours && ours->map_status == 1 &&
           r.port.taken_over == std::vector<uint64_t>{kHmiMap, kBox, kHmiMap, kBox});
    r.svc->shutdown(r.now);
    box = r.port.row(0x105, kBox);
    ok("stop: the hold released with the map", !r.port.row(0x105, kGuide) && !r.port.row(0x100, 0x010004f0) &&
                                                   box && box->map_status == 1);
}

/* The map's layers decide: guide_hold 0 releases the hold and takes nothing
 * over, 1 holds again; a client that never sends the field gets the hold. */
static void guide_hold_choice()
{
    Rig r;
    hold_rig(r);
    cr::Client a("waze", r.path);
    Events ea;
    ea.wire(a);
    r.clients = {&a};
    r.pump(50);
    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    lo.guide_hold = false;
    const uint32_t map = show_map(r, a, lo);
    r.pump(4000);
    ok("guide_hold 0: the map shown, the hold never asked for, the box shown, only the stock map taken over",
       ea.target["map"] == "shown" && !r.port.row(0x105, kGuide) && box_status(r) == 1 &&
           r.port.taken_over == std::vector<uint64_t>{kHmiMap});
    ok("the status names the layer's guide_hold 0",
       has(r.svc->server().status_text(r.now), "layer 1 video of waze on map, content z 0, guide_hold 0: shown"));

    lo.guide_hold = true;
    a.set(map, lo);
    r.pump(400);
    const SlotInfo *ours = r.port.row(0x105, kGuide);
    ok("guide_hold 1: held, the box taken over and parked behind it",
       ours && ours->map_status == 1 && box_status(r) == 3 &&
           r.port.taken_over == std::vector<uint64_t>{kHmiMap, kBox});

    lo.guide_hold = false;
    a.set(map, lo);
    r.pump(400);
    ok("guide_hold 0 again: released, the box shown, the map still shown",
       !r.port.row(0x105, kGuide) && box_status(r) == 1 && ea.target["map"] == "shown");
    r.pump(40000);
    ok("and no take-over of the box since", r.port.taken_over.size() == 2 && !r.port.row(0x105, kGuide));
    a.drop(map);
    r.pump(400);

    Raw old(r.path);
    old.send("{\"op\":\"hello\",\"app\":\"old\",\"proto\":1}");
    old.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"map\",\"kind\":\"effect\",\"fs\":\"x\",\"contend\":1}");
    r.pump(4000);
    ours = r.port.row(0x105, kGuide);
    ok("a client that never sends guide_hold: the map shown and held",
       r.svc->slots().status(0).state == TargetState::Shown && ours && ours->map_status == 1 && box_status(r) == 3);
}

/* The KOMBI restarting: our mappings dropped and the display service gone,
 * then back. */
static void kombi_restart(Rig &r)
{
    r.port.watchdog();
    r.port.set_up(false);
    r.pump(100);
    r.port.set_up(true);
}

/* Cluster restarts right after the hold's mapping, again and again: each
 * logged naming the target mapped last, and the map and the hold shown
 * again after each; the map's client never told either is disabled, the
 * status has no line about it; after a service restart the same. */
static void display_drops()
{
    Rig r;
    hold_rig(r);
    cr::Client a("waze", r.path);
    Events ea;
    ea.wire(a);
    r.clients = {&a};
    r.pump(50);
    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = show_map(r, a, lo);
    const SlotInfo *ours = r.port.row(0x105, kGuide);
    ok("drops: the map and the hold shown", ea.target["map"] == "shown" && ours && ours->map_status == 1);

    uint64_t log_seq = 0;
    std::vector<std::string> lines;
    cld::log_lines_since(&log_seq, &lines);
    for (int k = 0; k < 4; k++) {
        lines.clear();
        kombi_restart(r);
        cld::log_lines_since(&log_seq, &lines);
        bool logged = false;
        for (const std::string &l : lines)
            logged = logged || l.find("the display service went away") != std::string::npos;
        r.pump(5000);
        ours = r.port.row(0x105, kGuide);
        ok(("drop " + std::to_string(k + 1) + " right after a mapping: logged; the map and the hold shown again")
               .c_str(),
           logged && ea.target["map"] == "shown" && ours && ours->map_status == 1);
    }
    ok("the map's client never told the hold or the map is disabled; no such status line",
       !a.guide_disabled["map"] && !a.disabled["map"] &&
           !has(r.svc->server().status_text(r.now), "guard") && !has(r.svc->server().status_text(r.now), "strike"));

    r.svc.reset();
    r.start();
    const std::vector<uint8_t> f = atlas(2);
    for (int k = 0; k < 60; k++) {
        a.frame(map, f.data(), f.size(), 2 + k);
        r.pump(50);
    }
    ours = r.port.row(0x105, kGuide);
    ok("a service restart: the map and the hold shown", ea.target["map"] == "shown" && ours && ours->map_status == 1);
}

/* A service that answers the hello as told and keeps what the client
 * sends. */
struct Answering {
    std::string path = "/tmp/crs-answering-" + std::to_string(getpid()) + "-" + std::to_string(next_rig()) + ".sock";
    int lfd = -1, fd = -1;
    std::string hello, in;
    explicit Answering(const std::string &h) : hello(h)
    {
        struct sockaddr_un a;
        std::memset(&a, 0, sizeof a);
        a.sun_family = AF_UNIX;
        std::snprintf(a.sun_path, sizeof a.sun_path, "%s", path.c_str());
        unlink(path.c_str());
        lfd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (bind(lfd, (struct sockaddr *)&a, sizeof a) < 0 || listen(lfd, 1) < 0)
            std::printf("answering: %s\n", std::strerror(errno));
    }
    ~Answering()
    {
        close(fd);
        close(lfd);
        unlink(path.c_str());
    }
    void pump(cr::Client &c, int64_t *now)
    {
        for (int i = 0; i < 20; i++) {
            *now += 5;
            c.poll(*now);
            pollfd p{lfd, POLLIN, 0};
            if (fd < 0 && ::poll(&p, 1, 0) > 0) {
                fd = accept(lfd, nullptr, nullptr);
                const std::string m = cr::encode(cr::kJson, hello);
                if (write(fd, m.data(), m.size()) != (ssize_t)m.size())
                    std::printf("answering: write failed\n");
            }
            char b[65536];
            pollfd q{fd, POLLIN, 0};
            while (fd >= 0 && ::poll(&q, 1, 0) > 0) {
                const ssize_t n = read(fd, b, sizeof b);
                if (n <= 0)
                    break;
                in.append(b, (size_t)n);
            }
        }
    }
    void send(const std::string &json)
    {
        const std::string m = cr::encode(cr::kJson, json);
        if (write(fd, m.data(), m.size()) != (ssize_t)m.size())
            std::printf("answering: write failed\n");
    }
    /* What came since the last call: J bodies as they are, F as "F <id> <pixel bytes>". */
    std::vector<std::string> take()
    {
        std::vector<std::string> out;
        size_t off = 0, used = 0, n = 0;
        uint8_t type = 0;
        const char *body = nullptr;
        bool bad = false;
        while (cr::next_message(in.data() + off, in.size() - off, &used, &type, &body, &n, &bad)) {
            cr::FrameHeader h;
            if (type == cr::kFrame && cr::parse_frame(body, n, &h))
                out.push_back("F " + std::to_string(h.id) + " " + std::to_string(h.pixel_bytes));
            else
                out.push_back(std::string(body, n));
            off += used;
        }
        in.erase(0, off);
        return out;
    }
};

static bool has(const std::vector<std::string> &m, const std::string &s)
{
    for (const std::string &x : m)
        if (x.find(s) != std::string::npos)
            return true;
    return false;
}

static void repeats()
{
    const std::vector<uint8_t> f1 = atlas(1);
    const std::string frame = "F 1 " + std::to_string(f1.size());
    cr::LayerOptions lo;
    lo.target = "map";
    cr::VideoOptions vo;
    vo.stall_ms = 1000;
    {
        Rig r;
        cr::Client a("waze", r.path);
        Events ea;
        ea.wire(a);
        r.clients = {&a};
        r.pump(50);
        const uint32_t map = a.video(lo, vo);
        ok("repeat: refused before the layer's first frame", !a.repeat(map, 1));
        a.frame(map, f1.data(), f1.size(), 1);
        r.pump(200);
        bool taken = true, shown = true;
        for (int i = 0; i < 40; i++) {
            taken = taken && a.repeat(map, (uint64_t)i + 2);
            r.pump(50);
            shown = shown && ea.layer[map] == "shown";
        }
        const std::vector<const Layer *> v = r.svc->compositor().layers();
        ok("repeats keep a video layer shown past its stall_ms, counted as unchanged frames",
           taken && shown && v.size() == 1 && v[0]->stats().find("1 sent, 40 unchanged") == 0);
        r.pump(1100);
        ok("and with neither frames nor repeats it stalls", ea.layer[map] == "stalled");
    }
    {
        /* A layer the service refuses, with a still map: one error for its
         * frames and repeats, however many come. */
        Rig r;
        cr::Client a("waze", r.path);
        Events ea;
        ea.wire(a);
        r.clients = {&a};
        r.pump(50);
        cr::LayerOptions nowhere = lo;
        nowhere.target = "cockpit";
        const uint32_t map = a.video(nowhere, vo);
        a.frame(map, f1.data(), f1.size(), 1);
        r.pump(50);
        for (int i = 0; i < 40; i++) {
            a.repeat(map, (uint64_t)i + 2);
            r.pump(35);
        }
        int frame_errors = 0;
        for (const std::string &e : ea.errors)
            frame_errors += e.find("frame: ") == 0 || e.find("repeat: ") == 0;
        ok("a refused layer's still map: one error for its frames and repeats", frame_errors == 1 &&
                                                                                  ea.errors.size() == 2);
        Raw raw(r.path);
        raw.send("{\"op\":\"hello\",\"app\":\"raw\",\"proto\":1}");
        for (int i = 0; i < 20; i++)
            raw.send("{\"op\":\"repeat\",\"ref\":7}");
        r.pump(50);
        const std::string ev = raw.events();
        size_t n = 0;
        for (size_t at = ev.find("no such layer"); at != std::string::npos; at = ev.find("no such layer", at + 1))
            n++;
        ok("repeats for a ref the service has not got: answered once", n == 1);
    }
    int64_t now = 0;
    const std::string with_repeats =
        "{\"ev\":\"hello\",\"proto\":1,\"backend\":\"fake\",\"targets\":\"map:1920x720\",\"repeat\":1}";
    {
        Answering s(with_repeats);
        cr::Client c("waze", s.path);
        s.pump(c, &now);
        const uint32_t map = c.video(lo, vo);
        c.frame(map, f1.data(), f1.size(), 1);
        s.pump(c, &now);
        s.send("{\"ev\":\"error\",\"op\":\"frame\",\"ref\":" + std::to_string(map) + ",\"reason\":\"no such layer\"}");
        s.pump(c, &now);
        s.take();
        c.repeat(map, 2);
        s.pump(c, &now);
        const std::vector<std::string> m = s.take();
        ok("the service refuses the layer: its next repeat goes as the last frame whole",
           m.size() == 1 && m[0] == "F 2 " + std::to_string(f1.size()));
    }
    {
        /* Behind whole frames the service has not read yet: seven other
         * layers' frames, more than any socket buffer takes. */
        cr::VideoOptions big = vo;
        big.w = 1920;
        big.h = 720;
        const std::vector<uint8_t> f(1920 * 1080, 7);
        Answering s(with_repeats);
        cr::Client c("waze", s.path);
        s.pump(c, &now);
        std::vector<uint32_t> refs;
        for (int i = 0; i < 8; i++)
            refs.push_back(c.video(lo, big));
        const uint32_t map = refs[0];
        c.frame(map, f.data(), f.size(), 1);
        for (int i = 0; i < 10; i++)
            s.pump(c, &now);
        s.take();
        auto count_repeats = [&](std::vector<std::string> m) {
            int n = 0;
            for (const std::string &x : m)
                n += x.find("\"op\":\"repeat\"") != std::string::npos;
            return n;
        };
        for (size_t i = 1; i < refs.size(); i++)
            c.frame(refs[i], f.data(), f.size(), 2);
        for (int i = 0; i < 5; i++)
            c.repeat(map, (uint64_t)i + 3);
        for (int i = 0; i < 20; i++)
            s.pump(c, &now);
        std::vector<std::string> m = s.take();
        ok("repeats waiting behind whole frames go as one", m.size() == 8 && count_repeats(m) == 1);
        for (size_t i = 1; i < refs.size(); i++)
            c.frame(refs[i], f.data(), f.size(), 9);
        c.repeat(map, 10);
        c.frame(map, f.data(), f.size(), 11);
        for (int i = 0; i < 20; i++)
            s.pump(c, &now);
        m = s.take();
        ok("a repeat waiting when a newer whole frame is queued is dropped",
           m.size() == 8 && count_repeats(m) == 0 && has(m, "F 11 " + std::to_string(f.size())));
        for (size_t i = 1; i < refs.size(); i++)
            c.frame(refs[i], f.data(), f.size(), 12);
        c.repeat(map, 13);
        s.send("{\"ev\":\"error\",\"op\":\"repeat\",\"ref\":" + std::to_string(map) + ",\"reason\":\"no such layer\"}");
        now += 5;
        c.poll(now);
        c.repeat(map, 14);
        for (int i = 0; i < 20; i++)
            s.pump(c, &now);
        m = s.take();
        ok("a repeat waiting when the layer is refused: dropped for the last frame whole",
           m.size() == 8 && count_repeats(m) == 0 && has(m, "F 14 " + std::to_string(f.size())));
    }
    {
        Answering s(with_repeats);
        cr::Client c("waze", s.path);
        s.pump(c, &now);
        const uint32_t map = c.video(lo, vo);
        c.frame(map, f1.data(), f1.size(), 1);
        s.pump(c, &now);
        s.take();
        c.repeat(map, 2);
        s.pump(c, &now);
        const std::vector<std::string> m = s.take();
        ok("to a service that takes repeats: a repeat message, no frame", m.size() == 1 && has(m, "\"op\":\"repeat\""));
    }
    {
        Answering s("{\"ev\":\"hello\",\"proto\":1,\"backend\":\"fake\",\"targets\":\"map:1088x480\"}");
        cr::Client c("waze", s.path);
        s.pump(c, &now);
        const uint32_t map = c.video(lo, vo);
        std::vector<uint8_t> b = f1;
        c.frame(map, &b, 1);
        s.pump(c, &now);
        ok("to a service without repeats: the frame", has(s.take(), frame));
        c.repeat(map, 2);
        c.repeat(map, 3);
        s.pump(c, &now);
        const std::vector<std::string> m = s.take();
        ok("and each repeat as the last frame whole again, newest id",
           m.size() == 2 && m[0] == "F 2 " + std::to_string(f1.size()) && m[1] == "F 3 " + std::to_string(f1.size()));
        std::vector<uint8_t> copy;
        ok("the last frame is kept", c.latest(map, &copy) && copy == f1);
    }
    {
        /* A restart: the first service takes repeats, the next one has not
         * had the frame. */
        Answering s("{\"ev\":\"hello\",\"proto\":1,\"backend\":\"fake\",\"targets\":\"map:1088x480\",\"repeat\":1}");
        cr::Client c("waze", s.path);
        s.pump(c, &now);
        const uint32_t map = c.video(lo, vo);
        c.frame(map, f1.data(), f1.size(), 1);
        s.pump(c, &now);
        close(s.fd);
        s.fd = -1;
        s.pump(c, &now);
        ok("the service gone", !c.connected());
        s.in.clear();
        for (int i = 0; i < 20 && !c.connected(); i++)
            s.pump(c, &now);
        c.repeat(map, 4);
        s.pump(c, &now);
        const std::vector<std::string> m = s.take();
        ok("after a reconnect: the layer made again, and the repeat as the last frame whole",
           has(m, "\"op\":\"layer\"") && has(m, "F 4 " + std::to_string(f1.size())) && !has(m, "\"op\":\"repeat\""));
    }
}

/* The service's reads (recv_buffer.h): a frame split across reads, its
 * length too, shown byte for byte; several messages in one write; a
 * message of the largest length taken; one longer and one empty
 * disconnecting their client and nobody else. */
static void framing()
{
    Rig r;
    Raw raw(r.path);
    fcntl(raw.fd, F_SETFL, fcntl(raw.fd, F_GETFL) | O_NONBLOCK);
    /* All of m, a piece at a time, the service running between pieces. */
    auto put = [&](const std::string &m, size_t piece) {
        for (size_t off = 0; off < m.size();) {
            const ssize_t k = write(raw.fd, m.data() + off, std::min(piece, m.size() - off));
            if (k > 0)
                off += (size_t)k;
            r.pump(5);
        }
    };
    auto gone = [&](int fd) {
        char b[4096];
        for (int i = 0; i < 100; i++) {
            const ssize_t n = read(fd, b, sizeof b);
            if (n == 0)
                return true;
            if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
                return true;
            r.pump(5);
        }
        return false;
    };
    put(cr::encode(cr::kJson, "{\"op\":\"hello\",\"app\":\"raw\"}") +
            cr::encode(cr::kJson, "{\"op\":\"layer\",\"ref\":1,\"target\":\"map\",\"kind\":\"video\"}") +
            cr::encode(cr::kJson, "{\"op\":\"status\"}"),
        1 << 20);
    r.pump(20);
    std::string ev = raw.events();
    ok("several messages in one write: each answered in order",
       ev.find("\"ev\":\"hello\"") < ev.find("\"ev\":\"status\"") && ev.find("\"ev\":\"status\"") != std::string::npos &&
           r.svc->compositor().layers().size() == 1);

    const std::vector<uint8_t> f = atlas(5);
    const std::string frame = cr::frame_head(1, 1, {}, f.size()) + std::string(f.begin(), f.end());
    put(frame.substr(0, 2), 1);
    put(frame.substr(2, 9), 3);
    put(frame.substr(11, 70000), 70000);
    put(frame.substr(70011), 300000);
    r.pump(200);
    std::vector<uint8_t> rounded(f.size());
    crk::round_levels(rounded.data(), f.data(), f.size(), 2);
    bool shown = false;
    if (FakeGraph *g = r.gpu.graph("map"))
        for (const auto &kv : g->shown.buffers)
            shown = shown || (kv.second.f == TexFormat::R8 && kv.second.px == rounded);
    ok("a frame split across reads, its length too, is shown byte for byte", shown);

    const std::vector<uint8_t> f2 = atlas(6);
    std::string two = cr::frame_head(1, 2, {}, f.size()) + std::string(f.begin(), f.end()) +
                      cr::frame_head(1, 3, {}, f2.size()) + std::string(f2.begin(), f2.end()) +
                      cr::encode(cr::kJson, "{\"op\":\"status\"}");
    put(two, two.size());
    r.pump(200);
    crk::round_levels(rounded.data(), f2.data(), f2.size(), 2);
    shown = false;
    if (FakeGraph *g = r.gpu.graph("map"))
        for (const auto &kv : g->shown.buffers)
            shown = shown || (kv.second.f == TexFormat::R8 && kv.second.px == rounded);
    ok("two frames and a message in one write: the newer frame shown", shown);

    std::string largest(4, '\0');
    for (int i = 0; i < 4; i++)
        largest[i] = (char)(cr::kMaxMessage >> (8 * i));
    largest += (char)cr::kFrame;
    largest += std::string(4, '\x09');   /* ref 0x09090909: none */
    largest += std::string(cr::kMaxMessage - 5, '\0');
    raw.in.clear();
    put(largest + cr::encode(cr::kJson, "{\"op\":\"status\"}"), 1 << 20);
    r.pump(50);
    ev = raw.events();
    ok("a message of the largest length is taken: answered, the client kept",
       ev.find("no such layer") != std::string::npos && ev.find("\"ev\":\"status\"") != std::string::npos &&
           r.svc->server().clients() == 1);

    Raw other(r.path);
    other.send("{\"op\":\"hello\",\"app\":\"other\"}");
    r.pump(20);
    std::string longer(4, '\0');
    for (int i = 0; i < 4; i++)
        longer[i] = (char)((cr::kMaxMessage + 1) >> (8 * i));
    put(longer + "F", 5);
    ok("a message longer than the largest: its client disconnected, its layer removed",
       gone(raw.fd) && r.svc->compositor().layers().empty() && r.svc->server().clients() == 1);
    Raw empty(r.path);
    empty.send_message(std::string(4, '\0') + "J{}");
    r.pump(20);
    ok("an empty message: its client disconnected, the other kept",
       gone(empty.fd) && r.svc->server().clients() == 1 && other.events().find("\"ev\":\"hello\"") != std::string::npos);
}

/* A synthetic scene file of a gauge (fake_graph.h FakeFileScene): a needle
 * turning on a pivot, a bar, a plain quad. */
static const char *const kGaugeScene = "scene 0x01000400\n"
                                       "node gauge -\n"
                                       "node needle_pivot gauge\n"
                                       "mesh needle needle_pivot u_color\n"
                                       "mesh bar gauge u_level\n"
                                       "mesh quad - u_color\n"
                                       "camera main_cam -\n"
                                       "pass main_pass\n"
                                       "data level 1\n";

static std::string written(const std::string &path, const std::string &text)
{
    std::ofstream(path) << text;
    chmod(path.c_str(), 0644);
    return path;
}

static bool gauge_edited_turn(const FakeFileScene *s, float turn)
{
    return s && s->shown.pose.count("needle_pivot r") && s->shown.pose.at("needle_pivot r")[2] == turn;
}

static bool gauge_edited(const FakeFileScene *s, float turn)
{
    return s && s->shown.pose.count("needle_pivot r") && s->shown.pose.at("needle_pivot r")[2] == turn &&
           s->shown.values.count("bar:u_level") && s->shown.values.at("bar:u_level")[0] == 0.5f &&
           s->shown.visible.count("quad") && !s->shown.visible.at("quad");
}

/* The HUD's layers decide whether it gives way: by default it does, to a
 * pop-up in a yield slot, and is asked for again yield_ms after it goes;
 * yield 0 keeps it shown over pop-ups, 1 gives way again; a client that
 * never sends the field gets the default. */
static void hud_yield_choice()
{
    Rig r;
    TargetSpec h;
    h.name = "hud"; h.slot = 0x323; h.scene_id = 0x01000400; h.width = 800; h.height = 480; h.linger_ms = 3000;
    h.yield_slots = {0x322};   /* as cluster-render.conf ships it */
    h.yield_ms = 1500;
    r.sc.targets.push_back(h);
    r.start();
    cr::Client a("waze", r.path);
    Events ea;
    ea.wire(a);
    r.clients = {&a};
    r.pump(50);
    const cr::EffectOptions white{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0};
    cr::LayerOptions lo;
    lo.target = "hud";
    lo.contend = true;
    const uint32_t hud = a.effect(lo, white);
    r.pump(1500);
    ok("hud: shown", ea.target["hud"] == "shown");
    r.port.stock_map(0x322, 0x01000251);   /* the media source list */
    r.pump(100);
    ok("hud: gives way to the list", ea.target["hud"] == "waiting" && !r.port.row(0x323, 0x01000400));
    r.port.stock_unmap(0x322, 0x01000251);
    r.pump(3000);
    ok("hud: shown again after it", ea.target["hud"] == "shown");

    lo.yield = false;
    a.set(hud, lo);
    r.pump(20);
    r.port.stock_map(0x322, 0x01000251);   /* the media source list */
    r.pump(3000);
    ok("yield 0: kept shown over the list", ea.target["hud"] == "shown" && r.port.row(0x323, 0x01000400));
    ok("the status names the layer's yield 0",
       has(r.svc->server().status_text(r.now), "effect of waze on hud, content z 0, yield 0: shown"));
    lo.yield = true;
    a.set(hud, lo);
    r.pump(100);
    ok("yield 1: gives way to the list", ea.target["hud"] == "waiting");
    r.port.stock_unmap(0x322, 0x01000251);
    a.drop(hud);
    r.pump(5000);

    Raw old(r.path);
    old.send("{\"op\":\"hello\",\"app\":\"old\",\"proto\":1}");
    old.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"hud\",\"kind\":\"effect\",\"fs\":\"x\",\"contend\":1}");
    r.pump(1500);
    const int k = r.svc->slots().index("hud");
    ok("a client that never sends yield: shown", r.svc->slots().status(k).state == TargetState::Shown);
    r.port.stock_map(0x322, 0x01000251);
    r.pump(100);
    ok("and gives way", r.svc->slots().status(k).state == TargetState::Waiting);
}

static void scene_files()
{
    char tmpl[] = "/tmp/crs-service-scenes-XXXXXX";
    const std::string root = mkdtemp(tmpl) ? tmpl : "/nonexistent";
    const std::string gauge = written(root + "/gauge.scene", kGaugeScene);
    const std::string res = written(root + "/gauge.res", "resources");
    const std::string other = written(root + "/other.scene", "scene 0x010004f0\nnode a -\n");
    const std::string outside = written("/tmp/crs-service-outside-" + std::to_string(getpid()) + ".scene", kGaugeScene);
    Rig r;
    r.sc.targets[1].scene_files = true;
    TargetSpec h;
    h.name = "hud"; h.slot = 0x323; h.scene_id = 0x01000400; h.width = 800; h.height = 480; h.linger_ms = 3000;
    r.sc.targets.push_back(h);
    r.sc.scene_files.root = root;
    r.sc.scene_files.owner = getuid();
    r.start();
    const TargetSpec panel = r.sc.targets[1];

    cr::SceneOptions so;
    so.target = "panel";
    so.file = gauge;
    so.res = {res};
    const std::string gsha = sha256_file(gauge), rsha = sha256_file(res);
    so.sha256 = {gsha, rsha};
    {
        Raw raw(r.path);
        raw.send("{\"op\":\"scene\",\"ref\":1,\"target\":\"map\",\"file\":\"" + gauge + "\",\"sha256\":\"" + gsha + "\"}");
        raw.send("{\"op\":\"scene\",\"ref\":2,\"target\":\"panel\",\"file\":\"" + gauge + "\",\"res\":\"" + res +
                 "\",\"sha256\":\"" + gsha + " " + std::string(64, '0') + "\"}");
        raw.send("{\"op\":\"scene\",\"ref\":3,\"target\":\"panel\",\"file\":\"" + outside + "\",\"sha256\":\"" + gsha + "\"}");
        raw.send("{\"op\":\"scene\",\"ref\":4,\"target\":\"panel\",\"file\":\"" + gauge + "\",\"res\":\"" + res +
                 "\",\"sha256\":\"" + gsha + "\"}");
        raw.send("{\"op\":\"edit\",\"ref\":5,\"lines\":\"--hide x\"}");
        r.pump(20);
        const std::string said = raw.events();
        ok("scene files: refused on a target without them, with a resource file's hash not its, from outside the "
           "root, without a hash for each file; edits of none",
           said.find("target map takes no scene files (map_scene_files)") != std::string::npos &&
               said.find("gauge.res's SHA-256 is " + rsha) != std::string::npos &&
               said.find(outside + " is not under") != std::string::npos && said.find("2 SHA-256s") != std::string::npos &&
               said.find("no such scene") != std::string::npos && r.port.requests == 0);
    }

    std::unique_ptr<cr::Client> gone(new cr::Client("gauge", r.path));
    cr::Client &a = *gone, b("other", r.path);
    Events ea, eb;
    ea.wire(a);
    eb.wire(b);
    r.clients = {&a, &b};
    r.pump(50);
    const uint32_t sc = a.scene(so);
    a.edit(sc, "--rotate ^needle_pivot$=0,0,30\n--uniform ^bar$:u_level=0.5\n--hide ^quad$");
    r.pump(10);   /* requested; the HMI maps its own content there before the answer */
    r.port.stock_map(0x203, 0x01000401);
    r.pump(200);
    FakeFileScene *f = r.gpu.file("panel");
    ok("parked behind the stock content: the file loaded, its edits in its first flush, the scene waiting",
       ea.target["panel"] == "parked" && ea.layer[sc] == "waiting" && r.gpu.loads == 1 && gauge_edited(f, 30) &&
           !r.gpu.graph("panel"));
    a.edit(sc, "--rotate ^needle_pivot$=0,0,60");
    r.pump(200);
    ok("an edit while parked is held", gauge_edited(r.gpu.file("panel"), 30));
    r.port.stock_unmap(0x203, 0x01000401);
    r.pump(100);
    ok("the stock content gone: the scene shown, the held edit flushed", ea.target["panel"] == "shown" &&
                                                                             ea.layer[sc] == "shown" &&
                                                                             gauge_edited(r.gpu.file("panel"), 60));
    /* Edits faster than the tick (fps 30): at most a flush a tick, the last one in. */
    FakeFileScene *g = r.gpu.file("panel");
    const uint64_t before = g->flushes;
    for (int i = 1; i <= 10; i++) {
        a.edit(sc, "--rotate ^needle_pivot$=0,0," + std::to_string(60 + i));
        r.pump(5);
    }
    const uint64_t burst = g->flushes - before;
    r.pump(100);
    char burst_name[160];
    std::snprintf(burst_name, sizeof burst_name, "ten edits 5 ms apart: %llu flushes in their 50 ms (a tick 33 ms), the last edit in",
                  (unsigned long long)burst);
    ok(burst_name, burst >= 1 && burst <= 2 && gauge_edited(g, 70));
    a.edit(sc, "--rotate ^needle_pivot$=0,0,60");
    r.pump(100);

    /* The service restarts: the client makes the scene again with its edits. */
    r.svc.reset();
    r.pump(100);
    r.start();
    ea.layer.clear();
    r.pump(1500);
    ok("after a restart the client's scene and kept edits are back", ea.layer[sc] == "shown" && r.gpu.loads == 2 &&
                                                                         gauge_edited(r.gpu.file("panel"), 60));

    cr::LayerOptions pl;
    pl.target = "panel";
    const cr::EffectOptions red{"#version 100\nvoid main(){gl_FragColor=vec4(1.0,0.0,0.0,1.0);}", "", 0};
    const uint32_t fx = b.effect(pl, red);
    Raw raw(r.path);
    raw.send("{\"op\":\"scene\",\"ref\":1,\"target\":\"panel\",\"file\":\"" + gauge + "\",\"sha256\":\"" + gsha + "\"}");
    r.pump(100);
    ok("another client's layer on the panel waits for the scene, named by its client; a second scene there is refused",
       eb.layer[fx] == "waiting" &&
           has(r.svc->server().status_text(r.now), "layer 2 effect of other on panel, content z 0: waiting - scene of gauge") &&
           raw.events().find("the target has a scene file already") != std::string::npos && ea.layer[sc] == "shown");
    cr::LayerOptions own = pl;
    own.klass = "overlay";
    const uint32_t ofx = a.effect(own, red);
    r.pump(50);
    ok("the scene's own client's layer there waits for it, named by its ref",
       has(r.svc->server().status_text(r.now), "effect of gauge on panel, overlay z 0: waiting - scene " + std::to_string(sc)));
    a.drop(ofx);

    /* Published again: the stock HMI takes the slot, the HUD (the same scene
     * id) is shown meanwhile, then the panel's slot is free again. */
    r.port.steal(panel);
    r.pump(100);
    cr::LayerOptions hl;
    hl.target = "hud";
    const uint32_t hfx = b.effect(hl, red);
    r.pump(1500);
    ok("the HUD shown in the meantime: the panel's file scene unpublished for its scene id",
       eb.target["hud"] == "shown" && !r.gpu.file("panel") && ea.layer[sc] == "waiting");
    b.drop(hfx);
    r.pump(3500);
    r.port.free_slot(panel);
    r.pump(1500);
    ok("the panel published again: the file loaded again with every kept edit", ea.layer[sc] == "shown" &&
                                                                                r.gpu.loads == 3 &&
                                                                                gauge_edited(r.gpu.file("panel"), 60));

    a.drop(sc);
    r.pump(1500);
    ok("the scene dropped: the panel published again with the layers, the other client's shown",
       eb.layer[fx] == "shown" && r.gpu.graph("panel") && !r.gpu.file("panel"));

    cr::SceneOptions wrong = so;
    wrong.file = other;
    wrong.res.clear();
    wrong.sha256 = {sha256_file(other)};
    const uint32_t bad = a.scene(wrong);
    r.pump(5000);
    ok("a file of another scene id: the scene in error, the layers back", ea.layer[bad] == "error" &&
                                                                          eb.layer[fx] == "shown" && r.gpu.graph("panel"));
    a.drop(bad);
    const uint32_t sc2 = a.scene(so);
    a.edit(sc2, "--hide ^nothing$\n--spin x\n--rotate ^needle_pivot$=0,0,10");
    r.pump(1500);
    ok("edits: a malformed line refused and one that changes nothing reported, each named; the rest applied",
       has(ea.errors, "edit: '--spin x': unknown kind --spin") &&
           has(ea.errors, "edit: '--hide ^nothing$' changed nothing: no node matches") && ea.layer[sc2] == "shown" &&
           r.gpu.file("panel") && r.gpu.file("panel")->shown.pose.at("needle_pivot r")[2] == 10);

    /* Another file for the scene, in place. */
    const std::string gauge2 = written(root + "/gauge2.scene", std::string(kGaugeScene) + "node extra -\n");
    cr::SceneOptions so2 = so;
    so2.file = gauge2;
    so2.sha256 = {sha256_file(gauge2), rsha};
    const int requests = r.port.requests, releases = r.port.releases, loads = r.gpu.loads;
    ea.layer[sc2] = "";
    a.scene(sc2, so2);
    a.edit(sc2, "--rotate ^needle_pivot$=0,0,5");
    r.pump(200);
    const FakeFileScene *f2 = r.gpu.file("panel");
    ok("a file replaced in place: loaded, the slot neither released nor asked for again, the old edits gone, "
       "shown told again",
       r.port.requests == requests && r.port.releases == releases && r.gpu.loads == loads + 1 && f2 &&
           f2->names[FileScene::Node].size() == 7 && f2->shown.pose.at("needle_pivot r")[2] == 5 &&
           ea.layer[sc2] == "shown" && has(r.svc->server().status_text(r.now), "gauge2.scene and 1 resource files") &&
           has(r.svc->server().status_text(r.now), "1 edit lines kept"));

    /* The client goes, nothing else wants the panel: the scene lingers. */
    b.drop(fx);
    r.clients = {&b};
    gone.reset();
    r.pump(1000);
    ok("the client gone: the scene kept through the linger", eb.target["panel"] == "lingering" && r.gpu.file("panel"));
    r.pump(2500);
    ok("then released and unpublished", eb.target["panel"] == "idle" && !r.gpu.file("panel") && !r.gpu.graph("panel"));
    unlink(outside.c_str());
    const int removed = std::system(("rm -rf " + root).c_str());
    (void)removed;
}

/* A scene with layers 1 (PROTOCOL.md "Layers over a scene file", "host"):
 * the target's layers drawn over the file in a graph of its own past the
 * file's passes, edits flushed with them; a host of the map told to every
 * client, refused for the scene's own target, outside its target, by a
 * second scene's host and without layers, ended by layers 0; a producer
 * moving its video from the map to the host's rect, drawn over the file, the
 * map released; hidden; the scene, its edits and host back after a service
 * restart; dropped, the host ended and the layers in a plain scene again; a
 * backend drawing nothing over files: the layers wait, the file shown. */
static void layers_and_hosting()
{
    char tmpl[] = "/tmp/crs-service-hosting-XXXXXX";
    const std::string root = mkdtemp(tmpl) ? tmpl : "/nonexistent";
    const std::string gauge = written(root + "/gauge.scene", kGaugeScene);
    Rig r;
    r.sc.targets[1].scene_files = true;
    r.sc.scene_files.root = root;
    r.sc.scene_files.owner = getuid();
    r.start();
    cr::Client a("design", r.path), b("producer", r.path);
    Events ea, eb;
    ea.wire(a);
    eb.wire(b);
    std::vector<cr::Host> told;
    b.on_host = [&told](const cr::Host &h) { told.push_back(h); };
    r.clients = {&a, &b};
    r.pump(50);

    cr::LayerOptions ml;
    ml.target = "map";
    ml.contend = true;
    uint32_t video = b.video(ml, cr::VideoOptions());
    const std::vector<uint8_t> f1 = atlas(1);
    b.frame(video, f1.data(), f1.size(), 1);
    r.pump(1500);
    ok("hosting: the producer's map shown", eb.layer[video] == "shown" && eb.target["map"] == "shown");

    cr::SceneOptions so;
    so.target = "panel";
    so.file = gauge;
    so.sha256 = {sha256_file(gauge)};
    so.layers = true;
    const uint32_t sc = a.scene(so);
    a.edit(sc, "--rotate ^needle_pivot$=0,0,30");
    cr::LayerOptions pl;
    pl.target = "panel";
    pl.klass = "overlay";
    pl.x = 700; pl.y = 160; pl.w = 560; pl.h = 400;
    const cr::EffectOptions fade{"#version 100\nvoid main(){gl_FragColor=vec4(0.0);}", "", 0};
    const uint32_t edge = a.effect(pl, fade);
    r.pump(1500);
    FakeGraph *g = r.gpu.graph("panel");
    ok("layers 1: the file loaded, the layers drawn over it past its one pass, its edits flushed",
       ea.layer[sc] == "shown" && ea.layer[edge] == "shown" && r.gpu.file("panel") && g && g->over_file &&
           g->over_order == 1 && g->visible().size() == 1 && gauge_edited_turn(r.gpu.file("panel"), 30));
    ok("the status names it",
       has(r.svc->server().status_text(r.now), "1 edit lines kept; layers over it: shown"));

    cr::Host h;
    h.target = "map";
    h.x = 700; h.y = 160; h.w = 560; h.h = 400;
    h.src_x = 264; h.src_y = 40; h.src_w = 560; h.src_h = 400;
    a.host(sc, h);
    r.pump(50);
    ok("it hosts the map: the producer told where",
       b.hosts.count("map") && b.hosts["map"].into == "panel" && b.hosts["map"].w == 560 &&
           b.hosts["map"].src_x == 264 && b.hosts["map"].shown && !told.empty());
    {
        Raw raw(r.path);
        raw.send("{\"op\":\"hello\",\"app\":\"raw\",\"proto\":1}");
        raw.send("{\"op\":\"host\",\"ref\":9,\"target\":\"map\",\"x\":0,\"y\":0,\"w\":10,\"h\":10}");
        r.pump(50);
        ok("a client after it is told too; a host without a scene refused",
           raw.events().find("\"ev\":\"host\",\"target\":\"map\",\"into\":\"panel\"") != std::string::npos &&
               raw.in.find("no such scene") != std::string::npos);
    }
    cr::Host own = h;
    own.target = "panel";
    ok("its own target: refused by the client, nothing sent", !a.host(sc, own));
    cr::Host outside = h;
    outside.x = 1800;
    a.host(sc, outside);
    r.pump(50);
    ok("a rect outside the panel refused, and the scene's host of the map ended with it",
       has(ea.errors, "host: x, y, w, h must lie inside panel") && !b.hosts.count("map") && told.back().into.empty());
    cr::Host past = h;
    past.src_x = 800;
    a.host(sc, past);
    r.pump(50);
    ok("a part outside the map refused", has(ea.errors, "host: src_x, src_y, src_w, src_h must lie inside map"));
    a.host(sc, h);
    r.pump(50);
    ok("hosted again", b.hosts.count("map") && b.hosts["map"].x == 700);

    /* The producer moves its video to the host's rect: one layer, cropped. */
    b.drop(video);
    cr::LayerOptions hl;
    hl.target = "panel";
    hl.x = h.x; hl.y = h.y; hl.w = h.w; hl.h = h.h;
    cr::VideoOptions crop;
    crop.w = 560;
    crop.h = 400;
    crop.stall_ms = 600000;   /* one frame for the whole test */
    video = b.video(hl, crop);
    std::vector<uint8_t> f2(560 * 600, 90);
    b.frame(video, f2.data(), f2.size(), 2);
    r.pump(2000);
    g = r.gpu.graph("panel");
    ok("the producer's video over the file in the host's rect, under the scene owner's overlay; the map released",
       eb.layer[video] == "shown" && g && g->over_file && g->visible().size() == 2 && eb.target["map"] == "idle" &&
           r.gpu.file("panel"));
    a.edit(sc, "--rotate ^needle_pivot$=0,0,45");
    r.pump(100);
    ok("edits flush with the layers", gauge_edited_turn(r.gpu.file("panel"), 45));

    /* The host's edge: two quads over the producer's video draw its rows 2
     * in from its top and bottom on past its rect, held within the panel
     * (160 below it), the picture fading into them; out of range refused;
     * without it, none. */
    cr::Host eh = h;
    eh.edge_top = 50;
    eh.edge_bottom = 400;
    eh.edge_fade = 36;
    eh.edge_dim = 160;
    eh.edge_blur = 9;
    a.host(sc, eh);
    r.pump(100);
    g = r.gpu.graph("panel");
    std::vector<FakeQuad> edges;
    for (int q : g->visible())
        if (g->shown.quads.at(q).uniforms.count("u_edge"))
            edges.push_back(g->shown.quads.at(q));
    ok("an edge: two quads over the video, 50 up and 160 down (the panel's end), the picture fading into them over 36",
       g->visible().size() == 4 && edges.size() == 2 && edges[0].r.x == 700 && edges[0].r.w == 560 && edges[0].r.y == 110 &&
           edges[0].r.h == 86 && edges[1].r.y == 524 && edges[1].r.h == 196 &&
           edges[0].uniforms["u_edge"] == std::vector<float>({2.5f, 50, -36, 36}) &&
           edges[1].uniforms["u_edge"] == std::vector<float>({397.5f, -36, 160, 36}) &&
           edges[0].uniforms["u_look"] == std::vector<float>({160, 9}) && edges[0].uniforms["u_opacity"][0] > 0 &&
           eb.layer[video] == "shown" && has(r.svc->server().status_text(r.now), "its edge 50 up and 400 down"));
    cr::Host blurry = eh;
    blurry.edge_blur = 33;
    a.host(sc, blurry);
    r.pump(100);
    ok("an edge out of range refused", has(ea.errors, "host: edge_blur must be a number from 0 to 32"));
    a.host(sc, h);
    r.pump(100);
    ok("hosted again without an edge: no edge quads", b.hosts.count("map") && g->visible().size() == 2);

    /* The video's write refused: it holds the target (a half-written
     * buffer); the file's edits flush all the same. */
    g->write_budget = 0;
    std::vector<uint8_t> f3(560 * 600, 160);
    b.frame(video, f3.data(), f3.size(), 3);
    r.pump(100);
    const uint64_t held_flushes = g->flushes;
    a.edit(sc, "--rotate ^needle_pivot$=0,0,50");
    r.pump(100);
    ok("a video holding the target over the file: the file's edits flush all the same",
       gauge_edited_turn(r.gpu.file("panel"), 50) && g->flushes > held_flushes);
    g->write_budget = -1;
    b.frame(video, f2.data(), f2.size(), 4);
    r.pump(300);
    ok("its writes allowed again: the video whole again", eb.layer[video] == "shown");
    a.edit(sc, "--rotate ^needle_pivot$=0,0,45");
    r.pump(100);

    h.shown = false;
    a.host(sc, h);
    r.pump(50);
    ok("hidden: told", b.hosts.count("map") && !b.hosts["map"].shown);
    h.shown = true;
    a.host(sc, h);

    r.svc.reset();
    r.pump(100);
    ok("the service gone: no host known", b.hosts.empty());
    r.start();
    ea.layer.clear();
    r.pump(1000);
    b.frame(video, f2.data(), f2.size(), 3);   /* the producer's next frame: the last one whole again */
    r.pump(1000);
    ok("after a restart: the scene, its edits and its host back, the video over it",
       ea.layer[sc] == "shown" && gauge_edited_turn(r.gpu.file("panel"), 45) && b.hosts.count("map") &&
           b.hosts["map"].shown && r.gpu.graph("panel") && r.gpu.graph("panel")->over_file &&
           eb.layer[video] == "shown");

    so.layers = false;
    a.scene(sc, so);
    r.pump(1500);
    ok("layers 0: the host ended, the layers waiting, a host refused by the client",
       !b.hosts.count("map") && told.back().into.empty() && eb.layer[video] == "waiting" && !a.host(sc, h));
    /* What the client keeps: not the ended host (replaced, layers 0). */
    r.svc.reset();
    r.pump(100);
    r.start();
    r.pump(1500);
    ok("after a restart the client sends no host the scene's replacement ended",
       !has(ea.errors, "host: a scene hosts only with layers 1") && !b.hosts.count("map"));
    so.layers = true;
    a.scene(sc, so);
    a.host(sc, h);
    r.pump(1500);
    b.frame(video, f2.data(), f2.size(), 5);
    r.pump(300);
    ok("layers 1 again: hosted, the video shown", b.hosts.count("map") && eb.layer[video] == "shown");

    /* A host refused is not kept by the client either: not sent again. */
    a.host(sc, outside);
    r.pump(50);
    const auto refusals = [&ea]() {
        return std::count(ea.errors.begin(), ea.errors.end(), std::string("host: x, y, w, h must lie inside panel"));
    };
    const long before_restart = refusals();
    r.svc.reset();
    r.pump(100);
    r.start();
    r.pump(1500);
    ok("a refused host: the host ended, and not sent again after a restart",
       before_restart == 2 && refusals() == 2 && !b.hosts.count("map"));
    b.frame(video, f2.data(), f2.size(), 6);   /* the producer's next frame after the restart */
    r.pump(100);

    /* A file that fails to load ends what the scene hosted. */
    a.host(sc, h);
    r.pump(1500);
    const bool hosted_before = b.hosts.count("map") != 0;
    r.gpu.fail_loads = true;
    a.scene(sc, so);
    a.host(sc, h);
    r.pump(1500);
    ok("a file that fails to load: its host ended, told, and gone from the status",
       hosted_before && ea.layer[sc] == "error" && !b.hosts.count("map") &&
           !has(r.svc->server().status_text(r.now), "hosts map"));
    r.gpu.fail_loads = false;
    a.scene(sc, so);
    r.pump(1500);
    ok("the file replaced: shown, nothing hosted until it says so", ea.layer[sc] == "shown" && !b.hosts.count("map"));

    a.drop(sc);
    r.pump(1500);
    g = r.gpu.graph("panel");
    ok("the scene dropped: the host ended, the layers in a plain scene",
       !b.hosts.count("map") && told.back().into.empty() && g && !g->over_file && eb.layer[video] == "shown" &&
           !r.gpu.file("panel"));

    r.gpu.refuse_layers = true;
    const uint32_t sc2 = a.scene(so);
    r.pump(1500);
    ok("a backend drawing nothing over files: the file shown, the layers waiting for it",
       ea.layer[sc2] == "shown" && eb.layer[video] == "waiting" && r.gpu.file("panel") && !r.gpu.graph("panel"));
    a.host(sc2, h);
    r.pump(100);
    ok("and a host there refused, nobody told: the producer stays where it is drawn",
       has(ea.errors, "host: the display draws no layers over this scene") && !b.hosts.count("map"));
    {
        Raw raw(r.path);
        raw.send("{\"op\":\"hello\",\"app\":\"raw3\",\"proto\":1}");
        raw.send("{\"op\":\"host\",\"ref\":7,\"target\":\"map\",\"x\":0,\"y\":0,\"w\":10,\"h\":10,\"src_x\":0}");
        r.pump(50);
        ok("a host's error names its target", raw.events().find("\"op\":\"host\",\"ref\":7,\"target\":\"map\"") !=
                                                  std::string::npos);
    }
    const int removed = std::system(("rm -rf " + root).c_str());
    (void)removed;
}

/* Preload with the C++ client: the hello says the service knows it; a
 * hidden preload layer has its target fetched and not mapped (loaded, in
 * the status too); shown, the target is mapped with no second fetch;
 * hidden again, unmapped after the linger and loaded, not released; the
 * service restarting under the client, the field is sent again and the
 * target loaded again; preload 0 releases it. A loaded target with nothing
 * to flush leaves the loop at four ticks a second; wanted and waiting for
 * its slot, a write the budget holds ticks it at the frame rate. */
static void preload()
{
    Rig r;
    cr::Client c("preload", r.path);
    Events e;
    e.wire(c);
    r.clients = {&c};
    r.pump(50);
    ok("preload: the hello says the service knows preload", e.ready == 1 && c.takes_preload());
    cr::LayerOptions lo;
    lo.target = "panel";
    lo.w = lo.h = 64;
    lo.visible = false;
    lo.preload = true;
    cr::ImageOptions io;
    io.w = io.h = 64;
    const uint32_t img = c.image(lo, io);
    std::vector<uint8_t> px(64 * 64 * 4, 200);
    c.pixels(img, {}, px.data(), px.size());
    r.pump(300);
    ok("preload: a hidden preload layer: its target loaded, fetched and not mapped",
       e.target["panel"] == "loaded" && e.layer[img] == "hidden" && r.port.loads == 1 && r.port.requests == 0 &&
           !r.port.row(0x203, 0x01000400));
    ok("preload: the status names the target loaded",
       has(r.svc->server().status_text(r.now), "target panel: slot 0x203 scene 0x1000400 1920x720: loaded; scene "
                                               "fetched, not mapped (preload)"));
    lo.visible = true;
    c.set(img, lo);
    r.pump(1000);   /* the map spaced 1 s from the load */
    ok("preload: made visible: shown, mapped with no second fetch", e.layer[img] == "shown" &&
                                                                      e.target["panel"] == "shown" &&
                                                                      r.port.remaps == 1 && r.port.loads == 1 &&
                                                                      r.port.requests == 0);
    lo.visible = false;
    c.set(img, lo);
    r.pump(4000);
    ok("preload: hidden again: unmapped after the linger, loaded, not released",
       e.target["panel"] == "loaded" && r.port.releases == 0 && !r.port.row(0x203, 0x01000400));
    ok("preload: loaded with nothing to flush: the loop ticks four times a second",
       r.svc->timeout_ms(r.now) == 250 && !r.svc->compositor().pending(1));
    r.svc.reset();
    r.start();
    e.target.clear();
    r.pump(2000);
    ok("preload: the service restarted: the client sends preload again, the target loaded again",
       e.ready == 2 && e.target["panel"] == "loaded" && r.port.loads == 2 && r.port.requests == 0);
    lo.preload = false;
    c.set(img, lo);
    r.pump(100);
    ok("preload: preload 0: released", e.target["panel"] == "idle" && r.port.releases == 1);

    /* Wanted while loaded, its slot held by another app's content: its
     * writes the budget holds tick the loop at the frame rate until they
     * go. */
    Rig b(64 * 1024);
    cr::Client d("preload", b.path);
    Events f;
    f.wire(d);
    b.clients = {&d};
    b.pump(50);
    cr::LayerOptions big = lo;
    big.preload = true;
    big.visible = false;
    big.w = big.h = 256;
    io.w = io.h = 256;
    const uint32_t pic = d.image(big, io);
    std::vector<uint8_t> whole(256 * 256 * 4, 90);
    d.pixels(pic, {}, whole.data(), whole.size());
    b.pump(300);
    b.port.stock_map(0x203, 0x02000001);
    big.visible = true;
    d.set(pic, big);
    b.pump(1500);
    const bool waits = f.target["panel"] == "waiting" && b.svc->slots().loaded(1);
    whole.assign(whole.size(), 91);
    d.pixels(pic, {}, whole.data(), whole.size());
    b.pump(10);
    const bool held = b.svc->compositor().pending(1), fast = b.svc->timeout_ms(b.now) < 250;
    ok("preload: wanted while loaded, the slot another app's: a write held by the budget ticks the loop fast",
       waits && held && fast);
    b.pump(5000);
    ok("preload: once it has gone, idle again", !b.svc->compositor().pending(1) && b.svc->timeout_ms(b.now) == 250);
}

/* The updates a second the service's only video layer is clocked at now;
 * 999: none. */
static uint32_t video_clock(Rig &r)
{
    for (const Layer *l : r.svc->compositor().layers())
        if (!std::strcmp(l->kind(), "video"))
            return static_cast<const VideoLayer *>(l)->clock_fps();
    return 999;
}

/* others_fps with the C++ client: the hello says the service knows it; a
 * video alone keeps its own rate and its client gets no fps_cap event; a
 * hidden layer with others_fps holds nothing; shown, the other client's
 * video is written at most that often and its client told (with the app),
 * the requesting client's own video not held and it told nothing; below 15
 * counts as 15; hidden, set back to 0, dropped, or its client gone: the
 * video back at its own rate and its client told 0. The service
 * restarting: the held client told 0 as its connection goes, and held
 * again once the request is shown again. */
static void others_fps()
{
    Rig r;
    cr::Client w("waze", r.path);
    std::unique_ptr<cr::Client> k(new cr::Client("cluster", r.path));
    Events ew, ek;
    ew.wire(w);
    ek.wire(*k);
    std::vector<std::string> caps;
    int cluster_caps = 0;
    w.on_fps_cap = [&](unsigned fps, const std::string &app) { caps.push_back(std::to_string(fps) + " " + app); };
    k->on_fps_cap = [&](unsigned, const std::string &) { cluster_caps++; };
    r.clients = {&w, k.get()};
    r.pump(50);
    ok("others_fps: the hello says the service knows others_fps", w.takes_others_fps() && k->takes_others_fps());
    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = w.video(lo, cr::VideoOptions());
    int seed = 1;
    /* frames offered 100 a second for ms: the map's writes a second */
    auto rate = [&](int64_t ms) {
        const uint64_t before = r.svc->compositor().write_stats(0).frames;
        for (int64_t t = 0; t < ms; t += 10) {
            const std::vector<uint8_t> f = atlas(seed++);
            w.frame(map, f.data(), f.size(), (uint64_t)seed);
            r.pump(10);
        }
        return (unsigned)((r.svc->compositor().write_stats(0).frames - before) * 1000 / (uint64_t)ms);
    };
    rate(600);
    unsigned alone = rate(2000);
    ok("others_fps: a video alone: at its own 30 a second, no fps_cap event", ew.layer[map] == "shown" &&
                                                                                 alone >= 28 && alone <= 31 &&
                                                                                 caps.empty() &&
                                                                                 video_clock(r) == 30);

    cr::LayerOptions pl;
    pl.target = "panel";
    pl.w = pl.h = 64;
    pl.visible = false;
    pl.others_fps = 20;
    cr::ImageOptions io;
    io.w = io.h = 64;
    const uint32_t img = k->image(pl, io);
    std::vector<uint8_t> px(64 * 64 * 4, 200);
    k->pixels(img, {}, px.data(), px.size());
    unsigned hidden = rate(1000);
    ok("others_fps: the request hidden: nothing held", hidden >= 28 && caps.empty() && video_clock(r) == 30);

    pl.visible = true;
    k->set(img, pl);
    for (int i = 0; i < 100 && ek.layer[img] != "shown"; i++)
        r.pump(10);
    const unsigned held = rate(2000);
    ok("others_fps: shown: the other client's video written at most 20 a second, its client told who asks",
       ek.layer[img] == "shown" && held >= 18 && held <= 21 && video_clock(r) == 20 &&
           caps == std::vector<std::string>{"20 cluster"} && w.fps_cap == 20 && w.fps_cap_app == "cluster");
    ok("others_fps: the requesting client told nothing", k->fps_cap == 0 && cluster_caps == 0);
    ok("others_fps: the status names the request",
       r.svc->server().status_text(r.now).find("others_fps: cluster layer ") != std::string::npos);

    pl.others_fps = 5;
    k->set(img, pl);
    r.pump(50);
    ok("others_fps: below 15 counts as 15", w.fps_cap == 15 && video_clock(r) == 15);

    pl.visible = false;
    k->set(img, pl);
    r.pump(50);
    ok("others_fps: hidden: released, its client told 0",
       w.fps_cap == 0 && caps.back() == "0 " && video_clock(r) == 30);
    const unsigned back = rate(1000);
    ok("others_fps: and back at 30 a second", back >= 28 && back <= 31);

    pl.visible = true;
    pl.others_fps = 20;
    k->set(img, pl);
    r.pump(100);
    const bool again = w.fps_cap == 20;
    pl.others_fps = 0;
    k->set(img, pl);
    r.pump(50);
    ok("others_fps: set back to 0: released", again && w.fps_cap == 0 && video_clock(r) == 30);

    pl.others_fps = 20;
    k->set(img, pl);
    r.pump(100);
    const bool third = w.fps_cap == 20;
    k->drop(img);
    r.pump(50);
    ok("others_fps: the layer dropped: released", third && w.fps_cap == 0 && video_clock(r) == 30);

    const uint32_t img2 = k->image(pl, io);
    k->pixels(img2, {}, px.data(), px.size());
    r.pump(200);
    const bool fourth = w.fps_cap == 20 && video_clock(r) == 20;
    r.svc.reset();
    r.start();
    r.pump(10);
    const bool restart_released = caps.back() == "0 ";
    for (int i = 0; i < 300 && w.fps_cap != 20; i++)
        r.pump(10);
    ok("others_fps: the service restarted: told 0 as the connection goes, held again once the request is shown",
       fourth && restart_released && w.fps_cap == 20);
    r.clients = {&w};
    k.reset();
    r.pump(100);
    ok("others_fps: its client gone: released", w.fps_cap == 0 && caps.back() == "0 " && video_clock(r) == 30);
}

/* PROTOCOL.md "Render state" and "Mipmaps", over the socket with the C++
 * client: the hello says the service takes them; an asset with a
 * mipmapped, mirrored, anisotropic sampler, an effect layer blending
 * premultiplied without writing alpha, changed in place, and a mesh part
 * with its own depth test and blending, made again with all of it after a
 * service restart; malformed fields refused with an error event and
 * nothing made. */
static void render_state_and_samplers()
{
    Rig r;
    cr::Client c("gauges", r.path);
    Events e;
    e.wire(c);
    r.clients = {&c};
    r.pump(50);
    ok("render state: the hello says the service takes render state and samplers",
       c.takes_render_state() && c.takes_samplers());
    cr::AssetOptions ao;
    ao.target = "panel";
    ao.w = 64;
    ao.h = 32;
    cr::SamplerOptions so;
    so.sampling = "trilinear";
    so.wrap_u = "mirror";
    so.wrap_v = "repeat";
    so.anisotropy = 8;
    const uint32_t dial = c.asset(ao, so);
    std::vector<uint8_t> px(64 * 32 * 4, 180);
    c.pixels(dial, {}, px.data(), px.size());
    cr::LayerOptions lo;
    lo.target = "panel";
    lo.klass = "overlay";
    lo.x = 100;
    lo.y = 100;
    lo.w = 64;
    lo.h = 32;
    cr::RenderState glow;
    glow.blend = "premultiplied";
    glow.color_mask = "rgb";
    const uint32_t fx = c.effect(lo,
                                 cr::EffectOptions{"#version 100\nprecision mediump float;\nuniform sampler2D u_dial;\n"
                                                   "varying vec2 v_uv;\nvoid main(){gl_FragColor=texture2D(u_dial,v_uv);}",
                                                   "", 0},
                                 false, glow);
    c.bind(fx, "u_dial", dial);
    cr::LayerOptions ml = lo;
    ml.x = 600;
    ml.w = 400;
    ml.h = 300;
    cr::MeshOptions mo;
    mo.cz = 6;
    const uint32_t box = c.mesh(ml, mo);
    cr::PartOptions po;
    po.vs = "#version 100\nattribute vec3 a_position;\nattribute vec3 a_normal;\nuniform mat4 u_mvp;\n"
            "varying vec3 v_n;\nvoid main(){v_n=a_normal;gl_Position=u_mvp*vec4(a_position,1.0);}";
    po.fs = "#version 100\nprecision mediump float;\nvarying vec3 v_n;\nvoid main(){gl_FragColor=vec4(v_n,1.0);}";
    cr::RenderState decal;
    decal.depth_func = "greater_equal";
    decal.depth_write = 0;
    decal.blend_src = "one";
    decal.blend_dst = "one";
    decal.blend_op = "max";
    ok("render state: a part with its own render state is taken",
       c.part(box, 1, po, decal) && c.geometry(box, 1, cube()));
    r.pump(400);
    auto check = [&](const char *when, bool rgb_only) {
        FakeGraph *g = r.gpu.graph("panel");
        const FakeBuffer *b = nullptr;
        const FakeQuad *q = nullptr;
        const FakePart *p = nullptr;
        if (g) {
            for (const auto &kv : g->shown.buffers)
                if (kv.second.w == 64 && kv.second.h == 32)
                    b = &kv.second;
            for (const auto &kv : g->shown.quads)
                if (kv.second.textures.count("u_dial"))
                    q = &kv.second;
            for (const auto &kv : g->shown.parts)
                p = &kv.second;
        }
        const uint8_t mask = rgb_only ? (kMaskR | kMaskG | kMaskB) : kMaskRGBA;
        ok((std::string("render state: ") + when + ": the asset with every level and its sampler").c_str(),
           b && b->levels == 7 && b->sampler.sampling == Sampling::Trilinear && b->sampler.u == Wrap::Mirror &&
               b->sampler.v == Wrap::Repeat && b->sampler.anisotropy == 8 && b->mips.back().size() == 4 &&
               b->mips.back()[0] == 180);
        ok((std::string("render state: ") + when + ": the effect layer blends as asked").c_str(),
           q && q->look.blending() == blend_state(Blend::Premultiplied) && q->look.color_mask == mask);
        ok((std::string("render state: ") + when + ": the part drawn as asked").c_str(),
           p && p->look.depth_test() == DepthFunc::GreaterEqual && !p->look.depth_writes() &&
               p->look.blending().src == BlendFactor::One && p->look.blending().op == BlendOp::Max);
    };
    check("made", true);
    cr::RenderState all;
    all.blend = "premultiplied";
    c.set_look(fx, all);
    r.pump(50);
    check("set_look", false);
    r.svc.reset();
    r.start();
    r.pump(3000);
    check("after a service restart", false);
    ok("render state: no error so far", e.errors.empty());

    Raw raw(r.path);
    raw.send("{\"op\":\"hello\",\"app\":\"raw\",\"proto\":1}");
    raw.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"void main(){}\","
             "\"blend_src\":\"src_color\"}");
    raw.send("{\"op\":\"layer\",\"ref\":2,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"void main(){}\","
             "\"color_mask\":\"rgbx\"}");
    raw.send("{\"op\":\"layer\",\"ref\":3,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"void main(){}\","
             "\"blend\":\"none\",\"blend_op\":\"max\"}");
    raw.send("{\"op\":\"asset\",\"ref\":4,\"target\":\"panel\",\"w\":8,\"h\":8,\"sampling\":\"anisotropic\"}");
    raw.send("{\"op\":\"asset\",\"ref\":5,\"target\":\"panel\",\"w\":8,\"h\":8,\"anisotropy\":2.5}");
    raw.send("{\"op\":\"asset\",\"ref\":6,\"target\":\"panel\",\"w\":8,\"h\":8,\"wrap_v\":\"spiral\"}");
    raw.send("{\"op\":\"layer\",\"ref\":7,\"target\":\"panel\",\"kind\":\"mesh\"}");
    raw.send("{\"op\":\"part\",\"ref\":7,\"part\":1,\"vs\":\"attribute vec3 a_position;void main(){}\","
             "\"fs\":\"void main(){}\",\"depth\":0,\"depth_func\":\"less\"}");
    raw.send("{\"op\":\"part\",\"ref\":7,\"part\":2,\"vs\":\"attribute vec3 a_position;void main(){}\","
             "\"fs\":\"void main(){}\",\"depth_func\":\"sometimes\"}");
    r.pump(50);
    const std::string ev = raw.events();
    auto refused = [&](const char *op, int ref, const char *why) {
        return ev.find(std::string("\"op\":\"") + op + "\",\"ref\":" + std::to_string(ref) + ",\"reason\":\"" + why) !=
               std::string::npos;
    };
    ok("render state: a colour blend factor RAMSES 19 lacks is refused",
       refused("layer", 1, "blend_src must be zero, one, src_alpha"));
    ok("render state: a malformed colour mask is refused", refused("layer", 2, "color_mask must be"));
    ok("render state: blend factors with blend none are refused", refused("layer", 3, "blend none takes no"));
    ok("render state: an unknown sampling is refused", refused("asset", 4, "sampling must be nearest, bilinear"));
    ok("render state: a fractional anisotropy is refused", refused("asset", 5, "anisotropy must be a whole number"));
    ok("render state: an unknown wrap is refused", refused("asset", 6, "wrap_v must be clamp, repeat or mirror"));
    ok("render state: a depth test without depth is refused", refused("part", 7, "depth 0 takes no depth_func"));
    ok("render state: an unknown depth test is refused", refused("part", 7, "depth_func must be less"));
    size_t layers = 0;
    for (const Layer *l : r.svc->compositor().layers())
        layers += std::string(l->kind()) == "effect";
    ok("render state: nothing refused was made", layers == 1 && r.svc->compositor().assets().size() == 1);
}

/* The visible quads of g, bottom to top, each named by the first entry of
 * names whose rect it has ("?": none). */
static std::string stack_of(FakeGraph *g, const std::vector<std::pair<std::string, Rect>> &names)
{
    std::string out;
    if (!g)
        return out;
    for (int q : g->visible()) {
        const Rect &r = g->shown.quads.at(q).r;
        std::string name = "?";
        for (const auto &n : names)
            if (n.second.x == r.x && n.second.y == r.y && n.second.w == r.w && n.second.h == r.h) {
                name = n.first;
                break;
            }
        out += (out.empty() ? "" : " ") + name;
    }
    return out;
}

/* A host from layers (PROTOCOL.md "Hosting from layers"): a theme drawing
 * the panel with layers only hosts the map at a rect; the producer, told,
 * moves its video there marked as the hosted map (as waze-on-cluster does)
 * and it is drawn just under the theme's lowest drawn layer, over another
 * client's layers below that and under its layers above; another client's
 * unmarked video inside the rect keeps its place; a hidden theme layer is
 * no anchor; an exclusive lowest theme layer: the map just over it, still
 * shown; the edge; refusals (its own target, ref with into, an unknown
 * into), each ending the client's host of the target, also a refused move,
 * which the client forgets too (not sent again after a restart); a host
 * with no layer drawn waits and blocks nobody; of two live themes the one
 * sent first is live, the other waits, told why, and takes over while the
 * first is hidden; live only while a theme layer is drawn and the panel is
 * on screen (hidden, or the stock HMI taking the panel: the producer is
 * told the map is not hosted, the theme why); a scene file with layers 1 on
 * the panel keeps it live and the scene's own host wins over it, one
 * without layers makes it wait; unhost; kept by the client across a service
 * restart; the theme's client gone or crashed (its socket closed with
 * nothing said): the map not hosted any more. */
static void hosting_from_layers()
{
    char tmpl[] = "/tmp/crs-service-layerhost-XXXXXX";
    const std::string root = mkdtemp(tmpl) ? tmpl : "/nonexistent";
    const std::string gauge = written(root + "/gauge.scene", kGaugeScene);
    Rig r;
    r.sc.targets[1].scene_files = true;
    r.sc.scene_files.root = root;
    r.sc.scene_files.owner = getuid();
    r.start();
    cr::Client a("theme", r.path), b("producer", r.path), o("other", r.path);
    Events ea, eb, eo;
    ea.wire(a);
    eb.wire(b);
    eo.wire(o);
    std::vector<cr::Host> told;
    b.on_host = [&told](const cr::Host &h) { told.push_back(h); };
    std::map<std::string, std::string> hosting;   /* the theme's hosting events: state[: reason] */
    a.on_hosting = [&hosting](const std::string &t, const std::string &, const std::string &state,
                              const std::string &why) { hosting[t] = state + (why.empty() ? "" : ": " + why); };
    r.clients = {&a, &b, &o};
    r.pump(50);
    ok("layer hosts: the hello says the service takes them", a.takes_host_layers());

    /* The producer's map on its own slot. */
    cr::LayerOptions ml;
    ml.target = "map";
    ml.contend = true;
    uint32_t video = b.video(ml, cr::VideoOptions());
    const std::vector<uint8_t> f1 = atlas(1);
    b.frame(video, f1.data(), f1.size(), 1);
    r.pump(1500);
    ok("layer hosts: the producer's map shown on its slot", eb.layer[video] == "shown" && eb.target["map"] == "shown");

    /* The theme: a background over the whole panel and a frame, layers
     * only; another client's layers below and above them. */
    const cr::EffectOptions fx{"#version 100\nvoid main(){gl_FragColor=vec4(0.0);}", "", 0};
    const Rect R_BG{0, 0, 1920, 720}, R_FRAME{690, 150, 580, 420}, R_MAP{700, 160, 560, 400}, R_LOW{10, 10, 100, 100},
               R_HIGH{20, 20, 50, 50}, R_MID{30, 600, 80, 80}, R_OVID{760, 200, 128, 96}, R_AMB{40, 40, 60, 60},
               R_T2{620, 500, 50, 50};
    auto lo_at = [](const Rect &q, const char *klass, int z) {
        cr::LayerOptions l;
        l.target = "panel";
        l.klass = klass;
        l.z = z;
        l.x = q.x; l.y = q.y; l.w = q.w; l.h = q.h;
        return l;
    };
    const cr::LayerOptions bg_lo = lo_at(R_BG, "content", 0), frame_lo = lo_at(R_FRAME, "content", 0);
    const uint32_t low = o.effect(lo_at(R_LOW, "ambient", 0), fx);
    const uint32_t mid = o.effect(lo_at(R_MID, "content", -1), fx);
    const uint32_t bg = a.effect(bg_lo, fx);
    const uint32_t frame = a.effect(frame_lo, fx);
    const uint32_t high = o.effect(lo_at(R_HIGH, "overlay", 0), fx);
    r.pump(1500);
    ok("layer hosts: the theme and the other client shown on the panel",
       ea.layer[bg] == "shown" && ea.layer[frame] == "shown" && eo.layer[low] == "shown" && eo.layer[mid] == "shown" &&
           eo.layer[high] == "shown");

    cr::Host h;
    h.into = "panel";
    h.target = "map";
    h.x = 700; h.y = 160; h.w = 560; h.h = 400;
    h.src_x = 264; h.src_y = 40; h.src_w = 560; h.src_h = 400;
    /* A background client hosting first, a tiny layer of its own under the
     * theme's over its rect: live alone, but the theme, drawn higher over
     * the map, wins. */
    cr::Host gh = h;
    gh.x = 640;
    std::map<std::string, std::string> hosting_bg;
    {
        cr::Client bgc("background", r.path);
        bgc.on_hosting = [&hosting_bg](const std::string &t, const std::string &, const std::string &state,
                                       const std::string &why) { hosting_bg[t] = state + (why.empty() ? "" : ": " + why); };
        r.clients.push_back(&bgc);
        r.pump(50);
        bgc.effect(lo_at(Rect{710, 170, 1, 1}, "ambient", 0), fx);
        bgc.host(gh);
        r.pump(300);
        ok("layer hosts: a background client's early host with a tiny layer: live while alone",
           b.hosts.count("map") && b.hosts["map"].x == 640 && hosting_bg["map"] == "live");
        ok("layer hosts: the client keeps and sends it", a.host(h));
        r.pump(300);
        ok("layer hosts: the visible theme, drawn higher over the map, wins over the host sent first",
           b.hosts.count("map") && b.hosts["map"].x == 700 &&
               hosting_bg["map"] == "waiting: target map is hosted by another client's layers, drawn higher over it");
        r.clients.pop_back();
    }
    r.pump(100);
    ok("layer hosts: the producer told the map is hosted in the panel at the rect, the theme that it is live",
       b.hosts.count("map") && b.hosts["map"].into == "panel" && b.hosts["map"].x == 700 &&
           b.hosts["map"].src_x == 264 && b.hosts["map"].shown && !told.empty() && hosting["map"] == "live");
    ok("layer hosts: the status names it, live",
       has(r.svc->server().status_text(r.now), "theme hosts map from its layers on panel at 560x400+700+160 from "
                                               "560x400+264+40; live"));

    /* The producer moves its video into the rect, as waze-on-cluster does:
     * marked as the hosted map, made after the theme's layers, content z 0,
     * which alone would be on top of the frame. */
    b.drop(video);
    cr::LayerOptions hl = lo_at(R_MAP, "content", 0);
    hl.hosted = "map";
    cr::VideoOptions crop;
    crop.w = 560;
    crop.h = 400;
    crop.stall_ms = 600000;
    video = b.video(hl, crop);
    std::vector<uint8_t> f2(560 * 600, 90);
    b.frame(video, f2.data(), f2.size(), 2);
    r.pump(2000);
    const std::vector<std::pair<std::string, Rect>> names = {{"low", R_LOW},     {"mid", R_MID}, {"bg", R_BG},
                                                             {"frame", R_FRAME}, {"map", R_MAP}, {"high", R_HIGH},
                                                             {"ovid", R_OVID},   {"t2", R_T2}};
    FakeGraph *g = r.gpu.graph("panel");
    ok("layer hosts: the map under the theme's layers, over the other client's below them, under its overlay",
       eb.layer[video] == "shown" && eb.target["map"] == "idle" && stack_of(g, names) == "low mid map bg frame high");
    cr::LayerOptions unmarked = hl;
    unmarked.hosted.clear();
    b.set(video, unmarked);
    r.pump(200);
    ok("layer hosts: the mark cleared with set(): the video at its own place, over the frame",
       stack_of(r.gpu.graph("panel"), names) == "low mid bg frame map high");
    b.set(video, hl);
    r.pump(200);
    ok("layer hosts: marked again: under the theme again", stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high");

    /* A client drawing over the theme at its rect wins; the map is then
     * drawn over the theme's layers there too, never under them, though its
     * lowest layer is below them. */
    {
        cr::Client top("top", r.path);
        r.clients.push_back(&top);
        r.pump(50);
        top.effect(lo_at(Rect{710, 170, 1, 1}, "ambient", 0), fx);
        top.effect(lo_at(Rect{712, 172, 1, 1}, "overlay", 0), fx);
        top.host(gh);
        r.pump(300);
        ok("layer hosts: a client drawing over the theme wins, the theme told why, the map over the theme's layers",
           b.hosts["map"].x == 640 &&
               hosting["map"] == "waiting: target map is hosted by another client's layers, drawn higher over it" &&
               stack_of(r.gpu.graph("panel"), names) == "low ? mid bg frame map high ?");
        r.clients.pop_back();
    }
    r.pump(300);
    /* An image at opacity 0 over the rect is not seen: it wins nothing,
     * however high it is. */
    {
        cr::Client ghost("ghost", r.path);
        std::map<std::string, std::string> hosting_ghost;
        ghost.on_hosting = [&hosting_ghost](const std::string &t, const std::string &, const std::string &state,
                                            const std::string &why) { hosting_ghost[t] = state + (why.empty() ? "" : ": " + why); };
        r.clients.push_back(&ghost);
        r.pump(50);
        cr::LayerOptions clear = lo_at(Rect{712, 172, 4, 4}, "overlay", 0);
        clear.opacity = 0;
        cr::ImageOptions io4;
        io4.w = io4.h = 4;
        const uint32_t img = ghost.image(clear, io4);
        std::vector<uint8_t> px4(4 * 4 * 4, 255);
        ghost.pixels(img, {}, px4.data(), px4.size());
        ghost.host(gh);
        r.pump(300);
        ok("layer hosts: a client whose only layer over its rect is an image at opacity 0: not eligible, the theme live",
           b.hosts["map"].x == 700 && hosting["map"] == "live" &&
               hosting_ghost["map"] == "waiting: no layer of the client is drawn over its rect on panel");
        r.clients.pop_back();
    }
    r.pump(300);
    /* Clients whose hosts are not eligible (shown 0; a rect its layers are
     * not over) never move the picture, an alert layer of theirs over the
     * rect included: it stays by the theme's anchor. */
    {
        cr::Client off("off", r.path), away("away", r.path);
        r.clients.push_back(&off);
        r.clients.push_back(&away);
        r.pump(50);
        off.effect(lo_at(Rect{720, 180, 4, 4}, "alert", 0), fx);
        cr::Host hidden_host = gh;
        hidden_host.shown = false;
        off.host(hidden_host);
        away.effect(lo_at(Rect{730, 190, 4, 4}, "alert", 0), fx);
        cr::Host elsewhere = gh;
        elsewhere.x = 100; elsewhere.y = 40; elsewhere.w = 100; elsewhere.h = 50;
        away.host(elsewhere);
        r.pump(300);
        ok("layer hosts: hosts not eligible, with alert layers over the rect: the map still under the theme",
           b.hosts["map"].x == 700 && hosting["map"] == "live" &&
               stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high ? ?");
        r.clients.pop_back();
        r.clients.pop_back();
    }
    r.pump(300);
    ok("layer hosts: that client gone: the theme live again", b.hosts["map"].x == 700 && hosting["map"] == "live" &&
                                                                  stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high");

    /* shown 0: a host from layers shows the map nowhere, so it is not live:
     * the map goes back to its own slot. */
    cr::Host nowhere = h;
    nowhere.shown = false;
    a.host(nowhere);
    r.pump(100);
    ok("layer hosts: shown 0: not live, the producer told the map is not hosted, the theme why",
       !b.hosts.count("map") && hosting["map"] == "waiting: it shows the target nowhere (shown 0)");
    a.host(h);
    r.pump(100);

    /* Another client's video inside the rect, not marked: its own place. */
    cr::VideoOptions small;
    small.w = 128;
    small.h = 96;
    small.stall_ms = 600000;
    const uint32_t ovid = o.video(lo_at(R_OVID, "overlay", 0), small);
    std::vector<uint8_t> f3(128 * 144, 60);
    o.frame(ovid, f3.data(), f3.size(), 1);
    r.pump(1000);
    ok("layer hosts: another client's overlay video inside the rect keeps its place, over the theme",
       eo.layer[ovid] == "shown" && stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high ovid");
    o.drop(ovid);
    r.pump(200);

    /* A hidden theme layer is no anchor: one of a lower class leaves the
     * map where it was, over the other client's content. */
    cr::LayerOptions amb_lo = lo_at(R_AMB, "ambient", 0);
    amb_lo.visible = false;
    const uint32_t amb = a.effect(amb_lo, fx);
    r.pump(200);
    ok("layer hosts: a hidden ambient theme layer: the map still by the lowest drawn one",
       stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high");
    a.drop(amb);
    r.pump(200);

    /* An exclusive lowest theme layer: the map just over it, so it is not
     * suspended with what is below. */
    cr::LayerOptions ex = bg_lo;
    ex.exclusive = true;
    a.set(bg, ex);
    r.pump(500);
    ok("layer hosts: an exclusive background: the map just over it, shown, still hosted",
       eb.layer[video] == "shown" && b.hosts.count("map") && stack_of(r.gpu.graph("panel"), names) == "bg map frame high");
    a.set(bg, bg_lo);
    r.pump(500);
    ok("layer hosts: not exclusive again: back under it", stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high");

    /* The edge works as for a scene's host. */
    cr::Host eh = h;
    eh.edge_top = 40;
    eh.edge_bottom = 40;
    eh.edge_dim = 160;
    a.host(eh);
    r.pump(100);
    int edges = 0;
    g = r.gpu.graph("panel");
    for (int q : g->visible())
        edges += g->shown.quads.at(q).uniforms.count("u_edge") ? 1 : 0;
    ok("layer hosts: an edge drawn on the hosted video", edges == 2);
    a.host(h);
    r.pump(100);

    /* Refusals; a host with no layer drawn waits and blocks nobody. */
    cr::Host own = h;
    own.target = "panel";
    ok("layer hosts: its own target refused by the client", !a.host(own));
    {
        Raw raw(r.path);
        raw.send("{\"op\":\"hello\",\"app\":\"raw\",\"proto\":1}");
        raw.send("{\"op\":\"host\",\"into\":\"panel\",\"target\":\"map\",\"x\":0,\"y\":0,\"w\":10,\"h\":10}");
        raw.send("{\"op\":\"host\",\"into\":\"panel\",\"target\":\"map\",\"x\":0,\"y\":0,\"w\":100,\"h\":50,"
                 "\"src_x\":0,\"src_y\":0,\"src_w\":32,\"src_h\":16}");
        raw.send("{\"op\":\"host\",\"into\":\"panel\",\"target\":\"panel\",\"x\":0,\"y\":0,\"w\":10,\"h\":10}");
        raw.send("{\"op\":\"host\",\"into\":\"panel\",\"ref\":3,\"target\":\"map\",\"x\":0,\"y\":0,\"w\":10,\"h\":10}");
        raw.send("{\"op\":\"host\",\"into\":\"nowhere\",\"target\":\"hud\",\"x\":0,\"y\":0,\"w\":10,\"h\":10}");
        raw.send("{\"op\":\"host\",\"into\":\"panel\",\"target\":\"map\",\"x\":0,\"y\":0,\"w\":100,\"h\":50}");
        r.pump(100);
        const std::string got = raw.events();
        ok("layer hosts: refused: a rect or part under 64x32, its own target, ref with into, an unknown into, naming into",
               got.find("a host from layers is at least 64x32 (w, h and src_w, src_h)") != std::string::npos &&
               got.find("a host shows other targets, not its own") != std::string::npos &&
               got.find("ref or into, not both") != std::string::npos &&
               got.find("unknown target nowhere") != std::string::npos &&
               got.find("\"into\":\"panel\"") != std::string::npos);
        ok("layer hosts: a host with no layer drawn: taken, waiting and told why, the theme's still live",
           got.find("\"ev\":\"hosting\",\"target\":\"map\",\"into\":\"panel\",\"state\":\"waiting\","
                    "\"reason\":\"no layer of the client is drawn over its rect on panel\"") != std::string::npos &&
               b.hosts.count("map") && b.hosts["map"].x == 700 && hosting["map"] == "live");
    }

    /* Two live themes: the one drawn higher over its rect (the newer, here)
     * is live, the other waits; it hidden, the first takes over: a hidden
     * theme blocks nothing. */
    {
        cr::Client t2("theme2", r.path);
        std::map<std::string, std::string> hosting2;
        t2.on_hosting = [&hosting2](const std::string &t, const std::string &, const std::string &state,
                                    const std::string &why) { hosting2[t] = state + (why.empty() ? "" : ": " + why); };
        r.clients.push_back(&t2);
        r.pump(50);
        const uint32_t t2_layer = t2.effect(lo_at(R_T2, "content", 0), fx);
        cr::Host h2 = h;
        h2.x = 600;
        t2.host(h2);
        r.pump(500);
        ok("layer hosts: a second theme drawn higher over its rect is live; the first waits, told why",
           b.hosts["map"].x == 600 && hosting2["map"] == "live" &&
               hosting["map"] == "waiting: target map is hosted by another client's layers, drawn higher over it" &&
               has(r.svc->server().status_text(r.now), "(theme2)"));
        cr::LayerOptions t2_hidden = lo_at(R_T2, "content", 0);
        t2_hidden.visible = false;
        t2.set(t2_layer, t2_hidden);
        r.pump(500);
        ok("layer hosts: the second theme hidden: it blocks nothing, the first is live again",
           b.hosts.count("map") && b.hosts["map"].x == 700 && hosting["map"] == "live" &&
               hosting2["map"] == "waiting: no layer of the client is drawn over its rect on panel");
        r.clients.pop_back();
    }
    r.pump(200);

    /* Live only while a theme layer is drawn. */
    cr::LayerOptions hidden = bg_lo;
    hidden.visible = false;
    a.set(bg, hidden);
    r.pump(100);
    ok("layer hosts: one theme layer hidden, the other shown: still hosted", b.hosts.count("map"));
    hidden = frame_lo;
    hidden.visible = false;
    a.set(frame, hidden);
    r.pump(100);
    ok("layer hosts: every theme layer hidden: the producer told the map is not hosted, the status says why",
       !b.hosts.count("map") && told.back().into.empty() &&
           has(r.svc->server().status_text(r.now), "waiting: no layer of the client is drawn over its rect on panel"));
    a.set(bg, bg_lo);
    a.set(frame, frame_lo);
    r.pump(100);
    ok("layer hosts: shown again: hosted again", b.hosts.count("map") && b.hosts["map"].into == "panel");

    /* The stock HMI taking the panel: nobody sees it, so not hosted. */
    r.port.steal(r.sc.targets[1]);
    r.pump(200);
    ok("layer hosts: the stock HMI takes the panel: the map not hosted, the theme told why",
       !b.hosts.count("map") && hosting["map"].find("waiting: panel is not on screen") == 0);
    r.port.free_slot(r.sc.targets[1]);
    r.pump(2000);
    ok("layer hosts: the panel back: hosted again", b.hosts.count("map") && hosting["map"] == "live");

    /* A scene file on the panel: with layers 1 the layers are drawn over
     * it, so the theme's host can be live, but the scene's own host of the
     * map wins (as without hosts from layers); without layers they wait. */
    cr::SceneOptions so;
    so.target = "panel";
    so.file = gauge;
    so.sha256 = {sha256_file(gauge)};
    so.layers = true;
    const uint32_t sc = o.scene(so);
    r.pump(1500);
    ok("layer hosts: another client's scene with layers 1: still hosted by the theme",
       eo.layer[sc] == "shown" && b.hosts.count("map") && b.hosts["map"].x == 700);
    cr::Host sh = h;
    sh.into.clear();
    sh.x = 600;
    o.host(sc, sh);
    r.pump(200);
    ok("layer hosts: the scene's host of the map taken and live, the theme's waits, told why",
       !has(eo.errors, "host:") && b.hosts.count("map") && b.hosts["map"].x == 600 &&
           hosting["map"] == "waiting: target map is hosted by a scene");
    so.layers = false;
    o.scene(sc, so);
    r.pump(1500);
    ok("layer hosts: the scene without layers: the theme's layers wait, the map not hosted, the theme told why",
       ea.layer[bg] == "waiting" && !b.hosts.count("map") &&
           hosting["map"] == "waiting: panel's layers wait for a scene file there");
    o.drop(sc);
    r.pump(1500);
    ok("layer hosts: the scene dropped: hosted by the theme again",
       b.hosts.count("map") && b.hosts["map"].x == 700 && ea.layer[bg] == "shown");

    /* unhost. */
    a.unhost("map");
    r.pump(100);
    ok("layer hosts: unhost: the producer told the map is not hosted, nothing in the status",
       !b.hosts.count("map") && told.back().into.empty() && !has(r.svc->server().status_text(r.now), "hosts map"));

    /* A refused move to another into ends the host, and the client forgets
     * it: not sent again after a restart. */
    a.host(h);
    r.pump(100);
    cr::Host moved = h;
    moved.into = "nowhere";
    a.host(moved);
    r.pump(100);
    ok("layer hosts: a move to an unknown into refused: the host ended, the producer told",
       has(ea.errors, "host: unknown target nowhere") && !b.hosts.count("map") && told.back().into.empty());
    r.svc.reset();
    r.pump(100);
    r.start();
    r.pump(1500);
    ok("layer hosts: after a restart the client sends no host it was refused", !b.hosts.count("map"));

    /* Kept by the client across a restart. */
    a.host(h);
    r.pump(100);
    r.svc.reset();
    r.pump(100);
    ok("layer hosts: the service gone: nothing hosted", b.hosts.empty());
    r.start();
    r.pump(1500);
    b.frame(video, f2.data(), f2.size(), 3);
    r.pump(1000);
    ok("layer hosts: after a restart the client sends it again: hosted, the map under the theme again",
       b.hosts.count("map") && b.hosts["map"].into == "panel" &&
           stack_of(r.gpu.graph("panel"), names) == "low mid map bg frame high");

    /* The theme's client gone (it exits). */
    a.unhost("map");
    r.pump(100);
    {
        std::unique_ptr<cr::Client> t(new cr::Client("theme2", r.path));
        r.clients.push_back(t.get());
        r.pump(50);
        t->effect(bg_lo, fx);
        t->host(h);
        r.pump(1500);
        ok("layer hosts: another theme hosts the map once the first ended its host",
           b.hosts.count("map") && b.hosts["map"].into == "panel" &&
               has(r.svc->server().status_text(r.now), "theme2 hosts map"));
        r.clients.pop_back();
    }
    r.pump(100);
    ok("layer hosts: that theme's client gone: the map not hosted", !b.hosts.count("map") && told.back().into.empty());

    /* Crashed: a socket that closes with nothing more said. */
    {
        Raw crash(r.path);
        crash.send("{\"op\":\"hello\",\"app\":\"crash\",\"proto\":1}");
        crash.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"panel\",\"kind\":\"effect\",\"x\":0,\"y\":0,"
                   "\"w\":1920,\"h\":720,\"fs\":\"#version 100\\nvoid main(){gl_FragColor=vec4(0.0);}\"}");
        crash.send("{\"op\":\"host\",\"into\":\"panel\",\"target\":\"map\",\"x\":700,\"y\":160,\"w\":560,\"h\":400}");
        r.pump(1500);
        ok("layer hosts: a raw client hosts the map", b.hosts.count("map") && b.hosts["map"].into == "panel");
    }
    r.pump(100);
    ok("layer hosts: its socket closed with nothing said: the map not hosted",
       !b.hosts.count("map") && told.back().into.empty());
    const int removed = std::system(("rm -rf " + root).c_str());
    (void)removed;
}

/* Hosts from layers with a third target, hud: two hosted targets, each with
 * its producer's marked video, into one target, each video by its own
 * host's anchor (the second restack finds its anchor after the first moved
 * layers); hosts on different intos: the into that holds the target keeps
 * it while it has an eligible host, a host on another into sent later
 * waits, told why, and does not take it by unhost and host again; it takes
 * over once the live one is hidden, and keeps it when that one is shown
 * again. */
static void hosting_from_layers_more()
{
    Rig r;
    TargetSpec u;
    u.name = "hud"; u.slot = 0x323; u.scene_id = 0x010004f9; u.width = 800; u.height = 480; u.linger_ms = 3000;
    r.sc.targets.push_back(u);
    r.start();
    cr::Client a("themeA", r.path), bb("themeB", r.path), pm("mapper", r.path), ph("hudder", r.path);
    std::map<std::string, std::string> hosting_a, hosting_b;
    a.on_hosting = [&hosting_a](const std::string &t, const std::string &, const std::string &state,
                                const std::string &why) { hosting_a[t] = state + (why.empty() ? "" : ": " + why); };
    bb.on_hosting = [&hosting_b](const std::string &t, const std::string &, const std::string &state,
                                 const std::string &why) { hosting_b[t] = state + (why.empty() ? "" : ": " + why); };
    r.clients = {&a, &bb, &pm, &ph};
    r.pump(50);
    const cr::EffectOptions fx{"#version 100\nvoid main(){gl_FragColor=vec4(0.0);}", "", 0};
    auto lo_at = [](const char *target, const Rect &q, const char *klass) {
        cr::LayerOptions l;
        l.target = target;
        l.klass = klass;
        l.x = q.x; l.y = q.y; l.w = q.w; l.h = q.h;
        return l;
    };
    const Rect R_A{0, 0, 1920, 720}, R_B{1000, 100, 600, 400}, R_MV{100, 100, 560, 400}, R_HV{1040, 140, 400, 240};
    const uint32_t a_layer = a.effect(lo_at("panel", R_A, "content"), fx);
    bb.effect(lo_at("panel", R_B, "content"), fx);
    r.pump(1500);
    cr::Host hm;
    hm.into = "panel"; hm.target = "map";
    hm.x = 100; hm.y = 100; hm.w = 560; hm.h = 400;
    a.host(hm);
    cr::Host hh;
    hh.into = "panel"; hh.target = "hud";
    hh.x = 1040; hh.y = 140; hh.w = 400; hh.h = 240;
    bb.host(hh);
    r.pump(300);
    /* the producers' marked videos, made after the themes' layers */
    cr::LayerOptions mv = lo_at("panel", R_MV, "content");
    mv.hosted = "map";
    cr::VideoOptions vm;
    vm.w = 560; vm.h = 400; vm.stall_ms = 600000;
    const uint32_t mvid = pm.video(mv, vm);
    std::vector<uint8_t> fm(560 * 600, 90);
    pm.frame(mvid, fm.data(), fm.size(), 1);
    cr::LayerOptions hv = lo_at("panel", R_HV, "content");
    hv.hosted = "hud";
    cr::VideoOptions vh;
    vh.w = 400; vh.h = 240; vh.stall_ms = 600000;
    const uint32_t hvid = ph.video(hv, vh);
    std::vector<uint8_t> fh(400 * 360, 120);
    ph.frame(hvid, fh.data(), fh.size(), 1);
    r.pump(1500);
    const std::vector<std::pair<std::string, Rect>> names = {{"A", R_A}, {"B", R_B}, {"mv", R_MV}, {"hv", R_HV}};
    ok("layer hosts: two hosted targets into one target: each video by its own host's anchor",
       hosting_a["map"] == "live" && hosting_b["hud"] == "live" && stack_of(r.gpu.graph("panel"), names) == "mv A hv B");
    pm.drop(mvid);
    ph.drop(hvid);
    bb.unhost("hud");
    r.pump(300);

    /* Hosts on different intos: themeA holds the map on the panel; themeB,
     * a layer on the hud over its rect, hosts the map into the hud later. */
    bb.effect(lo_at("hud", Rect{0, 0, 800, 480}, "content"), fx);
    cr::Host hb;
    hb.into = "hud"; hb.target = "map";
    hb.x = 100; hb.y = 100; hb.w = 400; hb.h = 240;
    bb.host(hb);
    r.pump(1500);
    ok("layer hosts: a host on another into sent later waits, told why; the live one keeps the map",
       hosting_a["map"] == "live" &&
           hosting_b["map"] == "waiting: target map is hosted by another client's layers on panel, there first" &&
           pm.hosts.count("map") && pm.hosts["map"].into == "panel");
    for (int k = 0; k < 3; k++) {
        bb.unhost("map");
        r.pump(100);
        bb.host(hb);
        r.pump(300);
    }
    ok("layer hosts: unhost and host again does not take it", hosting_a["map"] == "live" &&
                                                             pm.hosts["map"].into == "panel" &&
                                                             hosting_b["map"].find("waiting") == 0);
    cr::LayerOptions a_hidden = lo_at("panel", R_A, "content");
    a_hidden.visible = false;
    a.set(a_layer, a_hidden);
    r.pump(500);
    ok("layer hosts: the live one hidden: the one waiting takes over",
       hosting_b["map"] == "live" && pm.hosts["map"].into == "hud" &&
           hosting_a["map"] == "waiting: no layer of the client is drawn over its rect on panel");
    a.set(a_layer, lo_at("panel", R_A, "content"));
    r.pump(1500);
    ok("layer hosts: shown again, it does not take the map back: the one live keeps it",
       hosting_b["map"] == "live" && pm.hosts["map"].into == "hud" &&
           hosting_a["map"] == "waiting: target map is hosted by another client's layers on hud, there first");
    bb.unhost("map");
    r.pump(500);
    ok("layer hosts: that one gone: the first live again", hosting_a["map"] == "live" && pm.hosts["map"].into == "panel");
}

int main()
{
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, nullptr, _IONBF, 0);
    Rig r;
    cr::Client a("waze", r.path), b("overlay", r.path);
    Events ea, eb;
    ea.wire(a);
    eb.wire(b);
    r.clients = {&a, &b};
    r.pump(50);
    ok("hello: both clients ready, the backend and targets named",
       ea.ready == 1 && eb.ready == 1 && a.backend == "fake" && a.targets == "map:1088x480,panel:1920x720");


    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = a.video(lo, cr::VideoOptions());
    r.pump(100);
    ok("a video layer without frames is stalled and asks for nothing",
       ea.layer[map] == "stalled" && r.port.requests == 0 && ea.target["map"] == "idle");
    const std::vector<uint8_t> f1 = atlas(1);
    ok("a frame of the wrong size is refused by the client", !a.frame(map, f1.data(), 100, 1));
    ok("its first frame is taken", a.frame(map, f1.data(), f1.size(), 1));
    r.pump(20);
    ok("the target is requested, the layer waits for it", r.port.requests == 1 && ea.layer[map] == "waiting");
    r.pump(100);
    FakeGraph *g = r.gpu.graph("map");
    std::vector<uint8_t> rounded(f1.size());
    crk::round_levels(rounded.data(), f1.data(), f1.size(), 2);
    bool atlas_shown = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            atlas_shown = atlas_shown || (kv.second.f == TexFormat::R8 && kv.second.px == rounded);
    ok("granted: shown, with the frame in the scene", ea.layer[map] == "shown" && ea.target["map"] == "shown" &&
                                                         atlas_shown);
    cr::LayerOptions turned = lo;
    turned.rotate = 10;
    turned.sx = 0.75f;
    a.set(map, turned);
    r.pump(20);
    const Layer *video = nullptr;
    for (const Layer *x : r.svc->compositor().layers())
        if (std::string(x->kind()) == "video")
            video = x;
    ok("the C++ client turns a video layer", video && video->params.rotate == 10 && video->params.sx == 0.75f);

    cr::LayerOptions ov;
    ov.target = "map";
    ov.klass = "overlay";
    ov.x = 900;
    ov.y = 400;
    ov.w = 64;
    ov.h = 64;
    cr::ImageOptions io;
    io.w = io.h = 64;
    const uint32_t badge = b.image(ov, io);
    std::vector<uint8_t> px(64 * 64 * 4, 255);
    b.pixels(badge, {}, px.data(), px.size());
    r.pump(100);
    ok("a second client's overlay joins the same scene: shown, no second request",
       eb.layer[badge] == "shown" && r.port.requests == 1 && g && g->visible().size() == 2);

    r.port.steal(r.sc.targets[0]);
    r.pump(20);
    ok("the stock HMI takes the slot: both layers wait, the target names the stock HMI",
       ea.layer[map] == "waiting" && eb.layer[badge] == "waiting" && ea.target["map"] == "waiting" &&
           ea.holder["map"] == "stock");
    a.frame(map, f1.data(), f1.size(), 2);   /* frames keep coming while it waits */
    r.pump(2100);
    ok("the contending video asks again after 2 s and both are shown",
       r.port.requests == 2 && ea.layer[map] == "shown" && eb.layer[badge] == "shown");
    {
        std::vector<uint8_t> f2 = atlas(2), wrong(100);
        const std::vector<uint8_t> want = f2;
        ok("a frame handed over without a copy: a wrong size is refused and left as it was",
           !a.frame(map, &wrong, 3) && wrong.size() == 100);
        ok("a frame handed over: taken, and a buffer of its size comes back",
           a.frame(map, &f2, 3) && f2.size() == want.size());
        r.pump(100);
        std::vector<uint8_t> rounded2(want.size());
        crk::round_levels(rounded2.data(), want.data(), want.size(), 2);
        bool shown2 = false;
        g = r.gpu.graph("map");
        if (g)
            for (const auto &kv : g->shown.buffers)
                shown2 = shown2 || (kv.second.f == TexFormat::R8 && kv.second.px == rounded2);
        ok("and the scene shows it", shown2);
    }

    /* The video's client goes; the overlay keeps the target up. */
    r.clients = {&b};
    {
        cr::Client *pa = new cr::Client("waze2", r.path);
        Events e;
        e.wire(*pa);
        r.clients.push_back(pa);
        r.pump(50);
        cr::LayerOptions l2;
        l2.target = "panel";
        const uint32_t ref = pa->effect(l2, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
        r.pump(100);
        ok("an effect layer on another target is shown", e.layer[ref] == "shown");
        r.clients.pop_back();
        delete pa;
        r.pump(50);
    }
    ok("its client gone: its layer is removed, the panel lingers", r.svc->compositor().layers().size() == 2 &&
                                                                     eb.target["panel"] == "lingering");
    const int releases = r.port.releases;
    a.drop(map);
    r.clients = {&a, &b};
    r.pump(50);
    r.clients = {&b};
    ok("the video dropped: the overlay keeps the map up, no release",
       r.port.releases == releases && eb.target["map"] == "shown");
    b.drop(badge);
    r.pump(1400);
    ok("the last layer gone: the map lingers", eb.target["map"] == "lingering");
    r.pump(200);
    ok("then is released", eb.target["map"] == "idle");
    {
        const SlotInfo *stock = r.port.row(0x100, 0x01000101);
        ok("the stock map, parked behind ours since the take-over, is shown again",
           r.port.taken_over.size() == 1 && stock && stock->map_status == 1 && !r.port.row(0x100, 0x010004f0));
    }
    r.port.free_slot(r.sc.targets[0]);   /* the HMI leaves the map slot */

    /* Errors reach the client. */
    cr::LayerOptions bad;
    bad.target = "nowhere";
    b.effect(bad, cr::EffectOptions{"x", "", 0});
    r.pump(20);
    ok("a layer on an unknown target is refused with a reason",
       !eb.errors.empty() && eb.errors.back().find("unknown target") != std::string::npos);

    /* The service restarts under the client: its layers are made again and
     * its image sent whole. */
    const uint32_t badge2 = b.image(ov, io);
    px.assign(px.size(), 77);
    b.pixels(badge2, {}, px.data(), px.size());
    r.pump(100);
    ok("before the restart: shown", eb.layer[badge2] == "shown");
    r.svc.reset();
    r.pump(100);
    r.start();
    eb.layer.clear();
    r.pump(1500);
    g = r.gpu.graph("map");
    bool resent = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            resent = resent || (kv.second.f == TexFormat::RGBA8 && kv.second.px[0] == 77);
    ok("after it: the client reconnected, its layer made again and its image sent whole",
       eb.ready >= 2 && eb.layer[badge2] == "shown" && resent);

    /* What a client could send that the clients never do. */
    Raw raw(r.path);
    raw.send("{\"op\":\"hello\",\"app\":\"raw\"}");
    raw.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"x\","
             "\"opacity\":nan}");
    raw.send("{\"op\":\"layer\",\"ref\":2,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"x\"}");
    for (int k = 0; k < 40; k++)
        raw.send("{\"op\":\"uniform\",\"ref\":2,\"name\":\"u_" + std::to_string(k) + "\",\"v\":\"1\"}");
    raw.send("{\"op\":\"uniform\",\"ref\":2,\"name\":\"u_x\",\"v\":\"inf\"}");
    r.pump(50);
    const std::string got = raw.events();
    ok("NaN is not a number in range", got.find("opacity must be a number") != std::string::npos);
    ok("a layer's uniform names are limited", got.find("at most 32 uniforms") != std::string::npos);
    ok("a uniform must be finite", got.find("finite numbers") != std::string::npos);

    /* A target waiting on a timer is reported once, not every pass. */
    r.port.grant_ms = 100000;   /* requests go unanswered: the 5 s timeout, then the ladder */
    cr::Client w("waiter", r.path);
    Events ew;
    ew.wire(w);
    r.clients.push_back(&w);
    int target_events = 0;
    w.on_target = [&](const std::string &t, const std::string &, const std::string &, const std::string &) {
        if (t == "map")
            target_events++;
    };
    r.pump(50);
    cr::LayerOptions wl;
    wl.target = "map";
    w.effect(wl, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
    r.pump(5100);
    target_events = 0;
    r.pump(1900);
    ok("waiting for its retry: no repeated target events", target_events == 0);

    /* An image layer the app has not drawn yet is not sent, so it asks for
     * nothing; overlapping updates bigger than the image go whole. */
    cr::LayerOptions il;
    il.target = "panel";
    il.w = 1920;
    il.h = 720;
    cr::Client big("big", r.path);
    Events ebig;
    ebig.wire(big);
    const uint32_t full = big.image(il, cr::ImageOptions());
    r.clients.push_back(&big);
    r.pump(200);
    ok("an image layer never drawn stays stalled", ebig.layer[full] == "stalled");
    /* The whole image is still being written when two updates of 3 MB
     * follow: together they would be a 6.1 MB message, over the service's
     * limit, so they go as the whole image. */
    std::vector<uint8_t> whole(1920 * 720 * 4, 20), rows(1920 * 400 * 4, 50);
    big.pixels(full, {}, whole.data(), whole.size());
    big.pixels(full, {cr::FrameRect{0, 0, 1920, 400}}, rows.data(), rows.size());
    big.pixels(full, {cr::FrameRect{0, 300, 1920, 400}}, rows.data(), rows.size());
    r.pump(300);
    ok("updates outgrowing the image go whole: the client is not disconnected",
       ebig.ready == 1 && ebig.layer[full] == "shown");
    r.clients.pop_back();
    r.clients.pop_back();

    /* Assets, binds, uniform arrays, a turned image, a mesh layer and
     * animations, over the socket. */
    r.port.grant_ms = 50;
    cr::Client dash("dash", r.path);
    Events ed;
    ed.wire(dash);
    r.clients.push_back(&dash);
    r.pump(50);
    cr::AssetOptions ga;
    ga.target = "panel";
    ga.r8 = true;
    ga.w = 64;
    ga.h = 32;
    const uint32_t glyphs = dash.asset(ga);
    std::vector<uint8_t> gpx(64 * 32, 200);
    ok("an asset is taken and its pixels too", glyphs && dash.pixels(glyphs, {}, gpx.data(), gpx.size()));
    cr::LayerOptions tl;
    tl.target = "panel";
    tl.klass = "overlay";
    tl.x = 100;
    tl.y = 100;
    tl.w = 64;
    tl.h = 32;
    const uint32_t label = dash.effect(tl, cr::EffectOptions{"#version 100\nprecision mediump float;\n"
                                                            "uniform sampler2D u_atlas;\nuniform vec4 u_cells[2];\n"
                                                            "uniform float u_time;\nvarying vec2 v_uv;\nvoid main(){"
                                                            "gl_FragColor=texture2D(u_atlas,v_uv)*u_cells[1]*u_time;}",
                                                            "", 0},
                                      true);
    dash.bind(label, "u_atlas", glyphs);
    dash.uniform(label, "u_cells", cr::UniformType::Vec4, {0, 0, 1, 1, 1, 1, 1, 1});
    cr::LayerOptions nl;
    nl.target = "panel";
    nl.klass = "overlay";
    nl.x = 1500;
    nl.y = 100;
    nl.w = nl.h = 32;
    nl.rotate = 45;
    nl.pivot = true;
    nl.px = 16;
    nl.py = 30;
    cr::ImageOptions nio;
    const uint32_t needle = dash.image(nl, nio);
    std::vector<uint8_t> npx(32 * 32 * 4, 128);
    dash.pixels(needle, {}, npx.data(), npx.size());
    cr::AnimationOptions sweep;
    sweep.property = "rotate";
    sweep.keys = "0:0 1000:90 2000:0";
    sweep.loop = true;
    const uint32_t sweep_id = dash.animate(needle, sweep);
    cr::LayerOptions ml;
    ml.target = "panel";
    ml.x = 600;
    ml.y = 200;
    ml.w = 400;
    ml.h = 300;
    cr::MeshOptions mo;
    mo.cz = 6;
    const uint32_t box = dash.mesh(ml, mo);
    cr::PartOptions po;
    po.vs = "#version 100\nattribute vec3 a_position;\nattribute vec3 a_normal;\nuniform mat4 u_mvp;\n"
            "uniform mat4 u_normal;\nvarying vec3 v_n;\nvoid main(){v_n=(u_normal*vec4(a_normal,0.0)).xyz;"
            "gl_Position=u_mvp*vec4(a_position,1.0);}";
    po.fs = "#version 100\nprecision mediump float;\nuniform vec4 u_color;\nvarying vec3 v_n;\n"
            "void main(){gl_FragColor=u_color*max(v_n.z,0.2);}";
    ok("a mesh layer's part and its geometry are taken", box && dash.part(box, 1, po) && dash.geometry(box, 1, cube()));
    cr::Transform tf;
    tf.ry = 30;
    dash.transform(box, 1, tf);
    dash.uniform(box, "u_color", cr::UniformType::Vec4, {1, 0.5f, 0, 1}, 1);
    cr::AnimationOptions spin;
    spin.part = 1;
    spin.property = "rotate";
    spin.keys = "0:0,0,0 4000:0,360,0";
    spin.loop = true;
    dash.animate(box, spin);
    r.pump(300);
    FakeGraph *pg = r.gpu.graph("panel");
    auto check_dash = [&](const char *when) {
        pg = r.gpu.graph("panel");
        const FakeQuad *tq = nullptr, *nq = nullptr;
        const FakePart *part = nullptr;
        const FakeBuffer *ab = nullptr;
        if (pg) {
            for (const auto &kv : pg->shown.quads) {
                if (kv.second.textures.count("u_atlas"))
                    tq = &kv.second;
                if (kv.second.turn.rotate == 45)
                    nq = &kv.second;
            }
            for (const auto &kv : pg->shown.parts)
                part = &kv.second;
            if (tq)
                ab = &pg->shown.buffers.at(tq->textures.at("u_atlas"));
        }
        int clock = 0, sweeps = 0, spins = 0;
        if (pg)
            for (const auto &kv : pg->shown.animations) {
                clock += kv.second.a.uniform == "u_time";
                sweeps += kv.second.a.property == crs::Animated::Rotate && kv.second.a.width == 1;
                spins += kv.second.a.property == crs::Animated::Rotate && kv.second.a.width == 3;
            }
        ok((std::string(when) + ": every layer shown").c_str(),
           ed.layer[label] == "shown" && ed.layer[needle] == "shown" && ed.layer[box] == "shown");
        ok((std::string(when) + ": the effect samples the asset, written whole, with its uniform array").c_str(),
           tq && tq->visible && ab && ab->px == gpx && tq->types.count("u_cells") &&
               tq->uniforms.at("u_cells").size() == 8);
        ok((std::string(when) + ": the image turned about its pivot").c_str(),
           nq && nq->turn.px == 16 && nq->turn.py == 30);
        ok((std::string(when) + ": the part with its geometry, transform and uniform").c_str(),
           part && part->geometry && part->vertices == 24 && part->indices == 36 && part->pose.r[1] == 30 &&
               part->uniforms.count("u_color"));
        ok((std::string(when) + ": u_time, the sweep and the spin played by the renderer").c_str(),
           clock == 1 && sweeps == 1 && spins == 1);
    };
    check_dash("over the socket");
    dash.drop(glyphs);
    r.pump(20);
    ok("an asset a layer samples is not dropped", !ed.errors.empty() && ed.errors.back() == "drop: asset in use");
    dash.stop(needle, sweep_id);
    r.pump(20);
    int sweeping = 0;
    for (const auto &kv : pg->shown.animations)
        sweeping += kv.second.a.width == 1 && kv.second.a.property == crs::Animated::Rotate;
    ok("a stopped animation leaves the scene", sweeping == 0);
    dash.animate(needle, sweep);
    r.pump(20);

    /* The service restarts: everything is made again from the client. */
    r.svc.reset();
    r.pump(100);
    r.start();
    ed.layer.clear();
    r.pump(1500);
    check_dash("after a restart");
    r.clients.pop_back();

    /* What a client could send that the clients never do. */
    Raw rawm(r.path);
    rawm.send("{\"op\":\"hello\",\"app\":\"bad\"}");
    rawm.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"panel\",\"kind\":\"mesh\"}");
    rawm.send("{\"op\":\"part\",\"ref\":1,\"part\":1,\"vs\":\"attribute vec3 a_position;\",\"fs\":\"x\"}");
    const std::string tri(3 * 12, '\0');
    const std::string idx = std::string("\0\0\1\0\2\0", 6);
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri.substr(0, 10)));
    rawm.send_message(mesh_body(1, 1, 3, 3, 8, tri + idx));
    rawm.send_message(mesh_body(1, 1, 1000000, 3, 0, tri + idx));
    rawm.send_message(mesh_body(1, 1, 3, 4, 0, tri + idx + std::string(2, '\0')));
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri + std::string("\0\0\1\0\7\0", 6)));
    std::string nan = tri;
    const uint32_t qnan = 0x7fc00000;
    std::memcpy(&nan[4], &qnan, 4);
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, nan + idx));
    rawm.send_message(cr::encode(cr::kMesh, "abc"));
    rawm.send_message(mesh_body(9, 1, 3, 3, 0, tri + idx));
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri + idx));
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri + idx));
    rawm.send("{\"op\":\"animate\",\"ref\":1,\"anim\":1,\"part\":1,\"property\":\"rotate\",\"keys\":\"5:1 2:1\"}");
    rawm.send("{\"op\":\"animate\",\"ref\":1,\"anim\":1,\"part\":1,\"property\":\"rotate\",\"keys\":\"0:1,2\"}");
    rawm.send("{\"op\":\"uniform\",\"ref\":1,\"part\":1,\"name\":\"u_m\",\"type\":\"mat4\",\"v\":\"1 2 3\"}");
    rawm.send("{\"op\":\"asset\",\"ref\":2,\"target\":\"panel\",\"w\":4096,\"h\":4}");
    rawm.send("{\"op\":\"asset\",\"ref\":3,\"target\":\"panel\",\"format\":\"etc2rgba\",\"w\":250,\"h\":280}");
    rawm.send("{\"op\":\"asset\",\"ref\":4,\"target\":\"panel\",\"format\":\"etc2rgba\",\"w\":8,\"h\":8}");
    {
        const std::string blk(16, '\x55');
        rawm.send_message(cr::frame_head(4, 1, {cr::FrameRect{0, 0, 4, 4}}, blk.size()) + blk);
        const std::string four(64, '\x55');
        rawm.send_message(cr::frame_head(4, 2, {}, four.size()) + four);
        rawm.send("{\"op\":\"asset\",\"ref\":5,\"target\":\"panel\",\"format\":\"etc2rgb\",\"w\":8,\"h\":8}");
        const std::string rgb(32, '\x55');
        rawm.send_message(cr::frame_head(5, 1, {}, rgb.size()) + rgb);
    }
    rawm.send("{\"op\":\"status\"}");
    r.pump(100);
    const std::string said = rawm.events();
    ok("a short mesh message is refused", said.find("this mesh is") != std::string::npos);
    ok("unknown mask bits are refused", said.find("mask bits") != std::string::npos);
    ok("too many vertices are refused", said.find("1 to 65535 vertices") != std::string::npos);
    ok("indices that are not whole triangles are refused", said.find("whole triangles") != std::string::npos);
    ok("an index past the vertices is refused", said.find("past its vertices") != std::string::npos);
    ok("a value that is not finite is refused", said.find("must be finite") != std::string::npos);
    ok("a header too short is refused", said.find("header is 17 bytes") != std::string::npos);
    ok("geometry for no layer is refused", said.find("no such layer") != std::string::npos);
    ok("a part's geometry replaced within a second is refused", said.find("once a second") != std::string::npos);
    ok("keys out of order or of the wrong width are refused",
       said.find("keys are t:v") != std::string::npos && said.find("3 values") != std::string::npos);
    ok("a uniform of part elements is refused", said.find("whole elements") != std::string::npos);
    ok("an asset too big is refused", said.find("w must be a number from 1 to 2048") != std::string::npos);
    ok("an etc2rgba asset not of 4x4 blocks is refused", said.find("multiples of 4") != std::string::npos);
    ok("its frames have no rects", said.find("sent whole, with no rects") != std::string::npos);
    ok("whole, it is taken, and status names it",
       said.find("sent once") == std::string::npos && said.find("etc2rgba 8x8") != std::string::npos);
    ok("an etc2rgb asset is taken whole at 8 bytes a block",
       said.find("etc2rgb 8x8") != std::string::npos && said.find("a whole asset is") == std::string::npos);
    ok("and the service still answers", said.find("\"ev\":\"status\"") != std::string::npos);
    {
        Rig r8;
        r8.sc.backend = "id8";
        r8.svc.reset();
        r8.start();
        Raw raw8(r8.path);
        raw8.send("{\"op\":\"hello\",\"app\":\"etc2\"}");
        raw8.send("{\"op\":\"asset\",\"ref\":1,\"target\":\"panel\",\"format\":\"etc2rgba\",\"w\":8,\"h\":8}");
        r8.pump(50);
        const std::string said8 = raw8.events();
        ok("iDrive 8 takes etc2rgba too", said8.find("\"ev\":\"error\"") == std::string::npos);
    }

    {
        /* The shared cap, steered by the governor, reaches every client. */
        Rig lr(6000 * 1024);
        cr::Client c("budget", lr.path);
        int budgets = 0;
        unsigned cap = 0;
        std::string why, status;
        c.on_budget = [&](unsigned kb, unsigned, const std::string &reason) {
            budgets++;
            cap = kb;
            why = reason;
        };
        c.on_status = [&](const std::string &t) { status = t; };
        lr.clients = {&c};
        lr.pump(50);
        ok("nothing barred: the status shows the configured ceiling",
           lr.svc->server().status_text(lr.now).find("upload: cap 6000 KB/s (ceiling 6000, floor 2000)") !=
               std::string::npos);
        lr.svc->compositor().governor().activity(lr.now);   /* evidence counts while writes go */
        lr.svc->compositor().governor().evidence(Evidence::Removal, lr.now);
        lr.pump(50);
        c.request_status();
        lr.pump(50);
        ok("the C++ client hears the cap at hello and when the governor lowers it, and gets the status",
           budgets == 2 && cap == 5500 && why.find("1 x scene removed") != std::string::npos &&
               status.find("upload: cap 5500 KB/s") != std::string::npos);
        ok("the status shows the run's ceiling once a removal barred a level",
           status.find("upload: cap 5500 KB/s (ceiling 5500, configured 6000, floor 2000)") !=
               std::string::npos);
    }

    {
        /* The remembered ceiling: the run starts there, the status shows it,
         * a removal lowers it and the 30 s before go to the log. */
        char tmpl[] = "/tmp/crs-ceiling.XXXXXX";
        const std::string dir = mkdtemp(tmpl) ? tmpl : "/tmp";
        const std::string file = dir + "/upload-ceiling";
        { std::ofstream(file) << "ceiling_kb 5000\nclean_runs 1\n"; }
        Rig lr(6000 * 1024);
        lr.sc.ceiling.path = file;
        lr.svc.reset();
        lr.start();
        lr.pump(50);
        const std::string st = lr.svc->server().status_text(lr.now);
        ok("a remembered 5000 under a configured 6000: the run starts at it, the status says so",
           lr.svc->compositor().governor().cap() == 5000u * 1024 &&
               st.find("upload: cap 5000 KB/s (ceiling 5000, configured 6000, floor 2000): remembered ceiling\n"
                       "upload ceiling: 5000 KB/s remembered, 1 of 3 clean runs before a probe\n") != std::string::npos);
        lr.pump(2000);
        uint64_t seq = 0;
        std::vector<std::string> lines;
        cld::log_lines_since(&seq, &lines);
        lr.svc->compositor().governor().activity(lr.now);
        lr.svc->compositor().governor().evidence(Evidence::Removal, lr.now);
        lr.svc->slots().on_evidence(Evidence::Removal, "map: taken: fetch removed", lr.now);
        lr.pump(1100);
        lines.clear();
        cld::log_lines_since(&seq, &lines);
        bool trace = false;
        for (const std::string &l : lines)
            trace = trace || l.find("upload: the ") != std::string::npos;
        std::ifstream in(file);
        std::string first;
        std::getline(in, first);
        ok("a removal at 5000: the 30 s before logged, 4500 remembered", trace && first == "ceiling_kb 4500");
        lr.svc.reset();
        if (std::system(("rm -rf " + dir).c_str()) != 0)
            std::printf("cleanup failed\n");
    }

    std::string text = r.svc->server().status_text(r.now);
    ok("the status names the targets and the layers",
       text.find("target map") != std::string::npos && text.find("image of overlay") != std::string::npos);
    take_over_and_fall_back();
    guide_hold();
    guide_hold_choice();
    hud_yield_choice();
    display_drops();
    repeats();
    framing();
    scene_files();
    layers_and_hosting();
    hosting_from_layers();
    hosting_from_layers_more();
    preload();
    others_fps();
    render_state_and_samplers();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
