// One Euro Filter — low-latency jitter smoothing for noisy real-time signals
// (Casiez, Roussel & Vogel, 2012). The de-facto standard for stabilising AR landmark
// tracking: it smooths hard when the signal is still (kills jitter) and loosens up when the
// signal moves fast (kills lag), unlike a fixed EMA which forces you to trade one for the other.

class LowPass {
    constructor() {
        this.hatXPrev = null;
    }
    filter(x, alpha) {
        this.hatXPrev = this.hatXPrev === null ? x : alpha * x + (1 - alpha) * this.hatXPrev;
        return this.hatXPrev;
    }
    get hasLast() {
        return this.hatXPrev !== null;
    }
}

export class OneEuroFilter {
    // minCutoff: lower = smoother but more lag at rest. beta: higher = less lag on fast motion.
    constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
        this.xFilter = new LowPass();
        this.dxFilter = new LowPass();
        this.tPrev = null;
        this.xPrev = null;
    }

    _alpha(cutoff, dt) {
        const tau = 1 / (2 * Math.PI * cutoff);
        return 1 / (1 + tau / dt);
    }

    // x: sample value. t: timestamp in seconds.
    filter(x, t) {
        if (this.tPrev === null) {
            this.tPrev = t;
            this.xPrev = x;
            this.xFilter.filter(x, 1);
            return x;
        }
        let dt = t - this.tPrev;
        if (!(dt > 0)) dt = 1e-3; // guard against zero/negative timestamps
        this.tPrev = t;

        const dxRaw = (x - this.xPrev) / dt;
        this.xPrev = x;
        const edx = this.dxFilter.filter(dxRaw, this._alpha(this.dCutoff, dt));
        const cutoff = this.minCutoff + this.beta * Math.abs(edx);
        return this.xFilter.filter(x, this._alpha(cutoff, dt));
    }
}
