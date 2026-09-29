const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-live-ex.user.js'), 'utf8');

function packet(value, operation = 5, version = 0) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const b = Buffer.alloc(16 + body.length);
  b.writeUInt32BE(b.length); b.writeUInt16BE(16, 4); b.writeUInt16BE(version, 6); b.writeUInt32BE(operation, 8);
  body.copy(b, 16); return b;
}
const gift = (id, uid = 123) => ({ cmd: 'SEND_GIFT', data: { uid, tid: id, giftId: 1, coin_type: 'gold', num: 1, total_coin: 1000 } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://live.bilibili.com/1', runScripts: 'outside-only' });
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  w.confirm = () => true;
  w.setInterval = callback => { w.poll = callback; return 1; };
  w.clearInterval = () => {};
  w.pako = require('pako');
  w.BrotliDecode = bytes => w.Int8Array.from(zlib.brotliDecompressSync(bytes));
  class Socket extends w.EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; }
    send(data) { this.sent.push(data); return 'original-result'; }
    receive(data) { this.dispatchEvent(new w.MessageEvent('message', { data })); }
    close() { this.readyState = 3; this.dispatchEvent(new w.Event('close')); }
  }
  w.WebSocket = Socket;
  w.eval(source);
  const encode = (value, op, version) => w.Uint8Array.from(packet(value, op, version)).buffer;
  const connect = (room = 1) => {
    const ws = new w.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
    assert.equal(ws.send(encode({ roomid: room }, 7)), 'original-result');
    return ws;
  };
  const panel = w.document.getElementById('bili-live-ex-panel').shadowRoot;
  return { dom, w, Socket, encode, connect, panel, text: id => panel.getElementById(id).textContent };
}

test('页面集成：旁路监听保留原消息、原连接行为；Brotli 消息更新面板', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  const ws = app.connect();
  assert.ok(ws instanceof app.Socket);
  assert.equal(app.w.WebSocket.OPEN, 1);
  let originalMessages = 0;
  ws.addEventListener('message', () => originalMessages++);
  const content = zlib.brotliCompressSync(Buffer.concat([packet(gift('one')), packet(gift('one'))]));
  ws.receive(app.encode(content, 5, 3));
  await flush(); await app.w.poll();
  assert.equal(originalMessages, 1);
  assert.equal(app.text('payers'), '1');
  assert.equal(app.text('total'), '¥1.00');
  assert.match(app.text('status'), /正在统计/);
  ws.close(); await app.w.poll(); assert.match(app.text('status'), /中断/);
});

test('页面集成：切房不混入旧连接、其他房间及异步 Blob 的数据', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  const old = app.connect();
  let release;
  old.receive({ arrayBuffer: () => new Promise(resolve => { release = resolve; }) });
  await flush();
  app.w.history.pushState({}, '', '/2'); await app.w.poll();
  release(app.encode(gift('late'))); await flush();
  old.receive(app.encode(gift('old-room')));
  const current = app.connect(2);
  const wrong = app.connect(999);
  wrong.receive(app.encode(gift('wrong-room')));
  current.receive(app.encode(gift('new-room')));
  await flush(); await app.w.poll();
  assert.equal(app.text('room'), '· 2');
  assert.equal(app.text('total'), '¥1.00');
});

test('页面集成：非弹幕连接不统计、未知人数不显示 0、关闭画质与重置生效', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  const other = new app.w.WebSocket('wss://example.com/sub');
  other.receive(app.encode(gift('external')));
  await flush(); await app.w.poll();
  assert.equal(app.text('total'), '¥0.00');
  assert.equal(app.text('online'), '未提供');
  const ws = app.connect(); ws.receive(app.encode(gift('paid')));
  ws.receive(app.encode({ cmd: 'ONLINE_RANK_COUNT', data: { count: 10, online_count: 0 } }));
  await flush(); await app.w.poll();
  assert.equal(app.text('online'), '0'); assert.equal(app.text('highEnergy'), '10');
  app.panel.getElementById('quality-toggle').click();
  assert.equal(app.w.localStorage.getItem('bili-live-ex:auto-quality'), 'false');
  assert.match(app.text('quality'), /关闭/);
  app.panel.getElementById('reset').click();
  assert.equal(app.text('payers'), '0'); assert.equal(app.text('total'), '¥0.00');
  ws.receive(app.encode(gift('after-reset')));
  await flush(); await app.w.poll(); assert.equal(app.text('total'), '¥1.00');
});

test('页面集成：损坏压缩包不会停止后续消息处理', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  app.w.console.warn = () => {};
  const ws = app.connect();
  ws.receive(app.encode(Buffer.from('invalid'), 5, 2));
  ws.receive(app.encode(gift('ok')));
  await flush(); await app.w.poll();
  assert.equal(app.text('total'), '¥1.00'); assert.match(app.text('warning'), /解析失败/);
});

test('页面集成：视频就绪立即触发画质，不受未结束的 Promise 阻塞', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  let current = 150, calls = 0;
  app.w.livePlayer = {
    getPlayerInfo: () => ({ quality: current, qualityCandidates: [{ qn: 10000, desc: '原画' }] }),
    switchQuality: () => { calls++; return new Promise(() => {}); },
  };
  const video = app.w.document.createElement('video'); app.w.document.body.append(video);
  video.dispatchEvent(new app.w.Event('loadedmetadata'));
  assert.equal(calls, 1); assert.match(app.text('quality'), /待确认/);
  current = 10000;
  video.dispatchEvent(new app.w.Event('playing'));
  assert.match(app.text('quality'), /最高画质：原画/);
  app.panel.getElementById('quality-toggle').click();
  current = 150; video.dispatchEvent(new app.w.Event('playing'));
  assert.equal(calls, 1); assert.match(app.text('quality'), /关闭/);
});

test('安全：网络文字按纯文本显示，不产生可执行 HTML', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  const ws = app.connect();
  const payload = '<img src=x onerror="window.compromised=true">';
  ws.receive(app.encode({ cmd: 'ONLINE_RANK_COUNT', data: { online_count: 3, online_count_text: payload } }));
  await flush(); await app.w.poll();
  assert.equal(app.text('online'), payload);
  assert.equal(app.panel.querySelector('img'), null);
  assert.equal(app.w.compromised, undefined);
});

test('安全：超大包被丢弃，正常 zlib 包仍能解析', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  app.w.console.warn = () => {};
  const ws = app.connect();
  ws.receive(new app.w.ArrayBuffer(1024 * 1024 + 1));
  ws.receive(app.encode(zlib.deflateSync(packet(gift('valid'))), 5, 2));
  await flush(); await app.w.poll();
  assert.equal(app.text('total'), '¥1.00');
  assert.match(app.text('warning'), /1 个消息包/);
});

test('安全：zlib 膨胀输出在分块阶段截断', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  app.w.console.warn = () => {};
  const ws = app.connect();
  ws.receive(app.encode(zlib.deflateSync(Buffer.alloc(17 * 1024 * 1024)), 5, 2));
  ws.receive(app.encode(gift('after-limit')));
  await flush(); await app.w.poll();
  assert.equal(app.text('total'), '¥1.00');
  assert.match(app.text('warning'), /1 个消息包/);
});

test('安全：缓慢 Blob 下队列不无限积压，溢出有提示', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  const ws = app.connect();
  let release;
  ws.receive({ size: 16, arrayBuffer: () => new Promise(resolve => { release = resolve; }) });
  await flush();
  for (let i = 0; i < 40; i++) ws.receive(app.encode(gift(`burst-${i}`)));
  release(app.encode(gift('first')));
  await flush(); await app.w.poll();
  assert.equal(app.text('total'), '¥32.00');
  assert.match(app.text('warning'), /9 个消息包/);
});

test('安全：非聊天域名和非加密连接不被监听', async t => {
  const app = setup(); t.after(() => app.dom.window.close());
  for (const url of ['wss://api.bilibili.com/sub', 'ws://broadcastlv.chat.bilibili.com/sub', 'wss://broadcastlv.chat.bilibili.com.evil.example/sub']) {
    const ws = new app.w.WebSocket(url);
    ws.send(app.encode({ roomid: 1 }, 7)); ws.receive(app.encode(gift(url)));
  }
  await flush(); await app.w.poll(); assert.equal(app.text('total'), '¥0.00');
});
