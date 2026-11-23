// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "map_feed.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <sstream>

#include "log.h"
#include "map_geometry.h"

namespace woc {

const char *const MapFeed::kWaiting = "Waiting for the phone's map";
const char *const MapFeed::kHostHidden = "hidden by the app it is shown in";

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

/* Why always_packed does not apply to a layer (MapFeed::unpacked_why_). */
const char *const kOddSize = "its size is not a multiple of 4";
const char *const kNotTaken = "the cluster renderer does not take it";

}  // namespace

MapFeed::MapFeed(const FeedConfig &cfg)
    : cfg_(cfg), client_("waze-on-cluster", cfg.socket), placed_x_(cfg.hud_offset_x), placed_y_(cfg.hud_offset_y)
{
    client_.on_ready = [this] {
        connected_ = true;
        /* The layer is made again on this connection, so only a refusal on it
         * counts, and no status request is outstanding on it. */
        refused_.clear();
        status_asked_ = false;
        log_info("render: connected to the cluster renderer (%s; %s)", client_.backend.c_str(), client_.targets.c_str());
        if (!layer_) {
            make_layer();
        } else if (cfg_.always_packed && unpacked_why_ != kOddSize &&
                   (unpacked_why_ == nullptr) != client_.takes_always_packed()) {
            /* a cluster-render that takes always_packed now, or no longer:
             * the layer made again for it, its next write whole */
            remake_layer();
        }
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
                               const std::string &) {
        if (t != drawn_target())
            return;
        target_state_ = state;
        holder_ = holder;
    };
    client_.on_host = [this](const cr::Host &h) {
        if (h.target == cfg_.target)
            set_host(h);
    };
    client_.on_budget = [this](unsigned cap, unsigned max, const std::string &reason) {
        cap_kb_ = cap;
        max_kb_ = max;
        budget_reason_ = reason;
    };
    client_.on_error = [this](const std::string &op, uint32_t ref, const std::string &reason) {
        log_error("render: %s refused: %s", op.c_str(), reason.c_str());
        if (op == "layer") {
            refused_ = reason;
            /* the hosted layer refused: on the feed's own target (poll) */
            if (hosted() && ref == layer_) {
                host_unusable_ = true;
                remake_ = true;
            }
        }
    };
    client_.on_status = [this](const std::string &text) {
        report_ = text;
        status_asked_ = false;
    };
}

void MapFeed::make_layer()
{
    part_ = OutputPart();
    uint32_t tw = 0, th = 0;
    if (!target_size(client_.targets, cfg_.target, &tw, &th)) {
        refused_ = "the cluster renderer has no target " + cfg_.target;
        log_error("render: %s", refused_.c_str());
        return;
    }
    show_due_ = false;
    refused_.clear();
    layer_state_ = "stalled";
    layer_reason_.clear();
    target_state_.clear();
    holder_.clear();
    /* Hidden by its host: no layer anywhere, nothing sent. */
    if (hosted() && !host_.shown)
        return;
    /* The map area: all of the map slot's scene, the centred 1088x480 of a
     * whole-panel one, a fitted centre on the HUD. */
    crk::QuadRect q = quad(tw, th);
    if (cfg_.rect.set() && cfg_.rect.fits(tw, th))
        q = crk::QuadRect{cfg_.rect.x, cfg_.rect.y, cfg_.rect.w, cfg_.rect.h};
    else if (cfg_.rect.set())
        log_warn("render: map_rect %u,%u,%u,%u is outside %s (%ux%u); the map area instead", cfg_.rect.x,
                 cfg_.rect.y, cfg_.rect.w, cfg_.rect.h, cfg_.target.c_str(), tw, th);
    /* The HUD, shown smaller than the decoded frame: the frame is scaled to
     * the size it is shown at (a multiple of 4 wide and high, as the
     * renderer and packed motion need), drawn 1:1 centred where the quad
     * was. On the cluster the KOMBI scales a map_rect itself. */
    cr::VideoOptions vo = cfg_.video;
    scaling_ = false;
    const uint32_t sw = q.w & ~3u, sh = q.h & ~3u;
    if (hosted()) {
        /* Hosted: the part of the picture the host's src covers where the
         * map would be (q), where that part lands in the host's rect,
         * scaled on the head unit to at most that size. */
        MapRect crop, place;
        if (!host_crop(MapRect{q.x, q.y, q.w, q.h}, cfg_.video.w, cfg_.video.h,
                       MapRect{(uint32_t)host_.src_x, (uint32_t)host_.src_y, host_.src_w, host_.src_h},
                       MapRect{(uint32_t)host_.x, (uint32_t)host_.y, host_.w, host_.h}, &crop, &place)) {
            fall_back("the host's part of " + cfg_.target + " misses the map");
            return;
        }
        const uint32_t dw = (crop.w < place.w ? crop.w : place.w) & ~3u, dh = (crop.h < place.h ? crop.h : place.h) & ~1u;
        if (dw < 64 || dh < 32) {
            fall_back("the map's part in the host's rect is smaller than 64x32");
            return;
        }
        q = crk::QuadRect{place.x, place.y, place.w, place.h};
        vo.w = dw;
        vo.h = dh;
        scaling_ = true;
        shape_ = ScaleShape();
        shape_.w = cfg_.video.w;
        shape_.h = cfg_.video.h;
        shape_.dw = dw;
        shape_.dh = dh;
        shape_.crop_x = crop.x;
        shape_.crop_y = crop.y;
        shape_.crop_w = crop.w;
        shape_.crop_h = crop.h;
        shape_.level_bits = cfg_.video.level_bits;
        if (cfg_.vpp_scale)
            part_ = OutputPart{crop.x, crop.y, crop.w, crop.h, dw, dh};
        log_info("render: hosted on %s: the map's %ux%u at %u,%u, as %ux%u%s", host_.into.c_str(), crop.w,
                 crop.h, crop.x, crop.y, dw, dh, part_.set() ? ", made by VPP (hosted_vpp_scale)" : "");
    } else if (cfg_.target == "hud" && cfg_.scale_down && (sw < cfg_.video.w || sh < cfg_.video.h) && sw >= 64 &&
               sh >= 32 && sw <= cfg_.video.w && sh <= cfg_.video.h) {
        q.x += (q.w - sw) / 2;
        q.y += (q.h - sh) / 2;
        q.w = sw;
        q.h = sh;
        vo.w = sw;
        vo.h = sh;
        scaling_ = true;
        shape_ = ScaleShape();
        shape_.w = cfg_.video.w;
        shape_.h = cfg_.video.h;
        shape_.dw = sw;
        shape_.dh = sh;
        shape_.level_bits = cfg_.scaled_level_bits;
        shape_.radius = cfg_.hud_round_corners ? (sh / 12 > 6 ? sh / 12 : 6) : 0;
        shape_.black = cfg_.hud_black_background;
    }
    /* a VPP-made picture is of no use to a layer of another part, or none */
    if (held_part_.set() && held_part_ != part_) {
        held_part_ = OutputPart();
        held_.clear();
        held_new_ = false;
    }
    if (cfg_.always_packed) {
        /* the size first: only the renderer's answer changes on a reconnect */
        const char *why = vo.w % 4 || vo.h % 4 ? kOddSize : !client_.takes_always_packed() ? kNotTaken : nullptr;
        if (why && why != unpacked_why_)
            log_warn("render: always_packed: the map's %ux%u not packed, %s: its updates as pan_blocks decides", vo.w,
                     vo.h, why);
        unpacked_why_ = why;
        vo.always_packed = !why;
        vo.pan_blocks = vo.pan_blocks || vo.always_packed;
    }
    lo_ = cr::LayerOptions();
    lo_.target = drawn_target();
    lo_.klass = "content";
    /* the map takes the slot back from the stock map; in a host's scene
     * the scene's owner decides that */
    lo_.contend = !hosted();
    lo_.guide_hold = cfg_.guide_hold;
    lo_.yield = hosted() || cfg_.target != "hud" || !cfg_.hud_keep_shown;
    /* marked as the hosted map, so a theme hosting it from its layers draws
     * it under them (an older renderer ignores the field) */
    lo_.hosted = hosted() ? cfg_.target : std::string();
    lo_.x = (int)q.x;
    lo_.y = (int)q.y;
    lo_.w = q.w;
    lo_.h = q.h;
    lo_.visible = live_ && !frozen_ && picture_ == Picture::Shown;
    layer_ = client_.video(lo_, vo);
    if (hosted())
        target_size(client_.targets, host_.into, &tw, &th);
    log_info("render: map layer on %s (%ux%u), quad %ux%u at %u,%u%s%s", lo_.target.c_str(), tw, th, q.w, q.h, q.x, q.y,
             part_.set() ? ", the part made to it by VPP on the GPU"
             : scaling_  ? ", the frame scaled to it on the head unit"
                         : "",
             vo.always_packed ? ", every update packed (always_packed)" : "");
}

void MapFeed::fall_back(const std::string &why)
{
    log_warn("render: %s: the map on %s instead, until the host changes", why.c_str(), cfg_.target.c_str());
    host_unusable_ = true;
    make_layer();
}

void MapFeed::set_host(const cr::Host &h)
{
    if (h == host_)
        return;
    host_ = h;
    host_unusable_ = remake_ = false;
    part_ = OutputPart();   /* the next layer's, if any */
    if (!hosted())
        log_info("render: %s is not hosted any more: the map on its own target", cfg_.target.c_str());
    else
        log_info("render: %s hosted on %s at %ux%u+%d+%d%s", cfg_.target.c_str(), h.into.c_str(), h.w, h.h,
                 h.x, h.y, h.shown ? "" : ", hidden there: nothing sent");
    remake_layer();
}

void MapFeed::remake_layer()
{
    if (layer_) {
        keep_newest();
        client_.drop(layer_);
        layer_ = 0;
    }
    if (client_.connected())
        make_layer();
}

/* Where the map goes on a target of tw x th: the kit's fitted rect, or on
 * the HUD with a size set, that width (the picture's shape kept, at most the
 * HUD's height), centred; on the HUD then moved by the offset, held inside
 * the scene. */
crk::QuadRect MapFeed::quad(uint32_t tw, uint32_t th) const
{
    if (cfg_.target != "hud" || !cfg_.video.w || !cfg_.video.h)
        return crk::map_quad(tw, th, cfg_.video.w, cfg_.video.h);
    crk::QuadRect q;
    const unsigned pct = cfg_.hud_width_pct;
    if (!pct) {
        q = crk::map_quad(tw, th, cfg_.video.w, cfg_.video.h);
    } else {
        uint64_t w = (uint64_t)tw * (pct > kHudMaxPct ? kHudMaxPct : pct) / 100;
        uint64_t h = (w * cfg_.video.h + cfg_.video.w / 2) / cfg_.video.w;
        if (h > th) {
            h = th;
            w = (h * cfg_.video.w + cfg_.video.h / 2) / cfg_.video.h;
        }
        q = crk::QuadRect{(uint32_t)((tw - w) / 2), (uint32_t)((th - h) / 2), (uint32_t)w, (uint32_t)h};
    }
    const long x = (long)q.x + cfg_.hud_offset_x, y = (long)q.y + cfg_.hud_offset_y;
    const long xmax = (long)tw - (long)q.w, ymax = (long)th - (long)q.h;
    const uint32_t cx = q.x, cy = q.y;
    q.x = (uint32_t)(x < 0 ? 0 : x > xmax ? xmax : x);
    q.y = (uint32_t)(y < 0 ? 0 : y > ymax ? ymax : y);
    placed_x_ = (int)q.x - (int)cx;
    placed_y_ = (int)q.y - (int)cy;
    return q;
}

void MapFeed::set_hud_offset(int dx, int dy)
{
    if (dx == cfg_.hud_offset_x && dy == cfg_.hud_offset_y)
        return;
    cfg_.hud_offset_x = placed_x_ = dx;
    cfg_.hud_offset_y = placed_y_ = dy;
    uint32_t tw, th;
    /* hosted, the host places it: the offset waits for the HUD's own */
    if (cfg_.target != "hud" || !layer_ || hosted() || !target_size(client_.targets, "hud", &tw, &th))
        return;
    const crk::QuadRect q = quad(tw, th);
    lo_.x = (int)q.x;
    lo_.y = (int)q.y;
    client_.set(layer_, lo_);
    log_info("render: HUD map moved to %u,%u (offset %+d,%+d)", q.x, q.y, placed_x_, placed_y_);
}

void MapFeed::set_hud_keep_shown(bool keep)
{
    cfg_.hud_keep_shown = keep;
    const bool yield = hosted() || cfg_.target != "hud" || !keep;
    if (layer_ && lo_.yield != yield) {
        lo_.yield = yield;
        client_.set(layer_, lo_);
        log_info("render: HUD map %s", keep ? "kept shown over BMW's pop-ups" : "gives way to BMW's pop-ups");
    }
}

void MapFeed::set_hud_width(unsigned pct)
{
    if (pct == cfg_.hud_width_pct)
        return;
    cfg_.hud_width_pct = pct;
    uint32_t tw, th;
    /* hosted, the host sizes it: the width waits for the HUD's own */
    if (cfg_.target != "hud" || !layer_ || hosted() || !target_size(client_.targets, "hud", &tw, &th))
        return;
    /* the texture's size changes with it: a new layer at the new size */
    log_info("render: HUD map %u%% wide", pct);
    remake_layer();
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
    if (remake_) {
        remake_ = false;
        log_warn("render: the hosted layer refused: the map on %s instead, until the host changes", cfg_.target.c_str());
        remake_layer();
    }
    send_pending(now_ms);
    if (connected_ && !client_.connected()) {
        connected_ = false;
        log_warn("render: the cluster renderer went away; reconnecting");
        /* Its hosts went with it: the layer comes back on the feed's own
         * target, and in the host's scene again once it says so. */
        set_host(cr::Host());
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
    show_when_sent();
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

bool MapFeed::sending() const
{
    return layer_ && client_.connected() && (lo_.visible || show_due_);
}

/* Counted as the frames the client would send, whether or not they go. */
void MapFeed::offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms)
{
    if (layer_ && client_.connected())
        frames_++;
    if (scaling_ || !sending() || !client_.frame(layer_, atlas, id)) {
        hold(atlas, id);
    } else {
        id_ = id;
        held_new_ = elsewhere_ = in_worker_ = false;
    }
    send_pending(now_ms);
    count_second(now_ms);
}

void MapFeed::offer_part(std::vector<uint8_t> *atlas, uint64_t id, const OutputPart &part, int64_t now_ms)
{
    if (!part_.set() || part != part_)
        return;   /* made for a part the layer no longer shows */
    if (layer_ && client_.connected())
        frames_++;
    hold(atlas, id);
    held_part_ = part;
    send_pending(now_ms);
    count_second(now_ms);
}

void MapFeed::repeat(uint64_t id, int64_t now_ms)
{
    id_ = id;
    if (layer_ && client_.connected())
        frames_++;
    if (sending())
        send_newest();
    count_second(now_ms);
}

void MapFeed::send_newest()
{
    if (!held_new_)
        client_.repeat(layer_, id_);
    else if (!elsewhere_ && (!scaling_ || (held_part_.set() && worker_.idle())))
        held_new_ = !client_.frame(layer_, &held_, id_);
}

void MapFeed::send_pending(int64_t now_ms)
{
    uint64_t sid = 0;
    if (worker_.take(&scaled_, &sid, shape_, in_worker_ ? &held_ : nullptr)) {
        in_worker_ = false;
        if (!scaled_.empty() && layer_)
            client_.frame(layer_, &scaled_, sid);
    }
    /* a VPP-made picture goes as it is, after the worker's */
    if (held_part_.set()) {
        if (held_new_ && sending() && worker_.idle())
            held_new_ = !client_.frame(layer_, &held_, id_);
        return;
    }
    if (!scaling_ || !held_new_ || elsewhere_ || in_worker_ || !sending() || now_ms < next_send_ms_ ||
        !worker_.idle())
        return;
    if (worker_.submit(&held_, id_, shape_)) {
        held_new_ = false;
        in_worker_ = true;
        unsigned fps = cfg_.video.fps;
        if (fps_cap() && (!fps || fps_cap() < fps))
            fps = fps_cap();
        next_send_ms_ = now_ms + (fps ? 1000 / (int64_t)fps : 0);
    }
}

void MapFeed::hold(std::vector<uint8_t> *atlas, uint64_t id)
{
    id_ = id;
    held_.swap(*atlas);
    held_new_ = true;
    elsewhere_ = in_worker_ = false;
    held_part_ = OutputPart();
}

void MapFeed::changed(uint64_t id)
{
    id_ = id;
    held_new_ = elsewhere_ = true;
    in_worker_ = false;
}

bool MapFeed::wants_picture(int64_t now_ms) const
{
    return elsewhere_ && held_new_ && sending() && now_ms >= next_send_ms_ && worker_.idle();
}

bool MapFeed::latest(std::vector<uint8_t> *out) const
{
    if (elsewhere_ || in_worker_ || held_part_.set())
        return false;
    if (scaling_ ? held_.empty() : !held_new_)
        return layer_ && !scaling_ && client_.latest(layer_, out);
    *out = held_;
    return true;
}

bool MapFeed::disabled() const
{
    auto d = client_.disabled.find(cfg_.target);
    return client_.connected() && d != client_.disabled.end() && d->second;
}

int64_t MapFeed::wake_in_ms(int64_t now_ms) const
{
    if (!scaling_ || !layer_)
        return -1;
    if (!worker_.idle())
        return kScaleWaitMs;
    return held_new_ && sending() && !disabled() ? std::max<int64_t>(1, next_send_ms_ - now_ms) : -1;
}

void MapFeed::keep_newest()
{
    if (held_part_.set()) {   /* the layer's last VPP-made picture, for a layer of its part */
        if (!held_new_)
            held_new_ = client_.latest(layer_, &held_);
    } else if (scaling_)
        held_new_ = true;
    else if (!held_new_)
        held_new_ = client_.latest(layer_, &held_);
}

void MapFeed::show_when_sent()
{
    if (!show_due_ || !layer_ || client_.frame_waiting(layer_) || (held_new_ && (scaling_ || elsewhere_)) ||
        in_worker_)
        return;
    show_due_ = false;
    lo_.visible = true;
    client_.set(layer_, lo_);
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
    if (!layer_ || (lo_.visible || show_due_) == visible)
        return;
    show_due_ = visible;
    if (visible) {
        if (client_.connected())
            send_newest();
        show_when_sent();
    } else if (lo_.visible) {
        lo_.visible = false;
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
    s.target = drawn_target();
    s.hosted = hosted();
    s.hud_width_pct = cfg_.hud_width_pct;
    s.hud_offset_x = placed_x_;
    s.hud_keep_shown = cfg_.hud_keep_shown;
    s.hud_offset_y = placed_y_;
    s.upload_cap_kb = cap_kb_;
    s.upload_reason = budget_reason_;
    s.guide_hold = cfg_.guide_hold;
    auto g = client_.guide_disabled.find(cfg_.target);
    s.guide_disabled = client_.connected() && g != client_.guide_disabled.end() && g->second;
    s.disabled = disabled();
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
    } else if (hosted() && !host_.shown) {
        s.state = "idle";   /* no layer: nothing sent */
        s.page = decode;
        s.reason = kHostHidden;
    } else if (layer_state_ == "shown") {
        s.state = "showing";
        char p[400];
        std::snprintf(p, sizeof p, "map — %d frames/s (%s%s)", rate_, decode.c_str(), cap);
        s.page = p;
        s.reason = stream;
        s.stream_reason = !stream.empty();
    } else if (layer_state_ == "waiting" || layer_state_ == "suspended") {
        s.state = "starting";
        s.page = decode;
        if (layer_state_ == "suspended")
            s.reason = "under an alert on the cluster";
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
