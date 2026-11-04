/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* Paces the map buffer's writes to an average byte rate.
 *
 * Every write's raw bytes travel to the KOMBI's renderer, in the flush's
 * scene actions, through vsomeipd. INFERRED: it shares one TCP connection
 * with every head-unit participant's scene data, whose queue drops messages
 * past endpoint-queue-limit-external (20 MiB, VERIFIED); the KOMBI's
 * renderer unsubscribes a scene whose SceneActionList counter skips
 * (VERIFIED), which the cluster reports as the fetch REMOVED. Sending faster
 * than the link carries would then cost our scene and the HMI's.
 *
 * A frame may go whenever the allowance is positive; its bytes are then
 * charged, so the average stays at the rate, the allowance going negative by
 * at most one frame. Unused allowance is kept up to burst_ms of the rate, which
 * bounds the bytes sent back to back after a quiet spell, and debt is kept for
 * as long as the pacer lives, across sessions. A frame held
 * back is not lost: the next upload is diffed against what the buffer
 * holds, so it carries every change since.
 *
 * A share pacer (share_of) has no rate of its own. While its share is on
 * (set_share), it takes share_pct of each of its source's refills, but only
 * up to share_pct of the source's burst: what it does not spend goes back to
 * the source in the same refill, so a share that writes little costs the
 * source little. A source sitting full, nothing spent since a refill filled
 * it, gives the share its whole refill, so a share writing alone has the
 * whole rate and up to the whole burst; a source that spends takes back what
 * the share holds over its part. The two together never hold more than one
 * burst (what the share holds comes off what the source may hold), so their
 * bytes in any t stay within the burst and t of the rate. The source never
 * gets less than 100 - share_pct of its rate. With the share off the share
 * pacer holds nothing and the source's spenders go exactly as they would
 * without it. */
#ifndef CRK_UPLOAD_PACER_H
#define CRK_UPLOAD_PACER_H

#include <stdint.h>

#include <algorithm>

namespace crk {

class UploadPacer {
public:
    /* Rates above this are taken as it, so that a refill cannot overflow. */
    static constexpr uint64_t kMaxRate = uint64_t(INT64_MAX) / 4000;

    /* bytes_per_s 0: no limit. The first ready() starts with a full burst's
     * allowance. */
    explicit UploadPacer(uint64_t bytes_per_s = 0, int64_t burst_ms = 1000)
        : rate_(int64_t(bytes_per_s < kMaxRate ? bytes_per_s : kMaxRate)),
          burst_ms_(burst_ms < 1 ? 1 : burst_ms > 1000 ? 1000 : burst_ms)
    {
    }

    UploadPacer(const UploadPacer &) = delete;
    UploadPacer &operator=(const UploadPacer &) = delete;

    /* This pacer becomes source's share pacer (above), its share off. */
    void share_of(UploadPacer *source)
    {
        source_ = source;
        source->share_ = this;
        burst_ms_ = source->burst_ms_;
        allowance_ = 0;
    }
    /* On a source: its share pacer's part of each refill, 0-100 (0: off). */
    void set_share(unsigned pct)
    {
        share_pct_ = pct > 100 ? 100 : pct;
        if (share_ && !share_pct_ && share_->allowance_ > 0)
            share_->allowance_ = 0;
    }

    bool limited() const { return rate() != 0; }

    /* A new average rate (0: no limit); the allowance or debt carries over,
     * within the new burst. A share pacer's follows its source's. */
    void set_rate(uint64_t bytes_per_s)
    {
        rate_ = int64_t(bytes_per_s < kMaxRate ? bytes_per_s : kMaxRate);
        const int64_t cap = rate_ * burst_ms_ / 1000;
        if (rate_ != 0 && allowance_ > cap)
            allowance_ = cap;
        if (share_ && rate_ != 0 && share_->allowance_ > cap - pos(allowance_))
            share_->allowance_ = cap - pos(allowance_);
    }

    /* Brings the allowance up to now_ms; whether a frame may go then. */
    bool ready(int64_t now_ms)
    {
        if (source_) {
            source_->ready(now_ms);
            return rate() == 0 || allowance_ > 0;
        }
        if (rate_ == 0)
            return true;
        const int64_t cap = rate_ * burst_ms_ / 1000;
        if (last_ms_ < 0) {
            allowance_ = full_at_ = cap;
            last_ms_ = now_ms;
        } else if (now_ms > last_ms_) {
            /* A gap long enough to repay the debt and refill the allowance
             * fills it; capping it there keeps rate_ * gap in range. */
            const int64_t enough = 1000 + (allowance_ < 0 ? (-allowance_ / rate_ + 1) * 1000 : 0);
            int64_t gap = now_ms - last_ms_;
            if (gap > enough)
                gap = enough;
            int64_t refill = rate_ * gap / 1000;
            int64_t room = cap;
            bool full = false;
            if (share_ && share_pct_) {
                int64_t &hud = share_->allowance_;
                const int64_t part = cap * share_pct_ / 100;
                /* Nothing spent since a refill filled it. */
                full = allowance_ > 0 && allowance_ == full_at_;
                const int64_t give = full ? refill : std::min(refill * share_pct_ / 100, pos(part - hud));
                hud = std::min(hud + give, cap);
                refill -= give;
                /* While the cluster writes, what the HUD holds over its part
                 * goes back as far as the two would hold more than a burst. */
                if (!full)
                    hud -= std::min(pos(pos(allowance_ + refill) + pos(hud) - cap), pos(hud - part));
                room = cap - pos(hud);
            }
            const bool filled = full || allowance_ + refill >= room;
            allowance_ = std::min(allowance_ + refill, room);
            full_at_ = filled ? allowance_ : -1;
            last_ms_ = now_ms;
        }
        return allowance_ > 0;
    }

    /* The bytes that may go now, as of the last ready(); negative: the
     * debt still to repay. Unlimited: INT64_MAX. */
    int64_t allowance() const { return rate() == 0 ? INT64_MAX : allowance_; }
    /* Charges bytes sent. Call ready() first, so the allowance is current. */
    void spend(uint64_t bytes)
    {
        if (rate() != 0)
            allowance_ -= int64_t(bytes);
    }

private:
    int64_t rate() const { return source_ ? source_->rate_ : rate_; }
    static int64_t pos(int64_t v) { return v > 0 ? v : 0; }

    int64_t rate_;
    int64_t burst_ms_;
    int64_t allowance_ = 0;
    int64_t full_at_ = -1;            /* a source's allowance while it sits full */
    int64_t last_ms_ = -1;
    UploadPacer *source_ = nullptr;   /* a share pacer's */
    UploadPacer *share_ = nullptr;    /* a source's share pacer */
    unsigned share_pct_ = 0;          /* a source's */
};

}  // namespace crk

#endif
