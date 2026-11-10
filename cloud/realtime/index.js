// مركز المزامنة اللحظية: كل شاشة (موبايل/كمبيوتر) تفتح اتصال WebSocket دائم،
// وأي تعديل على الجرد يُرسل فوراً لكل الشاشات المفتوحة (أقل من ثانية).
// يستخدم WebSocket Hibernation حتى لا يستهلك موارد أثناء عدم وجود رسائل.
import { DurableObject } from 'cloudflare:workers';

export class SyncHub extends DurableObject {
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
            const msg = await request.text();
            for (const ws of this.ctx.getWebSockets()) {
                try { ws.send(msg); } catch (_) { }
            }
            return new Response('ok');
        }
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
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
