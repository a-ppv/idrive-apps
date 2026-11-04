/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the map quad placement (map_geometry.h), the dirty-tile
 * upload plan (dirty_tiles.h) and the upload pacer (upload_pacer.h): where
 * the quad goes in the Map slot, the whole-panel slot and the HUD; which
 * tiles a change dirties, how runs merge, when the plan becomes the whole
 * frame; that writing a plan's rectangles over the previous frame always
 * yields the new one, with disjoint rectangles and no unchanged tile; that
 * the noise filter leaves only differences within its threshold, adds up
 * drift, and writes settled tiles on time; that a refused write stops there
 * and reports the bytes taken; and that paced uploads keep to their byte
 * rate, and how many whole and partial writes the default budget lets
 * through a second. */
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "../kit/dirty_tiles.h"
#include "../kit/map_geometry.h"
#include "../kit/upload_pacer.h"

using namespace crk;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static bool quad_is(const QuadRect &q, uint32_t x, uint32_t y, uint32_t w, uint32_t h)
{
    if (q.x == x && q.y == y && q.w == w && q.h == h)
        return true;
    std::printf("     got %u,%u %ux%u, want %u,%u %ux%u\n", q.x, q.y, q.w, q.h, x, y, w, h);
    return false;
}

static bool rect_is(const PixelRect &r, uint32_t x, uint32_t y, uint32_t w, uint32_t h)
{
    if (r.x == x && r.y == y && r.w == w && r.h == h)
        return true;
    std::printf("     got %u,%u %ux%u, want %u,%u %ux%u\n", r.x, r.y, r.w, r.h, x, y, w, h);
    return false;
}

struct Frame {
    uint32_t w, h, bpp;
    std::vector<uint8_t> px;
    Frame(uint32_t w_, uint32_t h_, uint32_t bpp_, uint8_t fill = 0) : w(w_), h(h_), bpp(bpp_), px((size_t)w_ * h_ * bpp_, fill) {}
    uint8_t *at(uint32_t x, uint32_t y) { return px.data() + ((size_t)y * w + x) * bpp; }
};

/* Writes the plan's rectangles from cur over tex, through pack_rect, the way
 * the producer writes them into the texture. */
static void apply_plan(const UploadPlan &p, const Frame &cur, Frame *tex)
{
    std::vector<uint8_t> scratch;
    for (const PixelRect &r : p.rects) {
        const uint8_t *src = pack_rect(cur.px.data(), cur.w, cur.bpp, r, &scratch);
        for (uint32_t y = 0; y < r.h; y++)
            std::memcpy(tex->at(r.x, r.y + y), src + (size_t)y * r.w * cur.bpp, (size_t)r.w * cur.bpp);
    }
}

static void test_geometry()
{
    ok("map slot 1088x480, native texture: fills the scene 1:1", quad_is(map_quad(1088, 480, 1088, 480), 0, 0, 1088, 480));
    ok("whole-panel 1920x720: the map area, centred", quad_is(map_quad(1920, 720, 1088, 480), 416, 120, 1088, 480));
    ok("map slot, 720x320 texture: height-limited, centred", quad_is(map_quad(1088, 480, 720, 320), 4, 0, 1080, 480));
    ok("whole-panel, 720x320 texture: inside the map area", quad_is(map_quad(1920, 720, 720, 320), 420, 120, 1080, 480));
    ok("map slot, 816x360 texture (34:15): exact fill", quad_is(map_quad(1088, 480, 816, 360), 0, 0, 1088, 480));
    ok("HUD 800x480 keeps its original smaller map", quad_is(map_quad(800, 480, 1088, 480), 173, 140, 453, 200));
    ok("square texture in the map slot: pillarboxed", quad_is(map_quad(1088, 480, 480, 480), 304, 0, 480, 480));

    ok("1088x480 is a valid texture", texture_size_error(1088, 480) == nullptr);
    ok("720x320 is a valid texture", texture_size_error(720, 320) == nullptr);
    ok("larger than the map area is refused", texture_size_error(1090, 480) != nullptr);
    ok("odd size is refused", texture_size_error(1087, 480) != nullptr);
    ok("width not a multiple of 4 is refused", texture_size_error(750, 330) != nullptr);
    ok("smaller than 64x32 is refused", texture_size_error(60, 30) != nullptr);
}

static void test_plan()
{
    const uint32_t W = 1088, H = 480, B = 3, T = kTileSize;
    Frame a(W, H, B, 7), b(W, H, B, 7);

    UploadPlan p = plan_upload(a.px.data(), b.px.data(), W, H, B, T, T);
    ok("1088x480 has 17x8 = 136 tiles", p.tiles == 136);
    ok("equal frames: nothing to write", p.rects.empty() && p.dirty_tiles == 0 && p.bytes == 0 && !p.whole);

    b.at(100, 70)[1] = 9;
    p = plan_upload(a.px.data(), b.px.data(), W, H, B, T, T);
    ok("one changed pixel dirties its one tile",
       p.dirty_tiles == 1 && p.rects.size() == 1 && rect_is(p.rects[0], 64, 64, 64, 64) && p.bytes == 64 * 64 * 3);

    b = a;
    b.at(10, 470)[0] = 1;
    p = plan_upload(a.px.data(), b.px.data(), W, H, B, T, T);
    ok("the last tile row is partial (32 rows)", p.rects.size() == 1 && rect_is(p.rects[0], 0, 448, 64, 32));

    b = a;
    b.at(64, 0)[0] = 1;
    b.at(191, 63)[2] = 1;
    b.at(1087, 0)[0] = 1;
    p = plan_upload(a.px.data(), b.px.data(), W, H, B, T, T);
    ok("adjacent tiles merge into one run; a separate tile is its own",
       p.dirty_tiles == 3 && p.rects.size() == 2 && rect_is(p.rects[0], 64, 0, 128, 64) && rect_is(p.rects[1], 1024, 0, 64, 64));

    b = a;
    for (uint32_t x = 0; x < W; x += T) {
        b.at(x, 64)[0] = 1;
        b.at(x, 128)[0] = 1;
    }
    p = plan_upload(a.px.data(), b.px.data(), W, H, B, T, T);
    ok("two full tile rows merge into one full-width rect",
       p.dirty_tiles == 34 && !p.whole && p.rects.size() == 1 && rect_is(p.rects[0], 0, 64, W, 128));
    std::vector<uint8_t> scratch;
    ok("a full-width rect is written straight from the frame",
       pack_rect(b.px.data(), W, B, p.rects[0], &scratch) == b.px.data() + (size_t)64 * W * B && scratch.empty());

    b = a;
    for (uint32_t y = 0; y < 3 * T; y += T) {
        b.at(128, y)[0] = 1;
        b.at(191 + 64, y)[0] = 1;
    }
    b.at(640, 0)[0] = 1;
    b.at(640 + 64, 64)[0] = 1;
    p = plan_upload(a.px.data(), b.px.data(), W, H, B, T, T);
    ok("runs of the same columns in three tile rows merge into one rect",
       p.rects.size() == 3 && rect_is(p.rects[0], 128, 0, 128, 192));
    ok("tiles in different columns of adjacent rows stay apart",
       rect_is(p.rects[1], 640, 0, 64, 64) && rect_is(p.rects[2], 704, 64, 64, 64) && p.bytes == (size_t)8 * 64 * 64 * B);

    /* The whole-frame threshold: 101 of 136 tiles (74%) is a tile plan, 102
     * (75%) the whole frame. Even tile columns first, then odd ones. */
    auto dirty_n = [&](uint32_t n) {
        Frame c = a;
        uint32_t k = 0;
        for (uint32_t pass = 0; pass < 2 && k < n; pass++)
            for (uint32_t ty = 0; ty < 8 && k < n; ty++)
                for (uint32_t tx = pass; tx < 17 && k < n; tx += 2, k++)
                    c.at(tx * T, ty * T)[0] = 1;
        return c;
    };
    Frame c = dirty_n(101);
    p = plan_upload(a.px.data(), c.px.data(), W, H, B, T, T);
    ok("101 of 136 tiles changed: tiles", p.dirty_tiles == 101 && !p.whole && p.rects.size() > 1);
    c = dirty_n(102);
    p = plan_upload(a.px.data(), c.px.data(), W, H, B, T, T);
    ok("102 of 136 tiles changed: the whole frame",
       p.dirty_tiles == 102 && p.whole && p.rects.size() == 1 && rect_is(p.rects[0], 0, 0, W, H) && p.bytes == (size_t)W * H * B);

    p = plan_upload(nullptr, b.px.data(), W, H, B, T, T);
    ok("no previous frame: the whole frame", p.whole && p.rects.size() == 1 && rect_is(p.rects[0], 0, 0, W, H));
    UploadPlanner high(W, H, B, T, T, 255, 0);
    p = high.plan(nullptr, b.px.data(), 0);
    ok("no previous frame, any threshold: the whole frame", p.whole && !high.quiet());

    /* Whole-frame mode: one tile the size of the frame. */
    p = plan_upload(a.px.data(), a.px.data(), W, H, B, W, H);
    ok("whole-frame mode, equal frames: nothing", p.tiles == 1 && p.rects.empty());
    b = a;
    b.at(5, 5)[0] = 2;
    p = plan_upload(a.px.data(), b.px.data(), W, H, B, W, H);
    ok("whole-frame mode, any change: the whole frame", p.whole && rect_is(p.rects[0], 0, 0, W, H));

    /* A width that is not a multiple of the tile: 748 = 11*64 + 44. */
    Frame d(748, 330, 4, 0), e(748, 330, 4, 0);
    e.at(747, 329)[3] = 1;
    p = plan_upload(d.px.data(), e.px.data(), 748, 330, 4, T, T);
    ok("partial last column and row", p.tiles == 12 * 6 && p.rects.size() == 1 && rect_is(p.rects[0], 704, 320, 44, 10));
    Frame got = d;
    apply_plan(p, e, &got);
    ok("the packed partial tile lands where it belongs", got.px == e.px);
}

/* xorshift64: random bytes eight at a time, for whole frames of noise. */
static uint64_t xorshift(uint64_t *s)
{
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    return *s;
}

/* Random edits of random sizes, both formats: the plan written over the
 * previous frame always gives the new frame, and leaves alone every pixel it
 * does not cover. */
static void test_random()
{
    std::srand(12345);
    uint64_t xs = 88172645463325252ull;
    bool all = true;
    for (int iter = 0; iter < 200 && all; iter++) {
        const uint32_t bpp = iter % 3 == 0 ? 1 : iter % 3 == 1 ? 3 : 4;   /* 1: the atlas */
        const uint32_t w = 1088, h = 480;
        Frame prev(w, h, bpp);
        for (size_t k = 0; k < prev.px.size(); k += 8) {
            const uint64_t r = xorshift(&xs);
            std::memcpy(&prev.px[k], &r, std::min<size_t>(8, prev.px.size() - k));
        }
        Frame cur = prev;
        const int edits = std::rand() % 12;
        for (int i = 0; i < edits; i++) {
            const uint32_t x = std::rand() % w, y = std::rand() % h;
            const uint32_t ew = 1 + std::rand() % (iter % 7 == 0 ? w : 90), eh = 1 + std::rand() % (iter % 7 == 0 ? h : 90);
            for (uint32_t yy = y; yy < y + eh && yy < h; yy++)
                for (uint32_t xx = x; xx < x + ew && xx < w; xx++)
                    cur.at(xx, yy)[xorshift(&xs) % bpp] ^= 0x5a;
        }
        UploadPlan p = plan_upload(prev.px.data(), cur.px.data(), w, h, bpp, kTileSize, kTileSize);
        Frame tex = prev;
        apply_plan(p, cur, &tex);
        size_t covered = 0;
        for (const PixelRect &r : p.rects)
            covered += (size_t)r.w * r.h * bpp;
        /* Unless the plan is whole, it writes exactly the tiles that differ:
         * each pixel at most once, and no unchanged tile. */
        size_t changed = 0;
        for (uint32_t ty = 0; ty < h; ty += kTileSize)
            for (uint32_t tx = 0; tx < w; tx += kTileSize) {
                const uint32_t tw = std::min(kTileSize, w - tx), th = std::min(kTileSize, h - ty);
                bool differs = false;
                for (uint32_t y = ty; y < ty + th && !differs; y++)
                    differs = std::memcmp(prev.at(tx, y), cur.at(tx, y), (size_t)tw * bpp) != 0;
                changed += differs ? (size_t)tw * th * bpp : 0;
            }
        std::vector<uint8_t> writes((size_t)w * h, 0);
        for (const PixelRect &r : p.rects)
            for (uint32_t y = r.y; y < r.y + r.h; y++)
                for (uint32_t x = r.x; x < r.x + r.w; x++)
                    writes[(size_t)y * w + x]++;
        const bool once = *std::max_element(writes.begin(), writes.end()) <= 1;
        all = tex.px == cur.px && covered == p.bytes && (edits > 0 || p.rects.empty()) && once &&
              (p.whole || covered == changed);
        if (!all)
            std::printf("     iteration %d (bpp %u, %d edits) differs\n", iter, bpp, edits);
    }
    ok("200 random edits: prev + plan == cur, bytes = covered area, disjoint, only changed tiles", all);
}

static void test_max_abs_diff()
{
    std::srand(777);
    bool all = true;
    std::vector<uint8_t> a(4096), b(4096);
    for (int iter = 0; iter < 2000 && all; iter++) {
        const size_t off = std::rand() % 64, n = std::rand() % 1000;
        for (size_t i = 0; i < n; i++) {
            a[off + i] = (uint8_t)std::rand();
            b[off + i] = iter % 3 ? (uint8_t)(a[off + i] + (std::rand() % 7) - 3) : (uint8_t)std::rand();
        }
        uint8_t want = 0;
        for (size_t i = 0; i < n; i++) {
            const int d = std::abs((int)a[off + i] - (int)b[off + i]);
            want = d > want ? (uint8_t)d : want;
        }
        all = max_abs_diff(a.data() + off, b.data() + off, n) == want &&
              max_abs_diff(b.data() + off, a.data() + off, n) == want;
        if (!all)
            std::printf("     iteration %d (offset %zu, %zu bytes): want %u\n", iter, off, n, want);
    }
    ok("max_abs_diff matches a byte-by-byte reference at any length and alignment", all);
    a.assign(64, 0);
    b.assign(64, 0);
    b[63] = 255;
    ok("max_abs_diff: the full range, in the last byte", max_abs_diff(a.data(), b.data(), 64) == 255);
}

static void test_noise_filter()
{
    const uint32_t W = 1088, H = 480, B = 3, T = kTileSize;
    Frame shown(W, H, B, 100), cur = shown;

    UploadPlanner pl(W, H, B, T, T, 8, 1000);
    cur.at(70, 70)[0] = 108;
    UploadPlan p = pl.plan(shown.px.data(), cur.px.data(), 0);
    ok("a difference of the threshold is quiet: nothing written",
       p.rects.empty() && p.quiet_tiles == 1 && p.dirty_tiles == 0 && pl.quiet() && pl.settle_due_ms() == 1000);
    cur.at(200, 70)[2] = 91;
    p = pl.plan(shown.px.data(), cur.px.data(), 10);
    ok("one past the threshold is written, the quiet tile stays",
       p.rects.size() == 1 && rect_is(p.rects[0], 192, 64, 64, 64) && p.quiet_tiles == 1 && pl.settle_due_ms() == 1000);
    copy_rects(shown.px.data(), cur.px.data(), W, B, p.rects);
    p = pl.plan(shown.px.data(), cur.px.data(), 999);
    ok("the quiet tile is not written before it settles", p.rects.empty() && p.quiet_tiles == 1);
    p = pl.plan(shown.px.data(), cur.px.data(), 1000);
    ok("after settle_ms it is written",
       p.rects.size() == 1 && rect_is(p.rects[0], 64, 64, 64, 64) && p.settled_tiles == 1 && p.dirty_tiles == 1 &&
       p.quiet_tiles == 0 && !pl.quiet() && pl.settle_due_ms() == -1);
    copy_rects(shown.px.data(), cur.px.data(), W, B, p.rects);
    ok("written plans leave the texture equal to the frame", shown.px == cur.px);

    /* A tile that goes back to equal starts its quiet time again. */
    cur.at(5, 5)[1] = 103;
    pl.plan(shown.px.data(), cur.px.data(), 2000);
    cur.at(5, 5)[1] = 100;
    pl.plan(shown.px.data(), cur.px.data(), 2500);
    ok("a tile back to equal is not quiet", !pl.quiet() && pl.settle_due_ms() == -1);
    cur.at(5, 5)[1] = 97;
    pl.plan(shown.px.data(), cur.px.data(), 2600);
    ok("quiet again: settles from the new start", pl.settle_due_ms() == 3600);

    /* Drift: one level a frame is written once it adds up past the
     * threshold, and the texture never strays further. */
    Frame tex(W, H, B, 50), frame = tex;
    UploadPlanner drift(W, H, B, T, T, 8, 0);
    int writes = 0, first = -1;
    uint8_t worst = 0;
    for (int i = 1; i <= 40; i++) {
        frame.at(300, 300)[1] = (uint8_t)(50 + i);
        p = drift.plan(tex.px.data(), frame.px.data(), i * 33);
        if (!p.rects.empty()) {
            writes++;
            if (first < 0)
                first = i;
        }
        copy_rects(tex.px.data(), frame.px.data(), W, B, p.rects);
        const uint8_t e = max_abs_diff(tex.px.data(), frame.px.data(), tex.px.size());
        worst = e > worst ? e : worst;
    }
    ok("drift is written each time it adds up past the threshold", first == 9 && writes == 4);
    ok("drift never leaves the texture more than the threshold off", worst <= 8);
    ok("settle_ms 0: quiet tiles are never due", drift.quiet() && drift.settle_due_ms() == -1);

    /* The whole frame writes the quiet tiles too. */
    UploadPlanner whole(W, H, B, T, T, 8, 1000);
    Frame w0(W, H, B, 0), w1 = w0;
    w1.at(0, 0)[0] = 3;
    whole.plan(w0.px.data(), w1.px.data(), 0);
    for (uint32_t ty = 0; ty < 8; ty++)
        for (uint32_t tx = 0; tx < 17; tx++)
            if (tx || ty)
                w1.at(tx * T + 1, ty * T)[0] = 200;
    p = whole.plan(w0.px.data(), w1.px.data(), 10);
    ok("a whole-frame write leaves nothing quiet", p.whole && p.quiet_tiles == 0 && !whole.quiet() && whole.settle_due_ms() == -1);

    /* The tiles by largest difference. */
    UploadPlanner bins(W, H, B, T, T, 0, 0);
    Frame h0(W, H, B, 128), h1 = h0;
    h1.at(0, 0)[0] = 129;       /* 1 */
    h1.at(64, 0)[0] = 125;      /* 3 */
    h1.at(128, 0)[2] = 132;     /* 4 */
    h1.at(192, 0)[1] = 0;       /* 128 */
    h1.at(256, 0)[1] = 255;     /* 127 */
    p = bins.plan(h0.px.data(), h1.px.data(), 0);
    const uint32_t want[kDeltaBins] = {1, 1, 1, 0, 0, 0, 1, 1};
    ok("differing tiles land in their bins", std::memcmp(p.delta_tiles, want, sizeof want) == 0);
    ok("threshold 0 writes every difference", p.dirty_tiles == 5 && p.quiet_tiles == 0);

    /* Whole-frame mode: the threshold is the frame's largest difference. */
    UploadPlanner one(W, H, B, W, H, 8, 0);
    Frame o0(W, H, B, 10), o1 = o0;
    o1.at(1000, 400)[0] = 18;
    p = one.plan(o0.px.data(), o1.px.data(), 0);
    ok("whole-frame mode: within the threshold, nothing", p.rects.empty() && p.tiles == 1 && p.quiet_tiles == 1);
    o1.at(3, 3)[0] = 1;
    p = one.plan(o0.px.data(), o1.px.data(), 0);
    ok("whole-frame mode: past it, the whole frame", p.whole && rect_is(p.rects[0], 0, 0, W, H));
}

/* Random noise and edits over many frames, the way the producer runs: each
 * plan written over the texture (its rectangles, or the whole frame), and the
 * texture is never more than the threshold off the frame, and equal to it
 * once every quiet tile has settled. */
static void test_random_noise()
{
    std::srand(4242);
    const uint32_t w = 1088, h = 480, bpp = 3, thr = 6;
    const int64_t settle = 500;
    Frame frame(w, h, bpp), tex(w, h, bpp);
    for (uint8_t &v : frame.px)
        v = (uint8_t)std::rand();
    tex = frame;
    UploadPlanner pl(w, h, bpp, kTileSize, kTileSize, thr, settle);
    bool bounded = true, packed = true;
    int64_t now = 0;
    for (int f = 0; f < 120 && bounded; f++, now += 33) {
        const int noisy = std::rand() % 40;
        for (int i = 0; i < noisy; i++) {
            uint8_t *px = frame.at(std::rand() % w, std::rand() % h);
            px[std::rand() % bpp] += (uint8_t)((std::rand() % 5) - 2);
        }
        if (f % 10 == 0) {
            const uint32_t x = std::rand() % (w - 100), y = std::rand() % (h - 100);
            for (uint32_t yy = y; yy < y + 1 + std::rand() % 100; yy++)
                for (uint32_t xx = x; xx < x + 1 + std::rand() % 100; xx++)
                    frame.at(xx, yy)[0] ^= 0x80;
        }
        UploadPlan p = pl.plan(tex.px.data(), frame.px.data(), now);
        Frame via_pack = tex;
        apply_plan(p, frame, &via_pack);
        if (p.whole)
            tex = frame;
        else
            copy_rects(tex.px.data(), frame.px.data(), w, bpp, p.rects);
        packed = packed && via_pack.px == tex.px;
        bounded = max_abs_diff(tex.px.data(), frame.px.data(), tex.px.size()) <= thr;
        if (!bounded)
            std::printf("     frame %d: texture off by more than %u\n", f, thr);
    }
    ok("120 noisy frames: the texture stays within the threshold", bounded);
    ok("copy_rects writes what the packed rectangles write", packed);
    const int64_t due = pl.settle_due_ms();
    ok("quiet tiles are due within settle_ms", pl.quiet() && due > now - 33 - settle && due <= now - 33 + settle);
    UploadPlan p = pl.plan(tex.px.data(), frame.px.data(), now + settle);
    copy_rects(tex.px.data(), frame.px.data(), w, bpp, p.rects);
    ok("once every quiet tile settles the texture equals the frame", tex.px == frame.px && !pl.quiet());
}

/* The buffer's write model on the 1088x720 R8 4:2:0 atlas of a 1088x480
 * map, with the default threshold (8) and 64x64 tiles. A change in one luma area plans
 * partial rectangles whose packed bytes, written as setData writes them,
 * leave the buffer equal to shown_ after copy_rects; a pan plans the whole
 * atlas, 783,360 B. */
static void test_r8_atlas_writes()
{
    const uint32_t w = 1088, h = 720, thr = 8;
    Frame shown(w, h, 1, 100), buffer(w, h, 1, 100), cur(w, h, 1, 100);
    UploadPlanner pl(w, h, 1, kTileSize, kTileSize, thr, 1000);
    for (uint32_t y = 200; y < 300; y++)   /* a 100x100 luma change */
        for (uint32_t x = 500; x < 600; x++)
            *cur.at(x, y) = 180;
    for (uint32_t y = 580; y < 600; y++)   /* and its chroma, in the U half */
        for (uint32_t x = 250; x < 300; x++)
            *cur.at(x, y) = 60;
    const UploadPlan p = pl.plan(shown.px.data(), cur.px.data(), 0);
    size_t area = 0;
    for (const PixelRect &r : p.rects)
        area += (size_t)r.w * r.h;
    ok("a local change plans partial rectangles", !p.rects.empty() && !p.whole);
    ok("their raw bytes are far under the whole atlas", area < (size_t)w * h / 10);
    apply_plan(p, cur, &buffer);
    copy_rects(shown.px.data(), cur.px.data(), w, 1, p.rects);
    ok("setData of the packed rectangles leaves the buffer equal to shown", buffer.px == shown.px);
    ok("and shown equal to the frame", shown.px == cur.px);

    for (uint8_t &v : cur.px)   /* a pan: every tile changes */
        v = (uint8_t)(v + 40);
    const UploadPlan pan = pl.plan(shown.px.data(), cur.px.data(), 33);
    ok("a pan plans the whole atlas, 783,360 raw bytes", pan.whole && pan.rects.size() == 1 && pan.bytes == 783360);
}

static void test_write_rects()
{
    Frame f(1088, 720, 1);
    for (size_t i = 0; i < f.px.size(); i++)
        f.px[i] = (uint8_t)(i * 7);
    const std::vector<PixelRect> rects{{0, 0, 1088, 128}, {64, 128, 128, 64}, {1024, 640, 64, 80}};
    std::vector<uint8_t> scratch;
    std::vector<PixelRect> calls;
    bool all = false, same = true;
    size_t taken = write_rects(f.px.data(), f.w, 1, rects, &scratch,
                               [&](const uint8_t *px, const PixelRect &r) {
                                   calls.push_back(r);
                                   for (uint32_t y = 0; y < r.h; y++)
                                       same = same && std::memcmp(px + (size_t)y * r.w, f.at(r.x, r.y + y), r.w) == 0;
                                   return true;
                               },
                               &all);
    ok("write_rects: every rectangle, in order, its pixels rows packed",
       all && calls.size() == 3 && same && rect_is(calls[2], 1024, 640, 64, 80));
    ok("write_rects: the bytes taken are the rectangles'", taken == 1088 * 128 + 128 * 64 + 64 * 80);

    calls.clear();
    taken = write_rects(f.px.data(), f.w, 1, rects, &scratch,
                        [&](const uint8_t *, const PixelRect &r) {
                            calls.push_back(r);
                            return calls.size() < 2;
                        },
                        &all);
    ok("write_rects: a refusal stops there", !all && calls.size() == 2);
    ok("write_rects: the bytes taken before it are reported", taken == 1088 * 128);
}

static void test_pacer()
{
    UploadPacer none;
    bool all = true;
    for (int i = 0; i < 100; i++) {
        all = all && none.ready(i);
        none.spend(10000000);
    }
    ok("pacer: rate 0 never holds a frame back", all);

    UploadPacer p(1000000);
    ok("pacer: the first ready starts with a second's allowance", p.ready(0));
    p.spend(1500000);
    ok("pacer: a frame over the allowance holds the next back", !p.ready(0) && !p.ready(499));
    ok("pacer: until the debt is refilled", !p.ready(500) && p.ready(501));
    ok("pacer: the allowance is what may go now", p.allowance() == 1000);
    p.spend(5000);
    ok("pacer: and negative while in debt", p.allowance() == -4000);
    ok("pacer: unlimited allows anything", none.allowance() == INT64_MAX);

    UploadPacer idle(1000000);
    idle.ready(0);
    bool capped = idle.ready(60000);
    idle.spend(1000000);
    ok("pacer: idle allowance is kept up to one second's worth", capped && !idle.ready(60000));

    UploadPacer slow(100000);
    slow.ready(0);
    slow.spend(1566720);   /* 14.7 s of debt */
    ok("pacer: debt over a second is kept", !slow.ready(10000) && !slow.ready(14600));
    UploadPacer slow2(100000);
    slow2.ready(0);
    slow2.spend(1566720);
    ok("pacer: one long gap repays debt over a second", slow2.ready(60000));

    UploadPacer huge(~uint64_t(0));
    huge.ready(0);
    huge.spend(1000000000);
    ok("pacer: an absurd rate and gap do not overflow", huge.limited() && huge.ready(INT64_MAX / 2) && huge.ready(INT64_MAX - 1));

    /* Frames of 1,566,720 B offered at 30 fps for 20 s against 4000 KB/s,
     * far over the rate: the bytes sent stay within the rate plus the
     * starting second and one frame, and the pacer uses what it is allowed. */
    const uint64_t rate = 4000 * 1024, frame = 1566720;
    UploadPacer v(rate);
    uint64_t sent = 0;
    int frames = 0;
    for (int64_t t = 0; t < 20000; t += 33) {
        if (v.ready(t)) {
            v.spend(frame);
            sent += frame;
            frames++;
        }
    }
    const bool bounded = sent <= rate * 20 + rate + frame && sent >= rate * 19;
    if (!bounded)
        std::printf("     sent %llu B in %d frames over 20 s at %llu B/s\n", (unsigned long long)sent, frames,
                    (unsigned long long)rate);
    ok("pacer: 30 fps of whole frames keeps to the byte rate", bounded);

    /* The default 5500 KB/s against raw writes: a whole 1088x480 atlas is
     * 783,360 B, and a partial write of 320 KB is about what the car's
     * synthetic motion wrote (8.2 MB/s at 26 updates a second). Offered at
     * 30 a second, counted over 20 s after the first 5 (past the starting
     * allowance), whole writes go at 5500 x 1024 / 783360 = 7.2 a second,
     * 320 KB ones at 5500 / 320 = 17.2. */
    const uint64_t def = 5500 * 1024;
    for (uint64_t size : {uint64_t(783360), uint64_t(320 * 1024)}) {
        UploadPacer d(def, 250);
        int offered = 0, gone = 0;
        for (int64_t t = 0; t < 25000; t += 33) {
            const bool counted = t >= 5000;
            offered += counted;
            if (d.ready(t)) {
                d.spend(size);
                gone += counted;
            }
        }
        const double ups = gone / 20.0;
        char name[112];
        std::snprintf(name, sizeof name, "pacer: 5500 KB/s passes %u KB writes at %.1f of %.1f a second",
                      (unsigned)(size / 1024), ups, offered / 20.0);
        ok(name, size == 783360 ? ups >= 6.5 && ups <= 7.8 : ups >= 16.5 && ups <= 18.0);
    }
}

/* The HUD's share: up to half of each refill, the rest back to the source. */
static void test_share_pacer()
{
    const uint64_t rate = 5500 * 1024;
    char name[160];
    /* With the share off, the source's spenders decide exactly as alone,
     * whatever the share pacer spends: a map writing 0.5 to 1.2 MB a frame
     * at 30 fps, some frames unchanged. */
    {
        UploadPacer alone(rate, 250), shared(rate, 250), hud;
        hud.share_of(&shared);
        uint32_t seed = 7;
        int same = 0, ticks = 0;
        for (int64_t t = 0; t < 60000; t += 33) {
            seed = seed * 1664525u + 1013904223u;
            const uint64_t want = (seed >> 28) < 4 ? 0 : 500000 + (seed >> 8) % 700000;
            const bool a = alone.ready(t), b = shared.ready(t);
            same += a == b && alone.allowance() == shared.allowance();
            ticks++;
            if (want && a)
                alone.spend(want);
            if (want && b)
                shared.spend(want);
            if (t % 99 == 0 && hud.ready(t))
                hud.spend(136000);
        }
        std::snprintf(name, sizeof name, "share pacer, off: the source decides as alone (%d of %d ticks)", same, ticks);
        ok(name, same == ticks);
    }
    /* On, both greedy for 60 s: the HUD at most half, the source at least
     * half; together within the rate. */
    {
        UploadPacer map(rate, 250), hud;
        hud.share_of(&map);
        map.set_share(50);
        uint64_t mb = 0, hb = 0;
        for (int64_t t = 0; t < 60000; t += 10) {
            while (map.ready(t) && map.allowance() > 0) {
                map.spend(783360);
                mb += 783360;
            }
            while (hud.ready(t) && hud.allowance() > 0) {
                hud.spend(136000);
                hb += 136000;
            }
        }
        std::snprintf(name, sizeof name, "share pacer, both greedy: map %llu KB, HUD %llu KB in 60 s", (unsigned long long)(mb / 1024),
                      (unsigned long long)(hb / 1024));
        ok(name, hb <= rate * 30 + rate / 8 + 136000 && mb >= rate * 30 - 783360 && mb + hb <= rate * 60 + rate / 2 + 783360 + 136000);
    }
    /* On, a HUD that writes a 136 KB frame ten times a second (1.3 MB/s):
     * the rest of its half flows back, the map gets the remainder. */
    {
        UploadPacer map(rate, 250), hud;
        hud.share_of(&map);
        map.set_share(50);
        uint64_t mb = 0, hb = 0;
        for (int64_t t = 0; t < 60000; t += 10) {
            while (map.ready(t) && map.allowance() > 0) {
                map.spend(783360);
                mb += 783360;
            }
            if (t % 100 == 0 && hud.ready(t)) {
                hud.spend(136000);
                hb += 136000;
            }
        }
        std::snprintf(name, sizeof name, "share pacer, a HUD at 10 a second: it gets %llu KB, the map the rest, %llu KB",
                      (unsigned long long)(hb / 1024), (unsigned long long)(mb / 1024));
        ok(name, hb >= 590 * 136000 && mb + hb >= rate * 60 - 783360 && mb >= rate * 60 - hb - 783360);
    }
    /* On, a HUD that writes nothing: after its half burst fills, the map has
     * the whole rate. */
    {
        UploadPacer alone(rate, 250), map(rate, 250), hud;
        hud.share_of(&map);
        map.set_share(50);
        uint64_t ab = 0, mb = 0;
        for (int64_t t = 0; t < 60000; t += 10) {
            while (alone.ready(t) && alone.allowance() > 0) {
                alone.spend(783360);
                ab += 783360;
            }
            while (map.ready(t) && map.allowance() > 0) {
                map.spend(783360);
                mb += 783360;
            }
        }
        std::snprintf(name, sizeof name, "share pacer, an idle HUD: the map loses at most the HUD's half burst (%llu of %llu KB)",
                      (unsigned long long)(mb / 1024), (unsigned long long)(ab / 1024));
        ok(name, mb + rate / 8 + 783360 >= ab && hud.ready(60000) && hud.allowance() <= (int64_t)(rate / 8));
    }
    /* On, both still for 10 s, then both greedy for 10 s: the two together
     * never hold more than one burst, so in any window t they send at most
     * the burst and t of the rate, plus the frame each that goes into debt. */
    {
        const int64_t cap = rate / 4;
        UploadPacer map(rate, 250), hud;
        hud.share_of(&map);
        map.set_share(50);
        bool held = true;
        std::vector<uint64_t> sent;   /* per 10 ms tick, once moving */
        for (int64_t t = 0; t < 20000; t += 10) {
            map.ready(t);
            hud.ready(t);
            held = held && std::max<int64_t>(map.allowance(), 0) + std::max<int64_t>(hud.allowance(), 0) <= cap;
            if (t < 10000)
                continue;
            uint64_t b = 0;
            for (; map.ready(t); b += 783360)
                map.spend(783360);
            for (; hud.ready(t); b += 136000)
                hud.spend(136000);
            sent.push_back(b);
        }
        bool within = true;
        for (size_t i = 0; i < sent.size(); i++) {
            uint64_t sum = 0;
            for (size_t j = i; j < sent.size(); j++) {
                sum += sent[j];
                within = within && sum <= cap + rate * (j - i + 1) / 100 + 783360 + 136000;
            }
        }
        uint64_t first = 0;
        for (size_t i = 0; i < 100; i++)
            first += sent[i];
        std::snprintf(name, sizeof name,
                      "share pacer, both still then both greedy: at most one burst held, %llu KB in the first second "
                      "(burst and rate %llu KB)",
                      (unsigned long long)(first / 1024), (unsigned long long)((cap + rate) / 1024));
        ok(name, held && within);
    }

    /* A source writing at its rate, the share off, leaves its share pacer
     * nothing; an idle source, the share on, gives it the whole rate, up to
     * a burst. */
    UploadPacer busy(rate, 250), starved;
    starved.share_of(&busy);
    int share_writes = 0;
    for (int64_t t = 0; t < 20000; t += 33) {
        if (busy.ready(t))
            busy.spend(783360);
        share_writes += starved.ready(t);
    }
    ok("share pacer, off: a source writing at its rate leaves it nothing", share_writes == 0);
    UploadPacer quiet(rate, 250), fed;
    fed.share_of(&quiet);
    quiet.set_share(50);
    quiet.ready(0);
    ok("share pacer: nothing at first, the source holds its starting burst", !fed.ready(0));
    ok("share pacer: a full source's refill, up to a burst", fed.ready(10000) && fed.allowance() == (int64_t)(rate / 4));
    uint64_t got = 0;
    for (int64_t t = 10000; t < 30000; t += 100)
        while (fed.ready(t)) {
            fed.spend(136000);
            got += 136000;
        }
    ok("share pacer: an idle source's rate goes to it", got >= rate * 19 && got <= rate * 20 + rate / 4 + 136000);
    UploadPacer unlimited, free_share;
    free_share.share_of(&unlimited);
    ok("share pacer: an unlimited source's is unlimited", free_share.ready(0) && free_share.allowance() == INT64_MAX);
    UploadPacer lowered(rate, 250), clipped;
    clipped.share_of(&lowered);
    lowered.set_share(50);
    lowered.ready(0);
    clipped.ready(5000);
    lowered.set_rate(2000 * 1024);
    ok("share pacer: a lower rate clips it to its burst too", clipped.allowance() == (int64_t)(2000 * 1024 / 4));
}

int main()
{
    test_geometry();
    test_plan();
    test_random();
    test_max_abs_diff();
    test_noise_filter();
    test_random_noise();
    test_r8_atlas_writes();
    test_write_rects();
    test_pacer();
    test_share_pacer();
    if (failures) {
        std::printf("%d FAILED\n", failures);
        return 1;
    }
    std::printf("all ok\n");
    return 0;
}
