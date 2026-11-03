// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* MapFeeds: the decoded map on one or two renderer targets at once - the
 * cluster's central map ("map"), the HUD ("hud"), or both ("map+hud").
 *
 * Each target is its own MapFeed (map_feed.h): its own connection to the
 * cluster renderer and its own contending video layer, so each slot is asked
 * for, held, taken over and released on its own, within the one upload
 * budget the renderer shares between all its clients. A frame goes to the
 * first feed without a copy and to the second as a copy. The stream's
 * liveness and freeze go to every feed.
 *
 * The app sees one status: its target is the spec ("map+hud"), its state the
 * first feed's unless another one errs or the first is not showing while
 * another is, and the page names a second feed's state when it differs. */
#ifndef WOC_MAP_FEEDS_H
#define WOC_MAP_FEEDS_H

#include <poll.h>
#include <stdint.h>

#include <memory>
#include <string>
#include <vector>

#include "map_feed.h"

namespace woc {

/* The renderer targets a spec names, the cluster first: "map" (also "sail",
 * "cluster"), "panel", "hud", or two of them joined by "+" or ","; "both" is
 * "map+hud". False, with why, for an unknown name, a repeat, more than two,
 * or two on the cluster (map and panel) or on one scene id (panel and hud,
 * never up at once). */
bool parse_targets(const std::string &spec, std::vector<std::string> *out, std::string *err);

/* The spec for a target list: "map", "hud", "map+hud". */
std::string join_targets(const std::vector<std::string> &targets);

class MapFeeds {
public:
    /* base.target is the spec; an invalid one is logged and "map" used. */
    explicit MapFeeds(const FeedConfig &base);

    /* Where the map goes from now on. A target that stays keeps its feed (and
     * its slot); a new one gets a feed, one no longer named is dropped. False
     * (nothing changed) for an invalid spec or a target the renderer has not
     * got. */
    bool set_targets(const std::string &spec);
    const std::vector<std::string> &targets() const { return targets_; }
    /* The HUD map's size, kept for a HUD feed made later. */
    void set_hud_width(unsigned pct);
    /* The map layer's guide_hold, kept for a feed made later. */
    void set_guide_hold(bool hold);

    /* For poll(): one entry per feed, appended; after_poll takes the same
     * vector and where they start. */
    size_t poll_fds(std::vector<pollfd> *fds) const;
    void poll(int64_t now_ms);

    void offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms);
    void set_stream(bool live, bool frozen, Picture picture);

    FeedStatus status(const std::string &decode, const std::string &stream = std::string()) const;
    void request_report();
    std::string report() const;

    size_t size() const { return feeds_.size(); }
    MapFeed &feed(size_t i) { return *feeds_[i]; }

private:
    std::unique_ptr<MapFeed> make(const std::string &target);

    FeedConfig base_;
    std::vector<std::string> targets_;
    std::vector<std::unique_ptr<MapFeed>> feeds_;
    std::vector<uint8_t> copy_;
    bool live_ = false, frozen_ = false;
    Picture picture_ = Picture::None;
};

}  // namespace woc

#endif
