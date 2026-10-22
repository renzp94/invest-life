#!/usr/bin/env node
/**
 * 录制游戏实机演示：CDP 逐帧截取 → ffmpeg 合成竖屏视频
 *
 *   node scripts/record.mjs            正式录制
 *   node scripts/record.mjs --dry      只走流程不录，打印每一步停在哪个屏
 *
 * 输出：docs/vlog/invest-life-gameplay.mp4（1080×1920）
 * 中间帧在 /tmp/vlog_frames/，可删。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_DIR = '/tmp/vlog_frames';
const OUT = path.join(ROOT, 'docs', 'vlog', 'invest-life-gameplay.mp4');
const DRY = process.argv.includes('--dry');
const WAIT_K = DRY ? 0.3 : 1;

function freePort(){
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function serve(root, port){
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    fs.readFile(path.join(root, u), (e, b) => {
      if (e){ res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(b);
    });
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

const port = await freePort();
const cdpPort = await freePort();
const srv = serve(ROOT, port);
const profile = '/tmp/vlog_profile_' + cdpPort;
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-allow-origins=*', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  '--remote-debugging-port=' + cdpPort,
  '--user-data-dir=' + profile,
  'about:blank'
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 100; i++){
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
    const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg){ wsUrl = pg.webSocketDebuggerUrl; break; }
  } catch (_){}
  await new Promise(r => setTimeout(r, 200));
}
if (!wsUrl) throw new Error('连不上 CDP');

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const waiting = new Map();
const frames = [];          // { file, t }
let recording = false;
let frameNo = 0;

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)){
    const w = waiting.get(m.id); waiting.delete(m.id);
    if (m.error) w.rej(new Error(JSON.stringify(m.error))); else w.res(m.result);
    return;
  }
  if (m.method === 'Page.screencastFrame'){
    const d = m.params;
    if (recording){
      const name = 'f' + String(++frameNo).padStart(5, '0') + '.jpg';
      fs.writeFileSync(path.join(FRAME_DIR, name), Buffer.from(d.data, 'base64'));
      frames.push({ file: name, t: d.metadata.timestamp });
    }
    send('Page.screencastFrameAck', { sessionId: d.sessionId }).catch(() => {});
  }
};

function send(method, params = {}){
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(expr){
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const W = 390, H = 844;
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1080 / W, mobile: true
});

const wait = ms => new Promise(r => setTimeout(r, ms * WAIT_K));
const click = sel => evalJS(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('no ${sel}');e.click();return 1;})()`);
const to = sel => evalJS(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 0;e.scrollIntoView({behavior:'smooth',block:'center'});return 1;})()`);
const screenNow = () => evalJS("(document.querySelector('.screen.show')||{}).id || '?'");

await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/index.html' });
await wait(2500);

/* ---------- 时间轴 ---------- */
const timeline = [];

timeline.push(async () => { await wait(2600); });                       // 首页停留

timeline.push(async () => { await click('[data-asset=index]'); });       // 进宽基指数
timeline.push(async () => { await wait(3000); });                      // 现金流

timeline.push(async () => { await click('#btnToConfig'); });            // 进配置
timeline.push(async () => { await wait(2400); });
timeline.push(async () => { await to('#idxGrid'); await wait(2600); }); // 指数列表
timeline.push(async () => { await evalJS('window.scrollTo({top:0,behavior:"smooth"})'); await wait(1400); });

timeline.push(async () => { await click('#btnStart'); });               // 开局
timeline.push(async () => { await wait(3000); });                      // 盘面

timeline.push(async () => { await click('#btnAllin'); });               // 全仓买入
timeline.push(async () => { await wait(2400); });

timeline.push(async () => { await click('#btnAuto'); });                // 自动播放
timeline.push(async () => { await wait(8500); });
timeline.push(async () => { await click('#btnAuto'); await wait(700); }); // 暂停

/* END 是防误触设计：第一次点变「确定?」，2.2 秒内再点一次才真的跳到结局 */
timeline.push(async () => { await click('#btnFF'); await wait(700); await click('#btnFF'); await wait(2600); });
timeline.push(async () => { await click('#envWrap'); await wait(3800); }); // 拆信封
timeline.push(async () => { await evalJS('window.scrollTo({top:640,behavior:"smooth"})'); await wait(2400); });

timeline.push(async () => { await click('#btnMenu'); await wait(1400); });

timeline.push(async () => { await click('[data-asset=compare]'); });      // 巅峰对决
timeline.push(async () => { await wait(2600); });
timeline.push(async () => { await click('#btnCmpStart'); await wait(2200); });

timeline.push(async () => {                                              // 手动推几步
  for (let i = 0; i < 10; i++){ await evalJS("document.getElementById('btnCmpNext').click()"); await wait(120); }
});
timeline.push(async () => { await wait(1600); });
timeline.push(async () => { await click('#btnCmpFF'); await wait(600); });
timeline.push(async () => { await click('#btnCmpFF'); await wait(3600); });
timeline.push(async () => { await evalJS('window.scrollTo({top:560,behavior:"smooth"})'); await wait(2400); });

/* ---------- 执行 ---------- */
if (!DRY){
  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAME_DIR, { recursive: true });
  await send('Page.startScreencast', {
    format: 'jpeg', quality: 88, maxWidth: 1080, maxHeight: 2400, everyNthFrame: 1
  });
  recording = true;
  console.log('● 开始录制');
}

let elapsed = 0;
for (const step of timeline){
  const t0 = Date.now();
  await step();
  elapsed += Date.now() - t0;
  if (DRY) console.log(`  ${String(Math.round(elapsed / 1000)).padStart(2)}s  ${await screenNow()}`);
}

await wait(1200);
recording = false;
if (!DRY){
  await send('Page.stopScreencast');
  console.log(`● 录制结束，共 ${frames.length} 帧`);
}

ws.close();
chrome.kill();
srv.close();

if (DRY){ console.log('dry run 完成'); process.exit(0); }

/* ---------- 合成 ---------- */
const t0 = frames[0].t;
const list = frames.map((f, i) => {
  const next = frames[i + 1];
  let d = next ? next.t - f.t : 1.2;
  d = Math.max(0.012, Math.min(d, 4));
  return { path: path.join(FRAME_DIR, f.file), d };
});

const txt = path.join(FRAME_DIR, 'list.txt');
fs.writeFileSync(txt, list.map(f => `file '${f.path}'\nduration ${f.d.toFixed(4)}`).join('\n') +
  `\nfile '${list[list.length - 1].path}'\nduration 1.2\n`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* 1080×1920 画布：游戏画面按高度铺满居中，两侧留深紫底，与游戏背景同色 */
const vf = 'scale=-2:1920:flags=lanczos,pad=1080:1920:(ow-iw)/2:0:color=0x0d0b16,fps=30,format=yuv420p';
const r = spawnSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', txt,
  '-vf', vf,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
  '-movflags', '+faststart',
  OUT
], { stdio: 'inherit' });

if (r.status !== 0){ console.error('✗ ffmpeg 合成失败'); process.exit(1); }

const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
const dur = frames[frames.length - 1].t - t0;
console.log(`✓ ${path.relative(ROOT, OUT)}  ${size} MB  ${dur.toFixed(1)}s`);
