/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "video_layer.h"

#include <algorithm>

#include <cstdio>

#include "block_pack.h"
#include "yuv_atlas.h"

namespace crs {

using crk::PixelRect;
using crk::UploadPlan;

VideoLayer::VideoLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, int atlas_effect,
                       int block_effect, const VideoParams &p, int64_t now_ms)
    : Layer(id, target, seq, pacer), p_(p), atlas_effect_(atlas_effect), block_effect_(block_effect),
      atlas_bytes_((size_t)p.w * crk::atlas_height(p.h)), atlas_h_(crk::atlas_height(p.h)),
      planner_(p.w, crk::atlas_height(p.h), 1, crk::kTileSize, crk::kTileSize, p.dirty_threshold, p.dirty_settle_ms),
      motion_(p.w, crk::atlas_height(p.h), 1, crk::kTileSize, crk::kTileSize, p.dirty_threshold, 0)
{
    if (p_.h % 4)
        p_.pan_blocks = false;
    if (p_.pan_blocks)
        packed_.resize(crk::block_bytes(p_.w, p_.h));
    clock_.configure(p_.fps);
    clock_.reset(now_ms);
}

const char *VideoLayer::size_error(uint32_t w, uint32_t h)
{
    if (w < 64 || h < 32)
        return "video smaller than 64x32";
    if (w > 1920 || h > 720)
        return "video larger than 1920x720";
    if (w % 4 || h % 2)
        return "video width must be a multiple of 4 and its height even";
    return nullptr;
}

void VideoLayer::offer(const uint8_t *atlas, int64_t now_ms)
{
    if (front_pending_)
        superseded_++;   /* the newest frame replaces the unsent one: it skips ahead, never replays */
    front_.resize(atlas_bytes_);
    crk::round_levels(front_.data(), atlas, atlas_bytes_, p_.level_bits);
    front_pending_ = true;
    front_ms_ = last_frame_ms_ = now_ms;
    have_ = true;
}

bool VideoLayer::ready(int64_t now_ms) const
{
    return have_ && now_ms - last_frame_ms_ <= p_.stall_ms;
}

bool VideoLayer::attach(Graph *g, int64_t now_ms, std::string *err)
{
    g_ = g;
    /* The scene starts from the newest frame: one not yet written, the
     * newest partly written (quiet tiles), or what the last scene's buffer
     * held. The first stage() writes it whole, checked like any other
     * write; a layer whose frames have stopped is not ready, so not drawn. */
    if (!front_pending_ && !planner_.quiet() && shown_.size() == atlas_bytes_) {
        front_.swap(shown_);
        front_ms_ = shown_ms_;
    }
    front_pending_ = front_.size() == atlas_bytes_ && front_ms_ >= 0;
    shown_.assign(atlas_bytes_, 0);
    shown_ms_ = -1;
    planner_.reset();
    buffer_stale_ = true;
    opaque_ = false;
    blocks_shown_ = parked_ = false;
    first_ = true;
    refine_due_ms_ = -1;
    drawn_ = false;

    const float size[2] = {(float)p_.w, (float)p_.h}, zero = 0.0f;
    atlas_buf_ = g->buffer(TexFormat::R8, p_.w, atlas_h_, Sampling::Bilinear);
    atlas_quad_ = atlas_buf_ ? g->quad(atlas_effect_, params.rect) : 0;
    bool good = atlas_quad_ && g->turn(atlas_quad_, params.turn()) && g->texture(atlas_quad_, "u_image", atlas_buf_) &&
                g->uniform(atlas_quad_, "u_size", size, 2) && g->uniform(atlas_quad_, "u_opacity", &zero, 1) &&
                g->show(atlas_quad_, false) && g->order(atlas_quad_, order_);
    if (good && p_.pan_blocks) {
        const uint32_t bw = crk::block_texels_w(p_.w), bh = crk::block_texels_h(p_.h);
        for (int k = 0; k < 2 && good; k++)
            good = (block_buf_[k] = g->buffer(TexFormat::RGBA8, bw, bh, Sampling::Nearest)) != 0;
        block_quad_ = good ? g->quad(block_effect_, params.rect) : 0;
        good = block_quad_ && g->turn(block_quad_, params.turn()) && g->texture(block_quad_, "u_image", block_buf_[0]) &&
               g->uniform(block_quad_, "u_size", size, 2) && g->uniform(block_quad_, "u_opacity", &zero, 1) &&
               g->show(block_quad_, false) && g->order(block_quad_, order_ + 1);
        block_bank_ = 0;
    }
    if (!good) {
        *err = p_.pan_blocks ? "video buffers, samplers or quads refused" : "video buffer, sampler or quad refused";
        detach(true);
        return false;
    }
    clock_.reset(now_ms);
    return true;
}

void VideoLayer::drop_objects()
{
    if (!g_)
        return;
    if (atlas_quad_) g_->drop_quad(atlas_quad_);
    if (block_quad_) g_->drop_quad(block_quad_);
    if (atlas_buf_) g_->drop_buffer(atlas_buf_);
    for (int k = 0; k < 2; k++)
        if (block_buf_[k]) g_->drop_buffer(block_buf_[k]);
}

void VideoLayer::detach(bool drop)
{
    if (drop)
        drop_objects();
    /* A frame the packed quad showed never reached the atlas: the next scene
     * starts from it. */
    if (blocks_shown_)
        front_pending_ = true;
    g_ = nullptr;
    atlas_buf_ = atlas_quad_ = block_quad_ = 0;
    block_buf_[0] = block_buf_[1] = 0;
    blocks_shown_ = parked_ = false;
    drawn_ = false;
    refine_due_ms_ = -1;
    staged_ = Staged();
}

void VideoLayer::show_blocks(bool on)
{
    blocks_shown_ = on;
    if (!g_)
        return;
    g_->show(atlas_quad_, drawn_ && !on);
    if (block_quad_)
        g_->show(block_quad_, drawn_ && on);
}

void VideoLayer::set_opacity()
{
    const float a = opaque_ ? params.opacity * fade_ : 0.0f;
    g_->uniform(atlas_quad_, "u_opacity", &a, 1);
    if (block_quad_)
        g_->uniform(block_quad_, "u_opacity", &a, 1);
}

void VideoLayer::arrange(bool drawn, int32_t order)
{
    order_ = order;
    if (!g_)
        return;
    drawn_ = drawn;
    show_blocks(blocks_shown_);
    g_->order(atlas_quad_, order);
    if (block_quad_)
        g_->order(block_quad_, order + 1);
}

void VideoLayer::place()
{
    if (!g_)
        return;
    g_->place(atlas_quad_, params.rect);
    g_->turn(atlas_quad_, params.turn());
    if (block_quad_) {
        g_->place(block_quad_, params.rect);
        g_->turn(block_quad_, params.turn());
    }
    set_opacity();
}

Stage VideoLayer::stage(int64_t now_ms)
{
    staged_ = Staged();
    if (!g_ || !drawn_)
        return Stage::Idle;
    /* Quiet tiles due to settle are written from front_, still the newest
     * frame, when no newer one waits; the packed quad gives way to the exact
     * atlas when no newer frame needed it for kRefineMs. */
    const int64_t settle_ms = planner_.settle_due_ms();
    const bool settle = !front_pending_ && settle_ms >= 0 && now_ms >= settle_ms;
    const bool refine = blocks_shown_ && !front_pending_ && now_ms >= refine_due_ms_;
    if (!(front_pending_ || settle || refine) || (!clock_.due(now_ms) && !parked_))
        return Stage::Idle;
    if (!pacer_.ready(now_ms)) {
        held_budget_++;
        return Stage::Idle;
    }
    return stage_exact(now_ms, front_pending_);
}

/* The plan's rectangles go into the one buffer in place; the compositor's
 * one flush then shows them, so the cluster never shows a frame half
 * written. setData's bytes travel raw in the flush: what the budget
 * charges. A new frame whose exact write costs more than the packed one and
 * more than the budget allows at that moment goes packed instead, except
 * the layer's first frame in a scene: that goes whole and exact, its bytes
 * charged as debt. */
Stage VideoLayer::stage_exact(int64_t now_ms, bool fresh)
{
    if (blocks_shown_ && fresh) {
        const UploadPlan m = motion_.plan(block_src_.data(), front_.data(), now_ms);
        if (m.rects.empty()) {
            (m.quiet_tiles ? quiet_ : same_)++;
            front_pending_ = false;
            return Stage::Idle;
        }
    }
    const bool refine = blocks_shown_;
    const UploadPlan p = planner_.plan(shown_.data(), front_.data(), now_ms);
    if (p.rects.empty() && opaque_ && !refine && !buffer_stale_) {
        if (fresh)
            (p.quiet_tiles ? quiet_ : same_)++;
        shown_ms_ = front_ms_;   /* the buffer is front_ to within the threshold */
        front_pending_ = false;
        return Stage::Idle;
    }
    /* Whole: a plan of most tiles, or a buffer a failed write (or a new
     * scene) left unlike shown_. */
    const bool whole = p.whole || buffer_stale_;
    const size_t raw = whole ? front_.size() : p.bytes;
    if (fresh && !first_ && p_.pan_blocks && raw > packed_.size() && pacer_.allowance() < (int64_t)raw) {
        planner_.reset();   /* the atlas is not written: no tile of it is left quiet */
        return stage_blocks(now_ms, fresh);
    }
    settled_ += p.settled_tiles;
    const std::vector<PixelRect> all{PixelRect{0, 0, p_.w, atlas_h_}};
    staged_.kind = Kind::Exact;
    staged_.fresh = fresh;
    staged_.offered_ms = front_ms_;
    staged_.whole = whole;
    staged_.refine = refine;
    staged_.raw = raw;
    staged_.rects = whole ? all : p.rects;
    bool written = true;
    staged_.accepted = crk::write_rects(
        front_.data(), p_.w, 1, staged_.rects, &rect_scratch_,
        [this](const uint8_t *px, const PixelRect &r) { return g_->write(atlas_buf_, r.x, r.y, r.w, r.h, px); },
        &written);
    if (!written) {
        refused_++;
        return Stage::Failed;
    }
    if (!opaque_) {
        opaque_ = true;   /* undone in committed() if the flush fails */
        set_opacity();
    }
    parked_ = false;
    show_blocks(refine ? false : blocks_shown_);
    return Stage::Wrote;
}

/* The whole of front_ packed into the bank not shown, which then shows: a
 * failed write or flush leaves the shown bank and quad as they were. */
Stage VideoLayer::stage_blocks(int64_t, bool fresh)
{
    crk::pack_blocks(front_.data(), p_.w, p_.h, packed_.data(), kPackThreads);
    staged_.kind = Kind::Blocks;
    staged_.fresh = fresh;
    staged_.offered_ms = front_ms_;
    staged_.next_bank = 1 - block_bank_;
    staged_.was_shown = blocks_shown_;
    staged_.was_parked = parked_;
    staged_.raw = packed_.size();
    bool written = g_->write(block_buf_[staged_.next_bank], 0, 0, crk::block_texels_w(p_.w),
                             crk::block_texels_h(p_.h), packed_.data());
    staged_.accepted = written ? packed_.size() : 0;
    if (!written)
        refused_++;
    if (written)
        written = g_->texture(block_quad_, "u_image", block_buf_[staged_.next_bank]);
    if (!written)
        return Stage::Failed;
    if (!opaque_) {
        opaque_ = true;
        set_opacity();
    }
    parked_ = false;   /* the stale atlas is hidden in this flush */
    show_blocks(true);
    return Stage::Wrote;
}

void VideoLayer::committed(bool ok, int64_t now_ms)
{
    const Staged s = staged_;
    staged_ = Staged();
    if (s.kind == Kind::None)
        return;
    /* A failed update is retried with the newest frame: packed blocks at the
     * next deadline, an exact write as soon as the budget allows. */
    clock_.sent(now_ms);
    if (!ok) {
        failed_++;
        pacer_.spend(s.accepted);
        if (s.kind == Kind::Blocks) {
            g_->texture(block_quad_, "u_image", block_buf_[block_bank_]);
            parked_ = s.was_parked;
            show_blocks(s.was_shown);
        } else {
            /* Part of front_ may be in the buffer, unflushed: the next write
             * is whole, and until it goes the target holds its flushes
             * (holds_flush), so the cluster keeps showing the last frame
             * and never a half-written one. The packed quad keeps showing
             * if it was. */
            buffer_stale_ = true;
            parked_ = !s.refine;
            show_blocks(s.refine ? true : blocks_shown_);
            /* A settle write that failed still has a frame to show: the next
             * deadline writes it whole. */
            if (!s.refine)
                front_pending_ = true;
        }
        if (shown_ms_ < 0 && !blocks_shown_) {
            opaque_ = false;
            set_opacity();
        }
        return;
    }
    if (s.fresh) {
        sent_++;
        age_ms_ += (uint64_t)std::max<int64_t>(0, now_ms - s.offered_ms);
    }
    bytes_ += s.raw;
    pacer_.spend(s.raw);
    if (s.kind == Kind::Blocks) {
        block_bank_ = s.next_bank;
        block_src_.assign(front_.begin(), front_.end());
        refine_due_ms_ = now_ms + kRefineMs;
        packed_writes_++;
        front_pending_ = false;   /* buffer_stale_ stays: the atlas still needs a whole write */
        return;
    }
    buffer_stale_ = false;
    first_ = false;
    /* shown_ is what the buffer holds: all of front_, or front_ in the
     * written rectangles; front_ stays the newest frame while quiet tiles
     * are left (planner_.quiet()). */
    if (s.whole) {
        shown_.swap(front_);
        planner_.reset();
        whole_writes_++;
    } else {
        crk::copy_rects(shown_.data(), front_.data(), p_.w, 1, s.rects);
        partial_writes_++;
    }
    if (s.refine) {
        refine_due_ms_ = -1;
        refines_++;
    }
    rects_ += s.rects.size();
    shown_ms_ = front_ms_;
    front_pending_ = false;
}

int64_t VideoLayer::wake_in_ms(int64_t now_ms) const
{
    if (!g_ || !drawn_ || !front_pending_)
        return -1;
    const int64_t w = clock_.ms_until_due(now_ms);
    return w > 0 ? w : -1;
}

WriteStats VideoLayer::write_stats() const
{
    WriteStats w;
    w.frames = sent_;
    w.age_ms = age_ms_;
    w.bytes = bytes_;
    w.failed = failed_;
    w.holds = held_budget_;
    return w;
}

std::string VideoLayer::stats() const
{
    char b[256];
    std::snprintf(b, sizeof b,
                  "%llu sent, %llu unchanged, %llu within threshold, %llu superseded, %llu settled, %llu failed "
                  "(%llu refused), %llu KB, %llu whole, %llu partial, %llu rects, %llu packed, %llu back to exact, "
                  "%llu budget holds",
                  (unsigned long long)sent_, (unsigned long long)same_, (unsigned long long)quiet_,
                  (unsigned long long)superseded_, (unsigned long long)settled_, (unsigned long long)failed_,
                  (unsigned long long)refused_, (unsigned long long)(bytes_ / 1024),
                  (unsigned long long)whole_writes_, (unsigned long long)partial_writes_, (unsigned long long)rects_,
                  (unsigned long long)packed_writes_, (unsigned long long)refines_,
                  (unsigned long long)held_budget_);
    return b;
}

}  // namespace crs
