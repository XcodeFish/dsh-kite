/**
 * 极小 QR 编码器（零依赖，byte 模式，版本 1–10 自动选版，ECC M，自动掩码）。
 *
 * 双端复用：Node（契约测试）与浏览器面板（`/kite/qr.js` 以 ES module 提供，
 * TextEncoder 两端都有）。只服务一个用途：把配对链接渲染成二维码。配对 URL ≈
 * 90–140 字符，v10-M 容量 213 字符，余量充足。结构遵循 ISO/IEC 18004：
 * finder/separator/timing/alignment/dark module/format BCH(15,5)/version BCH(18,6)。
 */

// ---- GF(256)，本原多项式 0x11D ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon 纠错码字（data → ecLen 个 ec 码字）。gen 以最高次项在前（除法约定）。 */
function rsEncode(data, ecLen) {
  // 生成多项式 g(x) = ∏(x - α^i)，系数按最高次在前存储（gen[0] = 1）。
  let gen = [1]; // 最高次在前
  for (let i = 0; i < ecLen; i += 1) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j += 1) {
      // gen(x) * (x + α^i)：gen[j]·x 落到 next[j]，gen[j]·α^i 落到 next[j+1]
      next[j] ^= gen[j];
      next[j + 1] ^= gmul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i += 1) rem[i] ^= gmul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ---- 版本表（ECC M）：[总码字, [组1块数, 组1数据码字], [组2…]|null, 每块纠错码字, 对齐坐标] ----
const VERSION_TABLE = [
  [26, [1, 16], null, 10, null], // v1
  [44, [1, 28], null, 16, [6, 18]], // v2
  [70, [1, 44], null, 26, [6, 22]], // v3
  [100, [2, 32], null, 18, [6, 26]], // v4
  [134, [2, 43], null, 24, [6, 30]], // v5
  [172, [4, 27], null, 16, [6, 34]], // v6
  [196, [4, 31], null, 18, [6, 22, 38]], // v7
  [242, [2, 38], [2, 39], 22, [6, 24, 42]], // v8
  [292, [3, 36], [2, 37], 22, [6, 26, 46]], // v9
  [346, [4, 43], [1, 44], 26, [6, 28, 50]] // v10
];
/** byte 模式 ECC-M 官方容量表。 */
const CAPACITY_M = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };
const ECC_LEVEL_M_BITS = 0b00;
const BYTE_MODE = 0b0100;

/** 选版本（v1..10，M）；超容量抛错。 */
export function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v += 1) {
    if (byteLen <= CAPACITY_M[v]) return v;
  }
  throw new Error(`qr: payload too large for v10-M (${byteLen} bytes > ${CAPACITY_M[10]})`);
}

/** 编码数据段：mode + count + bytes + terminator + pad → 全部数据码字（交错前）。 */
function buildDataCodewords(bytes, version) {
  const spec = VERSION_TABLE[version - 1];
  const totalData = spec[1][0] * spec[1][1] + (spec[2] ? spec[2][0] * spec[2][1] : 0);
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(BYTE_MODE, 4);
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, totalData * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; out.length < totalData; i += 1) out.push(pads[i % 2]);
  return out;
}

/** 按块切分 + RS 纠错 + 码字交错。 */
function interleave(bytes, version) {
  const spec = VERSION_TABLE[version - 1];
  const blocks = [];
  for (let i = 0; i < spec[1][0]; i += 1) blocks.push(bytes.splice(0, spec[1][1]));
  if (spec[2]) {
    for (let i = 0; i < spec[2][0]; i += 1) blocks.push(bytes.splice(0, spec[2][1]));
  }
  const ecs = blocks.map((block) => rsEncode(block, spec[3]));
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < spec[3]; i += 1) {
    for (const ec of ecs) out.push(ec[i]);
  }
  return out;
}

// ---- 矩阵构造 ----

function makeMatrix(version) {
  const size = 4 * version + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null=功能位未定
  // finder：7×7，暗-亮-暗同心环（ring 3/1 暗，2 亮，0 中心暗），ring 4 = separator 亮
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        m[y][x] = ring !== 4 && (ring === 0 || ring % 2 === 1);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  for (let i = 8; i < size - 8; i += 1) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
  }
  const aligns = VERSION_TABLE[version - 1][4];
  if (aligns) {
    for (const cy of aligns) {
      for (const cx of aligns) {
        // 只跳过与三个 finder 重叠的组合（表中坐标 6 恰与 finder 基址重合）；
        // 与 timing 重叠的对齐图案必须照常绘制（标准行为：覆盖 timing）。
        const overlapsFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
        if (overlapsFinder) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            m[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          }
        }
      }
    }
  }
  m[size - 8][8] = true; // dark module
  return m;
}

/** 格式信息 15 位：BCH(15,5) gen 0x537，异或掩码 0x5412。 */
function bchFormat(mask) {
  const data = (ECC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 版本信息 18 位（v≥7）：BCH(18,6) gen 0x1F25。 */
function bchVersion(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0);
  return (version << 12) | (rem & 0xfff);
}

/** 两个 format 段 + dark module（坐标与位序对齐 ISO/IEC 18004，参考实现逐位核对过）。 */
function placeFormat(m, size, mask) {
  const bits = bchFormat(mask);
  for (let i = 0; i < 15; i += 1) {
    const mod = ((bits >> i) & 1) === 1;
    // 垂直条（col 8）：i<6 → 行 i；i=6,7 → 行 i+1；i≥8 → 行 size-15+i
    if (i < 6) m[i][8] = mod;
    else if (i < 8) m[i + 1][8] = mod;
    else m[size - 15 + i][8] = mod;
    // 水平条（row 8）：i<8 → 列 size-1-i；i=8 → 列 7；i≥9 → 列 14-i
    if (i < 8) m[8][size - 1 - i] = mod;
    else if (i === 8) m[8][7] = mod;
    else m[8][14 - i] = mod;
  }
  m[size - 8][8] = true; // dark module
}

/** 版本信息块（v≥7，两处镜像）。 */
function placeVersion(m, size, version) {
  if (version < 7) return;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    m[row][col] = bit;
    m[col][row] = bit;
  }
}

/** 8 种掩码函数（ISO 18004 §8.8.2）。 */
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 2) + Math.floor(y / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

/** 惩罚评分 N1–N4（选最低掩码用）。 */
function penalty(m, size) {
  let score = 0;
  for (const axis of ['row', 'col']) {
    for (let i = 0; i < size; i += 1) {
      let run = 1;
      let prev = axis === 'row' ? m[i][0] : m[0][i];
      for (let j = 1; j < size; j += 1) {
        const cur = axis === 'row' ? m[i][j] : m[j][i];
        if (cur === prev) {
          run += 1;
          if (run >= 5) score += 1 + (run - 5);
        } else {
          run = 1;
        }
        prev = cur;
      }
    }
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = m[y][x];
      if (m[y][x + 1] === v && m[y + 1][x] === v && m[y + 1][x + 1] === v) score += 3;
    }
  }
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [...pat1].reverse();
  const matches = (get) => {
    let found = 0;
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j <= size - 11; j += 1) {
        let ok1 = true;
        let ok2 = true;
        for (let k = 0; k < 11; k += 1) {
          const v = get(i, j + k);
          if (v !== pat1[k]) ok1 = false;
          if (v !== pat2[k]) ok2 = false;
        }
        if (ok1 || ok2) found += 1;
      }
    }
    return found;
  };
  score += matches((i, j) => m[i][j]) * 40;
  score += matches((i, j) => m[j][i]) * 40;
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark += 1;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** format + version + dark module 的全部坐标（数据放置前必须预留，否则数据流错位）。 */
function markReservedFunctionCells(m, size, version) {
  const mark = (y, x) => {
    m[y][x] = false; // 先占位为亮；placeFormat/placeVersion 会写最终值
  };
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) mark(i, 8);
    else if (i < 8) mark(i + 1, 8);
    else mark(size - 15 + i, 8);
    if (i < 8) mark(8, size - 1 - i);
    else if (i === 8) mark(8, 7);
    else mark(8, 14 - i);
  }
  mark(size - 8, 8);
  if (version >= 7) {
    const bits = bchVersion(version); // 坐标集合与位值无关
    void bits;
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = (i % 3) + size - 11;
      mark(row, col);
      mark(col, row);
    }
  }
}

/**
 * 生成 QR 矩阵：{ size, version, get(x,y)→boolean }。dark=true。
 * options.mask（0–7）强制指定掩码（测试对照用）；缺省自动选惩罚最小者。
 * 数据之字形：自右下角起、首对列自底向上、逐对蛇形（与参考实现逐位一致）。
 */
export function qrMatrix(text, options = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const codewords = interleave(buildDataCodewords([...bytes], version), version);
  const size = 4 * version + 17;
  const build = (mask) => {
    const m = makeMatrix(version);
    markReservedFunctionCells(m, size, version);
    const maskFn = MASKS[mask];
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    const bitAt = (i) => (codewords[i >> 3] >> (7 - (i & 7))) & 1;
    let inc = -1;
    let row = size - 1;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (;;) {
        for (let c = 0; c < 2; c += 1) {
          const x = col - c;
          if (m[row][x] === null) {
            const bit = bitIndex < totalBits ? bitAt(bitIndex) === 1 : false;
            m[row][x] = bit !== maskFn(x, row);
            bitIndex += 1;
          }
        }
        row += inc;
        if (row < 0 || row >= size) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
    placeFormat(m, size, mask);
    placeVersion(m, size, version);
    return m;
  };
  if (options.mask !== undefined) {
    const m = build(options.mask & 7);
    return { size, version, get: (x, y) => m[y][x] === true };
  }
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = build(mask);
    const score = penalty(m, size);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { size, version, get: (x, y) => best[y][x] === true };
}

/** 版本表与内部函数导出（契约测试用）。 */
export { VERSION_TABLE, CAPACITY_M, buildDataCodewords, interleave, rsEncode, penalty, MASKS, bchFormat, bchVersion };
