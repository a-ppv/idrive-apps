/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The layered stack: how the layers of all clients on one target share its
 * scene (README.md "Arbitration").
 *
 * Every layer is drawn at once, bottom to top by class (ambient, content,
 * overlay, alert), then by the client's z within the class, then oldest
 * first, so a newer layer of the same class and z is on top. A layer marked
 * exclusive hides every layer below it while it is drawn and its pixels are
 * on the display (shown); they are suspended, not removed, and come back in
 * the same flush it goes. Until its first write has gone they stay shown,
 * under it (an image shows from that write: layer.h). A change of the
 * stack is a change of the scene: no display traffic.
 *
 * The target is wanted while any layer is visible and ready (it has
 * content), or visible and prewarm (it asks for the slot before its first
 * content, so that content shows at once). It contends with the stock HMI
 * while any wanting layer does (slots.h), and lets the guide holds that
 * follow it hold their slots unless a wanting layer has guide_hold false.
 * It is preloaded while any layer, visible or not, has preload (slots.h
 * "Preload"). */
#ifndef CRS_STACK_H
#define CRS_STACK_H

#include <stdint.h>
#include <string>
#include <vector>

namespace crs {

enum class Klass { Ambient = 0, Content = 1, Overlay = 2, Alert = 3 };
const char *klass_name(Klass k);
bool klass_from_name(const std::string &s, Klass *out);

struct StackItem {
    uint32_t id = 0;
    Klass klass = Klass::Content;
    int z = 0;
    uint64_t seq = 0;   /* creation order */
    /* With the klass, z and seq of another layer: 1 drawn just under it,
     * -1 just over it (a hosted video by its host's anchor: compositor.h) */
    int under = 0;
    bool visible = true, ready = false, exclusive = false, prewarm = false, contend = false, guide_hold = true;
    bool yield = true, preload = false;
    bool shown = true;   /* its pixels are on the display (Layer::on_display) */
};

struct Arrangement {
    std::vector<uint32_t> order;       /* every layer, bottom to top */
    std::vector<uint32_t> drawn;       /* visible, ready and not below a drawn, shown exclusive layer */
    std::vector<uint32_t> suspended;   /* visible and ready, but below a drawn, shown exclusive layer */
    bool wanted = false, contend = false, guide_hold = true, yield = true, preload = false;
};

Arrangement arrange(std::vector<StackItem> items);

}  // namespace crs

#endif
