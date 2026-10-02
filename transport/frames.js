/**
 * 承载帧编解码（协议 v1）。
 *
 * 三层分离（方案 §5.1）：语义层是 DSH 自己的 `/api/*` 与 `/api/remote.mux`（复用，
 * 不在此定义）；本文件只定义承载层 —— Connector ↔ Relay ↔ Phone 的信封。
 *
 * exactKeys 纪律（照抄 DSH gateway 的做法）：键精确匹配，多余字段一律拒绝；
 * 未知 kind 是协议错误（调用方必须断连）。单帧上限 1 MiB。
 *
 * 帧（kind → 键，* 为必填）：
 *   控制：hello{proto,caps?,nonce?} hello-ack{proto,caps} ping{} pong{}
 *   路由：kick{deviceId}
 *   PWA 透明转发：
 *     http-head    {deviceId,streamId,method,path,headers}        phone→conn
 *     http-body    {deviceId,streamId,chunk(b64),final}           phone→conn
 *     http-res-head{deviceId,streamId,status,headers}             conn→phone
 *     http-res-body{deviceId,streamId,chunk(b64),final}           conn→phone
 *     http-error   {deviceId,streamId,code,message}               conn→phone
 *     ws-open      {deviceId,streamId,path,headers}               phone→conn
 *     ws-accept    {deviceId,streamId}                            conn→phone
 *     ws-data      {deviceId,streamId,fin,opcode,data(b64)}       双向
 *     ws-close     {deviceId,streamId,code}                       双向
 *   配对/鉴权（thin client / PWA 配对页共用）：
 *     pair-begin   {channel,pairToken,name,pubKey?}               phone→conn
 *     pair-challenge{channel,challenge(b64url)}                   conn→phone
 *     pair-done    {channel,sig?(b64url),pubKey?(b64url)}         phone→conn
 *     pair-result  {channel,ok,error?,deviceId?,code?,setCookie?} conn→phone
 *     auth-begin   {channel,deviceId}                             phone→conn
 *     auth-challenge{channel,challenge(b64url)}                   conn→phone
 *     auth-done    {channel,sig(b64url),ts}                       phone→conn
 *     auth-result  {channel,ok,error?,ticket?,setCookie?}         conn→phone
 *   E2E 密文外层（中继只见这些键）：
 *     sealed       {deviceId,counter,nonce(b64url),ciphertext(b64url)}
 *   E2E 明文内层：open{reqId,method,path,headers?,bodyRef?} item{reqId,seq,chunk}
 *                end{reqId,status,headers?} error{reqId,code,message} upgrade{streamId,path}
 */

export const PROTO_VERSION = 1;
/** 单帧 JSON 上限（字节）。 */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** 二进制帧线上上限（中继 ws maxPayload 同此值 —— 头+原始载荷，不再受 1MiB JSON 限制）。 */
export const MAX_WIRE_FRAME_BYTES = 16 * 1024 * 1024;
/** JSON 头与原始载荷的分隔字节。 */
const SEPARATOR = Buffer.from([0x00]);
/** 单个请求/响应体分片上限（b64 前的字节数）。 */
export const MAX_CHUNK_BYTES = 256 * 1024;

/** b64url 编解码（Buffer 输入/输出）。 */
export function b64e(buf) {
  return Buffer.from(buf).toString('base64url');
}
export function b64d(str, field) {
  if (typeof str !== 'string') throw new FrameError('bad-frame', `${field}: expected base64url string`);
  if (str === '') return Buffer.alloc(0); // 空 body chunk 合法（GET 请求）
  const buf = Buffer.from(str, 'base64url');
  if (buf.toString('base64url') !== str.replace(/=+$/, '')) throw new FrameError('bad-frame', `${field}: not canonical base64url`);
  return buf;
}

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 帧键规格：{ field: [type, required] }。type ∈ string|number|boolean|object|array|b64|json。
 * json = 任意可 JSON 值（含对象/数组/null 以外的标量不校验内容）。
 */
const SPECS = {
  hello: { proto: ['number', true], caps: ['array', false], nonce: ['string', false] },
  'hello-ack': { proto: ['number', true], caps: ['array', false] },
  ping: {},
  pong: {},
  kick: { deviceId: ['string', true] },
  /**
   * 连接器 → 中继：上报「本实例已配对且未撤销的设备 id」。
   * 中继据此把 deviceId 映射到本连接器，使**不带 c 参数的普通 HTTP 请求**（PWA 页面
   * 只带 ra-device cookie）也能正确路由。真机事故 2026-09-30：缺此机制会导致
   * 「配对成功但点进入 DSH 后显示需要配对链接」。
   */
  devices: { deviceIds: ['array', true] },

  'http-head': { deviceId: ['string', true], streamId: ['string', true], method: ['string', true], path: ['string', true], headers: ['object', false] },
  'http-body': { deviceId: ['string', true], streamId: ['string', true], chunk: ['string', true], final: ['boolean', true] },
  'http-res-head': { deviceId: ['string', true], streamId: ['string', true], status: ['number', true], headers: ['object', false] },
  'http-res-body': { deviceId: ['string', true], streamId: ['string', true], chunk: ['string', true], final: ['boolean', true] },
  'http-error': { deviceId: ['string', true], streamId: ['string', true], code: ['string', true], message: ['string', true], status: ['number', false] },
  'ws-open': { deviceId: ['string', true], streamId: ['string', true], path: ['string', true], headers: ['object', false] },
  'ws-accept': { deviceId: ['string', true], streamId: ['string', true] },
  'ws-data': { deviceId: ['string', true], streamId: ['string', true], fin: ['boolean', true], opcode: ['number', true], data: ['string', true] },
  'ws-close': { deviceId: ['string', true], streamId: ['string', true], code: ['number', true] },

  'pair-begin': { channel: ['string', true], pairToken: ['string', true], name: ['string', true], pubKey: ['string', false] },
  'pair-challenge': { channel: ['string', true], challenge: ['string', true], code: ['string', false] },
  'pair-done': { channel: ['string', true], challenge: ['string', true], sig: ['string', true], ts: ['number', true] },
  'pair-result': { channel: ['string', true], ok: ['boolean', true], error: ['string', false], deviceId: ['string', false], code: ['string', false], setCookie: ['string', false] },
  'auth-begin': { channel: ['string', true], deviceId: ['string', true] },
  'auth-challenge': { channel: ['string', true], challenge: ['string', true] },
  'auth-done': { channel: ['string', true], sig: ['string', true], ts: ['number', true] },
  'auth-result': { channel: ['string', true], ok: ['boolean', true], error: ['string', false], ticket: ['string', false], setCookie: ['string', false] },

  sealed: { deviceId: ['string', true], counter: ['number', true], nonce: ['string', true], ciphertext: ['string', true] },

  // E2E 明文内层
  open: { reqId: ['string', true], method: ['string', true], path: ['string', true], headers: ['object', false], bodyRef: ['string', false] },
  item: { reqId: ['string', true], seq: ['number', true], chunk: ['string', true] },
  end: { reqId: ['string', true], status: ['number', true], headers: ['object', false] },
  error: { reqId: ['string', true], code: ['string', true], message: ['string', true] },
  upgrade: { streamId: ['string', true], path: ['string', true] }
};

const TYPE_CHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  b64: (v) => typeof v === 'string',
  json: () => true
};

/** 校验一帧的键与类型；任何偏差抛 FrameError（exactKeys）。 */
export function assertFrame(frame) {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    throw new FrameError('bad-frame', 'frame must be a JSON object');
  }
  const kind = frame.kind;
  if (typeof kind !== 'string') throw new FrameError('bad-frame', 'kind must be a string');
  const spec = SPECS[kind];
  if (spec === undefined) throw new FrameError('unknown-kind', `unknown frame kind ${JSON.stringify(kind)}`);
  const seen = new Set(['kind']);
  for (const [field, [type, required]] of Object.entries(spec)) {
    const value = frame[field];
    if (value === undefined) {
      if (required) throw new FrameError('bad-frame', `${kind}: missing required field "${field}"`);
      continue;
    }
    if (!TYPE_CHECK[type](value)) throw new FrameError('bad-frame', `${kind}: field "${field}" has wrong type (want ${type})`);
    seen.add(field);
  }
  for (const field of Object.keys(frame)) {
    if (!seen.has(field)) throw new FrameError('bad-frame', `${kind}: unexpected field "${field}" (exactKeys)`);
  }
  return frame;
}

/** 编码为 JSON 文本（超限抛错）。 */
export function encodeFrame(frame) {
  assertFrame(frame);
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new FrameError('frame-too-large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  return text;
}

/** 解码 JSON 文本；任何偏差抛 FrameError。 */
export function decodeFrame(text) {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new FrameError('frame-too-large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    throw new FrameError('bad-json', 'frame is not valid JSON');
  }
  return assertFrame(frame);
}

// ---- 二进制承载帧（协议 v1 扩展，caps 协商 'bin' 后启用）----
//
// 目的：大载荷帧（http-body / http-res-body / ws-data）不再走「b64 + JSON 文本」，
// 而是 ws 二进制消息 = 「JSON 头 + 0x00 分隔 + 原始载荷字节」。
//   收益：载荷零膨胀（v1 对压缩后字节仍有 +33%），且省 2×b64 与大字符串 JSON 字段
//   兼容：控制帧/信令帧仍走 JSON 文本；对端 caps 无 'bin' 时自动回退全文本。
//   中继不解码二进制帧语义 —— 头里的 deviceId/streamId 与 JSON 版完全一致，
//   中继解析头后走同一条 relayConnectorFrame 路径。

/** 可走二进制承载的 kind（载荷字段名 → 头里删除、放原始字节区）。 */
const BIN_PAYLOAD_FIELD = {
  'http-body': 'chunk',
  'http-res-body': 'chunk',
  'ws-data': 'data'
};

/** 判断一帧是否适合二进制承载（载荷足够大才值得 —— 小帧 JSON 更紧凑）。 */
export function isBinEligible(frame, minPayload = 4096) {
  if (!frame || typeof frame !== 'object') return false;
  const field = BIN_PAYLOAD_FIELD[frame.kind];
  if (!field) return false;
  const v = frame[field];
  if (typeof v !== 'string') return false;
  // b64 长度 × 3/4 ≈ 原始字节；超过阈值才切二进制（小帧切过去反而多写一遍头）
  return v.length >= Math.ceil(minPayload * 4 / 3);
}

/** 编码二进制帧：JSON 头（去掉载荷字段）+ 0x00 + 原始载荷。超限抛错。 */
export function encodeBinFrame(frame) {
  assertFrame(frame);
  const field = BIN_PAYLOAD_FIELD[frame.kind];
  if (!field) throw new FrameError('bad-frame', `${frame.kind}: not a binary-eligible kind`);
  const payload = b64d(frame[field], field);
  const head = { ...frame };
  delete head[field];
  const headText = JSON.stringify(head);
  const headBuf = Buffer.from(headText, 'utf8');
  const total = headBuf.length + 1 + payload.length;
  if (total > MAX_WIRE_FRAME_BYTES) throw new FrameError('frame-too-large', `binary frame exceeds ${MAX_WIRE_FRAME_BYTES} bytes`);
  return Buffer.concat([headBuf, SEPARATOR, payload]);
}

/** 解码二进制帧：与 encodeBinFrame 互逆。任何偏差抛 FrameError。 */
export function decodeBinFrame(buf) {
  if (!Buffer.isBuffer(buf)) throw new FrameError('bad-frame', 'binary frame must be a Buffer');
  const at = buf.indexOf(SEPARATOR[0]);
  if (at === -1 || at === 0 || at > 4096) throw new FrameError('bad-frame', 'binary frame: separator not found or head too large');
  let frame;
  try {
    frame = JSON.parse(buf.subarray(0, at).toString('utf8'));
  } catch {
    throw new FrameError('bad-json', 'binary frame head is not valid JSON');
  }
  const field = BIN_PAYLOAD_FIELD[frame?.kind];
  if (!field) throw new FrameError('unknown-kind', `binary frame has non-binary kind ${JSON.stringify(frame?.kind)}`);
  // 头里必须没有载荷字段（防伪造 + exactKeys 干净）；载荷区即字段值
  if (field in frame) throw new FrameError('bad-frame', `binary frame head must not carry "${field}"`);
  frame[field] = buf.subarray(at + 1).toString('base64url');
  return assertFrame(frame);
}

/** 组装 http-head 的合法请求头白名单（连接器重建请求时也用同一张表，见 proxy/reverse-proxy.js）。 */
export const REQUEST_HEADER_WHITELIST = ['content-type', 'content-disposition', 'x-ra-device'];
