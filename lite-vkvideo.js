/**
 * lite-vkvideo — lightweight Shadow DOM facade for VK Video embeds.
 * Docs: https://dev.vk.com/ru/widgets/video
 *
 * Usage:
 *   <lite-vkvideo oid="…" videoid="…" hash="…" videotitle="…"></lite-vkvideo>
 *   <lite-vkvideo … poster="https://…"></lite-vkvideo>
 *
 * Without an explicit `poster`, the component tries same-origin `/vk-poster`
 * (see vk-poster.mjs). If the proxy is missing, shows a dark frame + play button.
 */
class LiteVKVideoEmbed extends HTMLElement {
    static isPreconnected = false;
    static videoPlayerScriptPromise = null;

    /** Query keys owned by the component — `params` cannot override these. */
    static RESERVED_QUERY_KEYS = new Set(['oid', 'id', 'hash', 'hd', 't', 'autoplay', 'loop', 'muted', 'js_api']);

    /** Hosts allowed for poster URLs returned by the proxy. */
    static TRUSTED_POSTER_HOST_SUFFIXES = [
        'vk.ru',
        'vk.com',
        'vk.me',
        'vkuservideo.net',
        'userapi.com',
        'okcdn.ru',
        'mycdn.me',
        'vkvideo.ru',
    ];

    static STYLE = `
        :host {
          --aspect-ratio: var(--lite-vkvideo-aspect-ratio, 16 / 9);
          contain: content;
          display: block;
          position: relative;
          width: 100%;
          aspect-ratio: var(--aspect-ratio);
          background: #000;
          box-sizing: border-box;
        }

        :host([short]) {
          --aspect-ratio: var(--lite-vkvideo-aspect-ratio-short, 9 / 16);
        }

        :host([border]) {
          border: var(--lite-vkvideo-border, 1px solid rgba(0, 0, 0, 0.18));
          overflow: hidden;
        }

        #frame, #poster, iframe {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }

        #frame {
          cursor: pointer;
        }

        #poster {
          object-fit: cover;
          background: #000;
        }

        #title {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: 2;
          padding: 12px 14px;
          color: #fff;
          font: 500 14px/1.35 system-ui, sans-serif;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
          pointer-events: none;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        #title:empty {
          display: none;
        }

        #frame.has-title::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 40px;
          background: linear-gradient(
            180deg,
            rgba(0, 0, 0, 0.7) 0%,
            rgba(0, 0, 0, 0.25) 65%,
            transparent 100%
          );
          z-index: 1;
          pointer-events: none;
        }

        #playButton {
          box-sizing: border-box;
          width: 80px;
          height: 80px;
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.55);
          color: #fff;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate3d(-50%, -50%, 0);
          cursor: inherit;
          transition: transform 0.18s ease, background-color 0.18s ease;
        }

        #playButton svg {
          display: block;
          width: 48px;
          height: 48px;
          pointer-events: none;
          opacity: 0.72;
          transition: opacity 0.18s ease;
        }

        #frame:hover #playButton,
        #playButton:hover,
        #playButton:focus-visible {
          transform: translate3d(-50%, -50%, 0) scale(1.12);
          background: rgba(0, 0, 0, 0.65);
        }

        #frame:hover #playButton svg,
        #playButton:hover svg,
        #playButton:focus-visible svg {
          opacity: 1;
        }

        #frame.activated {
          cursor: unset;
        }

        #frame.activated::before,
        #frame.activated > #playButton,
        #frame.activated > #title,
        #frame.activated > #poster {
          display: none;
        }
  `;

    constructor() {
        super();
        this.isIframeLoaded = false;
        this.vkPlayer = null;
        this._posterLoading = false;
        this._posterResolvedKey = '';
        this._posterGeneration = 0;
        this._posterTimer = null;
        this._playerTimers = new Set();
        this._observers = [];
        this._lifecycleAbort = null;
        this._ioReady = false;
        this.setupDom();
    }

    static get observedAttributes() {
        return [
            'oid',
            'videoid',
            'hash',
            'videoplay',
            'videotitle',
            'hd',
            'autoplay',
            'loop',
            'jsapi',
            'mute',
            'unmute',
            't',
            'videostartat',
            'poster',
            'border',
        ];
    }

    /* ─── sanitizers / validators ─── */

    /** Strip control chars and limit length for display strings. */
    static sanitizeText(value, maxLen = 200) {
        return String(value ?? '')
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .trim()
            .slice(0, maxLen);
    }

    /** VK owner id: optional minus + digits. */
    static sanitizeOid(raw) {
        const v = String(raw ?? '').trim();
        return /^-?\d{1,16}$/.test(v) ? v : '';
    }

    /** VK video id: digits only. */
    static sanitizeVideoId(raw) {
        const v = String(raw ?? '').trim();
        return /^\d{1,16}$/.test(v) ? v : '';
    }

    /** Embed hash: hex / alnum. */
    static sanitizeHash(raw) {
        const v = String(raw ?? '').trim();
        return /^[a-zA-Z0-9]{1,64}$/.test(v) ? v : '';
    }

    /** `t` as 00h00m00s (or subset). */
    static sanitizeTimeCode(raw) {
        const v = String(raw ?? '')
            .trim()
            .toLowerCase();
        if (!/^(?:\d{1,3}h)?(?:\d{1,3}m)?(?:\d{1,3}s)?$/.test(v) || !/[hms]/.test(v)) {
            return '';
        }
        return v;
    }

    /** CSS border shorthand — reject injection vectors. */
    static sanitizeCssBorder(raw) {
        const v = String(raw ?? '')
            .trim()
            .slice(0, 80);
        if (!v) return '';
        if (/[;{}\\]|url\s*\(|expression|@import|javascript:/i.test(v)) {
            return '';
        }
        if (!/^[\w\s#%.,()/*+-]+$/i.test(v)) return '';
        return v;
    }

    /** Validate image URL — only http(s). Optionally restrict to VK CDN hosts. */
    static sanitizeImageUrl(raw, opts = {}) {
        const value = String(raw ?? '').trim();
        if (!value || value.length > 2048) return '';
        let url;
        try {
            url = new URL(value, window.location.href);
        } catch {
            return '';
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
        if (opts.trustedOnly) {
            const host = url.hostname.toLowerCase();
            const ok = LiteVKVideoEmbed.TRUSTED_POSTER_HOST_SUFFIXES.some(
                (suffix) => host === suffix || host.endsWith(`.${suffix}`)
            );
            if (!ok) return '';
        }
        return url.href;
    }

    static safeJsonParse(text) {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    /* ─── lifecycle ─── */

    connectedCallback() {
        this._lifecycleAbort?.abort();
        this._lifecycleAbort = new AbortController();
        const { signal } = this._lifecycleAbort;

        this.addEventListener('pointerover', () => LiteVKVideoEmbed.warmConnections(), { once: true, signal });
        this.addEventListener('click', () => this.addIframe(), { signal });

        this.setupComponent();
        this.scheduleResolvePoster();
    }

    disconnectedCallback() {
        this._lifecycleAbort?.abort();
        this._lifecycleAbort = null;
        this.clearPosterTimer();
        this.clearPlayerTimers();
        this.disconnectObservers();
        this.destroyPlayer();
        this._ioReady = false;
    }

    /* ─── attribute accessors ─── */

    get oid() {
        return LiteVKVideoEmbed.sanitizeOid(this.getAttribute('oid'));
    }

    get videoId() {
        return LiteVKVideoEmbed.sanitizeVideoId(this.getAttribute('videoid'));
    }

    get hash() {
        return LiteVKVideoEmbed.sanitizeHash(this.getAttribute('hash'));
    }

    get videoTitle() {
        return LiteVKVideoEmbed.sanitizeText(this.getAttribute('videotitle') || 'Video');
    }

    get videoPlay() {
        return LiteVKVideoEmbed.sanitizeText(this.getAttribute('videoplay') || 'Play', 80);
    }

    get poster() {
        return LiteVKVideoEmbed.sanitizeImageUrl(this.getAttribute('poster') || '');
    }

    /** Start time in seconds (from `videostartat` or numeric `t`). */
    get videoStartAtSeconds() {
        if (this.hasAttribute('videostartat')) {
            const n = parseInt(this.getAttribute('videostartat') || '', 10);
            if (!Number.isFinite(n) || n < 0) return 0;
            return Math.min(n, 86400 * 24);
        }
        const t = (this.getAttribute('t') || '').trim();
        if (t && /^\d{1,7}$/.test(t)) {
            return Math.min(parseInt(t, 10), 86400 * 24);
        }
        return 0;
    }

    /** VK `t` query value in 00h00m00s form, or empty. */
    get startTimeParam() {
        const coded = LiteVKVideoEmbed.sanitizeTimeCode(this.getAttribute('t'));
        if (coded) return coded;
        const seconds = this.videoStartAtSeconds;
        return seconds > 0 ? this.formatStartTime(seconds) : '';
    }

    /**
     * Explicit autoplay attr: true / false / null (use facade defaults).
     * Presence or "1"/"true" → on; "0"/"false" → off.
     */
    get autoplayPref() {
        if (!this.hasAttribute('autoplay')) return null;
        const v = (this.getAttribute('autoplay') || '').trim().toLowerCase();
        if (v === '0' || v === 'false') return false;
        return true;
    }

    get hd() {
        const v = this.getAttribute('hd');
        return v && ['1', '2', '3', '4'].includes(v) ? v : '';
    }

    get loop() {
        return this.hasAttribute('loop');
    }

    get mute() {
        return this.hasAttribute('mute');
    }

    get unmute() {
        return this.hasAttribute('unmute');
    }

    get jsApi() {
        return this.hasAttribute('jsapi');
    }

    get autoLoad() {
        return this.hasAttribute('autoload');
    }

    get autoPause() {
        return this.hasAttribute('autopause');
    }

    get params() {
        return this.getAttribute('params') || '';
    }

    get cacheKey() {
        return `lite-vkvideo-poster:${this.oid}_${this.videoId}`;
    }

    get hasValidIds() {
        return Boolean(this.oid && this.videoId);
    }

    /* ─── DOM ─── */

    setupDom() {
        if (this.shadowRoot) return;

        const root = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        if (window.liteVkVideoNonce) {
            style.setAttribute('nonce', String(window.liteVkVideoNonce));
        }
        style.textContent = LiteVKVideoEmbed.STYLE;

        const frame = document.createElement('div');
        frame.id = 'frame';

        const poster = document.createElement('img');
        poster.id = 'poster';
        poster.alt = '';
        poster.decoding = 'async';
        poster.loading = 'lazy';
        poster.hidden = true;
        poster.referrerPolicy = 'no-referrer';

        const title = document.createElement('div');
        title.id = 'title';

        const playButton = document.createElement('button');
        playButton.id = 'playButton';
        playButton.setAttribute('part', 'playButton');
        playButton.type = 'button';
        playButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true" width="48" height="48" viewBox="0 0 48 48" fill="var(--btn-color, #fff)">
        <path d="m14.4 8.76 24.02 13.85a1.6 1.6 0 0 1 0 2.78L14.4 39.24a1.6 1.6 0 0 1-2.4-1.39v-27.7a1.6 1.6 0 0 1 2.4-1.39"></path>
      </svg>
    `;

        frame.append(poster, title, playButton);
        root.append(style, frame);

        this.domRefFrame = frame;
        this.domRefPoster = poster;
        this.domRefPlayButton = playButton;
        this.domRefTitle = title;
    }

    setupComponent() {
        if (!this.domRefFrame) return;

        try {
            const label = `${this.videoPlay}: ${this.videoTitle}`;
            this.domRefPlayButton.setAttribute('aria-label', label);
            this.setAttribute('title', label);
            this.domRefPoster.alt = label;
            this.domRefTitle.textContent = this.hasAttribute('videotitle') ? this.videoTitle : '';
            this.domRefFrame.classList.toggle('has-title', this.hasAttribute('videotitle'));
            this.applyBorder();

            if (this.autoLoad || this.autoPause || this.hasAttribute('short')) {
                this.initIntersectionObserver();
            }
        } catch {
            /* never break the host page */
        }
    }

    applyBorder() {
        if (!this.hasAttribute('border')) {
            this.style.removeProperty('--lite-vkvideo-border');
            return;
        }
        const value = (this.getAttribute('border') || '').trim();
        if (!value || value === 'true' || value === '1') {
            this.style.removeProperty('--lite-vkvideo-border');
            return;
        }
        const safe = LiteVKVideoEmbed.sanitizeCssBorder(value);
        if (safe) {
            this.style.setProperty('--lite-vkvideo-border', safe);
        } else {
            this.style.removeProperty('--lite-vkvideo-border');
        }
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (oldVal === newVal || !this.domRefFrame) return;

        try {
            this.setupComponent();

            if (['oid', 'videoid', 'hash', 'poster'].includes(name)) {
                this._posterResolvedKey = '';
                this.scheduleResolvePoster();
            }

            if (this.domRefFrame.classList.contains('activated')) {
                this.resetIframe();
            }
        } catch {
            /* no-op */
        }
    }

    resetIframe() {
        this.clearPlayerTimers();
        this.destroyPlayer();
        this.shadowRoot?.querySelector('iframe')?.remove();
        this.domRefFrame?.classList.remove('activated');
        this.isIframeLoaded = false;
    }

    /* ─── poster ─── */

    setPosterUrl(url, { trustedOnly = false } = {}) {
        const safe = LiteVKVideoEmbed.sanitizeImageUrl(url, { trustedOnly });
        if (!safe || !this.domRefPoster) return false;
        this.domRefPoster.hidden = false;
        this.domRefPoster.src = safe;
        try {
            sessionStorage.setItem(this.cacheKey, safe);
        } catch {
            /* private mode / quota */
        }
        return true;
    }

    clearPosterTimer() {
        if (this._posterTimer != null) {
            clearTimeout(this._posterTimer);
            this._posterTimer = null;
        }
    }

    scheduleResolvePoster() {
        this.clearPosterTimer();
        this._posterTimer = setTimeout(() => {
            this._posterTimer = null;
            void this.resolvePoster();
        }, 0);
    }

    async resolvePoster() {
        if (!this.isConnected || this._posterLoading) return;

        const key = this.cacheKey;
        if (this._posterResolvedKey === key) return;

        const generation = ++this._posterGeneration;
        this._posterLoading = true;

        const stillCurrent = () => this.isConnected && generation === this._posterGeneration && this.cacheKey === key;

        try {
            if (this.poster) {
                if (stillCurrent() && this.setPosterUrl(this.poster)) {
                    this._posterResolvedKey = key;
                }
                return;
            }

            try {
                const cached = sessionStorage.getItem(key);
                if (cached && stillCurrent() && this.setPosterUrl(cached, { trustedOnly: true })) {
                    this._posterResolvedKey = key;
                    return;
                }
            } catch {
                /* private mode */
            }

            if (!this.hasValidIds) return;

            const url = await this.fetchPosterFromProxy();
            if (!stillCurrent()) return;

            if (url && this.setPosterUrl(url, { trustedOnly: true })) {
                this._posterResolvedKey = key;
            }
        } catch {
            /* swallow network / parse errors */
        } finally {
            if (generation === this._posterGeneration) {
                this._posterLoading = false;
            }
        }
    }

    async fetchPosterFromProxy() {
        if (!this.hasValidIds) return '';
        const qs = new URLSearchParams({ oid: this.oid, id: this.videoId });
        if (this.hash) qs.set('hash', this.hash);

        try {
            const res = await fetch(`/vk-poster?${qs}`, {
                credentials: 'same-origin',
                signal: this._lifecycleAbort?.signal,
            });
            if (!res.ok) return '';
            const data = LiteVKVideoEmbed.safeJsonParse(await res.text());
            return LiteVKVideoEmbed.sanitizeImageUrl(data?.url || '', {
                trustedOnly: true,
            });
        } catch {
            return '';
        }
    }

    /* ─── embed ─── */

    formatStartTime(seconds) {
        const total = Math.max(0, Math.min(Number(seconds) || 0, 86400 * 24));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(h)}h${pad(m)}m${pad(s)}s`;
    }

    /** Merge user `params` without overriding reserved keys. */
    applySafeParams(query) {
        const raw = this.params;
        if (!raw || raw.length > 1024) return;

        try {
            new URLSearchParams(raw).forEach((value, key) => {
                const k = String(key).trim().toLowerCase();
                if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) return;
                if (LiteVKVideoEmbed.RESERVED_QUERY_KEYS.has(k)) return;
                const v = String(value).slice(0, 256);
                if (/[\r\n]/.test(v)) return;
                query.set(k, v);
            });
        } catch {
            /* ignore malformed params */
        }
    }

    buildEmbedSrc(fromObserver = false) {
        if (!this.hasValidIds) return '';

        const query = new URLSearchParams();
        query.set('oid', this.oid);
        query.set('id', this.videoId);
        if (this.hash) query.set('hash', this.hash);

        if (this.hd) query.set('hd', this.hd);

        const t = this.startTimeParam;
        if (t) query.set('t', t);

        let autoplay;
        if (this.autoplayPref === true) autoplay = 1;
        else if (this.autoplayPref === false) autoplay = 0;
        else autoplay = fromObserver ? 0 : 1;
        if (this.hasAttribute('short') && this.autoplayPref !== false) {
            autoplay = 1;
        }
        query.set('autoplay', String(autoplay));

        if (this.loop || this.hasAttribute('short')) {
            query.set('loop', '1');
        }

        if (this.mute) {
            query.set('muted', '1');
        } else if (this.unmute) {
            query.set('muted', '0');
        }

        const needJsApi =
            this.jsApi || this.autoPause || this.mute || this.unmute || this.videoStartAtSeconds > 0 || Boolean(t);
        if (needJsApi) query.set('js_api', '1');

        this.applySafeParams(query);

        return `https://vk.ru/video_ext.php?${query.toString()}`;
    }

    createIframe(fromObserver = false) {
        const src = this.buildEmbedSrc(fromObserver);
        if (!src) return null;

        const iframe = document.createElement('iframe');
        iframe.setAttribute('credentialless', '');
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allowfullscreen', '');
        iframe.title = this.videoTitle;
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
        iframe.loading = 'lazy';
        // Assign src last so attributes apply first
        iframe.src = src;
        return iframe;
    }

    addIframe(fromObserver = false) {
        if (this.isIframeLoaded || !this.isConnected || !this.domRefFrame) return;
        if (!this.hasValidIds) return;

        try {
            const iframe = this.createIframe(fromObserver);
            if (!iframe) return;

            this.domRefFrame.append(iframe);
            this.domRefFrame.classList.add('activated');
            this.isIframeLoaded = true;

            const startAt = this.videoStartAtSeconds;
            if (this.autoPause || this.jsApi || this.mute || this.unmute || startAt > 0) {
                void this.initVkPlayer().then(() => {
                    if (!this.isConnected || !this.isIframeLoaded) return;
                    if (startAt > 0) this.applyStartTime(startAt);
                    if (this.mute) this.applyMute();
                    else if (this.unmute) this.applyUnmute();
                });
            }

            this.dispatchEvent(
                new CustomEvent('liteVkVideoIframeLoaded', {
                    detail: {
                        oid: this.oid,
                        videoId: this.videoId,
                        hash: this.hash,
                    },
                    bubbles: true,
                    cancelable: true,
                })
            );
        } catch {
            this.isIframeLoaded = false;
            this.domRefFrame?.classList.remove('activated');
        }
    }

    /* ─── observers / player ─── */

    disconnectObservers() {
        for (const obs of this._observers) {
            try {
                obs.disconnect();
            } catch {
                /* no-op */
            }
        }
        this._observers = [];
    }

    initIntersectionObserver() {
        if (this._ioReady || typeof IntersectionObserver !== 'function') return;
        this._ioReady = true;

        try {
            const loadObs = new IntersectionObserver((entries, obs) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && !this.isIframeLoaded) {
                        LiteVKVideoEmbed.warmConnections();
                        this.addIframe(true);
                        obs.unobserve(this);
                    }
                }
            });
            loadObs.observe(this);
            this._observers.push(loadObs);

            if (this.autoPause) {
                const pauseObs = new IntersectionObserver(
                    (entries) => {
                        for (const entry of entries) {
                            if (entry.intersectionRatio !== 1) {
                                this.safePlayerCall('pause');
                            }
                        }
                    },
                    { threshold: 1 }
                );
                pauseObs.observe(this);
                this._observers.push(pauseObs);
            }
        } catch {
            this._ioReady = false;
        }
    }

    destroyPlayer() {
        try {
            this.vkPlayer?.destroy?.();
        } catch {
            /* no-op */
        }
        this.vkPlayer = null;
    }

    clearPlayerTimers() {
        for (const id of this._playerTimers) {
            clearTimeout(id);
        }
        this._playerTimers.clear();
    }

    schedulePlayerAction(fn, delay = 400) {
        const id = setTimeout(() => {
            this._playerTimers.delete(id);
            if (!this.isConnected || !this.vkPlayer) return;
            try {
                fn();
            } catch {
                /* VK player may throw if iframe gone */
            }
        }, delay);
        this._playerTimers.add(id);
    }

    safePlayerCall(method, ...args) {
        const player = this.vkPlayer;
        if (!player || typeof player[method] !== 'function') return;
        try {
            player[method](...args);
        } catch {
            /* no-op */
        }
    }

    async initVkPlayer() {
        const iframe = this.shadowRoot?.querySelector('iframe');
        if (!iframe || !this.isConnected) return;

        try {
            await LiteVKVideoEmbed.loadVideoPlayerScript();
            if (!this.isConnected || !window.VK?.VideoPlayer) return;
            this.vkPlayer = window.VK.VideoPlayer(iframe);
        } catch {
            this.vkPlayer = null;
        }
    }

    applyStartTime(startAt) {
        const player = this.vkPlayer;
        if (!player || typeof player.seek !== 'function') return;

        const seekClamped = () => {
            try {
                const duration = Number(player.getDuration?.()) || 0;
                let target = startAt;
                if (duration > 0 && startAt >= duration) {
                    target = Math.max(0, duration - 1);
                }
                player.seek(target);
            } catch {
                /* no-op */
            }
        };

        try {
            player.on?.('inited', seekClamped);
        } catch {
            /* no-op */
        }
        this.schedulePlayerAction(seekClamped);
    }

    applyMute() {
        if (typeof this.vkPlayer?.mute !== 'function') return;
        const mute = () => this.safePlayerCall('mute');
        try {
            this.vkPlayer.on?.('inited', mute);
        } catch {
            /* no-op */
        }
        this.schedulePlayerAction(mute);
    }

    applyUnmute() {
        if (typeof this.vkPlayer?.unmute !== 'function') return;
        const unmute = () => this.safePlayerCall('unmute');
        try {
            this.vkPlayer.on?.('inited', unmute);
        } catch {
            /* no-op */
        }
        this.schedulePlayerAction(unmute);
    }

    static loadVideoPlayerScript() {
        if (window.VK?.VideoPlayer) return Promise.resolve();
        if (LiteVKVideoEmbed.videoPlayerScriptPromise) {
            return LiteVKVideoEmbed.videoPlayerScriptPromise;
        }

        LiteVKVideoEmbed.videoPlayerScriptPromise = new Promise((resolve, reject) => {
            try {
                const script = document.createElement('script');
                script.src = 'https://vk.ru/js/api/videoplayer.js';
                script.async = true;
                script.referrerPolicy = 'no-referrer';
                script.onload = () => resolve();
                script.onerror = () => {
                    LiteVKVideoEmbed.videoPlayerScriptPromise = null;
                    reject(new Error('Failed to load VK VideoPlayer script'));
                };
                document.head.append(script);
            } catch (err) {
                LiteVKVideoEmbed.videoPlayerScriptPromise = null;
                reject(err);
            }
        });
        return LiteVKVideoEmbed.videoPlayerScriptPromise;
    }

    static addPrefetch(url) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:') return;
            const link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = parsed.origin;
            link.crossOrigin = 'anonymous';
            document.head.append(link);
        } catch {
            /* no-op */
        }
    }

    static warmConnections() {
        if (LiteVKVideoEmbed.isPreconnected || window.liteVkVideoIsPreconnected) {
            return;
        }
        LiteVKVideoEmbed.addPrefetch('https://vk.ru');
        LiteVKVideoEmbed.addPrefetch('https://vk.com');
        LiteVKVideoEmbed.addPrefetch('https://vkvideo.ru');
        LiteVKVideoEmbed.addPrefetch('https://iv.okcdn.ru');
        LiteVKVideoEmbed.addPrefetch('https://i.mycdn.me');
        LiteVKVideoEmbed.isPreconnected = true;
        window.liteVkVideoIsPreconnected = true;
    }
}

if (!customElements.get('lite-vkvideo')) {
    customElements.define('lite-vkvideo', LiteVKVideoEmbed);
}
