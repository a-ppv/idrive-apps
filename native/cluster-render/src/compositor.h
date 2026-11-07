/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The compositor: every client's layers in their targets' scenes.
 *
 * Each tick, arrange() orders each target's layers (stack.h), shows the
 * drawn ones in its scene and tells the slot manager whether the target is
 * wanted; render() then has every layer of each requested target stage its
 * changes, top layer first (so overlays get the byte budget before a video
 * under them), and flushes the scene once: a tick's changes of all layers
 * reach the display together or not at all. A setData a layer could not
 * finish holds the flush back for the tick, and every layer that staged is
 * told the flush did not go (layer.h). A video layer or an exclusive image
 * whose buffer that left half written holds the target from then on: only
 * its whole rewrite stages, when the budget allows, and nothing is flushed
 * until it goes, so the display keeps the last frame.
 *
 * Assets (asset.h) are staged before the layers, in the same flush. A layer
 * that samples an asset (bind) is ready once every asset it samples has
 * pixels, and drawn only while their buffers hold them whole.
 *
 * Fades: a target's video and image layers are drawn at their opacity times
 * the target's fade. The fade is 0 while the target is not on screen
 * (acquiring, parked), rises to 1 over fade_ms once it is shown, and, when
 * nothing wants the target any more, falls back to 0 over fade_ms with the
 * layers last drawn kept drawn and the target kept wanted, so it is released
 * after the fade. A fade step goes at most every kFadeStepMs, in the
 * target's ordinary flush. A parked target stages nothing: nothing of it is
 * on screen.
 *
 * It is the slot manager's Scenes: publishing a target builds its scene and
 * attaches the target's assets and then its layers, which start from what
 * they last showed, binds and animations included; unpublishing takes the
 * scene down and keeps the assets and the layers. Only a target the slot
 * manager has requested stages and flushes. A released target's scene stays
 * published as last flushed, its layers attached and holding what they have
 * not written: a video's newest frame, an image's changed rectangles. Asked
 * for again, its layers continue from there in the tick that asks: what
 * their buffers hold is what the scene last flushed, and a renderer that
 * subscribes gets the scene whole, as last flushed, from the RAMSES client
 * (VERIFIED in the emulator: sent at the subscription), so a video writes
 * the tiles that differ from it, not the whole frame. That resend is
 * charged to the byte budget when the display takes the scene (resent()).
 *
 * The layers and assets of a target with the HUD's share (TargetSpec::share)
 * write from a budget of their own (upload_pacer.h share_of): while one of
 * them is asked for and has a layer, up to kSharePct of each refill of the
 * budget, only as much as they spend, what they leave going back to the
 * other targets at once, and the whole refill while the other targets'
 * budget sits full. The two together never hold more than one burst. The
 * other targets never get less than the rest, and with no such layer they
 * go exactly as they would without it. Evidence from such a target is
 * logged, never counted towards the cap, and its bytes are not the link's
 * load for the governor, so it never moves the cap.
 *
 * Videos: each video layer keeps buffers on the display (video_layer.h),
 * whose memory nobody has measured, so the display holds at most
 * CompositorLimits::videos of them, however many video layers the clients
 * have. While the display can hold every video's buffers, each video draws
 * itself, exactly as with no composites at all. Past that, the videos on
 * one target drawn unturned, at their frame's size and at even x and y are
 * drawn through the target's composite (video_composite.h): one video
 * layer composed on the CPU, one set of buffers, one video in the byte
 * budget and the dirty-tile planner; the targets whose composite saves the
 * most buffers compose, as few as it takes. A video turned, scaled or at an
 * odd x or y keeps buffers of its own. A video joining or leaving a
 * composite, and a composite made
 * again, start their scene objects again: their first frame goes whole. A
 * composite is made again for its videos' rectangle growing past it at most
 * every kRemakeMs (till then what lies outside is cut), and smaller only
 * once the smaller rectangle has held for kShrinkMs. Old objects go before new ones are
 * made, so the display never holds more video buffers than the limit. */
#ifndef CRS_COMPOSITOR_H
#define CRS_COMPOSITOR_H

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "asset.h"
#include "governor.h"
#include "graph.h"
#include "layer.h"
#include "mesh_layer.h"
#include "slots.h"
#include "stack.h"
#include "video_composite.h"
#include "video_layer.h"

namespace crs {

enum class LayerState { Hidden, Stalled, Waiting, Shown, Suspended, Error };
const char *layer_state_name(LayerState s);

struct CompositorLimits {
    /* An app drawing a cluster layout or a page of readings makes one small
     * effect layer per piece (a short shader over its own rectangle), so it
     * needs dozens; one large shader drawing many pieces instead has been
     * reported to restart the KOMBI. */
    uint32_t layers = 96;               /* across all clients */
    uint32_t per_client = 64;
    /* Video buffers on the display, each an atlas and two packed buffers:
     * a video drawing itself, or a target's composite of its videos. */
    uint32_t videos = 2;
    /* Client video layers, across all clients; each also within
     * pixel_bytes (four atlases and the packing each, and a composite as
     * much at its own size). */
    uint32_t client_videos = 8;
    uint64_t pixel_bytes = 16u << 20;   /* CPU copies of all images, videos, assets and meshes */
    uint32_t assets = 32;               /* across all clients */
    uint32_t assets_per_client = 16;
};

class Compositor : public Scenes {
public:
    /* The byte budget all layers share starts at budget.max_bps (0: none)
     * and follows the governor (governor.h). */
    Compositor(Gpu *gpu, SlotManager *slots, const GovernorConfig &budget, int upload_burst_ms,
               const CompositorLimits &limits = CompositorLimits());
    ~Compositor() override;

    /* Compiles the built-in effects (video atlas, packed blocks, image). */
    bool init(std::string *err);

    /* New layers, owned by a client; 0 with *err when refused. */
    uint32_t add_video(uint64_t owner, int target, const LayerParams &lp, const VideoParams &vp, int64_t now_ms,
                       std::string *err);
    uint32_t add_image(uint64_t owner, int target, const LayerParams &lp, uint32_t w, uint32_t h, uint32_t fps,
                       Sampling s, int64_t now_ms, std::string *err);
    uint32_t add_effect(uint64_t owner, int target, const LayerParams &lp, const std::string &vs,
                        const std::string &fs, uint32_t time_fps, int64_t now_ms, std::string *err);
    uint32_t add_mesh(uint64_t owner, int target, const LayerParams &lp, const MeshParams &mp, int64_t now_ms,
                      std::string *err);
    /* A mesh layer's part, its effect compiled here; false with *err. */
    bool add_part(uint64_t owner, uint32_t layer, uint32_t part, const std::string &vs, const std::string &fs,
                  const PartLook &look, std::string *err);
    /* A part's geometry, within the service's memory; false with *err. */
    bool geometry(uint64_t owner, uint32_t layer, uint32_t part, MeshData &&data, int64_t now_ms,
                  std::string *err);

    /* A new asset, owned by a client; 0 with *err when refused. */
    uint32_t add_asset(uint64_t owner, int target, const AssetParams &ap, std::string *err);
    /* The asset if it exists and belongs to owner. */
    Asset *asset(uint64_t owner, uint32_t id);
    /* False with *err while a layer samples it. */
    bool remove_asset(uint64_t owner, uint32_t id, std::string *err);
    /* The layer's sampler (of part, for a mesh layer) samples the asset,
     * which must be on its target; replaces what it sampled. */
    bool bind(uint64_t owner, uint32_t layer, uint32_t part, const std::string &sampler, uint32_t asset,
              std::string *err);
    /* After a change of a layer's scene objects outside stage(), so the next
     * flush carries it. */
    void touch(Layer *l);

    /* The layer if it exists and belongs to owner. */
    Layer *layer(uint64_t owner, uint32_t id);
    /* After a change of layer->params: placed and arranged again. */
    void changed(Layer *l);
    void remove(uint64_t owner, uint32_t id);
    void remove_owner(uint64_t owner);
    /* Whether layer l may take params p (before they are set and
     * changed()): a video's display buffers and memory stay within the
     * limits; false with *err. */
    bool check(const Layer *l, const LayerParams &p, std::string *err);
    /* The target's composite of its videos; null while it has none. */
    const CompositeVideo *composite(int target) const;

    void arrange(int64_t now_ms);
    void render(int64_t now_ms);
    int64_t wake_in_ms(int64_t now_ms) const;

    LayerState state(uint32_t id, std::string *reason) const;
    Governor &governor() { return governor_; }
    const Governor &governor() const { return governor_; }
    /* A flush taking this long is evidence of a link falling behind
     * (INFERRED: the RAMSES client sends the flush's scene actions through
     * vsomeip, which blocks once its queue to the display backs up). */
    void set_slow_flush_ms(int ms) { slow_flush_us_ = (int64_t)ms * 1000; }
    /* How long a fade in or out takes; 0: none. */
    void set_fade_ms(int ms) { fade_ms_ = ms; }
    static const int64_t kFadeStepMs = 50;
    /* A composite is made again for its videos' rect growing past it, or a
     * joining video's settings, at most this often; it is then made over
     * its old rect and the new one together. One whose videos fit in a
     * smaller rect is made again once that has held for kShrinkMs. */
    static const int64_t kRemakeMs = 1000;
    static const int64_t kShrinkMs = 3000;
    /* The most of each refill the HUD's share takes (upload_pacer.h). */
    static const unsigned kSharePct = 50;
    /* The clock flushes are timed with, in microseconds (tests set it). */
    void set_clock(int64_t (*clock_us)()) { clock_us_ = clock_us; }
    /* Layers by id, for status reports. */
    std::vector<const Layer *> layers() const;
    /* The sum of the target's layers' write_stats(). */
    WriteStats write_stats(int target) const;
    std::vector<const Asset *> assets() const;
    uint64_t owner_of(uint32_t id) const;

    bool publish(const TargetSpec &t, std::string *err) override;
    void unpublish(const TargetSpec &t) override;
    /* Charges the budget the scene's buffer bytes, layers' and assets'. */
    void resent(const TargetSpec &t, int64_t now_ms) override;

private:
    struct Entry {
        std::unique_ptr<Layer> layer;
        uint64_t owner = 0;
        int effect = 0;        /* a client effect this layer holds */
        size_t pixel_bytes = 0;
        std::string error;     /* the renderer refused the layer's objects */
        bool drawn = false;
        int32_t order = -1;
        bool composited = false;   /* a video drawn by its target's composite */
        bool placed = false;       /* a video the plans have placed (reconcile) */
        std::map<std::pair<uint32_t, std::string>, uint32_t> binds;   /* (part, sampler) -> asset */
    };
    struct AssetEntry {
        std::unique_ptr<Asset> asset;
        uint64_t owner = 0;
    };
    struct Target {
        std::unique_ptr<Graph> graph;
        Arrangement arr;
        bool dirty = false;    /* changed outside a layer's stage(): flush */
        uint64_t tag = 0;
        bool flush_failing = false;
        /* The fade (above): where it is, what the layers were last
         * given and when, and while fading out, the layers drawn when the
         * target was last wanted. */
        float fade = 1.0f, applied = 1.0f;
        int64_t fade_ms = 0, applied_ms = 0;
        bool fading_out = false;
        std::vector<uint32_t> last_drawn;
        bool last_contend = false, last_guide_hold = true;
        /* Its videos' composite, its pixel bytes, and why the renderer
         * refused its objects. */
        std::unique_ptr<CompositeVideo> composite;
        uint64_t composite_bytes = 0;
        std::string composite_error;
        /* When the composite was made; since when the plan has fitted a
         * smaller one (-1: it does not), and that one's rect; when a kept
         * composite is due to be made again (-1: none is). */
        int64_t composite_made_ms = 0, smaller_since_ms = -1, remake_ms = -1;
        Rect smaller;
    };
    struct VideoSpec {
        uint32_t id = 0;
        int target = 0;
        LayerParams params;
        VideoParams vp;
    };
    /* How a target's videos are drawn: those its composite draws (none, or
     * two or more), its canvas and place, and the video buffers they take
     * on the display. */
    struct VideoPlan {
        std::vector<uint32_t> composited;
        VideoParams vp;
        int32_t x = 0, y = 0;
        Rect clip;
        uint64_t bytes = 0;
        uint32_t buffers = 0;
        const char *error = nullptr;
    };

    uint32_t admit(uint64_t owner, int target, int64_t pixel_bytes, std::string *err);
    std::vector<VideoSpec> video_specs() const;
    /* The target's videos composed: its plan when it composes (none for
     * fewer than two composable videos). */
    VideoPlan compose_plan(int ti, const std::vector<VideoSpec> &specs, const Rect *with = nullptr) const;
    /* Every target's plan: every video separate while the display holds
     * them all (CompositorLimits::videos); past it, the targets whose
     * composite saves the most buffers compose, as few as it takes. *err:
     * why they do not fit even so; empty when they do. */
    std::vector<VideoPlan> plan_videos(const std::vector<VideoSpec> &specs, std::string *err) const;
    /* Whether the videos fit the display's video buffers; *bytes: their
     * composites' pixel bytes. Compiles the composite's effects when one is
     * needed. */
    bool videos_fit(const std::vector<VideoSpec> &specs, uint64_t *bytes, std::string *err);
    bool view_effects(std::string *err);
    /* Brings every target's videos to its plan: which draw themselves and
     * which its composite draws; what goes, on every target, before what
     * is made. */
    void reconcile();
    /* Whether the target's composite stays for plan pl (made again at once,
     * or once allowed: kRemakeMs, kShrinkMs); *pl becomes the plan it is
     * made with when it does not. */
    bool keep_composite(int ti, VideoPlan *pl);
    void reconcile_drop(int ti, VideoPlan &pl);
    void reconcile_make(int ti, const VideoPlan &pl);
    void attach_composite(Target &t);
    /* The layer is drawn in its target's scene: attached, or composited by
     * an attached composite. */
    bool on_scene(const Entry &e) const;
    /* The budget the target's writes spend: the HUD's share for a share
     * target. */
    crk::UploadPacer &pacer_for(int target);
    /* The governor's evidence, but a share target's only logged. */
    void evidence(const TargetSpec &t, Evidence e, int64_t now_ms, const std::string &detail);
    /* Bytes written now_ms, flushed or not, for the governor's load. */
    void load(uint64_t bytes, int64_t now_ms);
    /* Moves the target's fade on to now_ms and, fading out, keeps the
     * layers last drawn in t.arr; gives the layers the fade by steps. */
    void fade(int ti, Target &t, int64_t now_ms);
    uint64_t memory() const;
    void attach(Entry &e, Target &t);
    /* A drawn layer on the target holds its flushes (Layer::holds_flush). */
    bool holds(const Target &t) const;
    void apply_binds(Entry &e);
    void drop_effects(Entry &e);
    /* Every asset the layer samples has pixels; and its buffer holds them. */
    bool assets_have(const Entry &e) const;
    bool assets_clean(const Entry &e) const;

    Gpu *gpu_;
    SlotManager *slots_;
    CompositorLimits limits_;
    Governor governor_;
    crk::UploadPacer pacer_;
    crk::UploadPacer share_;
    int64_t slow_flush_us_ = 150000;
    int fade_ms_ = 0;
    /* Bytes written this second, flushed or not: the link counts as
     * carrying load (for the governor's evidence and healthy time) from
     * kLoadBytes a second. */
    static const uint64_t kLoadBytes = 64 * 1024;
    static const size_t kMaxBinds = 32;
    uint64_t second_bytes_ = 0;
    int64_t second_ms_ = 0;
    int64_t (*clock_us_)() = nullptr;
    int atlas_fx_ = 0, block_fx_ = 0, image_fx_ = 0;
    int atlas_view_fx_ = 0, block_view_fx_ = 0;   /* the composite's, made with the first one */
    std::map<uint32_t, Entry> layers_;
    std::map<uint32_t, AssetEntry> assets_;
    std::vector<Target> targets_;
    uint32_t next_id_ = 1;
    uint64_t seq_ = 0;
    int64_t now_ms_ = 0;
};

}  // namespace crs

#endif
