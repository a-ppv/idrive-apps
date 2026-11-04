// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "map_feeds.h"

#include "log.h"

namespace woc {

namespace {

/* The renderer target a cluster target names: "map" ("sail" too) or
 * "panel"; empty for anything else (the HUD is its own setting). */
std::string cluster_target(const std::string &name)
{
    return name == "map" || name == "sail" ? "map" : name == "panel" ? name : std::string();
}

}  // namespace

MapFeeds::MapFeeds(const FeedConfig &base, bool cluster, bool hud, unsigned hud_fps)
    : base_(base), hud_fps_(hud_fps), cluster_on_(cluster), hud_on_(hud)
{
    base_.target = cluster_target(base.target);
    if (base_.target.empty()) {
        log_error("target %s is not the cluster's (map, panel); using map", base.target.c_str());
        base_.target = "map";
    }
    if (base_.hud_width_pct > kHudMaxPct)
        base_.hud_width_pct = kHudMaxPct;
    follow();
}

void MapFeeds::follow()
{
    if (cluster_on_ != !!cluster_) {
        /* off, its connection closes: the renderer drops its layer and the
         * KOMBI shows its own content again */
        if (cluster_on_) {
            cluster_.reset(new MapFeed(base_));
            cluster_->set_stream(live_, frozen_, picture_);
        } else {
            cluster_.reset();
        }
        log_info("cluster: %s", cluster_on_ ? "on" : "off");
    }
    const bool want = hud_on_ && (!cluster_on_ || base_.target == "map");
    if (want == !!hud_)
        return;
    if (!want) {
        /* its connection closes: the renderer drops its layer and lets the
         * HUD's slot go */
        hud_.reset();
        hud_copy_.clear();
        hud_copy_.shrink_to_fit();
        log_info("hud: off");
        return;
    }
    FeedConfig fc = base_;
    fc.target = "hud";
    fc.rect = MapRect();   /* map_rect is the cluster's */
    fc.video.fps = hud_fps_;
    /* the HUD's frames go exact, into debt, and wait while the HUD's share
     * is in debt: no packing on the renderer's thread for the HUD */
    fc.video.pan_blocks = false;
    hud_.reset(new MapFeed(fc));
    hud_->set_stream(live_, frozen_, picture_);
    log_info("hud: on, at most %u frames a second", hud_fps_);
}

bool MapFeeds::set_target(const std::string &name)
{
    const std::string t = cluster_target(name);
    if (t.empty() || (cluster_ && !cluster_->set_target(t)))
        return false;
    base_.target = t;
    if (hud_on_ && cluster_on_ && t != "map")
        log_warn("hud: not while the map is on %s, which shares the HUD's scene id", t.c_str());
    follow();
    return true;
}

void MapFeeds::set_cluster(bool on)
{
    cluster_on_ = on;
    follow();
}

void MapFeeds::set_hud(bool on)
{
    hud_on_ = on;
    follow();
}

bool MapFeeds::wants_frames() const
{
    return cluster_ || (hud_ && hud_->takes_frames());
}

void MapFeeds::set_hud_width(unsigned pct)
{
    if (pct > kHudMaxPct)
        pct = kHudMaxPct;
    base_.hud_width_pct = pct;
    if (hud_)
        hud_->set_hud_width(pct);
}

void MapFeeds::set_hud_offset(int dx, int dy)
{
    base_.hud_offset_x = dx;
    base_.hud_offset_y = dy;
    if (!hud_)
        return;
    hud_->set_hud_offset(dx, dy);
}

void MapFeeds::set_guide_hold(bool hold)
{
    base_.guide_hold = hold;
    if (cluster_)
        cluster_->set_guide_hold(hold);
}

size_t MapFeeds::poll_fds(std::vector<pollfd> *fds) const
{
    const size_t first = fds->size();
    for (const MapFeed *f : {cluster_.get(), hud_.get()})
        if (f)
            fds->push_back(pollfd{f->fd(), (short)(f->fd() >= 0 ? (POLLIN | (f->wants_write() ? POLLOUT : 0)) : 0), 0});
    return first;
}

void MapFeeds::poll(int64_t now_ms)
{
    if (cluster_)
        cluster_->poll(now_ms);
    if (hud_)
        hud_->poll(now_ms);
}

int64_t MapFeeds::wake_in_ms(int64_t now_ms) const
{
    return hud_ ? hud_->wake_in_ms(now_ms) : -1;
}

void MapFeeds::offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms)
{
    /* The cluster's first; the HUD's copy only once its bytes are on their
     * way, and none while cluster-render's guard keeps the HUD off. The HUD
     * alone takes the frame itself. */
    const bool hud = hud_ && hud_->takes_frames();
    if (!cluster_) {
        if (hud)
            hud_->offer(atlas, id, now_ms);
        return;
    }
    cluster_->offer(atlas, id, now_ms, hud ? &hud_copy_ : nullptr);
    if (hud && !hud_copy_.empty())
        hud_->offer(&hud_copy_, id, now_ms);
}

void MapFeeds::set_stream(bool live, bool frozen, Picture picture)
{
    live_ = live;
    frozen_ = frozen;
    picture_ = picture;
    if (cluster_)
        cluster_->set_stream(live, frozen, picture);
    if (hud_)
        hud_->set_stream(live, frozen, picture);
}

FeedStatus MapFeeds::status(const std::string &decode, const std::string &stream) const
{
    FeedStatus s;
    if (cluster_) {
        s = cluster_->status(decode, stream);
    } else {
        s.state = "off";
        s.target = base_.target;
        s.page = decode;
        s.guide_hold = base_.guide_hold;
    }
    s.cluster = cluster_on_;
    s.hud = hud_on_;
    if (!hud_) {
        s.hud_state = "off";
    } else {
        const FeedStatus h = hud_->status(decode, stream);
        s.hud_state = h.disabled ? "disabled" : h.state;
        if (!cluster_) {
            s.upload_cap_kb = h.upload_cap_kb;
            s.upload_reason = h.upload_reason;
        }
    }
    s.hud_width_pct = base_.hud_width_pct;
    s.hud_offset_x = hud_ ? hud_->hud_offset_x() : base_.hud_offset_x;
    s.hud_offset_y = hud_ ? hud_->hud_offset_y() : base_.hud_offset_y;
    return s;
}

void MapFeeds::request_report()
{
    if (cluster_)
        cluster_->request_report();
    if (hud_)
        hud_->request_report();
}

std::string MapFeeds::report() const
{
    return (cluster_ ? cluster_->report() : std::string()) + (hud_ ? "--- hud\n" + hud_->report() : std::string());
}

}  // namespace woc
