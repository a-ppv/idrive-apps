/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for hidden tiles (occlusion.h, video_layer.h, compositor.h) on
 * the fake renderer:
 * - the coverage's cells and a tile's footprint: luma, chroma, straddling
 *   rows, scaled;
 * - tiles wholly under an opaque camera are not written while hidden: the
 *   buffer keeps an older frame there, the rest is the newest;
 * - nothing is hidden under a translucent, turned or scaled-turned camera,
 *   an effect layer, an image with a transparent pixel there, an animated
 *   image, or an image whose waiting pixels are transparent;
 * - with a camera, an image, a fade, a composite occluded and a composite
 *   occluding moved, hidden, shown, made translucent and turned by sets,
 *   faster than a tight budget writes, with refused flushes and writes, and
 *   with packed blocks: no flush ever shows a part of the map that is not
 *   from the frame the rest of it shows (the check is the test's own, from
 *   what the display shows: every visible luma pixel, and every chroma
 *   sample that reaches one);
 * - the map panning past the budget on its target (and after resent's
 *   whole-scene charge) while an image over a panel video moves and hides:
 *   the panel's effect flushes every tick, the image's change waits only
 *   until the budget's debt is repaid, and nothing stale shows;
 * - a hidden tile changed within the threshold: a scene published again
 *   starts from the newest frame there;
 * - with no opaque layer over a video, everything the renderer gets is
 *   what the build before hidden tiles sent (video_trace.h: a camera at 0.9
 *   or turned over the map, Waze on the cluster and the HUD, the map under
 *   an overlay with transparent pixels);
 * - bytes a minute, Waze-like, with and without the feature: an opaque
 *   camera, one at 0.9, a moving one (printed; the 0.9 one equal);
 * - the cost of the coverage test a tick (printed). */
#include <time.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../kit/yuv_atlas.h"
#include "../src/compositor.h"
#include "../src/occlusion.h"
#include "../src/video_composite.h"
#include "fake_graph.h"
#include "video_trace.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

struct NullPort : Port {
    bool available() const override { return true; }
    void request(const TargetSpec &) override {}
    void release(const TargetSpec &) override {}
    void take_over(const TargetSpec &, uint64_t) override {}
    void refresh_slots() override {}
};

static const uint32_t W = 1088, H = 480;

static Rect R(int x, int y, uint32_t w, uint32_t h)
{
    Rect r;
    r.x = x; r.y = y; r.w = w; r.h = h;
    return r;
}

struct Rig {
    NullPort port;
    FakeGpu gpu;
    SlotManager slots{&port, nullptr};
    std::unique_ptr<Compositor> comp;
    int64_t now = 50000;
    int map = 0, panel = 1;

    explicit Rig(uint64_t budget = 0, uint32_t videos = 2, int fade_ms = 0)
    {
        const struct { const char *name; uint64_t slot, scene; uint32_t w, h; } t[] = {
            {"map", 0x100, 0x010004f0, W, H}, {"panel", 0x203, 0x01000400, 1920, 720}};
        for (const auto &x : t) {
            TargetSpec s;
            s.name = x.name; s.slot = x.slot; s.scene_id = x.scene; s.width = x.w; s.height = x.h; s.linger_ms = 2000;
            slots.add(s);
        }
        GovernorConfig gc;
        gc.max_bps = budget;
        gc.floor_bps = budget / 3;
        CompositorLimits lim;
        lim.videos = videos;
        comp.reset(new Compositor(&gpu, &slots, gc, 250, lim));
        comp->set_fade_ms(fade_ms);
        slots.set_scenes(comp.get());
        std::string err;
        if (!comp->init(&err))
            std::printf("init: %s\n", err.c_str());
    }
    ~Rig() { comp.reset(); }
    void step(int64_t ms = 1)
    {
        now += ms;
        comp->arrange(now);
        slots.tick(now);
        comp->render(now);
    }
    void run(int64_t ms)
    {
        for (int64_t t = 0; t < ms; t++)
            step(1);
    }
    void show(const char *target)
    {
        step(1);
        slots.on_shown(slots.targets()[slots.index(target)].scene_id, now);
        step(1);
    }
    FakeGraph *g(const char *t) { return gpu.graph(t); }
    VideoLayer *video(uint64_t owner, int target, Rect r, uint32_t w, uint32_t h, int z = 0, float opacity = 1.0f,
                      VideoParams vp = VideoParams())
    {
        LayerParams lp;
        lp.rect = r;
        lp.opacity = opacity;
        lp.z = z;
        lp.contend = true;
        vp.w = w;
        vp.h = h;
        std::string err;
        const uint32_t id = comp->add_video(owner, target, lp, vp, now, &err);
        if (!id)
            std::printf("video: %s\n", err.c_str());
        return id ? static_cast<VideoLayer *>(comp->layer(owner, id)) : nullptr;
    }
    ImageLayer *image(uint64_t owner, int target, Rect r, uint32_t w, uint32_t h, uint32_t fps = 30)
    {
        LayerParams lp;
        lp.rect = r;
        lp.klass = Klass::Overlay;
        std::string err;
        const uint32_t id = comp->add_image(owner, target, lp, w, h, fps, Sampling::Bilinear, now, &err);
        return id ? static_cast<ImageLayer *>(comp->layer(owner, id)) : nullptr;
    }
};

static VideoParams exact(bool blocks = false)
{
    VideoParams vp;
    vp.level_bits = 0;
    vp.dirty_threshold = 0;
    vp.pan_blocks = blocks;
    return vp;
}

/* Frame k of a w x h video in which every pixel changes each frame, and
 * from which a pixel's k (mod 256) can be read back. */
static uint8_t luma(uint32_t x, uint32_t y, int k) { return (uint8_t)(x + 2 * y + (uint32_t)k); }
static uint8_t chroma(uint32_t c, uint32_t r, int plane, int k) { return (uint8_t)(c + 3 * r + 100 * plane + (uint32_t)k); }
static std::vector<uint8_t> counting(uint32_t w, uint32_t h, int k)
{
    std::vector<uint8_t> f((size_t)w * crk::atlas_height(h));
    for (uint32_t y = 0; y < h; y++)
        for (uint32_t x = 0; x < w; x++)
            f[(size_t)y * w + x] = luma(x, y, k);
    for (uint32_t r = 0; r < h / 2; r++)
        for (int p = 0; p < 2; p++)
            for (uint32_t c = 0; c < w / 2; c++)
                f[(size_t)(h + r) * w + p * (w / 2) + c] = chroma(c, r, p, k);
    return f;
}

/* A still w x h atlas. */
static std::vector<uint8_t> still(uint32_t w, uint32_t h, int seed)
{
    std::vector<uint8_t> f((size_t)w * crk::atlas_height(h));
    for (size_t i = 0; i < f.size(); i++)
        f[i] = (uint8_t)(i * 7 + (size_t)seed * 31);
    return f;
}

/* ---- the display as shown: what of a video can be seen ------------------- */

static bool unturned_quad(const FakeQuad &q) { return q.turn.rotate == 0 && q.turn.sx == 1 && q.turn.sy == 1; }

static float opacity_of(const FakeQuad &q)
{
    auto it = q.uniforms.find("u_opacity");
    return it == q.uniforms.end() ? 1.0f : it->second[0];
}

/* Target pixels drawn opaquely by the shown quads above order: videos'
 * and composites' quads (they sample an R8 atlas or packed blocks, u_size
 * set) over their rect at u_opacity 1, images' (RGBA8 buffer, no u_size)
 * where its texel is opaque, drawn at its size. */
static std::vector<uint8_t> covered(const FakeGraph *g, uint32_t tw, uint32_t th, int32_t order)
{
    std::vector<uint8_t> c((size_t)tw * th, 0);
    for (const auto &kv : g->shown.quads) {
        const FakeQuad &q = kv.second;
        if (!q.visible || q.order <= order || opacity_of(q) < 1.0f || !unturned_quad(q))
            continue;
        auto t = q.textures.find("u_image");
        if (t == q.textures.end() || !g->shown.buffers.count(t->second))
            continue;
        const FakeBuffer &b = g->shown.buffers.at(t->second);
        const bool image = b.f == TexFormat::RGBA8 && !q.uniforms.count("u_size");
        if (image && (b.w != q.r.w || b.h != q.r.h))
            continue;
        for (uint32_t y = 0; y < q.r.h; y++)
            for (uint32_t x = 0; x < q.r.w; x++) {
                const int32_t X = q.r.x + (int32_t)x, Y = q.r.y + (int32_t)y;
                if (X < 0 || Y < 0 || X >= (int32_t)tw || Y >= (int32_t)th)
                    continue;
                if (image && b.px[((size_t)y * b.w + x) * 4 + 3] != 255)
                    continue;
                c[(size_t)Y * tw + X] = 1;
            }
    }
    return c;
}

/* A video of vw x vh counting() frames as the display shows it: through
 * its own quad (u_size vw x vh) or a composite's (u_view vw x vh). Whether
 * its atlas quad shows; then *k the one frame every seen luma pixel and
 * chroma sample of it holds, or *k -1 when they hold different frames. */
struct Look {
    bool shown = false;
    int k = -1;
    int frames = 0;   /* how many different frames were seen (1: consistent) */
};

static Look look(const FakeGraph *g, uint32_t tw, uint32_t th, uint32_t vw, uint32_t vh)
{
    Look out;
    const FakeQuad *q = nullptr;
    int32_t ox = 0, oy = 0;
    for (const auto &kv : g->shown.quads) {
        const FakeQuad &c = kv.second;
        if (!c.visible || opacity_of(c) <= 0.0f)
            continue;
        auto t = c.textures.find("u_image");
        if (t == c.textures.end() || !g->shown.buffers.count(t->second) ||
            g->shown.buffers.at(t->second).f != TexFormat::R8)
            continue;
        auto view = c.uniforms.find("u_view");
        if (view != c.uniforms.end()) {
            if ((uint32_t)view->second[2] != vw || (uint32_t)view->second[3] != vh)
                continue;
            ox = (int32_t)view->second[0];
            oy = (int32_t)view->second[1];
        } else {
            const std::vector<float> &s = c.uniforms.at("u_size");
            if ((uint32_t)s[0] != vw || (uint32_t)s[1] != vh)
                continue;
            ox = oy = 0;
        }
        q = &c;
    }
    if (!q)
        return out;
    out.shown = true;
    const FakeBuffer &a = g->shown.buffers.at(q->textures.at("u_image"));
    const uint32_t aw = a.w, ah = a.h * 2 / 3;   /* the atlas's frame (or canvas) size */
    const std::vector<uint8_t> cov = covered(g, tw, th, q->order);
    const Rect &r = q->r;
    /* Seen target pixels of the quad, in frame pixels: [sx0, sx1) of frame
     * pixel x across (scaled: a pixel more each way). */
    auto seen = [&](int32_t x0, int32_t y0, int32_t x1, int32_t y1) {
        const int64_t X0 = r.x + (int64_t)x0 * r.w / vw - (r.w != vw), X1 = r.x + ((int64_t)x1 * r.w + vw - 1) / vw + (r.w != vw);
        const int64_t Y0 = r.y + (int64_t)y0 * r.h / vh - (r.h != vh), Y1 = r.y + ((int64_t)y1 * r.h + vh - 1) / vh + (r.h != vh);
        for (int64_t Y = std::max<int64_t>(Y0, std::max<int64_t>(r.y, 0)); Y < std::min<int64_t>(Y1, std::min<int64_t>(r.y + r.h, th)); Y++)
            for (int64_t X = std::max<int64_t>(X0, std::max<int64_t>(r.x, 0)); X < std::min<int64_t>(X1, std::min<int64_t>(r.x + r.w, tw)); X++)
                if (!cov[(size_t)Y * tw + X])
                    return true;
        return false;
    };
    bool got[256] = {};
    auto saw = [&](int k) {
        k &= 255;
        if (!got[k]) {
            got[k] = true;
            out.frames++;
            out.k = k;
        }
    };
    for (uint32_t y = 0; y < vh; y++)
        for (uint32_t x = 0; x < vw; x++)
            if (seen((int32_t)x, (int32_t)y, (int32_t)x + 1, (int32_t)y + 1))
                saw(a.px[(size_t)(oy + y) * aw + ox + x] - luma(x, y, 0));
    for (uint32_t rr = 0; rr < vh / 2; rr++)
        for (uint32_t c = 0; c < vw / 2; c++)
            if (seen(2 * (int32_t)c - 2, 2 * (int32_t)rr - 1, 2 * (int32_t)c + 2, 2 * (int32_t)rr + 3))
                for (int p = 0; p < 2; p++)
                    saw(a.px[(size_t)(ah + oy / 2 + rr) * aw + p * (aw / 2) + ox / 2 + c] - chroma(c, rr, p, 0));
    if (out.frames != 1)
        out.k = -1;
    return out;
}

/* ---- the cells and the footprints ----------------------------------------- */

static void cells()
{
    Coverage c;
    c.reset(W, H);
    ok("coverage: empty covers nothing", c.empty() && !c.covers(Box{0, 0, 8, 8}));
    c.add(Box{13, 13, 77, 77});
    ok("coverage: only cells wholly inside a rect are covered",
       c.covers(Box{16, 16, 72, 72}) && !c.covers(Box{13, 13, 20, 20}) && !c.covers(Box{16, 16, 73, 72}));
    c.add(Box{72, 16, 200, 72});
    ok("coverage: two rects side by side cover across their seam", c.covers(Box{16, 16, 200, 72}));
    ok("coverage: nothing off the target is covered", !c.covers(Box{-8, 16, 8, 24}));
    c.reset(W, H);
    ok("coverage: reset clears it", c.empty() && !c.covers(Box{16, 16, 24, 24}));
    c.add_if(Box{0, 0, 64, 64}, [](const Box &b) { return b.x0 >= 32; });
    ok("coverage: add_if takes the cells it is told", c.covers(Box{32, 0, 64, 64}) && !c.covers(Box{24, 0, 33, 8}));

    Box b[3];
    int n = tile_footprint(1, 1, W, H, R(0, 0, W, H), b);
    ok("footprint: a luma tile drawn at its size is its own pixels",
       n == 1 && b[0].x0 == 64 && b[0].y0 == 64 && b[0].x1 == 128 && b[0].y1 == 128);
    n = tile_footprint(1, 1, W, H, R(100, 50, W, H), b);
    ok("footprint: placed", n == 1 && b[0].x0 == 164 && b[0].y0 == 114 && b[0].x1 == 228 && b[0].y1 == 178);
    /* Row 7 (atlas rows 448-511): luma rows 448-479 and chroma rows 0-31;
     * column 8 (atlas columns 512-575) holds U 512-543 and V 0-31. */
    n = tile_footprint(8, 7, W, H, R(0, 0, W, H), b);
    ok("footprint: a tile over luma and both chroma planes has three parts",
       n == 3 && b[0].y0 == 448 && b[0].y1 == 480 && b[1].x0 == 1022 && b[1].x1 == 1088 && b[1].y0 == 0 &&
           b[1].y1 == 65 && b[2].x0 == 0 && b[2].x1 == 64);
    n = tile_footprint(3, 8, W, H, R(0, 0, W, H), b);
    ok("footprint: a chroma tile reaches the luma pixels its samples are read for",
       n == 1 && b[0].x0 == 382 && b[0].x1 == 512 && b[0].y0 == 63 && b[0].y1 == 193);
    n = tile_footprint(1, 1, W / 2, H / 2, R(0, 0, W, H), b);
    ok("footprint: scaled twice, wider for the filter",
       n == 1 && b[0].x0 <= 125 && b[0].x1 >= 259 && b[0].x0 >= 120 && b[0].x1 <= 264);
}

/* ---- tiles left unwritten --------------------------------------------------- */

static size_t hidden_count(const VideoLayer *v)
{
    const uint8_t *m = v->hidden_mask();
    if (!m)
        return 0;
    const size_t tiles = (size_t)((v->video().w + 63) / 64) * ((crk::atlas_height(v->video().h) + 63) / 64);
    return (size_t)std::count(m, m + tiles, 1);
}

static void skipped()
{
    Rig r;
    VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0, 1.0f, exact());
    VideoLayer *c = r.video(2, r.map, R(704, 64, 320, 240), 320, 240, 1, 1.0f, exact());
    m->offer(counting(W, H, 0).data(), r.now);
    c->offer(still(320, 240, 1).data(), r.now);
    r.show("map");
    r.run(100);
    char name[200];
    std::snprintf(name, sizeof name, "an opaque 320x240 camera at 704,64 hides 15 of the map's 204 tiles (%zu)",
                  hidden_count(m));
    ok(name, hidden_count(m) == 15);
    for (int k = 1; k <= 20; k++) {
        m->offer(counting(W, H, k).data(), r.now);
        r.run(34);
    }
    const Look l = look(r.g("map"), W, H, W, H);
    /* Under the camera the buffer keeps the frame of before. */
    const FakeBuffer *a = nullptr;
    for (const auto &kv : r.g("map")->shown.buffers)
        if (kv.second.f == TexFormat::R8 && kv.second.w == W)
            a = &kv.second;
    const int under = a ? (a->px[(size_t)160 * W + 800] - luma(800, 160, 0)) & 255 : -1;
    std::snprintf(name, sizeof name,
                  "tiles under it are not written: what shows is frame %d, under the camera frame %d", l.k, under);
    ok(name, l.frames == 1 && l.k == 20 && under == 0);
    ok("its status counts them", m->stats().find("tiles left hidden") != std::string::npos);
}

/* What hides the map's tiles and what does not. */
static void opaque_rules()
{
    struct Case {
        const char *name;
        float opacity, rotate, sx;
        bool hides;
    } cases[] = {
        {"an opaque camera hides the tiles under it", 1.0f, 0, 1, true},
        {"a camera at 0.9 hides nothing", 0.9f, 0, 1, false},
        {"a camera turned 1 degree hides nothing", 1.0f, 1, 1, false},
        {"a camera scaled by its turn hides nothing", 1.0f, 0, 1.05f, false},
    };
    for (const Case &k : cases) {
        Rig r;
        VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0);
        VideoLayer *c = r.video(2, r.map, R(704, 64, 320, 240), 320, 240, 1, k.opacity);
        c->params.rotate = k.rotate;
        c->params.sx = k.sx;
        r.comp->changed(c);
        m->offer(counting(W, H, 0).data(), r.now);
        c->offer(still(320, 240, 1).data(), r.now);
        r.show("map");
        r.run(100);
        ok(k.name, (hidden_count(m) > 0) == k.hides);
    }
    {
        Rig r;
        VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0);
        LayerParams lp;
        lp.rect = R(704, 64, 320, 240);
        lp.klass = Klass::Overlay;
        std::string err;
        r.comp->add_effect(2, r.map, lp, kQuadVertexShader,
                           "#version 100\nprecision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }", 0,
                           r.now, &err);
        m->offer(counting(W, H, 0).data(), r.now);
        r.show("map");
        r.run(100);
        ok("an effect layer hides nothing, whatever it draws", hidden_count(m) == 0);
    }
    {
        Rig r;
        VideoLayer *c = r.video(2, r.map, R(704, 64, 320, 240), 320, 240, 1);
        VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0);
        m->offer(counting(W, H, 0).data(), r.now);
        r.show("map");
        r.run(100);
        ok("a camera with no frame yet (drawn at opacity 0) hides nothing", hidden_count(m) == 0);
        c->offer(still(320, 240, 1).data(), r.now);
        r.run(100);
        ok("once its first frame is written it does", hidden_count(m) == 15);
    }
    /* Images: opaque where every pixel the filter reads has alpha 255, in
     * what the buffer holds and in what waits to be written. */
    std::vector<uint8_t> px((size_t)320 * 240 * 4, 255);
    Rig r;
    VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0);
    ImageLayer *img = r.image(2, r.map, R(704, 64, 320, 240), 320, 240, 30);
    std::string err;
    img->update({}, px.data(), px.size(), &err);
    m->offer(counting(W, H, 0).data(), r.now);
    r.show("map");
    r.run(100);
    ok("an opaque image hides the tiles under it as a camera does", hidden_count(m) == 15);
    /* A transparent 8x8 block at image 100,50: target 804,114, map tile
     * (12, 1); the tile at (13, 2) stays hidden. */
    const size_t t12_1 = 1 * 17 + 12, t13_2 = 2 * 17 + 13;
    std::vector<uint8_t> hole((size_t)8 * 8 * 4, 0);
    img->update({crk::PixelRect{100, 50, 8, 8}}, hole.data(), hole.size(), &err);
    r.step(1);
    ok("pixels waiting to be written with alpha 0 count at once: their tile shows",
       m->hidden_mask() && !m->hidden_mask()[t12_1] && m->hidden_mask()[t13_2]);
    r.run(100);
    ok("and once written", m->hidden_mask() && !m->hidden_mask()[t12_1] && m->hidden_mask()[t13_2]);
    std::vector<uint8_t> solid((size_t)8 * 8 * 4, 255);
    img->update({crk::PixelRect{100, 50, 8, 8}}, solid.data(), solid.size(), &err);
    r.step(1);
    ok("opaque pixels waiting to be written over transparent ones do not count until written",
       m->hidden_mask() && !m->hidden_mask()[t12_1]);
    r.run(100);
    ok("once written they do", m->hidden_mask() && m->hidden_mask()[t12_1]);
    for (size_t i = 3; i < px.size(); i += 4)
        px[i] = 254;
    img->update({}, px.data(), px.size(), &err);
    r.run(100);
    ok("an image at alpha 254 hides nothing", hidden_count(m) == 0);
    for (size_t i = 3; i < px.size(); i += 4)
        px[i] = 255;
    img->update({}, px.data(), px.size(), &err);
    r.run(100);
    Animation a;
    a.property = Animated::Translate;
    a.width = 3;
    a.t = {0, 1000};
    a.v = {0, 0, 0, 100, 0, 0};
    img->animate(1, 0, a, &err);
    r.step(1);
    ok("an animated image hides nothing", hidden_count(m) == 0);
    img->stop(1);
    img->params.opacity = 0.99f;
    r.comp->changed(img);
    r.step(1);
    ok("an image at 0.99 hides nothing", hidden_count(m) == 0);
    img->params.opacity = 1.0f;
    img->params.rect = R(704, 64, 400, 300);
    r.comp->changed(img);
    r.step(1);
    ok("a scaled opaque image hides what it covers", hidden_count(m) > 15);
}

/* ---- never stale ----------------------------------------------------------- */

enum class Over { Camera, Image, Blocks, Fade };

/* The map (counting frames every 33 ms, exact) under a 320x240 camera or
 * image moved every 37 ms to places on and off the tile grid and partly off
 * the target, hidden and shown, made translucent and opaque again, turned
 * and back, the target faded out and in (Fade), with refused flushes and a
 * refused write, on a budget the writes outrun: after every flush, every
 * part of the map that shows holds one frame. */
static void never_stale(Over over)
{
    Rig r(over == Over::Blocks ? 3000 * 1024 : 1500 * 1024, 2, over == Over::Fade ? 300 : 0);
    VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0, 1.0f, exact(over == Over::Blocks));
    Layer *top = nullptr;
    VideoLayer *cam = nullptr;
    ImageLayer *img = nullptr;
    std::string err;
    if (over == Over::Image) {
        img = r.image(2, r.map, R(64, 64, 320, 240), 320, 240, 30);
        std::vector<uint8_t> px((size_t)320 * 240 * 4, 255);
        img->update({}, px.data(), px.size(), &err);
        top = img;
    } else {
        cam = r.video(2, r.map, R(64, 64, 320, 240), 320, 240, 1, 1.0f, exact());
        cam->offer(still(320, 240, 3).data(), r.now);
        top = cam;
    }
    int k = 0;
    m->offer(counting(W, H, k).data(), r.now);
    r.show("map");
    r.run(500);
    FakeGraph *g = r.g("map");
    const int xs[] = {64, 704, 768, 320, 900, 66, 512, -40};
    const int ys[] = {64, 0, 192, 300, 63};
    int flushes = 0, checked = 0, stale = 0, newest = -1;
    for (int t = 0; t < 7000; t++) {
        /* With packed blocks, a pause every 1.2 s lets the exact atlas back. */
        if (t % 33 == 0 && (over != Over::Blocks || t % 1000 < 500)) {
            m->offer(counting(W, H, ++k).data(), r.now);
            if (cam)
                cam->repeat(r.now);
        }
        if (t % 37 == 0 && t < 6000) {
            top->params.rect.x = xs[(t / 37) % 8];
            top->params.rect.y = ys[(t / 37) % 5];
            r.comp->changed(top);
        }
        if (t == 1500 || t == 2000) {
            top->params.visible = t == 2000;
            r.comp->changed(top);
        }
        if (t == 2500 || t == 2800) {
            top->params.opacity = t == 2500 ? 0.9f : 1.0f;
            r.comp->changed(top);
        }
        if (t == 3100 || t == 3400) {
            top->params.rotate = t == 3100 ? 2.0f : 0.0f;
            r.comp->changed(top);
        }
        if (over == Over::Image && t == 3600) {
            /* Transparent pixels in the middle of it. */
            std::vector<uint8_t> hole((size_t)64 * 64 * 4, 0);
            img->update({crk::PixelRect{128, 96, 64, 64}}, hole.data(), hole.size(), &err);
        }
        if (over == Over::Fade && (t == 4300 || t == 5000)) {
            m->params.visible = top->params.visible = t == 5000;
            r.comp->changed(m);
            r.comp->changed(top);
        }
        g->fail_flush = t >= 3700 && t < 3760;
        if (t == 4000)
            g->write_budget = (long)g->written + 30000;
        if (t == 4100)
            g->write_budget = -1;
        const uint64_t f0 = g->flushes;
        r.step(1);
        if (g->flushes == f0)
            continue;
        flushes++;
        const Look l = look(g, W, H, W, H);
        if (!l.shown)
            continue;
        checked++;
        if (l.frames != 1)
            stale++;
        newest = std::max(newest, l.k);
    }
    const char *names[] = {"a camera", "an image", "a camera, the map with packed blocks", "a camera, faded out and in"};
    char name[300];
    std::snprintf(name, sizeof name,
                  "%s over the map moved every 37 ms, hidden, shown, translucent, turned, flushes and a write refused: "
                  "in %d flushes (%d checked) no part of the map shown from another frame (%d)",
                  names[(int)over], flushes, checked, stale);
    ok(name, stale == 0 && checked > 20);
    const std::string st = m->stats();
    if (over == Over::Blocks) {
        std::snprintf(name, sizeof name, "  and the map went packed and back to exact (frame %d of %d shown)", newest,
                      k & 255);
        ok(name, newest >= 0 && st.find(" 0 packed") == std::string::npos &&
                     st.find(" 0 back to exact") == std::string::npos && st.find("tiles left hidden") != std::string::npos);
        return;
    }
    std::snprintf(name, sizeof name, "  and the map kept up (frame %d of %d shown), hidden tiles used and uncovered",
                  newest, k & 255);
    ok(name, newest >= 0 && st.find("tiles left hidden") != std::string::npos &&
                 st.find(", 0 uncovered") == std::string::npos);
}

/* A composite (on a display holding one video's buffers) of a 768x480 map
 * and a camera beside it, under an opaque image moved about, hidden and
 * shown: the map's part of the canvas that shows always holds one frame.
 * (Beside, not over: where sources overlap, the lower one's chroma near the
 * edge is drawn from the upper one's part of the canvas, whatever is
 * hidden.) */
static void composite_occluded()
{
    const uint32_t MW = 768;
    Rig r(1500 * 1024, 1);
    VideoLayer *m = r.video(1, r.map, R(0, 0, MW, H), MW, H, 0, 1.0f, exact());
    VideoLayer *c = r.video(2, r.map, R(768, 64, 320, 240), 320, 240, 1, 1.0f, exact());
    ImageLayer *img = r.image(3, r.map, R(64, 64, 320, 240), 320, 240, 30);
    std::string err;
    std::vector<uint8_t> px((size_t)320 * 240 * 4, 255);
    img->update({}, px.data(), px.size(), &err);
    int k = 0;
    m->offer(counting(MW, H, k).data(), r.now);
    c->offer(still(320, 240, 3).data(), r.now);
    r.show("map");
    r.run(500);
    FakeGraph *g = r.g("map");
    const CompositeVideo *cv = r.comp->composite(r.map);
    const int xs[] = {64, 512, 768, 320, 0, 600};
    int checked = 0, stale = 0, hid = 0, newest = -1;
    for (int t = 0; t < 5000; t++) {
        if (t % 33 == 0) {
            m->offer(counting(MW, H, ++k).data(), r.now);
            c->repeat(r.now);
        }
        if (t % 41 == 0 && t < 4000) {
            img->params.rect.x = xs[(t / 41) % 6];
            img->params.rect.y = 64 + (t / 41) % 3 * 64;
            r.comp->changed(img);
        }
        if (t == 2000 || t == 2300) {
            img->params.visible = t == 2300;
            r.comp->changed(img);
        }
        g->fail_flush = t >= 2700 && t < 2760;
        const uint64_t f0 = g->flushes;
        r.step(1);
        if (cv && cv->hidden_mask())
            hid++;
        if (g->flushes == f0)
            continue;
        const Look l = look(g, W, H, MW, H);
        if (!l.shown)
            continue;
        checked++;
        stale += l.frames != 1;
        newest = std::max(newest, l.k);
    }
    char name[260];
    std::snprintf(name, sizeof name,
                  "a composite under an opaque image moved about: canvas tiles hidden in %d ticks, in %d checked "
                  "flushes no part of the map from another frame (%d)",
                  hid, checked, stale);
    ok(name, cv && hid > 1000 && checked > 20 && stale == 0 && newest >= 0);
}

/* A scaled map (544x240 frames over 1088x480: buffers of its own) under two
 * cameras its target composites: the composite's quads hide the map's
 * tiles, and a camera moved (its quads moving only with the canvas write)
 * never shows the map from another frame where it was. */
static void composite_occluding()
{
    Rig r(1500 * 1024);
    VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W / 2, H / 2, 0, 1.0f, exact());
    VideoLayer *a = r.video(2, r.map, R(64, 64, 320, 240), 320, 240, 1, 1.0f, exact());
    VideoLayer *b = r.video(3, r.map, R(704, 160, 320, 240), 320, 240, 2, 1.0f, exact());
    int k = 0;
    m->offer(counting(W / 2, H / 2, k).data(), r.now);
    a->offer(still(320, 240, 3).data(), r.now);
    b->offer(still(320, 240, 4).data(), r.now);
    r.show("map");
    r.run(500);
    FakeGraph *g = r.g("map");
    const int xs[] = {64, 384, 704, 128, 512};
    int checked = 0, stale = 0, hid = 0;
    for (int t = 0; t < 5000; t++) {
        if (t % 33 == 0) {
            m->offer(counting(W / 2, H / 2, ++k).data(), r.now);
            a->repeat(r.now);
            b->repeat(r.now);
        }
        if (t % 53 == 0 && t < 4000) {
            a->params.rect.x = xs[(t / 53) % 5];
            r.comp->changed(a);
        }
        if (t == 2000 || t == 2400) {
            b->params.visible = t == 2400;
            r.comp->changed(b);
        }
        const uint64_t f0 = g->flushes;
        r.step(1);
        hid += m->hidden_mask() != nullptr;
        if (g->flushes == f0)
            continue;
        const Look l = look(g, W, H, W / 2, H / 2);
        if (!l.shown)
            continue;
        checked++;
        stale += l.frames != 1;
    }
    char name[260];
    std::snprintf(name, sizeof name,
                  "a scaled map under two composited cameras, one moved: the map's tiles hidden in %d ticks, in %d "
                  "checked flushes none of it shown from another frame (%d)",
                  hid, checked, stale);
    ok(name, r.comp->composite(r.map) && hid > 1000 && checked > 50 && stale == 0);
}

/* ---- an uncover waiting for the budget ------------------------------------ */

static const char *const kClockFs =
    "#version 100\nprecision mediump float;\nuniform float u_time;\n"
    "void main() { gl_FragColor = vec4(fract(u_time), 0.0, 0.0, 1.0); }";

/* The map panning past the 5500 KB/s budget on map, and on the panel a
 * video (counting frames) under an opaque image moved or hidden every 300
 * ms, beside an effect whose u_time the service sets 30 times a second
 * (with resend, both scenes charged whole by resent() at 1.7 s, the map
 * paused before so that the panel video writes under the image). The
 * panel flushes as
 * often as its effect changes, the image's change shows once the panel
 * video's uncovered tiles are written, within the time the budget takes to
 * repay what it owes, and no panel flush shows part of the video from
 * another frame. */
static void uncover_waits(bool resend)
{
    Rig r(5500 * 1024);
    std::string err;
    LayerParams mp;
    mp.rect = R(0, 0, W, H);
    mp.contend = true;
    VideoParams mvp;
    VideoLayer *m = static_cast<VideoLayer *>(r.comp->layer(1, r.comp->add_video(1, r.map, mp, mvp, r.now, &err)));
    VideoLayer *p = r.video(2, r.panel, R(416, 120, W, H), W, H, 0, 1.0f, exact());
    ImageLayer *img = r.image(3, r.panel, R(800, 200, 320, 240), 320, 240, 30);
    std::vector<uint8_t> px((size_t)320 * 240 * 4, 255);
    img->update({}, px.data(), px.size(), &err);
    LayerParams ep;
    ep.rect = R(1600, 40, 200, 60);
    ep.klass = Klass::Overlay;
    const uint32_t eid = r.comp->add_effect(4, r.panel, ep, kQuadVertexShader, kClockFs, 30, r.now, &err);
    std::vector<uint8_t> f;
    int k = 0, pan = 0;
    trace_frame(f, W, H, pan, 0, 0);
    m->offer(f.data(), r.now);
    p->offer(counting(W, H, k).data(), r.now);
    r.show("map");
    r.show("panel");
    r.run(1000);
    FakeGraph *g = r.g("panel");
    int effect_quad = 0, image_quad = 0;
    for (const auto &kv : g->shown.quads) {
        if (kv.second.uniforms.count("u_time"))
            effect_quad = kv.first;
        auto t = kv.second.textures.find("u_image");
        if (t != kv.second.textures.end() && g->shown.buffers.count(t->second) &&
            g->shown.buffers.at(t->second).f == TexFormat::RGBA8 && !kv.second.uniforms.count("u_size"))
            image_quad = kv.first;
    }
    (void)eid;
    const int xs[] = {800, 512, 1200, 700, 960};
    int64_t last_time_change = r.now, longest_gap = 0, longest_wait = 0, waits = 0, landed = 0;
    float shown_time = -1;
    int checked = 0, stale = 0;
    int64_t asked = -1;
    Rect want = img->params.rect;
    bool want_visible = true;
    const uint64_t uncovers0 = 0;
    (void)uncovers0;
    for (int t = 0; t < 6000; t++) {
        if (t % 33 == 0) {
            /* With resend, the map pauses just before the charge, so the
             * panel video writes with tiles under the image. */
            if (!resend || t < 1500 || t >= 1700) {
                pan += 24;
                trace_frame(f, W, H, pan, 0, 0);
                m->offer(f.data(), r.now);
            }
            p->offer(counting(W, H, ++k).data(), r.now);
        }
        if (resend && t == 1700) {
            r.comp->resent(r.slots.targets()[r.map], r.now);
            r.comp->resent(r.slots.targets()[r.panel], r.now);
        }
        if (t % 300 == 150 && t < 5400) {
            if ((t / 300) % 4 == 3) {
                img->params.visible = !img->params.visible;
            } else {
                img->params.visible = true;
                img->params.rect.x = xs[(t / 300) % 5];
            }
            r.comp->changed(img);
            want = img->params.rect;
            want_visible = img->params.visible;
            asked = r.now;
        }
        const uint64_t f0 = g->flushes;
        r.step(1);
        if (g->flushes == f0)
            continue;
        const FakeQuad &e = g->shown.quads.at(effect_quad);
        if (e.uniforms.count("u_time") && e.uniforms.at("u_time")[0] != shown_time) {
            shown_time = e.uniforms.at("u_time")[0];
            longest_gap = std::max(longest_gap, r.now - last_time_change);
            last_time_change = r.now;
        }
        const FakeQuad &iq = g->shown.quads.at(image_quad);
        if (asked >= 0 && iq.visible == want_visible && (!want_visible || iq.r == want)) {
            longest_wait = std::max(longest_wait, r.now - asked);
            waits += r.now - asked > 1;
            landed++;
            asked = -1;
        }
        const Look l = look(g, 1920, 720, W, H);
        if (!l.shown)
            continue;
        checked++;
        stale += l.frames != 1;
    }
    longest_gap = std::max(longest_gap, r.now - last_time_change);
    char name[400];
    std::snprintf(name, sizeof name,
                  "the map panning past the budget%s: the panel's effect flushed at most %lld ms apart", 
                  resend ? ", after both scenes were charged whole (resent)" : "", (long long)longest_gap);
    ok(name, longest_gap <= 40);
    /* What the budget owes at most: a resent scene's buffers, or a packed
     * map frame and a panel frame written in one tick, repaid at 5500 KB/s. */
    const double owed = resend ? 2.0 * (783360 + 2 * 261120) + 783360 + 307200 : 783360.0 + 261120 + 783360;
    const double bound_ms = owed / (5500.0 * 1024) * 1000 + 34;
    std::snprintf(name, sizeof name,
                  "  the image's moves and hides over the panel video shown once its uncovered tiles were written: "
                  "%lld of %d waited, the longest %lld ms (what the budget owes, repaid: %.0f ms)",
                  (long long)waits, (int)landed, (long long)longest_wait, bound_ms);
    ok(name, landed >= 15 && waits > 0 && longest_wait <= bound_ms && longest_wait >= (resend ? 100 : 20));
    std::snprintf(name, sizeof name, "  in %d checked panel flushes no part of the video from another frame (%d)",
                  checked, stale);
    ok(name, checked > 50 && stale == 0);
}

/* A hidden tile changed within the threshold, then the scene taken down and
 * published again: the new scene's first write is the newest frame, that
 * tile included. */
static void quiet_hidden_reattach()
{
    Rig r;
    VideoParams vp = exact();
    vp.dirty_threshold = 8;
    VideoLayer *m = r.video(1, r.map, R(0, 0, W, H), W, H, 0, 1.0f, vp);
    VideoLayer *c = r.video(2, r.map, R(704, 64, 320, 240), 320, 240, 1, 1.0f, exact());
    std::vector<uint8_t> a = counting(W, H, 0), b = a;
    for (uint32_t y = 128; y < 192; y++)
        for (uint32_t x = 768; x < 832; x++)
            b[(size_t)y * W + x] += 4;
    m->offer(a.data(), r.now);
    c->offer(still(320, 240, 1).data(), r.now);
    r.show("map");
    r.run(200);
    m->offer(b.data(), r.now);
    r.run(200);
    const TargetSpec &spec = r.slots.targets()[r.map];
    r.comp->unpublish(spec);
    std::string err;
    r.comp->publish(spec, &err);
    r.run(300);
    const FakeBuffer *atlas = nullptr;
    for (const auto &kv : r.g("map")->shown.buffers)
        if (kv.second.f == TexFormat::R8 && kv.second.w == W)
            atlas = &kv.second;
    bool newest = atlas != nullptr;
    for (uint32_t y = 128; y < 192 && newest; y++)
        newest = !std::memcmp(&atlas->px[(size_t)y * W + 768], &b[(size_t)y * W + 768], 64);
    ok("a hidden tile changed within the threshold: a scene published again starts from the newest frame there",
       m->hidden_mask() && m->hidden_mask()[2 * 17 + 12] && newest);
}

/* ---- as before with nothing opaque over a video ----------------------------- */

/* Recorded with video_trace.h from the build before hidden tiles
 * (cluster-render-video-composite at 83a34d0): hash, calls, write bytes,
 * flushes, failed flushes, failed writes. */
static const uint64_t kBaseTranslucent[6] = {0x65f389e6faaa92beull, 3087, 40754688, 379, 4, 30};
static const uint64_t kBaseTurned[6] = {0xe3d2afd834497d9eull, 3087, 40754688, 379, 4, 30};
static const uint64_t kBaseHud[6] = {0xd034cccd82a2b14full, 1460, 30050304, 334, 0, 0};
static const uint64_t kBaseOverlay[6] = {0x02cf39cafba3de0eull, 726, 99647488, 168, 0, 0};
/* A minute (camera_minute_trace): kind 0, 1, 2. */
static const uint64_t kBaseMinute[3][6] = {
    {0x8c91ce7f810aafc2ull, 9278, 187145216, 1363, 0, 0},
    {0xa55b718dab651bb6ull, 9278, 187145216, 1363, 0, 0},
    {0x30ea992b354a52a2ull, 21242, 187145216, 2533, 0, 0},
};
/* The map's frames sent and bytes in those runs. */
static const uint64_t kBaseMinuteMap[2] = {896, 146554880};

static bool same(const Trace &t, const uint64_t v[6])
{
    return t.hash == v[0] && t.calls == v[1] && t.write_bytes == v[2] && t.flushes == v[3] &&
           t.failed_flushes == v[4] && t.failed_writes == v[5];
}

static void unchanged()
{
    struct {
        const char *name;
        Trace t;
        const uint64_t *v;
    } runs[] = {
        {"a camera at 0.9 over the map", two_video_trace(0, 0.9f), kBaseTranslucent},
        {"a camera turned 3 degrees over the map", two_video_trace(0, 1.0f, 3.0f), kBaseTurned},
        {"Waze on the cluster and the HUD", hud_trace(), kBaseHud},
        {"the map under an overlay with transparent pixels", overlay_trace(), kBaseOverlay},
    };
    for (const auto &x : runs) {
        char name[220];
        std::snprintf(name, sizeof name,
                      "%s: every renderer call, pixel and flush as before hidden tiles (%llu calls, %llu KB)", x.name,
                      (unsigned long long)x.t.calls, (unsigned long long)(x.t.write_bytes / 1024));
        ok(name, same(x.t, x.v));
    }
}

/* ---- what it saves ---------------------------------------------------------- */

static void minute()
{
    const char *names[] = {"an opaque camera", "a camera at 0.9", "an opaque camera sliding 4 px a frame"};
    for (int kind = 0; kind < 3; kind++) {
        const Trace t = camera_minute_trace(kind);
        const double mb = t.write_bytes / 1e6, base = kBaseMinute[kind][2] / 1e6;
        size_t up = t.video_stats.find(" uncovered");
        std::string uncovered = "0";
        if (up != std::string::npos) {
            size_t s = t.video_stats.rfind(' ', up - 1);
            uncovered = t.video_stats.substr(s + 1, up - s - 1);
        }
        char name[400];
        std::snprintf(name, sizeof name,
                      "a Waze-like map a minute under %s: %.1f MB written (before: %.1f MB, %+.1f %%); the map %llu "
                      "frames in %.1f MB (before: %llu in %.1f MB), %s written early for an uncover",
                      names[kind], mb, base, (mb - base) / base * 100, (unsigned long long)t.video.frames,
                      t.video.bytes / 1e6, (unsigned long long)kBaseMinuteMap[0], kBaseMinuteMap[1] / 1e6,
                      uncovered.c_str());
        ok(name, kind == 1 ? same(t, kBaseMinute[1]) : t.write_bytes < kBaseMinute[kind][2]);
        if (kind == 2) {
            std::snprintf(name, sizeof name, "  within the 5500 KB/s budget: %.0f KB/s", t.write_bytes / 1024.0 / 60);
            ok(name, t.write_bytes / 1024.0 / 60 <= 5500);
        }
    }
}

/* ---- cost -------------------------------------------------------------------- */

static double wall_ms()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void cost()
{
    /* A tick's coverage test for the map under a camera: the cells cleared,
     * the camera's added, the map's 204 tiles tested. */
    const int n = 20000;
    Coverage cov;
    std::vector<uint8_t> hidden;
    size_t any = 0;
    double w0 = wall_ms();
    for (int i = 0; i < n; i++) {
        cov.reset(W, H);
        cov.add(box_of(R(704, 64, 320, 240)));
        any += hidden_tiles(cov, W, H, R(0, 0, W, H), &hidden);
    }
    const double opaque = (wall_ms() - w0) / n;
    /* The camera image: its opaque blocks consulted cell by cell. */
    std::vector<uint8_t> blocks(40 * 30, 1);
    w0 = wall_ms();
    for (int i = 0; i < n; i++) {
        cov.reset(W, H);
        cov.add_if(box_of(R(704, 64, 320, 240)), [&](const Box &c) {
            for (int32_t by = (c.y0 - 64) / 8; by <= (c.y1 - 65) / 8; by++)
                for (int32_t bx = (c.x0 - 704) / 8; bx <= (c.x1 - 705) / 8; bx++)
                    if (!blocks[(size_t)by * 40 + bx])
                        return false;
            return true;
        });
        any += hidden_tiles(cov, W, H, R(0, 0, W, H), &hidden);
    }
    const double image = (wall_ms() - w0) / n;
    /* A composite of the map and a camera (its canvas 1088x480) under an
     * opaque image: the canvas's tiles tested for each source. */
    crk::UploadPacer pacer;
    VideoParams mp, cp;
    mp.w = W, mp.h = H, cp.w = 320, cp.h = 240;
    VideoLayer map(1, 0, 1, pacer, 0, 0, mp, 0), cam(2, 0, 2, pacer, 0, 0, cp, 0);
    map.params.rect = R(0, 0, W, H);
    cam.params.rect = R(704, 64, 320, 240);
    map.to_source();
    cam.to_source();
    CompositeVideo cv(0, pacer, 0, 0, mp, 0, 0, R(0, 0, W, H), 0);
    cv.add(1, &map);
    cv.add(2, &cam);
    cv.arrange_source(1, true, 0);
    cv.arrange_source(2, true, 4);
    w0 = wall_ms();
    for (int i = 0; i < n; i++) {
        cov.reset(W, H);
        cv.begin_hidden();
        cov.add(box_of(R(64, 64, 320, 240)));
        cv.see_source(2, cov);
        cv.see_source(1, cov);
        cv.end_hidden();
        any += cv.hidden_mask() != nullptr;
    }
    const double composite = (wall_ms() - w0) / n;
    char name[300];
    std::snprintf(name, sizeof name,
                  "cost of the coverage test a tick, the map under a camera: %.4f ms (%.2f ms a second at 30 fps); "
                  "under an image: %.4f ms; a composite of the map and a camera under an image: %.4f ms",
                  opaque, opaque * 30, image, composite);
    ok(name, any == 3u * n);
}

int main()
{
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    cells();
    skipped();
    opaque_rules();
    never_stale(Over::Camera);
    never_stale(Over::Image);
    never_stale(Over::Blocks);
    never_stale(Over::Fade);
    composite_occluded();
    composite_occluding();
    uncover_waits(false);
    uncover_waits(true);
    quiet_hidden_reattach();
    unchanged();
    minute();
    cost();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
