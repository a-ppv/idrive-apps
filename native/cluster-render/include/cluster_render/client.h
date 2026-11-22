/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* A client of the cluster render service, for native producers (PROTOCOL.md).
 *
 *   cr::Client c("my-app");
 *   cr::LayerOptions lo;  lo.target = "map";  lo.contend = true;
 *   uint32_t map = c.video(lo, cr::VideoOptions());
 *   c.on_layer = [](uint32_t ref, const std::string &state, const std::string &why) { ... };
 *   for (;;) {
 *       poll({c.fd(), c.wants_write() ? POLLIN | POLLOUT : POLLIN}, timeout <= 250 ms);
 *       c.poll(now_ms);
 *       c.frame(map, &atlas, n);   // whenever a frame is decoded; atlas comes back free
 *   }
 *
 * Nothing blocks. The client connects, and reconnects whenever the service
 * goes (a restart, an update), making every asset and layer again with its
 * last settings: uniforms, mesh parts with their geometry and transforms,
 * binds and animations, and every scene file with its kept edits; on_ready()
 * then asks the app for its content.
 * Frames are newest-wins per layer: a video frame not yet sent is replaced
 * by the next, so a producer never queues behind the display. A video
 * layer's last frame is kept once sent (and over a reconnect), so a frame
 * whose picture is that one again goes as a repeat (a few bytes; one per
 * layer waits, and a whole frame queued after it drops it), or that frame
 * whole to a service that has not had it on this connection, refused the
 * layer, or takes no repeats; an image
 * layer or an asset is kept here whole, and what changed since it was last
 * sent goes as one update when the socket takes it (and the whole of it
 * again after a reconnect). Control messages, geometry included, keep their
 * order and go before frames. */
#ifndef CLUSTER_RENDER_CLIENT_H
#define CLUSTER_RENDER_CLIENT_H

#include <stdint.h>
#include <deque>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "cluster_render/protocol.h"

namespace cr {

struct LayerOptions {
    std::string target;              /* a target the service has: "map", "panel", "hud" by default */
    std::string klass = "content";   /* ambient, content, overlay or alert */
    int z = 0;
    int x = 0, y = 0;
    unsigned w = 0, h = 0;           /* 0: the whole target */
    bool visible = true;
    bool exclusive = false;          /* hides every layer below it while drawn */
    bool prewarm = false;            /* asks for the slot before the first content */
    bool preload = false;            /* keeps the target's scene loaded on the display while not shown */
    bool contend = false;            /* retries a slot the stock HMI takes */
    bool guide_hold = true;          /* false: the stock HMI's guidance box shows while this layer wants the map */
    bool yield = true;               /* false: the target stays shown over the stock HMI's pop-ups while this layer wants it */
    /* While this layer is shown, every other client's video at most this
     * many updates a second (15 at least), so this app gets the upload
     * bandwidth they leave; 0: no request (PROTOCOL.md "Bandwidth for a layer"). Sent
     * when set, and with set() also when it goes back to 0. */
    unsigned others_fps = 0;
    /* A producer's layer placed by a host of its target (on_host): that
     * target's name, so a host from layers stacks it under its own layers
     * (PROTOCOL.md "Hosting from layers"); empty: none. Sent when set,
     * and with set() also when it goes back to empty. */
    std::string hosted;
    float opacity = 1.0f;
    /* Video, image and effect layers: turned (degrees clockwise) and scaled about
     * the pivot, in pixels from the layer's top-left (its centre unless
     * pivot). */
    float rotate = 0, sx = 1, sy = 1;
    bool pivot = false;
    float px = 0, py = 0;
};

/* 4:2:0 frames as one atlas: Y (w x h), then U and V side by side (w/2
 * each) in h/2 rows; frame_bytes() long. */
struct VideoOptions {
    unsigned w = 1088, h = 480;
    unsigned fps = 30;
    unsigned level_bits = 2, dirty_threshold = 8, settle_ms = 1000;
    bool pan_blocks = true;
    unsigned stall_ms = 6000;
    /* Every write as packed 4x4 blocks, never the exact atlas (PROTOCOL.md);
     * sent only when set, to a service whose hello takes it
     * (Client::takes_always_packed). */
    bool always_packed = false;
};

/* RGBA, straight alpha, w x h (0: the layer's w and h, which must then be
 * set). */
struct ImageOptions {
    unsigned w = 0, h = 0;
    unsigned fps = 30;
    bool bilinear = false;
};

/* How an effect layer or a mesh part is drawn (PROTOCOL.md "Render
 * state"), to a service whose hello has render_state
 * (Client::takes_render_state()). An empty field is not sent: the
 * service's default. */
struct RenderState {
    std::string blend;   /* alpha, add, none, premultiplied, max, min or subtract */
    /* zero, one, src_alpha, one_minus_src_alpha, dst_alpha, one_minus_dst_alpha */
    std::string blend_src, blend_dst, blend_src_alpha, blend_dst_alpha;
    std::string blend_op, blend_op_alpha;   /* add, subtract, reverse_subtract, min or max */
    std::string color_mask;                 /* some of r, g, b and a, or none */
    std::string depth_func;   /* parts: less, less_equal, equal, not_equal, greater, greater_equal, always, never */
    int depth_write = -1;     /* parts: 0 or 1; -1: as depth */
};

/* GLSL ES 1.00; the fragment shader gets varying vec2 v_uv (0,0 at the
 * top-left). vs empty: the service's quad vertex shader. */
struct EffectOptions {
    std::string fs, vs;
    unsigned time_fps = 0;   /* u_time (seconds) updated this often; 0: none */
};

/* A texture the app's effect layers and mesh parts on its target sample
 * (bind): RGBA, or one byte a pixel with r8, w x h up to 2048x2048 within one
 * frame message. */
struct AssetOptions {
    std::string target;
    bool r8 = false;
    unsigned w = 0, h = 0;
    bool bilinear = false;
    bool repeat = false;   /* wraps; else clamps */
};

/* More of an asset's sampler, to a service whose hello has samplers
 * (Client::takes_samplers()): sampling by name, in place of
 * AssetOptions::bilinear (nearest, bilinear, nearest_mips, bilinear_mips,
 * trilinear, min_linear_mag_nearest, min_nearest_mag_linear; with mipmaps
 * the service makes the asset's levels from its pixels), wrap_u and wrap_v
 * in place of AssetOptions::repeat (clamp, repeat or mirror), anisotropy
 * 1-16. Empty, 0: not sent. */
struct SamplerOptions {
    std::string sampling, wrap_u, wrap_v;
    unsigned anisotropy = 0;
};

enum class UniformType { Float, Vec2, Vec3, Vec4, Mat4 };

/* A mesh layer's projection (its aspect the layer's) and camera. */
struct MeshOptions {
    bool ortho = false;
    float fov = 30;       /* perspective: vertical, degrees */
    float ortho_h = 2;    /* orthographic: the height seen */
    float near = 0.1f, far = 100;
    float cx = 0, cy = 0, cz = 0;      /* the camera's position */
    float crx = 0, cry = 0, crz = 0;   /* and rotation, degrees; it looks down -z */
};

/* A mesh part's shaders (GLSL ES 1.00; attributes a_position, a_normal,
 * a_texcoord, a_color) and how it is drawn. */
struct PartOptions {
    std::string vs, fs;
    bool depth = true;              /* tested (less or equal) and written */
    std::string cull = "back";      /* back, front or none */
    std::string blend = "alpha";    /* alpha, add or none */
};

/* A part's vertices and triangles: positions and normals xyz, texture
 * coordinates uv, colours rgba, one per vertex (each but positions may be
 * empty), up to 65535 vertices and 196605 indices. */
struct Geometry {
    std::vector<float> positions, normals, texcoords, colors;
    std::vector<uint16_t> indices;
};

/* A part's place: translation, rotation (degrees about x, y, z), scale. */
struct Transform {
    float tx = 0, ty = 0, tz = 0;
    float rx = 0, ry = 0, rz = 0;   /* degrees, right-handed */
    float sx = 1, sy = 1, sz = 1;
};

/* A scene file the service loads as a target's whole scene, on a target
 * that takes them (PROTOCOL.md "Scene files"). */
struct SceneOptions {
    std::string target;
    std::string file;                  /* its absolute path */
    std::vector<std::string> res;      /* its resource files' */
    std::vector<std::string> sha256;   /* SHA-256 (hex) of the file, then of each resource file */
    bool contend = false;              /* retries a slot the stock HMI takes */
    /* The target's layers drawn over the file (PROTOCOL.md "Layers over a
     * scene file"): their passes from render order layers_order up when
     * layers_order_set, else past the file's own. */
    bool layers = false;
    bool layers_order_set = false;
    int layers_order = 0;
};

/* A scene, or a client's layers, showing another target's content
 * (PROTOCOL.md "host"): in the host's target at x, y, w, h, the part src_*
 * of target's pixels; shown false: nowhere. into: the target whose layers
 * host it (host(const Host &)); as an event, the hosting target, empty once
 * target is not hosted any more. */
struct Host {
    std::string target, into;
    int x = 0, y = 0;
    unsigned w = 0, h = 0;
    int src_x = 0, src_y = 0;
    unsigned src_w = 0, src_h = 0;   /* 0: the whole target */
    bool shown = true;
    /* the edge drawn on the hosted picture (sent, all five, with edge_top or
     * edge_bottom; the event never carries it) */
    unsigned edge_top = 0, edge_bottom = 0, edge_fade = 0, edge_dim = 0, edge_blur = 0;
    bool operator==(const Host &o) const
    {
        return target == o.target && into == o.into && x == o.x && y == o.y && w == o.w && h == o.h &&
               src_x == o.src_x && src_y == o.src_y && src_w == o.src_w && src_h == o.src_h && shown == o.shown &&
               edge_top == o.edge_top && edge_bottom == o.edge_bottom && edge_fade == o.edge_fade &&
               edge_dim == o.edge_dim && edge_blur == o.edge_blur;
    }
    bool operator!=(const Host &o) const { return !(*this == o); }
};

/* An animation the renderer plays by itself (PROTOCOL.md "animate"). */
struct AnimationOptions {
    uint32_t part = 0;      /* a mesh part; 0: the layer's quad, or a mesh layer's camera */
    std::string property;   /* rotate, translate, scale or uniform */
    std::string name;       /* the uniform's */
    std::string keys;       /* "t:v[,v,v] t:v ...", t in ms */
    bool loop = false;
    bool step = false;      /* else linear */
};

class Client {
public:
    explicit Client(const std::string &app, const std::string &socket_path = kDefaultSocket);
    ~Client();
    Client(const Client &) = delete;
    Client &operator=(const Client &) = delete;

    int fd() const { return fd_; }
    bool connected() const { return ready_; }
    bool wants_write() const;
    /* Connects or reconnects when due, reads events, writes what waits. */
    void poll(int64_t now_ms);

    uint32_t video(const LayerOptions &lo, const VideoOptions &vo);
    uint32_t image(const LayerOptions &lo, const ImageOptions &io);
    uint32_t effect(const LayerOptions &lo, const EffectOptions &eo);
    /* With cluster_time, u_time comes from the renderer's own clock: seconds
     * from 0 to 3600, then again, with nothing sent per frame. */
    uint32_t effect(const LayerOptions &lo, const EffectOptions &eo, bool cluster_time);
    /* With its render state: its blending and colour mask (RenderState). */
    uint32_t effect(const LayerOptions &lo, const EffectOptions &eo, bool cluster_time, const RenderState &look);
    /* A 3D layer: its parts drawn in its own pass over lo's rect. */
    uint32_t mesh(const LayerOptions &lo, const MeshOptions &mo);
    /* An asset; 0 when its size is out of range. */
    uint32_t asset(const AssetOptions &ao);
    /* With more of its sampler (SamplerOptions). */
    uint32_t asset(const AssetOptions &ao, const SamplerOptions &so);
    /* A scene file as the target's scene; 0 without a file or a hash for
     * each file. */
    uint32_t scene(const SceneOptions &so);
    /* Another file for the scene, in place: its kept edits go. */
    void scene(uint32_t ref, const SceneOptions &so);
    /* Edit lines for a scene (PROTOCOL.md "edit"), separated by newlines;
     * kept by their key (edit_key), each replacing the kept line of its
     * key, and sent again after a reconnect in the order last sent. */
    void edit(uint32_t ref, const std::string &lines);
    /* The scene (made with layers) hosts h.target there (PROTOCOL.md
     * "host"), its src_* part when src_w and src_h are set (all four go),
     * else all of it. Kept by target and sent again after a reconnect,
     * until the service refuses it or the scene is replaced; false, nothing
     * sent, for a scene without layers or a host of its own target. */
    bool host(uint32_t ref, const Host &h);
    /* This client's layers on h.into host h.target there, with no scene
     * (PROTOCOL.md "Hosting from layers"): the hosted video is drawn under
     * them, while one of them is visible. Kept by target (one into a
     * target), sent to a service whose hello has host_layers 1, now or once
     * one is connected, until unhost() or the service refuses it (the
     * service ends it; here it is forgotten unless one into another target
     * was sent since); false, nothing kept,
     * without h.into or h.target, or for h.into itself. on_hosting says
     * whether it is live. */
    bool host(const Host &h);
    /* This client's layers host target no more: sent to such a service also
     * with nothing kept here, so it ends whatever the service holds. */
    void unhost(const std::string &target);
    /* Everything of lo but its target. */
    void set(uint32_t ref, const LayerOptions &lo);
    /* An effect layer's render state, in place of its EffectOptions'. */
    void set_look(uint32_t ref, const RenderState &look);
    /* A mesh layer's camera and projection (orthographic or not as made). */
    void camera(uint32_t ref, const MeshOptions &mo);
    void uniform(uint32_t ref, const std::string &name, const std::vector<float> &v);
    /* v holds whole elements of type, up to 1024 floats; an array uniform
     * when more than one. part: a mesh layer's part, 0 for an effect. */
    void uniform(uint32_t ref, const std::string &name, UniformType type, const std::vector<float> &v,
                 uint32_t part = 0);
    /* The effect layer's (or mesh part's) sampler samples the asset. */
    void bind(uint32_t ref, const std::string &sampler, uint32_t asset, uint32_t part = 0);
    /* A mesh layer's part, numbered from 1; false when it exists. */
    bool part(uint32_t ref, uint32_t part, const PartOptions &po);
    /* With the rest of its render state; look.blend, when set, in place of
     * po.blend. */
    bool part(uint32_t ref, uint32_t part, const PartOptions &po, const RenderState &look);
    /* The part's geometry; the service takes a new one at most once a
     * second. False when it is out of range. */
    bool geometry(uint32_t ref, uint32_t part, const Geometry &g);
    void transform(uint32_t ref, uint32_t part, const Transform &t);
    /* Returns the animation's number (0: refused here); playing it again
     * means stop() and animate(). */
    uint32_t animate(uint32_t ref, const AnimationOptions &a);
    /* Replaces the layer's animation anim (one animate() returned) with a;
     * returns anim, or 0 when the layer has no such animation. */
    uint32_t animate(uint32_t ref, const AnimationOptions &a, uint32_t anim);
    void stop(uint32_t ref, uint32_t anim);
    /* A layer or an asset; an asset a layer samples stays (the service
     * refuses it). */
    void drop(uint32_t ref);

    size_t frame_bytes(uint32_t ref) const;
    /* A video frame: the whole atlas, copied. False while not connected. */
    bool frame(uint32_t ref, const uint8_t *atlas, size_t n, uint64_t id);
    /* A video frame without a copy: *atlas (frame_bytes() long) is taken
     * as it is and sent from there, and *atlas comes back as a buffer of
     * the same size to fill next: the frame it replaced, if that was still
     * unsent, else one sent before, else a new one. Its contents are
     * undefined. False, and *atlas untouched, while not connected or for a
     * wrong size. */
    bool frame(uint32_t ref, std::vector<uint8_t> *atlas, uint64_t id);
    /* A video frame whose picture is the layer's last frame's again, byte for
     * byte. False while not connected, or when the layer has had no frame. */
    bool repeat(uint32_t ref, uint64_t id);
    /* A copy of the newest frame a video layer was given into *out; false
     * when it has had none. */
    bool latest(uint32_t ref, std::vector<uint8_t> *out) const;
    /* A frame of the layer waits to be sent. */
    bool frame_waiting(uint32_t ref) const { return frames_.count(ref) != 0; }
    /* An image or asset update: rects of rows packed one rect after
     * another, or no rects and the whole image. False when a rect is
     * outside the image or n does not match. */
    bool pixels(uint32_t ref, const std::vector<FrameRect> &rects, const uint8_t *px, size_t n);

    std::function<void()> on_ready;
    std::function<void(uint32_t ref, const std::string &state, const std::string &reason)> on_layer;
    std::function<void(const std::string &target, const std::string &state, const std::string &holder,
                       const std::string &reason)>
        on_target;
    /* By target, from its last target event (before on_target): a guide
     * hold following it is disabled; the target's own mapping is disabled
     * (PROTOCOL.md). */
    std::map<std::string, bool> guide_disabled, disabled;
    std::function<void(const std::string &op, uint32_t ref, const std::string &reason)> on_error;
    /* The shared upload cap changed (governor): KB/s now, the ceiling, why. */
    std::function<void(unsigned cap_kb, unsigned max_kb, const std::string &reason)> on_budget;
    /* The answer to request_status(): the service's status text. */
    std::function<void(const std::string &text)> on_status;
    /* A target hosted, moved, shown, hidden or not hosted any more (h.into
     * empty), from the service's host events; hosts holds the targets
     * hosted now, by name (none while not connected). */
    std::function<void(const Host &h)> on_host;
    /* This client's host from layers of target (host(const Host &)): state
     * "live", or "waiting" with the reason (PROTOCOL.md "hosting"). */
    std::function<void(const std::string &target, const std::string &into, const std::string &state,
                       const std::string &reason)>
        on_hosting;
    std::map<std::string, Host> hosts;
    /* Another client's layer shown with others_fps holds this client's
     * videos to fps_cap updates a second (0: none; app: that client's
     * name), from the service's fps_cap events; 0 while not connected.
     * on_fps_cap: it changed, also to 0 when the connection goes. */
    unsigned fps_cap = 0;
    std::string fps_cap_app;
    std::function<void(unsigned fps, const std::string &app)> on_fps_cap;
    void request_status();
    /* The service's hello: its backend ("id7", "id8") and targets ("map:1088x480,..."). */
    std::string backend, targets;
    /* The service's hello takes a video layer's always_packed (VideoOptions). */
    bool takes_always_packed() const { return always_packed_; }
    /* The service's hello knows a layer's preload (LayerOptions). */
    bool takes_preload() const { return preload_; }
    /* The service's hello knows a layer's others_fps (LayerOptions). */
    bool takes_others_fps() const { return others_fps_; }
    /* The service's hello takes a render state's blend factors, depth_func
     * and color_mask (RenderState). */
    bool takes_render_state() const { return render_state_; }
    /* The service's hello takes an asset's sampling by name, wrap_u, wrap_v
     * and anisotropy (SamplerOptions). */
    bool takes_samplers() const { return samplers_; }
    /* The service's hello takes a host from layers (host(const Host &)). */
    bool takes_host_layers() const { return host_layers_; }

private:
    struct Part {
        std::string json;        /* its part message */
        std::string geometry;    /* its M message; empty: none yet */
        std::string transform;   /* its transform message; empty: none */
    };
    struct Layer {
        std::string kind;                /* video, image, effect, mesh, asset or scene */
        LayerOptions lo;
        RenderState look;                /* an effect layer's */
        SamplerOptions sampler;          /* an asset's */
        VideoOptions vo;
        ImageOptions io;
        EffectOptions eo;
        MeshOptions mo;
        AssetOptions ao;
        SceneOptions so;
        std::map<std::string, std::pair<uint64_t, std::string>> edits;   /* a scene's: key -> (when, line) */
        std::map<std::string, std::string> hosts;                          /* a scene's host messages, by target */
        bool cluster_time = false;
        unsigned w = 0, h = 0, bpp = 4;  /* an image's or asset's pixels */
        /* The last message of each, sent again after a reconnect. */
        std::map<std::pair<uint32_t, std::string>, std::string> uniforms;            /* (part, name) */
        std::map<std::pair<uint32_t, std::string>, std::pair<uint32_t, std::string>> binds;  /* -> asset */
        std::map<uint32_t, Part> parts;
        std::map<uint32_t, std::string> animations;
        uint32_t next_anim = 1;
        std::vector<uint8_t> image;      /* an image layer's or asset's pixels */
        std::vector<FrameRect> dirty;    /* changed since last sent */
        size_t dirty_bytes = 0;
        bool whole = false;              /* all of it is to be sent */
        bool have = false;               /* the app has drawn it */
        std::vector<uint8_t> last;       /* a video layer's last frame sent, or the newest given before a reconnect */
        bool sent = false;               /* a video frame of it went whole on this connection */
    };
    static const size_t kMaxDirty = 16;

    void connect_now(int64_t now_ms);
    void disconnect(int64_t now_ms);
    void read_events();
    void write_out();
    void queue(const std::string &json);
    void queue_message(const std::string &msg);
    void send_now();
    std::vector<std::pair<std::string, std::string>> fields(const char *op, uint32_t ref,
                                                            const LayerOptions &lo) const;
    void turn_fields(std::vector<std::pair<std::string, std::string>> *kv, const LayerOptions &lo) const;
    void mesh_fields(std::vector<std::pair<std::string, std::string>> *kv, const MeshOptions &mo) const;
    std::string layer_json(uint32_t ref, const Layer &l) const;
    std::string host_json(const std::pair<std::string, std::string> &by, const Host &h) const;
    /* A scene's kept edit lines as one edit message, oldest first. */
    std::string edits_json(uint32_t ref, const Layer &l) const;
    bool next_image(std::string *msg);
    std::string uniform_json(uint32_t ref, const std::string &name, const std::vector<float> &v) const;
    uint32_t add(const Layer &l);

    std::string app_, path_;
    int fd_ = -1;
    bool ready_ = false;
    int64_t retry_ms_ = 0;
    int backoff_ = 0;
    std::map<uint32_t, Layer> layers_;
    uint32_t next_ref_ = 1;
    uint64_t edits_ = 0;   /* edit lines taken */
    std::string in_;
    struct Frame {
        std::string head;
        std::vector<uint8_t> px;
    };
    /* A buffer of n bytes into *v: a spare one, else a new one. */
    void take_spare(std::vector<uint8_t> *v, size_t n);
    /* *px, a frame of the video layer ref, becomes its last; the one it
     * replaces (or *px, for a layer gone) becomes a spare. */
    void keep_last(uint32_t ref, std::vector<uint8_t> *px);
    bool video_frame_ok(uint32_t ref, size_t n) const;

    /* The message being written: cur_, then a frame's pixels in cur_px_,
     * sent from where they are. */
    std::string cur_;
    std::vector<uint8_t> cur_px_;
    size_t cur_off_ = 0;
    std::deque<std::string> ctl_;
    std::map<uint32_t, Frame> frames_;   /* the newest unsent frame per layer */
    /* Layers with a repeat to send, one each, before control messages: a
     * whole frame queued after it drops it. */
    std::set<uint32_t> repeats_due_;
    std::vector<std::vector<uint8_t>> spare_;   /* frame buffers sent, to fill again, oldest first */
    static const size_t kMaxSpare = 4;
    uint32_t last_frame_ref_ = 0;   /* the layer whose frame went last; cur_px_'s while it is sent */
    bool repeats_ = false;          /* the service takes repeats (its hello) */
    bool always_packed_ = false;    /* and always_packed */
    bool preload_ = false;          /* and knows preload */
    bool others_fps_ = false;       /* and others_fps */
    bool render_state_ = false;     /* and render state */
    bool samplers_ = false;         /* and samplers */
    bool host_layers_ = false;      /* and hosts from layers */
    /* Hosts from this client's layers: by hosted target, (into, message). */
    std::map<std::string, std::pair<std::string, std::string>> layer_hosts_;
};

}  // namespace cr

#endif
