#!/usr/bin/env node
/**
 * 构建脚本：把 data/indexes.json 内联进 src/template.html，产出可直接双击运行的 index.html
 *
 *   node build.js
 *
 * 数据是唯一真源。改 data/indexes.json（或用页面里的「导入」按钮临时换一套），
 * 再跑一次本脚本，就能把游戏换成任意指数 / 行业 / 个股。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'indexes.json');
const PROMPT = path.join(ROOT, 'data', 'PROMPT.md');
const TPL = path.join(ROOT, 'src', 'template.html');
const OUT = path.join(ROOT, 'index.html');

/* ---------- 读取并校验数据 ---------- */
const ds = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const items = Array.isArray(ds) ? ds : ds.items;

if (!Array.isArray(items) || !items.length) {
  throw new Error('数据为空：需要 items 数组');
}

const errors = [];
let minYm = null, maxYm = null, totalPoints = 0;

items.forEach((it, i) => {
  const tag = it.code ? `${it.name || '?'}(${it.code})` : `第 ${i + 1} 条`;

  if (!it.code) errors.push(`${tag} 缺少 code`);
  if (!it.name) errors.push(`${tag} 缺少 name`);
  if (!Array.isArray(it.points)) { errors.push(`${tag} points 不是数组`); return; }

  /* 粒度由第一个点决定：10 位 = 日频，7 位 = 月频。同一标的不能混用 */
  const first0 = Array.isArray(it.points[0]) ? it.points[0][0] : '';
  const isDay = typeof first0 === 'string' && first0.length === 10;
  const keyRe = isDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
  const minPts = isDay ? 400 : 25;
  it._gran = isDay ? 'day' : 'month';
  if (it.points.length < minPts)
    errors.push(`${tag} 只有 ${it.points.length} 个${isDay ? '交易日' : '月'}，至少需要 ${minPts} 个`);

  let prev = null, ohlcCount = 0;
  it.points.forEach((p, j) => {
    if (!Array.isArray(p) || p.length < 2) { errors.push(`${tag} 第 ${j + 1} 个数据点格式错误`); return; }
    const ym = p[0];
    const full = p.length >= 5;          // [日期, 开, 收, 高, 低]
    const close = full ? p[2] : p[1];
    if (!keyRe.test(String(ym)))
      errors.push(`${tag} 第 ${j + 1} 个日期 "${ym}" 不是 ${isDay ? 'YYYY-MM-DD' : 'YYYY-MM'}`);
    if (!(close > 0)) errors.push(`${tag} ${ym} 收盘价非法：${close}`);
    if (full) {
      const o = +p[1], c = +p[2], h = +p[3], l = +p[4];
      if (![o, c, h, l].every(v => v > 0)) errors.push(`${tag} ${ym} 开高低收存在非正数`);
      else if (!(h >= Math.max(o, c) - 1e-6 && l <= Math.min(o, c) + 1e-6))
        errors.push(`${tag} ${ym} 最高/最低价不自洽`);
      else ohlcCount++;
    }
    if (prev) {
      if (String(ym) <= String(prev)) errors.push(`${tag} ${prev} → ${ym} 日期没有升序`);
      /* 月频必须一个接一个；日频跳周末、节假日是正常的，只查重复与升序 */
      if (!isDay) {
        const [y1, m1] = String(prev).split('-').map(Number);
        const [y2, m2] = String(ym).split('-').map(Number);
        if ((y2 - y1) * 12 + (m2 - m1) !== 1) errors.push(`${tag} ${prev} → ${ym} 月份不连续`);
      }
    }
    prev = ym;
  });
  it._full = ohlcCount;

  const first = it.points[0][0], last = it.points[it.points.length - 1][0];
  if (!minYm || first < minYm) minYm = first;
  if (!maxYm || last > maxYm) maxYm = last;
  totalPoints += it.points.length;

  if (typeof it.div !== 'number') it.div = 0.02;
  if (!it.short) it.short = it.name;
  if (it.short.length > 8) errors.push(`${tag} 的 short 超过 8 个字，按钮会放不下`);
});

const dupCodes = items.map(i => i.code).filter((c, i, a) => a.indexOf(c) !== i);
if (dupCodes.length) errors.push('code 重复：' + [...new Set(dupCodes)].join(', '));

if (errors.length) {
  console.error('✗ 数据校验未通过：');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}

/* ---------- 注入模板 ---------- */
const tpl = fs.readFileSync(TPL, 'utf8');
if (!tpl.includes('__DATASET__')) throw new Error('模板里找不到 __DATASET__ 占位符');
if (!tpl.includes('__PROMPT__')) throw new Error('模板里找不到 __PROMPT__ 占位符');

// JSON 内联到 <script type="application/json">，需转义 </script 与 <!--
const json = JSON.stringify(ds)
  .replace(/<\//g, '<\\/')
  .replace(/<!--/g, '<\\u0021--');

/* 提示词正文：取 PROMPT.md 里 ````text 代码块的内容，供游戏内一键复制 */
let promptText = '';
try {
  const md = fs.readFileSync(PROMPT, 'utf8');
  const m = md.match(/````text\r?\n([\s\S]*?)````/);
  promptText = (m ? m[1] : md).trim();
} catch (e) {
  console.warn('! 未找到 data/PROMPT.md，游戏内的提示词将为空');
}
const promptJson = JSON.stringify(promptText)
  .replace(/<\//g, '<\\/')
  .replace(/<!--/g, '<\\u0021--');

const html = tpl.replace('__DATASET__', json).replace('__PROMPT__', promptJson);

/* --check：只校验、不落盘，给 CI 或改完数据先验一遍用 */
const CHECK = process.argv.includes('--check');
if (CHECK){
  console.log('✓ 校验通过（--check，未写出 index.html）');
  console.log('  标的 ' + items.length + ' 个 · 数据点 ' + totalPoints +
              ' · 区间 ' + minYm + ' ~ ' + maxYm);
  process.exit(0);
}

fs.writeFileSync(OUT, html);

/* ---------- 报告 ---------- */
const kb = n => (n / 1024).toFixed(1) + 'KB';
const fullItems = items.filter(it => it._full === it.points.length).length;
console.log('✓ 构建完成 → index.html  ' + kb(html.length));
console.log('  标的 ' + items.length + ' 个 · 数据点 ' + totalPoints +
            ' · 区间 ' + minYm + ' ~ ' + maxYm);
console.log('  完整 OHLC：' + fullItems + '/' + items.length + ' 个标的（其余仅有收盘价，K 线用前收补开盘）');
items.forEach(it => {
  const p = it.points;
  console.log('  · ' + (it.short || it.name).padEnd(9) +
              String(p.length).padStart(5) + (it._gran === 'day' ? ' 日  ' : ' 月  ') +
              p[0][0] + '→' + p[p.length - 1][0] +
              (it._full === p.length ? '  OHLC' : '  close'));
});
