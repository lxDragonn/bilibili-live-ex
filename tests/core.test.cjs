const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Stats, payment, decodePackets, QualityController, roomPath } = require('../bilibili-live-ex.user.js');

function packet(value, { operation = 5, version = 0, header = 16 } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(header + body.length);
  result.writeUInt32BE(result.length);
  result.writeUInt16BE(header, 4);
  result.writeUInt16BE(version, 6);
  result.writeUInt32BE(operation, 8);
  body.copy(result, header);
  return result;
}
const inflate = (v, b) => v === 2 ? zlib.inflateSync(b) : zlib.brotliDecompressSync(b);
const gift = (data = {}) => ({ cmd: 'SEND_GIFT', data: { uid: 123, coin_type: 'gold', num: 1, price: 1000, total_coin: 1000, giftId: 1, tid: 'tx1', ...data } });

test('金额单位、跨类型用户去重及合计', () => {
  const s = new Stats('1');
  s.consume(gift());
  s.consume({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 12, uid: 123, price: 30 } });
  s.consume({ cmd: 'GUARD_BUY', data: { uid: 456, price: 198000, num: 2, start_time: 123 } });
  assert.equal(s.snapshot().totalYuan, 427);
  assert.equal(s.payers.size, 2);
  assert.equal(s.events, 3);
});

test('实际广播 total_coin 优先，零金额不能退回标价', () => {
  assert.equal(payment(gift({ total_coin: 500, price: 1000, num: 10 })).units, 500);
  assert.equal(payment(gift({ total_coin: undefined, price: 100, num: 2 })).units, 200);
  assert.equal(payment(gift({ total_coin: 0 })).invalid, true);
});

test('排除免费礼物、连击汇总、上舰展示和日语 SC', () => {
  const s = new Stats('1');
  s.consume(gift({ coin_type: 'silver' }));
  for (const cmd of ['COMBO_SEND', 'USER_TOAST_MSG', 'SUPER_CHAT_MESSAGE_JPN']) s.consume({ ...gift(), cmd });
  assert.equal(s.events, 0);
});

test('重复包去重，但同一连击的不同交易仍入账', () => {
  const s = new Stats('1');
  s.consume(gift({ batch_combo_id: 'same' }));
  s.consume(gift({ batch_combo_id: 'same' }));
  s.consume(gift({ batch_combo_id: 'same', tid: 'tx2' }));
  assert.equal(s.events, 2);
  assert.equal(s.snapshot().totalYuan, 2);
});

test('无交易标识时仅在短时间内对相同消息去重', () => {
  const s = new Stats('1');
  const g = gift({ tid: undefined });
  s.consume(g, 1000); s.consume(g, 2000); s.consume(g, 7000);
  assert.equal(s.events, 2);
});

test('缺失和匿名 UID 不能合并成虚构的付费用户', () => {
  const s = new Stats('1');
  s.consume(gift({ uid: 0 }));
  s.consume(gift({ uid: undefined, tid: 'tx2' }));
  assert.equal(s.payers.size, 0);
  assert.equal(s.unidentified, 2);
  assert.equal(s.snapshot().totalYuan, 2);
});

test('缺失价格不产生 NaN，跨房间消息被排除', () => {
  const s = new Stats('1');
  s.consume(gift({ total_coin: undefined, price: undefined }));
  s.consume(gift({ roomid: 2 }));
  assert.equal(s.events, 0);
  assert.equal(s.invalid, 1);
});

test('在线、高能、看过三个口径分离，保留 0 与缺失的区别', () => {
  const s = new Stats('1');
  s.consume({ cmd: 'ONLINE_RANK_COUNT', data: { count: 123 } });
  assert.equal(s.highEnergy, 123); assert.equal(s.online, null);
  s.consume({ cmd: 'ONLINE_RANK_COUNT', data: { count: 0, online_count: 0 } });
  assert.equal(s.online, 0);
  s.consume({ cmd: 'WATCHED_CHANGE', data: { num: 999 } });
  assert.equal(s.watched, 999); assert.equal(s.online, 0);
  s.consume({ cmd: 'PREPARING' });
  assert.equal(s.online, null); assert.equal(s.watched, null);
});

test('普通协议、拼包、扩展消息头、心跳人气', () => {
  const pop = Buffer.alloc(4); pop.writeUInt32BE(12345);
  const input = Buffer.concat([packet(gift(), { header: 20 }), packet(pop, { operation: 3, version: 1 })]);
  const received = [];
  decodePackets(input, p => received.push(p), inflate);
  assert.equal(received.length, 2);
  assert.equal(received[0].message.cmd, 'SEND_GIFT');
  assert.equal(received[1].popularity, 12345);
});

for (const version of [2, 3]) {
  test(`真实 ${version === 2 ? 'zlib' : 'Brotli'} 压缩包及多消息解码`, () => {
    const inner = Buffer.concat([packet(gift()), packet(gift({ tid: 'tx2' }))]);
    const compressed = version === 2 ? zlib.deflateSync(inner) : zlib.brotliCompressSync(inner);
    const result = [];
    decodePackets(packet(compressed, { version }), p => result.push(p), inflate);
    assert.equal(result.length, 2);
  });
}

test('损坏 JSON 不阻断后续消息，损坏长度明确失败', () => {
  const result = [];
  decodePackets(Buffer.concat([packet(Buffer.from('{broken')), packet(gift())]), x => result.push(x), inflate);
  assert.equal(result.length, 1);
  const bad = packet(gift()); bad.writeUInt32BE(0);
  assert.throws(() => decodePackets(bad, () => {}, inflate), /长度/);
  assert.throws(() => decodePackets(Buffer.alloc(3), () => {}, inflate), /消息头/);
});

test('最高画质从乱序候选中选择，读回确认后不重复切换', async () => {
  let quality = 150, calls = [];
  const player = {
    getPlayerInfo: () => ({ quality, qualityCandidates: [{ qn: 400 }, { qn: 10000, desc: '原画' }, { qn: 150 }] }),
    switchQuality: qn => { calls.push(qn); quality = qn; },
  };
  const c = new QualityController();
  await c.tick(player, 0); assert.match(c.status, /待确认/);
  await c.tick(player, 1000); assert.match(c.status, /最高画质：原画/);
  await c.tick(player, 2000); assert.deepEqual(calls, ['10000']);
});

test('受限画质失败三次后退回可用档位，冷却后重新探测', async () => {
  let quality = 150, calls = [];
  const player = {
    getPlayerInfo: () => ({ quality, qualityCandidates: [{ qn: 10000 }, { qn: 400 }, { qn: 30000, locked: true }] }),
    switchQuality: qn => { calls.push(qn); if (qn === '400') quality = qn; },
  };
  const c = new QualityController();
  for (const t of [0, 20000, 40000, 60000, 61000]) await c.tick(player, t);
  assert.deepEqual(calls, ['10000', '10000', '10000', '400']);
  assert.match(c.status, /可用画质/);
  await c.tick(player, 320000); assert.equal(calls.at(-1), '10000');
});

test('第三次尝试成功不能被错误降到下一档', async () => {
  let quality = 150, calls = 0;
  const player = { getPlayerInfo: () => ({ quality, qualityCandidates: [{ qn: 10000 }, { qn: 400 }] }),
    switchQuality: q => { if (++calls === 3) quality = q; } };
  const c = new QualityController();
  for (const t of [0, 20000, 40000, 41000]) await c.tick(player, t);
  assert.equal(calls, 3); assert.equal(quality, '10000'); assert.match(c.status, /最高/);
});

test('播放器重新创建后重新检测；兼容短房间路径与 blanc 路径', async () => {
  const c = new QualityController();
  await c.tick(null); assert.match(c.status, /等待/);
  assert.equal(roomPath('/blanc/123'), '123');
  assert.equal(roomPath('/123/'), '123');
  assert.equal(roomPath('/p/html'), '');
});

module.exports = { packet, gift };

test('慢速换流：20 秒确认期内不重发，也不提前降档', () => {
  let current = 150;
  const calls = [];
  const player = { getPlayerInfo: () => ({ quality: current, qualityCandidates: [{ qn: 10000 }, { qn: 400 }] }),
    switchQuality: qn => { calls.push(qn); } };
  const c = new QualityController();
  for (const at of [0, 8000, 16000, 19000]) c.tick(player, at);
  assert.deepEqual(calls, ['10000']);
  current = 10000; c.tick(player, 19500);
  assert.match(c.status, /最高/); assert.equal(c.attempts.size, 0);
});

test('永不结束的切换 Promise 不阻塞读回或播放器更换', async () => {
  let current = 150;
  const player = { getPlayerInfo: () => ({ quality: current, qualityCandidates: [{ qn: 10000 }] }),
    switchQuality: () => new Promise(() => {}) };
  const c = new QualityController(); c.tick(player, 0);
  current = 10000; c.tick(player, 1000); assert.match(c.status, /最高/);
  let called = false;
  c.tick({ getPlayerInfo: () => ({ quality: 150, qualityCandidates: [{ qn: 400 }] }),
    switchQuality: () => { called = true; } }, 2000);
  assert.equal(called, true);
});

test('旧 Promise 的迟到失败不能污染重置后的状态', async () => {
  let reject;
  const player = { getPlayerInfo: () => ({ quality: 150, qualityCandidates: [{ qn: 10000 }] }),
    switchQuality: () => new Promise((_, r) => { reject = r; }) };
  const c = new QualityController(); c.tick(player, 0);
  const oldReject = reject; c.reset(); c.tick(player, 1000);
  oldReject(new Error('late')); await Promise.resolve();
  assert.equal(c.pending.failed, false);
});

test('候选列表更新与恢复检测清除失败记录；初始化期间不消耗次数', () => {
  let current = 0, candidates = [{ qn: 10000 }], calls = 0;
  const player = { getPlayerInfo: () => ({ quality: current, qualityCandidates: candidates }), switchQuality: () => { calls++; } };
  const c = new QualityController(); c.tick(player, 0); assert.equal(calls, 0);
  current = 150;
  for (const at of [1000, 21000, 41000, 61000]) c.tick(player, at);
  assert.equal(calls, 3);
  candidates = [{ qn: 10000 }, { qn: 400 }]; c.tick(player, 62000);
  assert.equal(calls, 4);
  c.recover(); c.tick(player, 63000); assert.equal(calls, 4);
});

test('当前网页接口：QN 严格字符串匹配，并传入候选 HDR 参数', async () => {
  let quality = '250', hdrType = 0;
  const candidates = [{ qn: '10000', hdrType: 1, desc: 'HDR 原画' }, { qn: '10000', hdrType: 0 }];
  const player = {
    getPlayerInfo: () => ({ quality, hdrType, qualityCandidates: candidates }),
    switchQualityAsync: async (qn, hdr) => {
      const target = candidates.find(q => q.qn === qn && q.hdrType === hdr);
      assert.ok(target, '模拟真实播放器严格匹配');
      quality = target.qn; hdrType = target.hdrType;
      return { code: 0 };
    },
  };
  const c = new QualityController(); c.tick(player, 0); await Promise.resolve(); c.tick(player, 1000);
  assert.equal(quality, '10000'); assert.equal(hdrType, 1); assert.match(c.status, /最高/);
});

test('异步接口业务错误计为失败', async () => {
  let calls = 0;
  const player = { getPlayerInfo: () => ({ quality: '250', qualityCandidates: [{ qn: '10000' }] }),
    switchQualityAsync: async () => { calls++; return { code: 1000003 }; } };
  const c = new QualityController(); c.tick(player, 0); await Promise.resolve();
  assert.equal(c.pending.failed, true);
  c.tick(player, 1000); assert.equal(calls, 1);
  c.tick(player, 8000); assert.equal(calls, 2);
});

test('安全：去重键不存储昵称和 SC 内容，导出无付费 UID', () => {
  const s = new Stats('1');
  s.consume({ cmd: 'SUPER_CHAT_MESSAGE', data: { uid: '987654321', price: 30, message: 'private-message', uname: 'private-name' } });
  const cached = [...s.seen.keys()].join();
  assert.ok(!cached.includes('private-message') && !cached.includes('private-name'));
  assert.ok(!JSON.stringify(s.snapshot()).includes('987654321'));
});

test('安全：付费人数缓存达到上限时显示下限，不无限积累', () => {
  const s = new Stats('1');
  s.payers = new Set(Array.from({ length: 100000 }, (_, i) => String(i + 1)));
  s.consume(gift({ uid: '100001' }));
  assert.equal(s.payers.size, 100000);
  assert.equal(s.snapshot().payerLimitReached, true);
  assert.equal(s.events, 1);
});

test('发布：版本一致，外部依赖具有 SHA256 校验', () => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const script = fs.readFileSync(path.join(__dirname, '../bilibili-live-ex.user.js'), 'utf8');
  assert.match(script, /@version\s+1\.0\.0/);
  assert.equal(require('../package.json').version, '1.0.0');
  const entries = [...script.matchAll(/@require\s+(\S+)/g)];
  assert.equal(entries.length, 2);
  for (const [, url] of entries) assert.match(url, /^https:\/\/.+#sha256=[a-f0-9]{64}$/);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('pako/dist/pako_inflate.min.js'))).digest('hex');
  assert.ok(entries[0][1].endsWith(hash));
  const include = script.match(/@include\s+\/(.+)\//)[1];
  const pattern = new RegExp(include);
  assert.ok(pattern.test('https://live.bilibili.com/blanc/123?from=share'));
  assert.ok(!pattern.test('https://live.bilibili.com/p/html'));
  assert.ok(!pattern.test('https://live.bilibili.com.evil.example/123'));
});
