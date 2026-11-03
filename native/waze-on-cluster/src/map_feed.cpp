// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "map_feed.h"

#include <cstdio>
#include <cstdlib>
#include <sstream>

#include "log.h"
#include "map_geometry.h"

namespace woc {

const char *const MapFeed::kWaiting = "Waiting for the phone's map";

namespace {

/* The size of a target in the renderer's hello ("map:1088x480,panel:..."). */
bool target_size(const std::string &targets, const std::string &name, uint32_t *w, uint32_t *h)
{
    std::stringstream ss(targets);
    std::string t;
    while (std::getline(ss, t, ',')) {
        const size_t colon = t.find(':');
        if (colon == std::string::npos || t.compare(0, colon, name) != 0 || colon != name.size())
            continue;
        return std::sscanf(t.c_str() + colon + 1, "%ux%u", w, h) == 2;
    }
    return false;
}

}  // namespace

MapFeed::MapFeed(const FeedConfig &cfg) : cfg_(cfg), client_("waze-on-cluster", cfg.socket)
{
    client_.on_ready = [this] {
        connected_ = true;
        /* The layer is made again on this connection, so only a refusal on it
         * counts, and no status request is outstanding on it. */
        refused_.clear();
        status_asked_ = false;
        log_info("render: connected to the cluster renderer (%s; %s)", client_.backend.c_str(), client_.targets.c_str());
        if (!layer_)
            make_layer();
    };
    client_.on_layer = [this](uint32_t ref, const std::string &state, const std::string &reason) {
        if (ref != layer_)
            return;
        if (state != layer_state_ || reason != layer_reason_)
            log_info("render: map %s%s%s", state.c_str(), reason.empty() ? "" : " - ", reason.c_str());
        layer_state_ = state;
        layer_reason_ = reason;
    };
    client_.on_target = [this](const std::string &t, const std::string &state, const std::string &holder,
                               const std::string &reason) {
        if (t != cfg_.target)
            return;
        target_state_ = state;
        holder_ = holder;
        target_reason_ = reason;
    };
    client_.on_budget = [this](unsigned cap, unsigned max, const std::string &reason) {
        cap_kb_ = cap;
        max_kb_ = max;
        budget_reason_ = reason;
    };
    client_.on_error = [this](const std::string &op, uint32_t, const std::string &reason) {
        log_error("render: %s refused: %s", op.c_str(), reason.c_str());
        if (op == "layer") {
            refused_ = reason;
        }
    };
    client_.on_status = [this](const std::string &text) {
        report_ = text;
        status_asked_ = false;
    };
}

void MapFeed::make_layer()
{
    uint32_t tw = 0, th = 0;
    if (!target_size(client_.targets, cfg_.target, &tw, &th)) {
        refused_ = "the cluster renderer has no target " + cfg_.target;
        log_error("render: %s", refused_.c_str());
        return;
    }
    /* The map area: all of the map slot's scene, the centred 1088x480 of a
     * whole-panel one, a fitted centre on the HUD. */
    crk::QuadRect q = quad(tw, th);
    if (cfg_.rect.set() && cfg_.rect.fits(tw, th))
        q = crk::QuadRect{cfg_.rect.x, cfg_.rect.y, cfg_.rect.w, cfg_.rect.h};
    else if (cfg_.rect.set())
        log_warn("render: map_rect %u,%u,%u,%u is outside %s (%ux%u); the map area instead", cfg_.rect.x,
                 cfg_.rect.y, cfg_.rect.w, cfg_.rect.h, cfg_.target.c_str(), tw, th);
    /* Shown smaller than the decoded frame: the frame is scaled to the size
     * it is shown at (a multiple of 4 wide and high, as the renderer and
     * packed motion need), drawn 1:1 centred where the quad was. */
    cr::VideoOptions vo = cfg_.video;
    scaling_ = false;
    pending_ready_ = false;
    const uint32_t sw = q.w & ~3u, sh = q.h & ~3u;
    if (cfg_.scale_down && (sw < cfg_.video.w || sh < cfg_.video.h) && sw >= 64 && sh >= 32 &&
        scaler_.configure(cfg_.video.w, cfg_.video.h, sw, sh, cfg_.scaled_level_bits)) {
        q.x += (q.w - sw) / 2;
        q.y += (q.h - sh) / 2;
        q.w = sw;
        q.h = sh;
        vo.w = sw;
        vo.h = sh;
        scaling_ = true;
        scaler_.set_corner_radius(cfg_.target == "hud" && cfg_.hud_round_corners ? (sh / 12 > 6 ? sh / 12 : 6) : 0);
        scaler_.set_black_background(cfg_.target == "hud" && cfg_.hud_black_background);
    }
    lo_ = cr::LayerOptions();
    lo_.target = cfg_.target;
    lo_.klass = "content";
    lo_.contend = true;   /* the map takes the slot back from the stock map */
    lo_.guide_hold = cfg_.guide_hold;
    lo_.x = (int)q.x;
    lo_.y = (int)q.y;
    lo_.w = q.w;
    lo_.h = q.h;
    lo_.visible = live_ && !frozen_ && picture_ == Picture::Shown;
    refused_.clear();
    layer_state_ = "stalled";
    layer_reason_.clear();
    target_state_.clear();
    target_reason_.clear();
    holder_.clear();
    layer_ = client_.video(lo_, vo);
    log_info("render: map layer on %s (%ux%u), quad %ux%u at %u,%u%s", cfg_.target.c_str(), tw, th, q.w, q.h, q.x, q.y,
             scaling_ ? ", the frame scaled to it on the head unit" : "");
}

/* Where the map goes on a target of tw x th: the kit's fitted rect, or on
 * the HUD with a size set, that width (the picture's shape kept, at most the
 * HUD's height), centred. */
crk::QuadRect MapFeed::quad(uint32_t tw, uint32_t th) const
{
    const unsigned pct = cfg_.hud_width_pct;
    if (cfg_.target != "hud" || !pct || !cfg_.video.w || !cfg_.video.h)
        return crk::map_quad(tw, th, cfg_.video.w, cfg_.video.h);
    uint64_t w = (uint64_t)tw * (pct > kHudMaxPct ? kHudMaxPct : pct) / 100;
    uint64_t h = (w * cfg_.video.h + cfg_.video.w / 2) / cfg_.video.w;
    if (h > th) {
        h = th;
        w = (h * cfg_.video.w + cfg_.video.h / 2) / cfg_.video.h;
    }
    return crk::QuadRect{(uint32_t)((tw - w) / 2), (uint32_t)((th - h) / 2), (uint32_t)w, (uint32_t)h};
}

void MapFeed::set_hud_width(unsigned pct)
{
    if (pct == cfg_.hud_width_pct)
        return;
    cfg_.hud_width_pct = pct;
    uint32_t tw, th;
    if (cfg_.target != "hud" || !layer_ || !target_size(client_.targets, "hud", &tw, &th))
        return;
    /* the texture's size changes with it: a new layer at the new size */
    log_info("render: HUD map %u%% wide", pct);
    client_.drop(layer_);
    layer_ = 0;
    make_layer();
}

bool MapFeed::knows(const std::string &name) const
{
    uint32_t w, h;
    return !client_.connected() || target_size(client_.targets, name == "sail" ? "map" : name, &w, &h);
}

bool MapFeed::set_target(const std::string &name)
{
    const std::string t = name == "sail" ? "map" : name;
    uint32_t w, h;
    if (client_.connected() && !target_size(client_.targets, t, &w, &h))
        return false;
    if (t == cfg_.target && layer_)
        return true;
    if (layer_)
        client_.drop(layer_);
    layer_ = 0;
    cfg_.target = t;
    if (client_.connected())
        make_layer();
    return true;
}

void MapFeed::set_guide_hold(bool hold)
{
    cfg_.guide_hold = hold;
    if (layer_ && lo_.guide_hold != hold) {
        lo_.guide_hold = hold;
        client_.set(layer_, lo_);
    }
}

void MapFeed::poll(int64_t now_ms)
{
    client_.poll(now_ms);
    send_pending(now_ms);
    if (connected_ && !client_.connected()) {
        connected_ = false;
        log_warn("render: the cluster renderer went away; reconnecting");
    }
    if (client_.connected()) {
        down_since_ms_ = -1;
    } else if (down_since_ms_ < 0) {
        down_since_ms_ = now_ms;
    } else if (!down_long_ && now_ms - down_since_ms_ >= kUnreachableMs) {
        down_long_ = true;
    }
    if (client_.connected() && down_long_) {
        down_long_ = false;
    }
    count_second(now_ms);
}

void MapFeed::count_second(int64_t now_ms)
{
    if (now_ms - second_ms_ < 1000)
        return;
    const int rate = second_ms_ ? (int)((int64_t)frames_ * 1000 / (now_ms - second_ms_)) : 0;
    rate_ = rate;
    frames_ = 0;
    second_ms_ = now_ms;
}

void MapFeed::offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms)
{
    if (scaling_ && layer_) {
        /* kept without a copy: the buffer handed back is the last pending
         * one, the same size (a copy only for the first) */
        if (pending_.size() == atlas->size())
            pending_.swap(*atlas);
        else
            pending_ = *atlas;
        pending_ready_ = true;
        pending_id_ = id;
        send_pending(now_ms);
    } else if (layer_ && client_.frame(layer_, atlas, id)) {
        frames_++;
    }
    count_second(now_ms);
}

void MapFeed::send_pending(int64_t now_ms)
{
    if (!pending_ready_ || !layer_ || now_ms < next_send_ms_)
        return;
    scaler_.scale(pending_.data(), &scaled_);
    pending_ready_ = false;
    if (client_.frame(layer_, &scaled_, pending_id_))
        frames_++;
    next_send_ms_ = now_ms + (cfg_.video.fps ? 1000 / (int64_t)cfg_.video.fps : 0);
}

void MapFeed::set_stream(bool live, bool frozen, Picture picture)
{
    if (live == live_ && frozen == frozen_ && picture == picture_)
        return;
    const char *line = !live                       ? "is not live"
                       : frozen                    ? "froze"
                       : picture == Picture::None  ? "is live, no frame yet"
                       : picture == Picture::Blank ? "is live, its picture blank"
                                                   : "is live, with a picture";
    if (line != stream_line_)   /* frames after the stream ends change only the verdicts */
        log_info("render: CarPlay's cluster stream %s", line);
    stream_line_ = line;
    live_ = live;
    frozen_ = frozen;
    picture_ = picture;
    const bool visible = live && !frozen && picture == Picture::Shown;
    if (layer_ && lo_.visible != visible) {
        lo_.visible = visible;
        client_.set(layer_, lo_);
    }
}

void MapFeed::request_report()
{
    if (client_.connected() && !status_asked_) {
        client_.request_status();
        status_asked_ = true;
    }
}

bool StatusLog::due(const FeedStatus &s, int64_t now_ms)
{
    const std::string state = s.state + '\n' + s.target;
    if (logged_ && state == state_) {
        if (s.reason == reason_)
            return false;
        if (s.stream_reason || stream_) {
            if (now_ms - stream_ms_ < kStreamMs)
                return false;
            stream_ms_ = now_ms;
        }
    }
    state_ = state;
    reason_ = s.reason;
    stream_ = s.stream_reason;
    logged_ = true;
    return true;
}

FeedStatus MapFeed::status(const std::string &decode, const std::string &stream) const
{
    FeedStatus s;
    s.target = cfg_.target;
    s.hud_width_pct = cfg_.hud_width_pct;
    s.upload_cap_kb = cap_kb_;
    s.upload_reason = budget_reason_;
    s.guide_hold = cfg_.guide_hold;
    auto g = client_.guide_disabled.find(cfg_.target);
    s.guide_disabled = client_.connected() && g != client_.guide_disabled.end() && g->second;
    char cap[96] = "";
    if (cap_kb_ && cap_kb_ < max_kb_)
        std::snprintf(cap, sizeof cap, ", upload cap %u KB/s", cap_kb_);
    if (!refused_.empty()) {
        s.state = "error";
        s.reason = refused_;
        s.page = decode;
    } else if (!client_.connected()) {
        s.state = down_long_ ? "error" : "starting";
        s.reason = down_long_ ? "cluster renderer not reachable" : "waiting for the cluster renderer";
        s.page = decode;
    } else if (frozen_ && live_) {
        s.state = "frozen";
        s.reason = "the phone's cluster stream froze";
        s.page = decode;
    } else if (!live_) {
        s.state = "idle";
        s.page = decode;
    } else if (picture_ != Picture::Shown) {
        s.state = "idle";   /* the layer hidden: the stock map shows */
        s.page = decode;
        s.reason = stream;
        s.stream_reason = !stream.empty();
        if (stream.empty() && picture_ == Picture::Blank)
            s.reason = kWaiting;
    } else if (layer_state_ == "shown") {
        s.state = "showing";
        char p[400];
        std::snprintf(p, sizeof p, "Waze map — %d frames/s (%s%s)", rate_, decode.c_str(), cap);
        s.page = p;
        s.reason = stream;
        s.stream_reason = !stream.empty();
    } else if (layer_state_ == "waiting" || layer_state_ == "suspended") {
        s.state = "starting";
        s.page = decode;
        if (layer_state_ == "suspended")
            s.reason = "under an alert on the cluster";
        else if (target_reason_.find("pop-up") != std::string::npos)
            s.reason = "a HUD pop-up is open; the map returns when it closes";
        else if (holder_ == "stock")
            s.reason = "the stock map holds the slot";
        else if (holder_ == "foreign")
            s.reason = "another app holds the slot";
        else
            s.reason = layer_reason_;
    } else if (layer_state_ == "error") {
        s.state = "error";
        s.reason = layer_reason_;
        s.page = decode;
    } else {
        s.state = "idle";   /* stalled: no frames yet, or none for idle_ms */
        s.page = decode;
        s.reason = stream;
        s.stream_reason = !stream.empty();
    }
    return s;
}

}  // namespace woc
