// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "map_feeds.h"

#include <algorithm>

#include "log.h"

namespace woc {

bool parse_targets(const std::string &spec, std::vector<std::string> *out, std::string *err)
{
    std::vector<std::string> t;
    std::string word;
    const std::string s = spec + "+";
    for (char c : s) {
        if (c == '+' || c == ',') {
            if (word.empty()) {
                *err = "an empty target in \"" + spec + "\"";
                return false;
            }
            if (word == "both") {
                t.push_back("map");
                t.push_back("hud");
            } else if (word == "map" || word == "sail" || word == "cluster") {
                t.push_back("map");
            } else if (word == "panel" || word == "hud") {
                t.push_back(word);
            } else {
                *err = "unknown target \"" + word + "\" (map, panel, hud, map+hud)";
                return false;
            }
            word.clear();
        } else if (c != ' ') {
            word += c;
        }
    }
    for (size_t i = 0; i < t.size(); i++)
        for (size_t j = i + 1; j < t.size(); j++)
            if (t[i] == t[j]) {
                *err = "\"" + t[i] + "\" named twice";
                return false;
            }
    if (t.size() > 2) {
        *err = "at most two targets";
        return false;
    }
    const auto has = [&t](const char *n) { return std::find(t.begin(), t.end(), n) != t.end(); };
    if (has("map") && has("panel")) {
        *err = "map and panel are both the cluster";
        return false;
    }
    if (has("panel") && has("hud")) {
        *err = "panel and hud share a scene id and are never up at once";
        return false;
    }
    /* the cluster first: it is the one the status follows */
    std::stable_sort(t.begin(), t.end(), [](const std::string &a, const std::string &b) { return a != "hud" && b == "hud"; });
    *out = t;
    return true;
}

std::string join_targets(const std::vector<std::string> &targets)
{
    std::string s;
    for (const std::string &t : targets)
        s += (s.empty() ? "" : "+") + t;
    return s;
}

MapFeeds::MapFeeds(const FeedConfig &base) : base_(base)
{
    if (base_.hud_width_pct > kHudMaxPct)
        base_.hud_width_pct = kHudMaxPct;
    std::string err;
    if (!parse_targets(base.target, &targets_, &err)) {
        log_error("target: %s; using map", err.c_str());
        targets_ = {"map"};
    }
    for (const std::string &t : targets_)
        feeds_.push_back(make(t));
}

std::unique_ptr<MapFeed> MapFeeds::make(const std::string &target)
{
    FeedConfig fc = base_;
    fc.target = target;
    std::unique_ptr<MapFeed> f(new MapFeed(fc));
    f->set_stream(live_, frozen_, picture_);
    return f;
}

bool MapFeeds::set_targets(const std::string &spec)
{
    std::vector<std::string> want;
    std::string err;
    if (!parse_targets(spec, &want, &err)) {
        log_warn("start: %s", err.c_str());
        return false;
    }
    for (const std::string &t : want)
        if (!feeds_.empty() && !feeds_[0]->knows(t)) {
            log_warn("start: the cluster renderer has no target %s", t.c_str());
            return false;
        }
    if (want == targets_)
        return true;
    std::vector<std::unique_ptr<MapFeed>> next;
    for (const std::string &t : want) {
        std::unique_ptr<MapFeed> f;
        for (auto &old : feeds_)
            if (old && old->target() == t)
                f = std::move(old);
        next.push_back(f ? std::move(f) : make(t));
    }
    /* feeds left in the old list close their connections: the renderer drops
     * their layers and lets those slots go */
    feeds_ = std::move(next);
    log_info("targets: %s -> %s", join_targets(targets_).c_str(), join_targets(want).c_str());
    targets_ = want;
    return true;
}

void MapFeeds::set_hud_width(unsigned pct)
{
    if (pct > kHudMaxPct)
        pct = kHudMaxPct;
    base_.hud_width_pct = pct;
    for (auto &f : feeds_)
        f->set_hud_width(pct);
}

void MapFeeds::set_guide_hold(bool hold)
{
    base_.guide_hold = hold;
    for (auto &f : feeds_)
        f->set_guide_hold(hold);
}

void MapFeeds::set_hud_offset(int dx, int dy)
{
    base_.hud_offset_x = dx;
    base_.hud_offset_y = dy;
    for (auto &f : feeds_)
        f->set_hud_offset(dx, dy);
}

size_t MapFeeds::poll_fds(std::vector<pollfd> *fds) const
{
    const size_t first = fds->size();
    for (const auto &f : feeds_)
        fds->push_back({f->fd(), (short)(POLLIN | (f->wants_write() ? POLLOUT : 0)), 0});
    return first;
}

void MapFeeds::poll(int64_t now_ms)
{
    for (auto &f : feeds_)
        f->poll(now_ms);
}

void MapFeeds::offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms)
{
    /* the copies first: the first feed takes the frame's buffer */
    for (size_t i = 1; i < feeds_.size(); i++) {
        copy_.assign(atlas->begin(), atlas->end());
        feeds_[i]->offer(&copy_, id, now_ms);
    }
    if (!feeds_.empty())
        feeds_[0]->offer(atlas, id, now_ms);
}

void MapFeeds::set_stream(bool live, bool frozen, Picture picture)
{
    live_ = live;
    frozen_ = frozen;
    picture_ = picture;
    for (auto &f : feeds_)
        f->set_stream(live, frozen, picture);
}

FeedStatus MapFeeds::status(const std::string &decode, const std::string &stream) const
{
    if (feeds_.empty())
        return FeedStatus();
    FeedStatus s = feeds_[0]->status(decode, stream);
    for (size_t i = 1; i < feeds_.size(); i++) {
        const FeedStatus o = feeds_[i]->status(decode, stream);
        const std::string &name = targets_[i];
        if (o.state == "error" && s.state != "error") {
            s.state = "error";
            s.reason = name + ": " + o.reason;
        } else if (s.state != "showing" && s.state != "error" && o.state == "showing") {
            s.state = "showing";
            s.page = o.page;
        }
        if (o.state != feeds_[0]->status(decode, stream).state)
            s.page += " · " + name + " " + o.state + (o.reason.empty() ? "" : ": " + o.reason);
    }
    s.target = join_targets(targets_);
    s.hud_width_pct = base_.hud_width_pct;
    s.hud_offset_x = base_.hud_offset_x;
    s.hud_offset_y = base_.hud_offset_y;
    return s;
}

void MapFeeds::request_report()
{
    for (auto &f : feeds_)
        f->request_report();
}

std::string MapFeeds::report() const
{
    std::string r;
    for (size_t i = 0; i < feeds_.size(); i++)
        r += (feeds_.size() > 1 ? "--- " + targets_[i] + "\n" : std::string()) + feeds_[i]->report();
    return r;
}

}  // namespace woc
