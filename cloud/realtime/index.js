// مركز المزامنة اللحظية: كل شاشة (موبايل/كمبيوتر) تفتح اتصال WebSocket دائم،
// وأي تعديل على الجرد يُرسل فوراً لكل الشاشات المفتوحة (أقل من ثانية).
// يستخدم WebSocket Hibernation حتى لا يستهلك موارد أثناء عدم وجود رسائل.
//
// وكمان بيمسك (من غير ما يلمس قاعدة البيانات D1 خالص):
//   - "رقم نسخة البيانات" (ver): بيزيد مع كل تعديل. الجهاز يحتفظ بآخر نسخة من الصفحات، ولو الرقم متغيرش
//     بيفتح من الجهاز بدل ما يقرا من قاعدة البيانات تاني (الريفرش صفر قراءات).
//   - عدّاد استهلاك اليوم (قراءات/كتابات D1) اللي بيبعته الموقع، وبيوصله لكل الشاشات لحظياً لشريط الحد اليومي.
import { DurableObject } from 'cloudflare:workers';

const utcDay = () => new Date().toISOString().slice(0, 10);
const resetsAt = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) + 86400000; };

export class SyncHub extends DurableObject {
    async load() {
        if (this.loaded) return;
        const got = await this.ctx.storage.get(['ver', 'usage']);
        this.ver = got.get('ver') || Date.now();
        this.usage = got.get('usage') || { day: utcDay(), r: 0, w: 0, rl: 5000000, wl: 100000, seeded: false };
        this.loaded = true;
    }
    roll(day) {
        const d = day || utcDay();
        if (this.usage.day !== d && d >= this.usage.day) this.usage = { ...this.usage, day: d, r: 0, w: 0, seeded: false };
    }
    meta() {
        const u = this.usage;
        return { type: '__meta', ver: this.ver, usage: { day: u.day, r: u.r, w: u.w, rl: u.rl, wl: u.wl, resets_at: resetsAt(u.day) } };
    }
    sendAll(msg) {
        for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch (_) { } }
    }
    json(o) { return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }); }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
            this.sendAll(await request.text());
            return new Response('ok');
        }
        // الموقع بيبعت الاستهلاك الجديد (وعلامة إن فيه تعديل حصل) ويرجعله الإجمالي ورقم النسخة
        if (url.pathname.endsWith('/sync') && request.method === 'POST') {
            await this.load();
            const b = await request.json().catch(() => ({}));
            this.roll(b.day);
            const add = Number(b.r) || 0, addW = Number(b.w) || 0;
            if (Number(b.rl) >= 0 && b.rl != null) this.usage.rl = Number(b.rl);
            if (Number(b.wl) >= 0 && b.wl != null) this.usage.wl = Number(b.wl);
            this.usage.r += add; this.usage.w += addW;
            if (b.touch) this.ver = Math.max(Date.now(), this.ver + 1);
            if (add || addW || b.touch) {
                this.ctx.storage.put({ ver: this.ver, usage: this.usage });
                this.sendAll(JSON.stringify(this.meta()));
            }
            return this.json({ ...this.meta(), need_seed: !this.usage.seeded });
        }
        // أول مرة في اليوم: استهلاك اليوم اللي اتسجل قبل كده في قاعدة البيانات يتضاف مرة واحدة
        if (url.pathname.endsWith('/seed') && request.method === 'POST') {
            await this.load();
            const b = await request.json().catch(() => ({}));
            this.roll(b.day);
            if (!this.usage.seeded && b.day === this.usage.day) {
                this.usage.r += Number(b.r) || 0; this.usage.w += Number(b.w) || 0; this.usage.seeded = true;
                this.ctx.storage.put({ usage: this.usage });
                this.sendAll(JSON.stringify(this.meta()));
            }
            return this.json(this.meta());
        }
        if (url.pathname.endsWith('/state')) {
            await this.load();
            this.roll();
            return this.json(this.meta());
        }
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        await this.load();
        this.roll();
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        // أول ما الشاشة تتصل: رقم النسخة والاستهلاك الحالي
        try { pair[1].send(JSON.stringify(this.meta())); } catch (_) { }
        return new Response(null, { status: 101, webSocket: pair[0] });
    }
    async webSocketMessage(ws, message) {
        // نبضة إبقاء الاتصال حياً
        if (message === 'ping') { try { ws.send('pong'); } catch (_) { } }
    }
    async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch (_) { } }
    async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (_) { } }
}

export default {
    async fetch() { return new Response('RAMBFE realtime hub', { status: 200 }); }
};
