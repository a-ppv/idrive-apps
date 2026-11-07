/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A video layer: decoded 4:2:0 frames, such as a CarPlay map, drawn with
 * these upload rules:
 *
 * - one persistent R8 buffer holding the frame's Y, U and V planes as an
 *   atlas (yuv_atlas.h), turned into colour by the renderer's GPU, with one
 *   sampler, made when the scene is: no texture or sampler per frame;
 * - each update writes only the 64x64 tiles that differ visibly from what
 *   the buffer holds (the noise filter and settle time, dirty_tiles.h), the
 *   whole atlas when most do, in place with setData;
 * - fast motion whose exact write the byte budget cannot cover at once goes
 *   as 4x4 colour blocks into one of two persistent RGBA8 buffers drawn by a
 *   second quad (block_pack.h), and the exact atlas comes back with the next
 *   update the budget covers, or kRefineMs after the last packed one;
 * - updates go on the frame clock's grid (frame_clock.h) and within the
 *   service's one byte budget (upload_pacer.h), shared by every layer;
 * - only the newest frame waits: a frame not yet written is replaced by each
 *   newer one, so the picture skips ahead and memory stays four atlases, a
 *   rectangle scratch and, with packed blocks, the packing;
 * - setData and the flush are checked: on a refusal the newest frame stays
 *   pending and the next write is whole.
 *
 * The target's scene carries every layer, so stage() writes and the
 * compositor flushes once for all of them; committed() then settles the
 * flush's outcome: what it wrote is shown, or after a refusal the next write
 * is whole. Frames come from a client (offer).
 *
 * A target with several videos draws them through one composite
 * (video_composite.h): each client video is then a source, with no objects
 * in the scene; it keeps its newest frame for the composite to take, and
 * goes back to drawing itself, its newest frame written whole, once the
 * display holds every video's buffers separately again (compositor.h). */
#ifndef CRS_VIDEO_LAYER_H
#define CRS_VIDEO_LAYER_H

#include "layer.h"

namespace crs {

struct VideoParams {
    uint32_t w = 1088, h = 480;      /* the frame's size; the atlas is w x h*3/2 */
    uint32_t level_bits = 2;         /* round_levels (yuv_atlas.h); 0: exact */
    uint32_t dirty_threshold = 8;    /* dirty_tiles.h; 0: every difference */
    int dirty_settle_ms = 1000;      /* 0: never */
    uint32_t fps = 30;               /* updates a second at most; 0: no clock */
    bool pan_blocks = true;          /* packed fast motion; needs h a multiple of 4 */
    int stall_ms = 6000;             /* no frame for this long: not ready */
};

class VideoLayer : public Layer {
public:
    /* The packed quad gives way to the exact atlas once no update has needed
     * it for this long, and the packing runs on this many threads (the
     * caller's and two more; MGU has four cores). */
    static const int64_t kRefineMs = 250;
    static const unsigned kPackThreads = 3;

    VideoLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, int atlas_effect, int block_effect,
               const VideoParams &p, int64_t now_ms);
    const char *kind() const override { return "video"; }
    static const char *size_error(uint32_t w, uint32_t h);
    size_t frame_bytes() const { return atlas_bytes_; }

    /* A frame's atlas, frame_bytes() long; its levels are rounded on the
     * way in. Replaces a frame not yet written. */
    void offer(const uint8_t *atlas, int64_t now_ms);
    /* A frame that is the last one offered again, byte for byte: staged,
     * counted and kept live as that frame would be, with nothing to copy and
     * no plan to make unless tiles are due to settle. */
    void repeat(int64_t now_ms);

    bool ready(int64_t now_ms) const override;
    bool attach(Graph *g, int64_t now_ms, std::string *err) override;
    void detach(bool drop) override;
    void arrange(bool drawn, int32_t order) override;
    void place() override;
    Stage stage(int64_t now_ms) override;
    void committed(bool ok, int64_t now_ms) override;
    size_t staged_bytes() const override { return staged_.raw; }
    bool holds_flush() const override { return parked_ && drawn_; }
    int64_t wake_in_ms(int64_t now_ms) const override;
    std::string stats() const override;
    WriteStats write_stats() const override;
    size_t buffer_bytes() const override
    {
        return g_ ? atlas_bytes_ + (p_.pan_blocks ? 2 * packed_.size() : 0) : 0;
    }
    bool fades() const override { return true; }

    const VideoParams &video() const { return p_; }

    /* A source of its target's composite (video_composite.h): detached, its
     * newest frame in newest(). direct() makes it a layer of its own again,
     * before it is attached: its newest frame then goes whole. */
    void to_source();
    void direct();
    bool source() const { return source_; }
    /* The newest frame, frame_bytes() long; null before the first. */
    const uint8_t *newest() const { return have_ ? front_.data() : nullptr; }
    /* A source's frame or repeat waits for the composite, and whether it is
     * a frame (not a repeat). took(): the composite has taken it. */
    bool waiting() const { return front_pending_; }
    bool fresh() const { return front_pending_ && !repeated_; }
    void took() { front_pending_ = repeated_ = false; }
    /* A source's copy of what the composite last took from it, frame_bytes()
     * long, which its next frame is compared with. */
    uint8_t *taken();

protected:
    void faded() override
    {
        if (g_)
            set_opacity();
    }

    /* The quads drawing the buffers: one over params.rect for the atlas and
     * one for the packed blocks. The composite draws one pair a source. */
    virtual bool make_atlas_quads(Graph *g);
    virtual bool make_block_quads(Graph *g);
    virtual void drop_quads();
    /* Shows the atlas quads, or with blocks the packed ones, where drawn. */
    virtual void show_quads(bool blocks);
    /* The packed quads sample buf. */
    virtual bool bank_quads(int buf);
    virtual void set_opacity();

    /* The composite's frame, composed in place: the newest frame, whole
     * (black before the first). canvas_changed(): it changed, and waits to
     * be written as an offered frame would. */
    uint8_t *canvas();
    void canvas_changed(int64_t now_ms);
    /* A write may go now: the frame clock is due (or a whole rewrite is) and
     * the budget allows one. */
    bool due(int64_t now_ms);
    /* Milliseconds until the frame clock is due; 0 or less: it is. */
    int64_t clock_wait_ms(int64_t now_ms) const { return clock_.ms_until_due(now_ms); }

    VideoParams p_;
    int atlas_effect_, block_effect_;
    int atlas_buf_ = 0;
    int block_buf_[2] = {0, 0};
    int block_bank_ = 0;
    bool blocks_shown_ = false, opaque_ = false;

private:
    enum class Kind { None, Exact, Blocks };
    /* A write staged into the scene, awaiting the flush's outcome. */
    struct Staged {
        Kind kind = Kind::None;
        bool fresh = false, whole = false, refine = false, was_shown = false, was_parked = false;
        int next_bank = 0;
        size_t raw = 0, accepted = 0;
        int64_t offered_ms = 0;   /* when its frame was offered */
        std::vector<crk::PixelRect> rects;
    };

    Stage stage_exact(int64_t now_ms, bool fresh);
    Stage stage_blocks(int64_t now_ms, bool fresh);
    void show_blocks(bool on);
    void drop_objects();

    size_t atlas_bytes_;
    uint32_t atlas_h_;
    crk::UploadPlanner planner_;   /* each update against shown_, and its quiet tiles */
    crk::UploadPlanner motion_;    /* new frames against the packed one */
    crk::FrameClock clock_;

    /* The newest frame, not yet written while front_pending_; shown_ is what
     * the buffer holds, the reference the next frame is diffed against, and
     * outlives the scene so the next one starts from it. */
    std::vector<uint8_t> front_, shown_, rect_scratch_;
    bool front_pending_ = false;
    /* repeated_: front_ waits as a repeat of the picture last staged.
     * front_stale_: a whole write swapped the newest frame into shown_. */
    bool repeated_ = false, front_stale_ = false;
    int64_t front_ms_ = -1, shown_ms_ = -1, last_frame_ms_ = -1;
    bool have_ = false;

    int atlas_quad_ = 0, block_quad_ = 0;
    /* parked_: a failed exact write left the atlas unlike any frame; the
     * target holds its flushes until the next whole write. first_: the
     * scene's first write is still to go. source_: drawn by the composite. */
    bool buffer_stale_ = false, parked_ = false, first_ = false, source_ = false;
    std::vector<uint8_t> block_src_, packed_;
    int64_t refine_due_ms_ = -1;
    Staged staged_;

    uint64_t age_ms_ = 0;   /* the sent frames' ages at their flush, summed */
    uint64_t sent_ = 0, same_ = 0, quiet_ = 0, superseded_ = 0, settled_ = 0, failed_ = 0, refused_ = 0,
             bytes_ = 0, whole_writes_ = 0, partial_writes_ = 0, rects_ = 0, packed_writes_ = 0, refines_ = 0,
             held_budget_ = 0;
};

}  // namespace crs

#endif
