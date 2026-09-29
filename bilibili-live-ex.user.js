// ==UserScript==
// @name         Bilibili 直播增强：最高画质与付费统计
// @namespace    bilibili-live-ex
// @version      1.0.0
// @description  自动选择最高可用画质，显示在线/看过人数，统计本次观察的付费人数与礼物、SC、上舰金额。
// @include      /^https:\/\/live\.bilibili\.com\/(?:blanc\/)?\d+\/?(?:[?#].*)?$/
// @run-at       document-start
// @noframes
// @grant        none
// @sandbox      raw
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js#sha256=fa226c8e1e3556993260e6a5c1fe94e225da59b3418a06811fdc51d308f8bb43
// @require      https://cdn.jsdelivr.net/gh/google/brotli@5692e422da6af1e991f9182345d58df87866bc5e/js/decode.js#sha256=f0cffbbe312747b2461757ba3649cb62d5ebbb07ec74b3dff22b84e37a3e3932
// ==/UserScript==

/* 功能思路参考 https://github.com/qianjiachun/douyuEx ，独立实现 Bilibili 适配。
 * 不调用第三方统计服务；不发送礼物，不绕过画质权限。
 * 金额是已观察到的消息价值，不是主播结算收入或用户实际扣款。
 */
(function () {
  'use strict';

  const decoder = new TextDecoder();
  const MAX_PACKET = 16 * 1024 * 1024;
  const MAX_WIRE = 1024 * 1024;
  const MAX_QUEUE = 32;
  const MAX_PAYERS = 100000;
  const number = value => value !== null && value !== '' && value !== undefined &&
    Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const uidOf = data => {
    const uid = data.uid ?? data.sender_uinfo?.uid ?? data.uinfo?.uid;
    return /^\d{1,32}$/.test(String(uid)) && Number(uid) > 0 ? String(uid) : null;
  };
  const roomPath = path => path.match(/^\/(?:blanc\/)?(\d+)\/?$/)?.[1] || '';

  // 解压函数作为参数传入：浏览器用固定版本依赖，离线测试用 Node zlib。
  function decodePackets(input, emit, decompress, depth = 0) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (depth > 8 || bytes.byteLength > MAX_PACKET) throw new Error('消息体过大或嵌套过深');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < 16) throw new Error('消息头不完整');
      const size = view.getUint32(offset);
      const head = view.getUint16(offset + 4);
      const version = view.getUint16(offset + 6);
      const operation = view.getUint32(offset + 8);
      if (head < 16 || size < head || size > bytes.length - offset) throw new Error('消息长度无效');
      const body = bytes.subarray(offset + head, offset + size);
      if (version === 2 || version === 3) {
        decodePackets(decompress(version, body), emit, decompress, depth + 1);
      } else if (version === 0 || version === 1) {
        if (operation === 3 && body.length >= 4) {
          emit({ operation, popularity: new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0) });
        } else if ([5, 7, 8].includes(operation) && body.length) {
          let value;
          try { value = JSON.parse(decoder.decode(body).replace(/\0+$/, '')); }
          catch { offset += size; continue; }
          for (const message of Array.isArray(value) ? value : [value]) emit({ operation, message });
        }
      } else throw new Error(`暂不支持消息协议 ${version}`);
      offset += size;
    }
  }

  function payment(message) {
    const cmd = String(message.cmd || '').split(':')[0];
    const d = message.data || {};
    let units, kind, id;
    if (cmd === 'SEND_GIFT' && d.coin_type === 'gold') {
      kind = 'gift';
      units = number(d.total_coin);
      if (units === null && number(d.price) !== null && number(d.num) !== null) units = Number(d.price) * Number(d.num);
      // 连击 ID 不是交易 ID，不能用于去重，否则会漏掉同一连击中的后续礼物。
      id = d.tid || d.rnd;
      if (id) id = `${id}:${uidOf(d)}:${d.giftId ?? d.gift_id}:${d.num}:${units}`;
    } else if (cmd === 'SUPER_CHAT_MESSAGE') {
      kind = 'sc';
      units = number(d.price) === null ? null : Math.round(Number(d.price) * 1000);
      id = d.id;
    } else if (cmd === 'GUARD_BUY') {
      kind = 'guard';
      units = number(d.price) !== null && number(d.num) !== null ? Number(d.price) * Number(d.num) : null;
      id = d.order_id || (d.start_time ? `${uidOf(d)}:${d.guard_level}:${d.start_time}:${d.end_time}:${d.num}:${d.price}` : null);
    } else return null; // COMBO_SEND / USER_TOAST_MSG / JPN 是展示消息，避免重复入账。
    if (units === null || !Number.isSafeInteger(units) || units <= 0) return { invalid: true };
    const strong = !!id && String(id).length <= 256;
    // 无交易 ID 时仅保留计数所需字段，不在去重缓存中保留完整消息、昵称、头像或 SC 内容。
    const weakKey = [kind, uidOf(d), String(d.timestamp ?? d.start_time ?? '').slice(0,32),
      String(d.giftId ?? d.gift_id ?? '').slice(0,32), number(d.num), units].join(':');
    return { kind, units, uid: uidOf(d), key: strong ? `${kind}:${id}` : weakKey, strong };
  }

  class Stats {
    constructor(room, now = Date.now()) {
      this.room = room;
      this.startedAt = now;
      this.payers = new Set();
      this.seen = new Map();
      this.totals = { gift: 0, sc: 0, guard: 0 };
      this.events = 0;
      this.unidentified = 0;
      this.payerLimitReached = false;
      this.invalid = 0;
      this.online = null;
      this.onlineText = '';
      this.highEnergy = null;
      this.watched = null;
      this.popularity = null;
      this.metricTimes = {};
      this.lastPacketAt = 0;
      this.errors = 0;
      this.live = null;
    }
    consume(message, now = Date.now()) {
      if (!message || typeof message !== 'object') return;
      const d = message.data || {};
      const command = String(message.cmd || '').split(':')[0];
      const targetRoom = d.roomid ?? d.room_id ?? message.roomid;
      if (targetRoom && String(targetRoom) !== String(this.room)) return;
      if (command === 'ONLINE_RANK_COUNT') {
        // count 是高能用户数，不可拿来填充缺失的 online_count。
        this.online = number(d.online_count);
        this.onlineText = this.online === null ? '' : String(d.online_count_text || '');
        this.highEnergy = number(d.count);
        this.metricTimes.online = now;
        this.metricTimes.highEnergy = now;
      }
      if (command === 'WATCHED_CHANGE') { this.watched = number(d.num); this.metricTimes.watched = now; }
      if (command === 'LIVE' || command === 'PREPARING') {
        this.live = command === 'LIVE';
        this.online = null;
        this.onlineText = '';
        this.watched = null;
        this.highEnergy = null;
        this.popularity = null;
      }
      const item = payment(message);
      if (!item) return;
      if (item.invalid) { this.invalid++; return; }
      if (!Number.isSafeInteger(this.totals[item.kind] + item.units)) { this.invalid++; return; }
      const previous = this.seen.get(item.key);
      if (previous !== undefined && (item.strong || now - previous <= 5000)) return;
      this.seen.delete(item.key);
      this.seen.set(item.key, now);
      // 有界缓存避免长时间挂机无上限积累交易 ID；去重覆盖最近 50,000 笔。
      if (this.seen.size > 50000) this.seen.delete(this.seen.keys().next().value);
      this.totals[item.kind] += item.units;
      this.events++;
      if (item.uid) {
        if (this.payers.size < MAX_PAYERS || this.payers.has(item.uid)) this.payers.add(item.uid);
        else this.payerLimitReached = true;
      }
      else this.unidentified++;
    }
    snapshot(now = Date.now()) {
      return {
        roomId: this.room, startedAt: new Date(this.startedAt).toISOString(), exportedAt: new Date(now).toISOString(),
        scope: '本次页面观察；刷新、切房或手动重置后重新统计；不是全场历史或真实扣款',
        online: this.online, onlineText: this.onlineText, highEnergy: this.highEnergy, watched: this.watched,
        popularity: this.popularity, metricUpdatedAt: this.metricTimes,
        payers: this.payers.size, paymentEvents: this.events, unidentifiedEvents: this.unidentified,
        payerLimitReached: this.payerLimitReached,
        invalidPaymentEvents: this.invalid, decodeErrors: this.errors,
        giftYuan: this.totals.gift / 1000, scYuan: this.totals.sc / 1000, guardYuan: this.totals.guard / 1000,
        totalYuan: (this.totals.gift + this.totals.sc + this.totals.guard) / 1000,
      };
    }
  }

  function qualityCandidates(info) {
    return (Array.isArray(info?.qualityCandidates) ? info.qualityCandidates : [])
      .filter(q => number(q.qn) !== null && Number(q.qn) > 0 && !q.disabled && !q.locked && q.available !== false)
      .slice().sort((a, b) => Number(b.qn) - Number(a.qn));
  }
  const qualityKey = q => `${Number(q.qn)}:${number(q.hdrType) ?? 0}`;

  // 控制器同时用于浏览器和测试；发出请求后必须读回当前画质才能确认成功。
  class QualityController {
    constructor() { this.reset(); }
    reset() {
      this.player = null;
      this.attempts = new Map();
      this.pending = null;
      this.signature = '';
      this.lastTry = -Infinity;
      this.status = '等待播放器';
    }
    recover() { this.attempts.clear(); }
    tick(player, now = Date.now()) {
      if (!player?.getPlayerInfo || !(player?.switchQualityAsync || player?.switchQuality)) { this.status = '等待播放器'; return; }
      if (player !== this.player) { this.reset(); this.player = player; }
      try {
        const info = player.getPlayerInfo();
        const candidates = qualityCandidates(info);
        if (!candidates.length) { this.status = '等待可用画质列表'; return; }
        const signature = candidates.map(qualityKey).join(',');
        if (signature !== this.signature) {
          this.signature = signature;
          this.attempts.clear();
          if (!candidates.some(q => qualityKey(q) === this.pending?.key)) this.pending = null;
        }
        const current = number(info.quality);
        if (!current) { this.status = '等待播放器初始化画质'; return; }
        const highest = candidates[0];
        const currentKey = qualityKey({ qn: current, hdrType: info.hdrType });
        if (currentKey === qualityKey(highest)) {
          this.pending = null;
          this.attempts.delete(qualityKey(highest));
          this.status = `最高画质：${highest.desc || `QN ${highest.qn}`}`;
          return;
        }
        // 调用次数不等于失败次数。给异步换流留足确认时间，最后一次请求也必须等完。
        if (this.pending) {
          const pending = this.pending;
          if (currentKey === pending.key) {
            this.pending = null;
            this.attempts.delete(pending.key);
          } else if (!pending.failed && now - pending.at < 20000) {
            this.status = `正在切换：${pending.name}（待确认）`;
            return;
          } else {
            const previous = this.attempts.get(pending.key);
            this.attempts.set(pending.key, { count: (previous?.count || 0) + 1, at: now });
            this.pending = null;
          }
        }
        const target = candidates.find(q => {
          const a = this.attempts.get(qualityKey(q));
          return !a || a.count < 3 || now - a.at >= 60000;
        });
        if (!target) { this.status = '切换未成功，稍后自动重试；也可点击重试画质'; return; }
        const qn = Number(target.qn);
        const key = qualityKey(target);
        const name = target.desc || `QN ${qn}`;
        if (currentKey === key) {
          this.status = `${key === qualityKey(candidates[0]) ? '最高' : '可用'}画质：${name}`;
          return;
        }
        if (now - this.lastTry < 8000) return;
        const previous = this.attempts.get(key);
        if (previous && now - previous.at >= 60000) this.attempts.delete(key);
        this.lastTry = now;
        const pending = { qn, key, name, at: now, failed: false };
        this.pending = pending;
        this.status = `正在切换：${name}（待确认）`;
        // 不等待播放器返回的 Promise：一些实现不结束 Promise，但画质实际已经切换。
        // 旧请求的迟到拒绝不能改变新播放器、新房间或新一次切换的状态。
        try {
          // 当前播放器严格匹配字符串 QN；传数字会落到无效的 0 档，表面无异常但不切换。
          const switchQuality = player.switchQualityAsync || player.switchQuality;
          Promise.resolve(switchQuality.call(player, String(target.qn), number(target.hdrType) ?? 0)).then(result => {
            if (this.pending === pending && (result === false || (result?.code !== undefined && Number(result.code) !== 0))) pending.failed = true;
          }).catch(() => {
            if (this.pending === pending) pending.failed = true;
          });
        } catch { pending.failed = true; }
      } catch { this.status = '画质切换失败，将自动重试'; }
    }
  }

  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = { decodePackets, payment, Stats, QualityController, qualityCandidates, roomPath };
    return;
  }

  if (window.top !== window.self || window.__BILI_LIVE_EX_INSTALLED__) return;
  window.__BILI_LIVE_EX_INSTALLED__ = true;
  let path = roomPath(location.pathname);
  let epoch = 0;
  let stats = new Stats(path);
  let canonicalRoom = '';
  let host, shadow;
  let collapsed = false;
  let enabled = true;
  try { enabled = localStorage.getItem('bili-live-ex:auto-quality') !== 'false'; } catch { /* 存储禁用 */ }
  const quality = new QualityController();
  const sockets = new Set();

  function checkRoute() {
    const next = roomPath(location.pathname);
    if (path === next) return;
    path = next;
    epoch++;
    canonicalRoom = '';
    stats = new Stats(path);
    quality.reset();
    if (host) host.hidden = !path;
  }

  function knownRoom() {
    const info = window.__NEPTUNE_IS_MY_WAIFU__?.roomInfoRes?.data?.room_info;
    if (info && [String(info.room_id), String(info.short_id)].includes(path)) return String(info.room_id);
    const live = window.BilibiliLive;
    if (live && [String(live.ROOMID), String(live.SHORT_ROOMID)].includes(path)) return String(live.ROOMID);
    return canonicalRoom;
  }

  function decompress(version, bytes) {
    if (version === 2 && window.pako?.Inflate) {
      const inflater = new window.pako.Inflate({ chunkSize: 65536 });
      let length = 0;
      const chunks = [];
      inflater.onData = chunk => {
        length += chunk.length;
        if (length > MAX_PACKET) throw new Error('解压输出超过限制');
        chunks.push(chunk);
      };
      inflater.push(bytes, true);
      if (inflater.err || !inflater.ended) throw new Error('zlib 数据无效或不完整');
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    }
    if (version === 3 && window.BrotliDecode) {
      const decoded = window.BrotliDecode(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    }
    throw new Error('解压库未加载，请检查 Tampermonkey 的外部资源');
  }

  function isDanmakuSocket(url) {
    try { const u = new URL(String(url)); return u.protocol === 'wss:' && u.hostname.endsWith('.chat.bilibili.com') && u.pathname === '/sub'; }
    catch { return false; }
  }

  // 仅旁路读取页面已有连接，保留原消息、返回值及连接生命周期，不另建鉴权连接。
  const NativeWebSocket = window.WebSocket;
  const SocketProxy = new Proxy(NativeWebSocket, {
    construct(Target, args, NewTarget) {
      const ws = Reflect.construct(Target, args, NewTarget);
      if (!isDanmakuSocket(args[0])) return ws;
      checkRoute();
      const context = { epoch, room: '', queue: Promise.resolve(), queued: 0, ws };
      sockets.add(context);
      ws.addEventListener('close', () => sockets.delete(context));
      const send = ws.send;
      ws.send = function (data) {
        const result = Reflect.apply(send, this, arguments);
        try {
          checkRoute();
          if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
            decodePackets(bytes, packet => {
              if (packet.operation !== 7 || !packet.message?.roomid) return;
              context.epoch = epoch;
              context.room = String(packet.message.roomid);
              const expected = knownRoom();
              if (path && (!expected || expected === context.room)) {
                canonicalRoom = context.room;
                stats.room = canonicalRoom;
              }
            }, decompress);
          }
        } catch { /* 旁路解析不得影响页面发送 */ }
        return result;
      };
      ws.addEventListener('message', event => {
        checkRoute();
        const captured = stats;
        const capturedEpoch = epoch;
        if (!path || context.epoch !== epoch) return;
        const expected = knownRoom();
        if (!context.room || (expected && context.room !== expected)) return;
        const size = event.data?.byteLength ?? event.data?.size;
        if (size > MAX_WIRE || context.queued >= MAX_QUEUE) { stats.errors++; return; }
        context.queued++;
        context.queue = context.queue.then(async () => {
          const data = event.data;
          const buffer = typeof data?.arrayBuffer === 'function' ? await data.arrayBuffer() : data;
          if (captured !== stats || capturedEpoch !== epoch || context.epoch !== epoch) return;
          if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) return;
          stats.lastPacketAt = Date.now();
          const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
          decodePackets(bytes, packet => {
            if (packet.operation === 3) {
              stats.popularity = packet.popularity;
              stats.metricTimes.popularity = Date.now();
            } else if (packet.operation === 5) stats.consume(packet.message);
          }, decompress);
        }).catch(error => {
          if (captured !== stats) return;
          stats.errors++;
          if (stats.errors === 1) console.warn('[Bilibili Live Ex] 消息解析失败', error);
        }).finally(() => { context.queued--; });
      });
      return ws;
    },
  });
  window.WebSocket = SocketProxy;

  function mount() {
    if (!document.body || !path) return;
    if (host) { if (!host.isConnected) document.body.append(host); return; }
    host = document.createElement('div');
    host.id = 'bili-live-ex-panel';
    host.style.cssText = 'position:fixed;left:18px;bottom:24px;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#e8eef8;color-scheme:dark}
        *{box-sizing:border-box} section{width:300px;max-width:calc(100vw - 36px);background:#172130f5;border:1px solid #3a4a62;border-radius:12px;box-shadow:0 8px 32px #0005;overflow:hidden}
        header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#223044;cursor:move;touch-action:none}
        button{font:inherit;color:inherit;border:1px solid #52647e;border-radius:6px;background:#2c3e56;cursor:pointer;padding:3px 9px} button:hover{background:#405879}button:focus-visible{outline:2px solid #79caff}
        main{padding:12px 14px;max-height:75vh;overflow:auto} dl{margin:10px 0;display:grid;grid-template-columns:1fr auto;gap:6px 12px}dt{color:#b9c6da}dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600} .accent{color:#73d4ff}
        .hint{font-size:11px;color:#a9b8cf;margin:8px 0;overflow-wrap:anywhere}.status{color:#a9dcff;margin:6px 0;font-size:12px} .actions{display:flex;gap:8px}summary{cursor:pointer}input{vertical-align:middle} [hidden]{display:none!important}
      </style>
      <section aria-label="Bilibili 直播增强统计">
        <header><strong>直播增强 <span id="room"></span></strong><button id="collapse" aria-label="收起统计面板" aria-expanded="true">收起</button></header>
        <main>
          <label><input id="quality-toggle" type="checkbox"> 自动最高可用画质</label>
          <div id="quality" class="status"></div>
          <button id="quality-retry" title="重新检测最高可用画质，不清空统计">重试画质</button>
          <dl>
            <dt title="B站 online_count；平台可能截断或不下发，非精确普查">在线人数（平台口径）</dt><dd id="online">等待数据</dd>
            <dt title="累计看过人数，不等于当前在线人数">看过人数</dt><dd id="watched">等待数据</dd>
            <dt title="高能榜用户数，不等于本次付费人数">高能用户</dt><dd id="highEnergy">等待数据</dd>
            <dt title="当前观察期内，有可识别 UID 的付费用户去重数">观察到的付费人数</dt><dd id="payers">0</dd>
            <dt title="金瓜子礼物、SC 与上舰的广播价值合计；非实际扣款或主播收入">付费总额（估算）</dt><dd id="total" class="accent">¥0.00</dd>
          </dl>
          <details><summary>明细与统计说明</summary>
            <dl><dt>金瓜子礼物</dt><dd id="gift"></dd><dt>醒目留言 SC</dt><dd id="sc"></dd><dt>上舰标价</dt><dd id="guard"></dd><dt>付费事件数</dt><dd id="events"></dd><dt>人气值（非人数）</dt><dd id="popularity"></dd></dl>
            <p class="hint">仅累计本页运行期间收到的消息。刷新、切房或重置会重新计数，断线期间不能补齐。免费礼物不计入；金瓜子礼物按广播价值估算，可能来自背包、活动或折扣，不代表实际付款。上舰按标价计算。</p>
            <p class="hint">在线人数可能有上限；“未提供”表示未取得该指标，不能按 0 处理。数值后的 * 表示超过 90 秒未更新。匿名事件计金额，但无法计入去重付费人数。</p>
          </details>
          <p id="status" class="status" role="status"></p>
          <p id="period" class="hint"></p><p id="warning" class="hint"></p>
          <div class="actions"><button id="export">导出统计</button><button id="reset">重置统计</button></div>
        </main>
      </section>`;
    document.body.append(host);
    const toggle = shadow.getElementById('quality-toggle');
    toggle.checked = enabled;
    toggle.addEventListener('change', () => {
      enabled = toggle.checked;
      quality.reset();
      try { localStorage.setItem('bili-live-ex:auto-quality', String(enabled)); } catch { /* 可继续使用 */ }
      tick();
    });
    shadow.getElementById('quality-retry').addEventListener('click', () => {
      quality.recover();
      tick();
    });
    shadow.getElementById('collapse').addEventListener('click', () => {
      collapsed = !collapsed;
      shadow.querySelector('main').hidden = collapsed;
      const button = shadow.getElementById('collapse');
      button.textContent = collapsed ? '展开' : '收起';
      button.setAttribute('aria-label', collapsed ? '展开统计面板' : '收起统计面板');
      button.setAttribute('aria-expanded', String(!collapsed));
    });
    shadow.getElementById('reset').addEventListener('click', () => {
      if (window.confirm('将清空本次观察统计，并从现在重新计数。是否继续？')) stats = new Stats(canonicalRoom || path);
      render();
    });
    shadow.getElementById('export').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(stats.snapshot(), null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `bilibili-live-${stats.room}-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    const header = shadow.querySelector('header');
    let drag;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
      if (!drag) return;
      host.style.left = `${Math.max(0, Math.min(innerWidth - host.offsetWidth, event.clientX - drag.x))}px`;
      host.style.top = `${Math.max(0, Math.min(innerHeight - 42, event.clientY - drag.y))}px`;
      host.style.bottom = 'auto';
    });
    header.addEventListener('lostpointercapture', () => { drag = null; });
  }

  function render() {
    if (!shadow || !path) return;
    const now = Date.now();
    const set = (id, value) => {
      const element = shadow.getElementById(id);
      if (element.textContent !== String(value)) element.textContent = String(value);
    };
    const metric = key => {
      if (stats[key] === null) return '未提供';
      const text = key === 'online' && stats.onlineText ? stats.onlineText : stats[key].toLocaleString('zh-CN');
      return text + (now - (stats.metricTimes[key] || 0) > 90000 ? ' *' : '');
    };
    set('room', `· ${stats.room || path}`);
    set('quality', enabled ? quality.status : '自动画质已关闭');
    for (const key of ['online', 'watched', 'highEnergy', 'popularity']) set(key, metric(key));
    set('payers', stats.payers.size + (stats.unidentified || stats.payerLimitReached ? '（至少）' : ''));
    set('events', stats.events);
    const money = n => `¥${(n / 1000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
    for (const key of ['gift', 'sc', 'guard']) set(key, money(stats.totals[key]));
    set('total', money(stats.totals.gift + stats.totals.sc + stats.totals.guard));
    const connected = [...sockets].some(c => c.epoch === epoch && c.room === String(stats.room) && c.ws.readyState === NativeWebSocket.OPEN);
    let status = '等待直播消息；长时间无数据请刷新页面';
    if (stats.lastPacketAt) status = connected && now - stats.lastPacketAt < 90000 ? '正在统计本次观察数据' : '消息已中断，统计暂停；等待页面重连';
    if (stats.live === false) status = '直播已结束；保留本次累计数据';
    set('status', status);
    set('period', `观察起点：${new Date(stats.startedAt).toLocaleString('zh-CN')} · 刷新后重新统计`);
    const warnings = [];
    if (stats.unidentified) warnings.push(`${stats.unidentified} 笔无可识别 UID`);
    if (stats.payerLimitReached) warnings.push('付费人数达到缓存上限，显示下限值');
    if (stats.invalid) warnings.push(`${stats.invalid} 笔金额字段缺失或无效，未入账`);
    if (stats.errors) warnings.push(`${stats.errors} 个消息包解析失败或超出处理限制，统计可能不完整`);
    set('warning', warnings.join('；'));
  }

  function tick() {
    checkRoute();
    if (!path) return;
    mount();
    if (enabled) quality.tick(window.livePlayer);
    render();
  }
  tick();
  const timer = setInterval(tick, 1000);
  // 页面恢复与视频就绪时立即检测；定时检查仍用于播放器替换和自动降画质。
  function recoverQuality() {
    checkRoute();
    if (!path || !enabled) return;
    quality.recover();
    tick();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverQuality();
  });
  window.addEventListener('pageshow', recoverQuality);
  window.addEventListener('online', recoverQuality);
  document.addEventListener('loadedmetadata', event => {
    if (event.target?.tagName === 'VIDEO') tick();
  }, true);
  document.addEventListener('playing', event => {
    if (event.target?.tagName === 'VIDEO') tick();
  }, true);
  window.addEventListener('pagehide', event => { if (!event.persisted) clearInterval(timer); });
})();
