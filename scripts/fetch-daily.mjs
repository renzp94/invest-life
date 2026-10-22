#!/usr/bin/env node
/**
 * 把 data/indexes.json 从「月线」升级成「日线」，并更新到最后指定的交易日
 *
 *   node scripts/fetch-daily.mjs            # 更新到昨天
 *   node scripts/fetch-daily.mjs --dry      # 只体检不写文件
 *   node scripts/fetch-daily.mjs --end=2026-10-20
 *
 * 数据源：东方财富历史 K 线（klt=101 日线，fqt=0 不复权，指数无复权问题）
 * 输出：points = [["YYYY-MM-DD", 开, 收, 高, 低], ...]，粒度由 build.js 与引擎自动识别
 *
 * 安全网：
 *   1. 与旧月线逐月对账收盘价，偏差超阈值就跳过该标的（保留旧数据，绝不写坏）
 *   2. 日期升序 + 唯一 + OHLC 自洽（最高 ≥ 开收、最低 ≤ 开收）才写入
 *   3. 只保留到指定日期，不含当天盘中数据
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'indexes.json');
const DRY = process.argv.includes('--dry');
const TOL = 0.005;            // 收盘价对账容差 0.5%
const argEnd = process.argv.find(a => a.startsWith('--end='));

/* 默认更新到「昨天」：当天还没收盘，不能算进去 */
function yesterday(){
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}
const END = argEnd ? argEnd.slice(6) : yesterday();

/* 东方财富 secid：A 股按代码前缀推断（沪 1.xxx / 深 0.xxx），
   美股指数走 100.xxx，数据里用 secid 字段直接指定即可 */
function emSecid(item){
  if (item.secid) return item.secid;
  const c = item.code;
  return (c.startsWith('399') ? '0.' : '1.') + c;
}

async function fetchDaily(item){
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?ut=fa5fd1943f7b386f172d6893dbfba10b' +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57' +
    '&klt=101&fqt=0&secid=' + emSecid(item) +
    '&beg=0&end=' + END.replace(/-/g, '') + '&lmt=100000';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }
  });
  const j = await r.json();
  if (!j.data || !Array.isArray(j.data.klines) || !j.data.klines.length){
    throw new Error('无数据: ' + item.short + ' ' + JSON.stringify(j).slice(0, 90));
  }
  return j.data.klines.map(s => {
    const p = s.split(',');
    return { date: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4] };
  });
}

/* 断层裁剪：相邻交易日间隔超过 MAX_GAP 天，说明中间整段缺失。
   两端的收盘价都是真的（东财标普缺了 1986-10 ~ 1987-03，一句话就跳了 208 天），
   但把两个隔了半年的点直接连起来，日档 K 线会画出「一天涨 22%」——那是假行情。
   宁可起点往后挪，也不给玩家一段编出来的历史。
   A 股有史以来最长休市 20 天（1999 年春节），30 天这个阈值不会误伤。 */
const MAX_GAP = 30;
function trimFault(rows){
  let cut = 0, note = '';
  for (let i = 1; i < rows.length; i++){
    const g = (Date.parse(rows[i].date) - Date.parse(rows[i - 1].date)) / 86400000;
    if (g > MAX_GAP){
      cut = i;
      note = rows[i - 1].date + ' → ' + rows[i].date + ' 缺 ' + g + ' 天，起点截到 ' + rows[i].date;
    }
  }
  return { rows: cut ? rows.slice(cut) : rows, note: note };
}

/* 体检：升序、唯一、OHLC 自洽、价格为正 */
function validate(rows, name){
  const seen = new Set();
  for (let i = 0; i < rows.length; i++){
    const r = rows[i];
    if (seen.has(r.date)) throw new Error(name + ' 日期重复: ' + r.date);
    seen.add(r.date);
    if (i && r.date <= rows[i - 1].date) throw new Error(name + ' 日期未升序: ' + rows[i - 1].date + ' → ' + r.date);
    if (![r.o, r.c, r.h, r.l].every(v => Number.isFinite(v) && v > 0))
      throw new Error(name + ' 价格非法: ' + r.date);
    if (!(r.h >= Math.max(r.o, r.c) - 1e-6 && r.l <= Math.min(r.o, r.c) + 1e-6))
      throw new Error(name + ' OHLC 不自洽: ' + r.date + ' ' + [r.o, r.c, r.h, r.l].join('/'));
  }
}

const round = v => Math.round(v * 100) / 100;

const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const prevAsOf = ds.asOf;
const report = [];
let okCount = 0, skipCount = 0, totalPts = 0, prevTotalPts = 0;

for (const item of ds.items){
  prevTotalPts += item.points.length;
  /* 没有历史数据时打 '首次'，避免 points[0] 越界 */
  const oldGran = !item.points.length ? '首次'
    : (String(item.points[0][0]).length === 10 ? 'day' : 'month');
  let rows, fault = '';
  try {
    rows = await fetchDaily(item);
    /* 只保留到 END */
    rows = rows.filter(r => r.date <= END);
    const tf = trimFault(rows);
    rows = tf.rows;
    fault = tf.note;
    validate(rows, item.short);
    if (rows.length < 400) throw new Error('交易日不足 400: ' + rows.length);
  } catch (e){
    report.push({ 标的: item.short, 结果: '跳过', 说明: e.message.slice(0, 60),
                  点数: item.points.length, 区间: '-' });
    skipCount++;
    continue;
  }

  /* 与旧数据逐月对账：新月末收盘 vs 旧月收盘 */
  const newYm = new Map();
  rows.forEach(r => newYm.set(r.date.slice(0, 7), r.c));
  const oldYm = new Map();
  item.points.forEach(p => oldYm.set(String(p[0]).slice(0, 7), p.length >= 5 ? p[2] : p[1]));

  let worst = 0, worstYm = '', checked = 0;
  for (const [ym, oldClose] of oldYm){
    const nc = newYm.get(ym);
    if (nc == null) continue;
    const d = Math.abs(nc - oldClose) / oldClose;
    if (d > worst){ worst = d; worstYm = ym; }
    checked++;
  }
  if (checked >= 10 && worst > TOL){
    report.push({ 标的: item.short, 结果: '跳过', 说明: '对账偏差 ' + (worst * 100).toFixed(2) + '% @' + worstYm,
                  点数: item.points.length, 区间: '-' });
    skipCount++;
    continue;
  }

  const first = rows[0].date, last = rows[rows.length - 1].date;
  item.points = rows.map(r => [r.date, round(r.o), round(r.c), round(r.h), round(r.l)]);
  item.gran = 'day';
  totalPts += rows.length;
  okCount++;
  report.push({
    标的: item.short, 结果: oldGran === 'day' ? '刷新' : (oldGran === '首次' ? '首次' : '升级'),
    说明: (fault ? '断层: ' + fault : (checked ? '偏差 ' + (worst * 100).toFixed(3) + '% (' + checked + ' 月对账)' : '无旧数据可比')),
    点数: rows.length, 区间: first + '→' + last
  });
}

console.table(report);
console.log('截止日:', END, '  asOf:', prevAsOf, '→',
  ds.items.reduce((mx, it) => {
    const last = String(it.points[it.points.length - 1][0]);
    return last > mx ? last : mx;
  }, ''));
console.log('成功:', okCount, ' 跳过:', skipCount);
console.log('点数:', prevTotalPts, '→', ds.items.reduce((s, i) => s + i.points.length, 0));

if (okCount === 0){
  console.error('✗ 没有任何标的抓取成功，未写入');
  process.exit(1);
}

ds.asOf = ds.items.reduce((mx, it) => {
  const last = String(it.points[it.points.length - 1][0]);
  return last > mx ? last : mx;
}, '');
ds.count = ds.items.length;
ds.schema = 3;
ds.gran = 'day';
ds.ohlc = true;
ds.updated = new Date().toISOString().slice(0, 10);
ds.source = 'eastmoney klt=101 fqt=0';

const out = JSON.stringify(ds, null, 0) + '\n';
console.log('文件大小:', (out.length / 1024 / 1024).toFixed(2) + 'MB');

if (DRY){
  console.log('→ --dry：未写入文件');
} else {
  fs.writeFileSync(FILE, out);
  console.log('✓ 已写入', FILE);
}
