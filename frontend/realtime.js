// اتصال لحظي دائم (WebSocket) بمركز المزامنة على Cloudflare.
// أي تعديل من الموبايل أو الكمبيوتر يصل لكل الشاشات المفتوحة فوراً بدون انتظار.
(function () {
    const CLOUD_HOST = 'rambfe.pages.dev';
    const isCloudPage = /\.pages\.dev$|\.workers\.dev$/.test(location.hostname);
    const wsUrl = `wss://${isCloudPage ? location.host : CLOUD_HOST}/api/realtime`;

    const RT = {
        connected: false,
        _ws: null,
        _handlers: [],
        _retry: 1000,
        _pingTimer: null,
        onEvent(fn) { this._handlers.push(fn); },
        _emit(evt) {
            // تجاهل أحداث الصيدليات الأخرى
            const cur = window.RambfeProfiles ? window.RambfeProfiles.currentId() : 1;
            if (evt && evt.profile_id && evt.profile_id !== cur && evt.type !== 'profiles_changed') return;
            for (const h of this._handlers) { try { h(evt); } catch (e) { console.warn('realtime handler', e); } }
        },
        connect() {
            if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return;
            let ws;
            try { ws = new WebSocket(wsUrl); } catch (e) { this._schedule(); return; }
            this._ws = ws;
            ws.onopen = () => {
                const wasDown = !this.connected;
                this.connected = true;
                this._retry = 1000;
                clearInterval(this._pingTimer);
                this._pingTimer = setInterval(() => { try { ws.send('ping'); } catch (_) { } }, 25000);
                // بعد أي انقطاع: إعادة تحميل البيانات لالتقاط ما فات
                if (wasDown) this._emit({ type: '__resync', payload: {}, timestamp: Date.now() / 1000 });
            };
            ws.onmessage = (m) => {
                if (m.data === 'pong') return;
                try { this._emit(JSON.parse(m.data)); } catch (_) { }
            };
            ws.onclose = () => { this.connected = false; clearInterval(this._pingTimer); this._schedule(); };
            ws.onerror = () => { try { ws.close(); } catch (_) { } };
        },
        _schedule() {
            setTimeout(() => this.connect(), this._retry);
            this._retry = Math.min(this._retry * 2, 15000);
        }
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) RT.connect(); });
    window.addEventListener('online', () => RT.connect());
    window.RambfeRealtime = RT;
    RT.connect();
})();
