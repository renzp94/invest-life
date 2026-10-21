/**
 * 抓取月 K 的完整 OHLC（开、收、高、低），写回 data/indexes.json
 *
 * 数据源：腾讯行情 fqkline 接口（与首次采集同源）
 * 返回格式：[["2005-04-29","984.660","932.400","1008.730","914.830","187171470.000"], ...]
 *           [ 日期, 开, 收, 高, 低, 成交量 ]
 *
 * 输出：points = [[ "YYYY-MM", 开, 收, 高, 低 ], ...]
 *
 * 用法：node scripts/fetch-ohlc.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'indexes.json');

/* 指数代码 → 腾讯符号：000xxx 在沪市，399xxx 在深市 */
function txSymbol(code){
  return (code.startsWith('399') ? 'sz' : 'sh') + code;
}

function fetchMonth(sym){
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
              sym + ',month,,,2000,qfq';
  const out = execFileSync('curl', ['-s', '--max-time', '30', url], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const node = j.data && j.data[sym];
  if (!node) throw new Error('无数据: ' + sym);
  const arr = node.month || node.qfqmonth;
  if (!Array.isArray(arr) || !arr.length) throw new Error('月线为空: ' + sym);
  return arr;
}

/* 月末对齐：接口最后一条通常是未结束的当月，调用方会剔除 */
function toRows(arr){
  const rows = [];
  for (const r of arr){
    const date = r[0];
    const ym = date.slice(0, 7);
    const o = +r[1], c = +r[2], h = +r[3], l = +r[4];
    if (![o, c, h, l].every(Number.isFinite)) continue;
    if (!(h >= Math.max(o, c) - 1e-6 && l <= Math.min(o, c) + 1e-6)){
      throw new Error('OHLC 不自洽: ' + date + ' ' + [o, c, h, l].join('/'));
    }
    rows.push({ ym, date, o, c, h, l });
  }
  return rows;
}

/* 月份连续性检查：相邻两点必须差 1 个月 */
function checkGaps(rows, name){
  const gaps = [];
  for (let i = 1; i < rows.length; i++){
    const [y1, m1] = rows[i - 1].ym.split('-').map(Number);
    const [y2, m2] = rows[i].ym.split('-').map(Number);
    const d = (y2 - y1) * 12 + (m2 - m1);
    if (d !== 1) gaps.push(rows[i - 1].ym + ' → ' + rows[i].ym + ' (' + d + ')');
  }
  if (gaps.length) console.log('  ⚠ ' + name + ' 断档: ' + gaps.join(', '));
  return gaps;
}

const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const prevAsOf = ds.asOf;
let changed = 0, maxDiff = 0;
const report = [];

for (const item of ds.items){
  const sym = txSymbol(item.code);
  let rows = toRows(fetchMonth(sym));

  /* 去掉未结束的当月 */
  const now = new Date();
  const curYm = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  if (rows.length && rows[rows.length - 1].ym === curYm){
    rows.pop();
  }

  /* 起点以原数据为准，避免复权口径变化把历史拉长 */
  const oldStart = item.points[0][0];
  rows = rows.filter(r => r.ym >= oldStart);

  checkGaps(rows, item.name);

  /* 收盘价对账：新数据不能和旧数据漂移 */
  const oldMap = new Map(item.points.map(p => [p[0], p[1]]));
  let diff = 0, checked = 0, missing = 0;
  for (const r of rows){
    if (!oldMap.has(r.ym)){ missing++; continue; }
    const d = Math.abs(oldMap.get(r.ym) - r.c) / oldMap.get(r.ym);
    if (d > diff) diff = d;
    checked++;
  }
  maxDiff = Math.max(maxDiff, diff);

  /* 若旧数据里有而新数据没有的月份 → 报出来 */
  const newSet = new Set(rows.map(r => r.ym));
  const lost = item.points.filter(p => !newSet.has(p[0])).map(p => p[0]);

  item.points = rows.map(r => [r.ym, round(r.o), round(r.c), round(r.h), round(r.l)]);
  changed++;

  report.push({
    name: item.short,
    n: rows.length,
    from: rows[0].ym,
    to: rows[rows.length - 1].ym,
    closeMaxDiffPct: (diff * 100).toFixed(4),
    missing,
    lost: lost.length ? lost.slice(0, 4).join(',') + (lost.length > 4 ? '…' : '') : '-'
  });
}

function round(v){ return Math.round(v * 100) / 100; }

ds.asOf = ds.items.reduce((mx, it) => {
  const last = it.points[it.points.length - 1][0];
  return last > mx ? last : mx;
}, '');
ds.schema = 2;
ds.ohlc = true;
ds.updated = new Date().toISOString().slice(0, 10);

console.table(report);
console.log('asOf:', prevAsOf, '→', ds.asOf);
console.log('收盘价最大偏差:', (maxDiff * 100).toFixed(4) + '%');
console.log('总点数:', ds.items.reduce((s, i) => s + i.points.length, 0));

if (maxDiff > 0.002){
  console.error('✗ 收盘价偏差超过 0.2%，数据源口径可能变了，已中止写入');
  process.exit(1);
}

fs.writeFileSync(FILE, JSON.stringify(ds, null, 0) + '\n');
console.log('✓ 已写入', FILE, (fs.statSync(FILE).size / 1024).toFixed(0) + 'KB');
