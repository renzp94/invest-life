#!/usr/bin/env node
/**
 * 出片：字幕 + 配乐 + 封面
 *
 *   npm run vlog            合成成片（先跑配乐脚本）
 *   node scripts/publish-video.mjs --subs-only   只重烧字幕
 *
 * 输入：docs/vlog/invest-life-vlog.mp4（片头 + 实机 + 片尾）
 *       docs/vlog/audio/vlog-audio.wav（scripts/vlog-audio.py 生成）
 * 输出：docs/vlog/invest-life-publish.mp4（H.264 + AAC 1080×1920）
 *       docs/vlog/cover.png（1080×1920 封面）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VL = path.join(ROOT, 'docs', 'vlog');
const SRC = path.join(VL, 'invest-life-vlog.mp4');
const AUDIO = path.join(VL, 'audio', 'vlog-audio.wav');
const SUBS = path.join(VL, 'captions.ass');
const OUT = path.join(VL, 'invest-life-publish.mp4');
const COVER = path.join(VL, 'cover.png');
const CN_FONT = '/System/Library/Fonts/STHeiti Medium.ttc';

/* ---------------------------------------------------------------- 时间轴
 * 时间是对着成片量的（场景检测 + 逐帧确认），改字幕直接改这里。
 * 每行：开始 / 结束 / 字幕（| 换行） / 解说（写进章节文件，不上屏）
 */
const TIMELINE = [
  [0.9, 2.5, '如果人生能重来一次，你会怎么投？|2005 → 2026 · 真实收盘价'],
  [2.9, 5.3, '三种玩法|宽基指数 / 巅峰对决'],
  [5.7, 8.3, '开局没有本金，只有一份工资|月薪 ¥12,000 · 支出 ¥7,000'],
  [8.6, 11.4, '15 只宽基|A 股 · 港股 · 美股，最早追到 1987'],
  [11.4, 14.6, '每月剩 ¥5,000，才有 ¥5,000 可投|场外 / 场内，费率不同'],
  [15.0, 17.9, '2005 年 1 月 4 日 · 本金 ¥50,000|每一步自己点，没有回放'],
  [18.0, 20.8, '买入 / 全仓 / 减仓 / 清仓|留着现金，还是全部上车'],
  [21.0, 24.8, 'AUTO 打开，时间开始跑|生活费按天扣，工资按月到账'],
  [24.8, 28.4, '2006 → 2010，四年走完|净值从 5 万到 57 万'],
  [28.4, 30.2, '回撤来的时候|真的会想清仓'],
  [30.4, 33.4, 'END：一口气开到 2026 年|二十一年，一屏结算'],
  [33.6, 36.2, '拆开那封信|看看最后留下了什么'],
  [36.2, 39.0, '赚了 ¥283,116|但 82% 的身家还在现金里'],
  [39.3, 42.9, '换个玩法：巅峰对决|同一笔钱，同一起点，只比行情'],
  [43.1, 46.3, '每个账户 ¥100,000|2005.01 → 2026.10'],
  [46.3, 49.3, '标普 500 / 沪深 300 / 恒生|三只指数，一条时间轴'],
  [49.3, 52.2, '二十一年，一张图看完|标普一路向上，恒生几乎原地'],
  [52.6, 55.0, '标普 500：¥851,457（+751.5%）|最大回撤 -55.6%'],
  [55.0, 57.0, '恒生：¥336,023（+236.0%）|头尾相差 51.5 万'],
  [57.4, 60.0, '一个 HTML 文件，打开就能玩|renzp94.github.io/invest-life'],
];

/* ---------------------------------------------------------------- ASS 字幕 */
const ts = s => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 关键数字染个色，静音刷也能扫到（base 是回落的颜色） */
function paint(line, base = 'FFFFFF') {
  const reset = `{\\c&H${base}}`;
  return esc(line)
    .replace(/¥[\d,]+(\.\d+)?/g, m => `{\\c&H4AD2FF&}${m}${reset}`)
    .replace(/[+\-]\d+(\.\d+)?%/g, m => `{\\c&H9CFF8C&}${m}${reset}`);
}

function buildAss() {
  const head = `[Script Info]
Title: 投资人生 · vlog 字幕
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,PingFang SC,46,&H00FFFFFF,&H00FFFFFF,&H00121018,&H8C120E18,0,0,0,0,100,100,0.6,0,3,16,0,8,70,70,48,1
Style: Cap2,PingFang SC,34,&H00D8CFF0,&H00D8CFF0,&H00121018,&H8C120E18,0,0,0,0,100,100,0.4,0,3,12,0,8,70,70,44,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = TIMELINE.map(([a, b, txt]) => {
    const parts = txt.split('|');
    const main = paint(parts[0]);
    const sub = parts[1] ? `\\N{\\fs33\\c&HCFC8E8&}${paint(parts[1], 'CFC8E8')}` : '';
    return `Dialogue: 0,${ts(a)},${ts(b)},Cap,,0,0,0,,{\\fad(140,140)}${main}${sub}`;
  });
  fs.writeFileSync(SUBS, head + lines.join('\n') + '\n');
  console.log(`· 字幕 ${TIMELINE.length} 条 → ${path.relative(ROOT, SUBS)}`);
}

/* ---------------------------------------------------------------- 合成 */
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ ${label}\n${(r.stderr || '').split('\n').slice(-12).join('\n')}`);
    process.exit(1);
  }
}

function mux() {
  const vf = [
    'ass=docs/vlog/captions.ass:fontsdir=/System/Library/Fonts',
    'fade=t=in:st=0:d=0.35',
    'fade=t=out:st=59.85:d=0.45',
  ].join(',');

  const af = 'loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=58.2:d=2.2';

  run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', SRC,
    '-i', AUDIO,
    '-filter_complex', `[0:v]${vf}[v];[1:a]${af}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    OUT,
  ], 'ffmpeg 合成成片');
}

/* ---------------------------------------------------------------- 封面 */
function cover() {
  const shot = 55.2;
  const T = (text, size, y, color) =>
    `drawtext=fontfile='${CN_FONT}':text='${text}':fontsize=${size}:fontcolor=${color}:` +
    `x=(w-text_w)/2:y=${y}:expansion=none`;

  const full = [
    `[0:v]trim=start=${shot},setpts=PTS-STARTPTS,crop=1080:1124:0:56[shot]`,
    `color=c=0x0d0b16:s=1080x1920:d=1[bg]`,
    `[bg][shot]overlay=0:26[base]`,
    `[base]` + [
      `drawbox=x=0:y=1146:w=1080:h=4:color=0xFFD24A@0.55:t=fill`,
      `drawbox=x=0:y=1150:w=1080:h=770:color=0x0d0b16:t=fill`,
      T('投 资 人 生   ·   像 素 投 资 模 拟', 30, 1196, '0xFFD24A'),
      T('同样 21 年', 86, 1252, 'white'),
      T('差了 51.5 万', 112, 1352, '0xFFD24A'),
      T('标普 500  +751.5%      恒生  +236.0%', 32, 1502, '0xB9B2DC'),
      `drawbox=x=90:y=1584:w=900:h=104:color=0x1a1530:t=fill`,
      `drawbox=x=90:y=1584:w=900:h=104:color=0xFFD24A@0.55:t=3`,
      T('renzp94.github.io/invest-life', 40, 1616, '0xFFE08A'),
      T('真实历史行情 · 仅供娱乐 · 不构成投资建议', 24, 1818, '0x6F6890'),
    ].join(',') + '[out]',
  ].join(';');

  run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', SRC,
    '-filter_complex', full,
    '-map', '[out]', '-frames:v', '1',
    COVER,
  ], 'ffmpeg 生成封面');
}

/* ---------------------------------------------------------------- 章节 */
function chapters() {
  const md = [
    '# 投资人生 · 成片章节（可直接用于 B 站 / 视频号章节）',
    '',
    '| 时间 | 主字幕 | 副字幕 |',
    '| --- | --- | --- |',
    ...TIMELINE.map(([a, b, txt]) => {
      const [main, sub] = txt.split('|');
      return `| ${ts(a).slice(2, 7)}–${ts(b).slice(2, 7)} | ${main} | ${sub || ''} |`;
    }),
    '',
    '> 由 `scripts/publish-video.mjs` 的 TIMELINE 生成，改片请先改脚本。',
  ].join('\n');
  fs.writeFileSync(path.join(VL, '成片章节.md'), md + '\n');
}

/* ---------------------------------------------------------------- main */
const subsOnly = process.argv.includes('--subs-only');
const coverOnly = process.argv.includes('--cover-only');
buildAss();
if (!subsOnly) {
  if (!coverOnly) {
    if (!fs.existsSync(AUDIO)) {
      console.error('缺少配乐：先跑 python3 scripts/vlog-audio.py');
      process.exit(1);
    }
    console.log('· 混音 + 烧字幕…');
    mux();
  }
  console.log('· 封面…');
  cover();
  chapters();

  const info = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_name,width,height,r_frame_rate,channels',
    '-of', 'default=nw=1', OUT], { encoding: 'utf8' }).stdout.trim();
  console.log('\n' + info.split('\n').map(l => '  ' + l).join('\n'));
  for (const f of [OUT, COVER]) {
    console.log(`✓ ${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB`);
  }
}
