/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A target's videos composed on the CPU into one video layer, so the
 * display holds one video's buffers for all of them (compositor.h).
 *
 * The composite is a video layer (video_layer.h) whose frame, the canvas,
 * covers its sources' rectangles: it is written with every rule of a video
 * layer, from the target's one byte budget, its dirty tiles planned against
 * what its buffer holds, packed blocks for motion the budget cannot cover.
 * Each source is drawn by its own pair of quads (atlas and packed blocks)
 * over its rectangle, sampling the canvas there, at the source's place in
 * the stack and at its own opacity times the target's fade. So the stack's
 * order holds between a video and the other layers, and the canvas
 * outside every source is never drawn.
 *
 * The canvas at a pixel is what the sources over it would draw there over
 * nothing, without the alpha: the bottom source's frame, then each source
 * above blended in by its share of the coverage. A source's quad drawn at
 * its opacity a over the quads below it then gives each pixel exactly the
 * colour the sources' own quads would give, as long as no other layer is
 * drawn between two overlapping translucent videos. Where the top source
 * is opaque or covers alone, the canvas is a plain copy of its frame.
 * Opacity is composed from the layer's own (params.opacity); the fade is
 * applied by the quads.
 *
 * Each source's quads sample only its own part of the canvas: luma at pixel
 * centres and chroma clamped inside the part, as the video shader clamps a
 * whole frame, so an opaque source draws as it would alone.
 *
 * Work per frame: a source's new frame is compared with what the composite
 * last took from it, tile by tile (the canvas's 64x64 tiles); only the
 * tiles a source changed, and those a source moving, hiding, showing or
 * changing opacity or order touched, are composed again. A cell of a tile
 * covered by one source, or under an opaque top source, is copied; only
 * cells where a translucent source overlaps another are blended, with SSE2
 * where there is one. A repeat from every source is a repeat of the
 * canvas.
 *
 * Sources are client video layers drawn unturned, at their frame's size
 * (rect w x h = vw x vh) and at even x and y, so the canvas's 4:2:0 planes
 * line up with theirs. */
#ifndef CRS_VIDEO_COMPOSITE_H
#define CRS_VIDEO_COMPOSITE_H

#include <stddef.h>
#include <stdint.h>
#include <vector>

#include "dirty_tiles.h"
#include "video_layer.h"

namespace crs {

/* The video shaders for a part of the canvas: u_view is the part (x, y, w,
 * h in canvas pixels) the quad covers; u_size the canvas. */
extern const char *const kAtlasViewFragmentShader;
extern const char *const kBlockViewFragmentShader;

/* The most sources compose_rect() takes. */
const size_t kComposeMax = 16;

/* A source's part of a composed rectangle. */
struct ComposeSource {
    const uint8_t *atlas = nullptr;   /* its frame's 4:2:0 atlas */
    uint32_t w = 0, h = 0;            /* its frame's size */
    int32_t x = 0, y = 0;             /* its frame's top-left in the canvas, even */
    crk::PixelRect clip{0, 0, 0, 0};  /* what it covers in the canvas, within its frame; even */
    uint32_t alpha = 256;             /* its opacity, 0-256 */
};

/* Composes r (even) of the canvas, a cw x ch 4:2:0 atlas, from the
 * sources, bottom first (above), at most kComposeMax; cells no source
 * covers stay as they are.
 * simd: the SSE2 blend where there is one; both give the same bytes. */
void compose_rect(uint8_t *canvas, uint32_t cw, uint32_t ch, const crk::PixelRect &r, const ComposeSource *src,
                  size_t n, bool simd = true);
/* dst = (dst * (256 - t) + src * t + 128) / 256 over n bytes, t 0-256. */
void blend_bytes(uint8_t *dst, const uint8_t *src, size_t n, uint32_t t, bool simd = true);

class CompositeVideo : public VideoLayer {
public:
    /* The canvas p.w x p.h has its top-left at (x, y) on the target; clip
     * is the target's rectangle the sources are drawn within. */
    CompositeVideo(int target, crk::UploadPacer &pacer, int atlas_effect, int block_effect, const VideoParams &p,
                   int32_t x, int32_t y, const Rect &clip, int64_t now_ms);
    const char *kind() const override { return "composite"; }
    int32_t x() const { return x_; }
    int32_t y() const { return y_; }
    const Rect &clip() const { return clip_; }

    /* A client video layer drawn through the composite from now (already a
     * source, video_layer.h), or no more. */
    void add(uint32_t id, VideoLayer *src);
    void remove(uint32_t id);
    bool has(uint32_t id) const;
    size_t sources() const { return src_.size(); }
    /* The source's place in the stack (drawn, draw order) and its params
     * (rect, opacity), each arrange; then arranged(). */
    void arrange_source(uint32_t id, bool drawn, int32_t order);
    /* Whether anything the scene shows changed since the last call. */
    bool arranged();
    /* Takes the sources' new frames and composes what they changed; before
     * stage(). */
    void compose(int64_t now_ms);

    void detach(bool drop) override;
    void arrange(bool drawn, int32_t order) override;
    void place() override;
    std::string stats() const override;

    /* Tiles composed and compose() calls that composed any, since made. */
    uint64_t composed_tiles() const { return tiles_composed_; }
    uint64_t composes() const { return composes_; }

protected:
    bool make_atlas_quads(Graph *g) override;
    bool make_block_quads(Graph *g) override;
    void drop_quads() override;
    void show_quads(bool blocks) override;
    bool bank_quads(int buf) override;
    void set_opacity() override;

private:
    struct Source {
        uint32_t id = 0;
        VideoLayer *layer = nullptr;
        Rect rect;                 /* drawn on the target: its rect within clip_; w 0: nowhere */
        int32_t fx = 0, fy = 0;    /* its frame's top-left in the canvas */
        float opacity = 1.0f;
        bool drawn = false;
        int32_t order = 0;
        bool full = true;          /* compose its whole rect and take its whole frame next */
        int atlas_quad = 0, block_quad = 0;
    };

    Source *find(uint32_t id);
    /* rect on the target, in the canvas. */
    crk::PixelRect in_canvas(const Rect &r) const;
    void mark(const Rect &r);
    bool make_quad(Graph *g, Source &s, bool blocks, int bank);
    void view_uniforms(Source &s);
    void source_opacity(Source &s);
    void source_shows(Source &s);

    int32_t x_, y_;
    Rect clip_;
    uint32_t cols_, rows_;
    std::vector<Source> src_;
    std::vector<uint8_t> dirty_;       /* per canvas tile */
    std::vector<uint32_t> ranking_;    /* drawn sources' ids by draw order, as last composed */
    bool scene_changed_ = false;
    uint64_t tiles_composed_ = 0, composes_ = 0;
};

}  // namespace crs

#endif
