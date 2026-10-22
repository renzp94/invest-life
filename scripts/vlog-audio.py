#!/usr/bin/env python3
"""
为 vlog 合成 8-bit 配乐与音效（纯标准库，无第三方依赖）

    python3 scripts/vlog-audio.py

输出：docs/vlog/audio/vlog-audio.wav
      44.1kHz / 16bit / 立体声 / 60.45s

曲子结构按画面走：
  0.0–2.4   片头        pad + 琶音，留白
  2.4–9.6   首页/现金流  主旋律入场，鼓点克制
  9.6–19.2  选标的      加花，节奏走起来
  19.2–28.8 对局        B 段旋律，高八度
  28.8–31.2 转折        骤停，只剩低音与 pad
  31.2–43.2 拆信封/成绩  全编制回归
  43.2–55.2 巅峰对决     高潮
  55.2–60.4 片尾        收束、淡出
"""

import array
import math
import os
import random
import struct
import wave
from pathlib import Path

SR = 44100
BPM = 100.0
SPB = 60.0 / BPM          # 一拍 0.6s
BAR = 4 * SPB             # 一小节 2.4s
TOTAL = 60.45
N = int(TOTAL * SR)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'vlog' / 'audio' / 'vlog-audio.wav'

rng = random.Random(20261021)


# ---------------------------------------------------------------- 基础工具

def buf():
    """全零单声道缓冲区（array('f') 省内存）"""
    return array.array('f', bytes(4 * N))


def mtof(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def tone(b, t0, dur, midi, amp, kind='sq', duty=0.5, atk=0.006,
         dec=0.0, rel=0.03, vib=0.0):
    """往缓冲区叠加一个音符"""
    i0 = int(t0 * SR)
    if i0 >= N or dur <= 0:
        return
    n = min(int(dur * SR), N - i0)
    f = mtof(midi)
    ph = 0.0
    for i in range(n):
        t = i / SR
        e = min(1.0, t / atk) if atk > 0 else 1.0
        if dec:
            e *= math.exp(-t * dec)
        left = dur - t
        if left < rel:
            e *= max(0.0, left / rel)
        if e < 1e-4 and t > atk:
            break
        fr = f * (1.0 + vib * math.sin(2 * math.pi * 5.2 * t))
        ph += fr / SR
        p = ph % 1.0
        if kind == 'sq':
            s = 1.0 if p < duty else -1.0
        elif kind == 'tri':
            s = 4.0 * abs(p - 0.5) - 1.0
        elif kind == 'sine':
            s = math.sin(2 * math.pi * ph)
        else:                                   # saw
            s = 2.0 * p - 1.0
        b[i0 + i] += s * e * amp


def kick(b, t0, amp=0.75):
    i0 = int(t0 * SR)
    n = min(int(0.30 * SR), N - i0)
    ph = 0.0
    for i in range(n):
        t = i / SR
        fr = 46.0 + 118.0 * math.exp(-t * 26.0)
        ph += fr / SR
        e = math.exp(-t * 9.0) * min(1.0, t / 0.002)
        b[i0 + i] += math.sin(2 * math.pi * ph) * e * amp


def snare(b, t0, amp=0.30):
    i0 = int(t0 * SR)
    n = min(int(0.22 * SR), N - i0)
    prev = 0.0
    ph = 0.0
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 22.0)
        x = rng.uniform(-1, 1)
        hp = x - prev * 0.55                    # 粗略高通，去掉闷响
        prev = x
        ph += 196.0 / SR
        body = math.sin(2 * math.pi * ph) * 0.45
        b[i0 + i] += (hp * 0.72 + body) * e * amp


def hat(b, t0, amp=0.10, dur=0.05):
    i0 = int(t0 * SR)
    n = min(int(dur * SR), N - i0)
    prev = 0.0
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 78.0)
        x = rng.uniform(-1, 1)
        hp = x - prev
        prev = x
        b[i0 + i] += hp * e * amp


def crash(b, t0, amp=0.30):
    i0 = int(t0 * SR)
    n = min(int(1.1 * SR), N - i0)
    prev = 0.0
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 3.4)
        x = rng.uniform(-1, 1)
        hp = x - prev * 0.2
        prev = x
        b[i0 + i] += hp * e * amp


def sweep(b, t0, dur, f0, f1, amp=0.16):
    """噪声扫频，用作转场"""
    i0 = int(t0 * SR)
    n = min(int(dur * SR), N - i0)
    prev = 0.0
    for i in range(n):
        t = i / SR
        k = t / dur
        e = math.sin(math.pi * k) ** 1.4
        x = rng.uniform(-1, 1)
        fc = f0 + (f1 - f0) * k
        a = 1.0 - math.exp(-2 * math.pi * fc / SR)
        prev += a * (x - prev)
        b[i0 + i] += prev * e * amp


# ---------------------------------------------------------------- 和声

# 每小节一个和弦：Am – F – C – G
CHORDS = [
    dict(bass=45, triad=[69, 72, 76]),     # Am
    dict(bass=41, triad=[65, 69, 72]),     # F
    dict(bass=48, triad=[72, 76, 79]),     # C
    dict(bass=43, triad=[67, 71, 74]),     # G
]

# 主旋律 A：4 小节一个循环
MEL_A = [
    (0.0, .5, 76), (0.5, .5, 79), (1.0, 1.0, 81), (2.0, .5, 79), (2.5, .5, 76), (3.0, 1.0, 74),
    (4.0, .5, 72), (4.5, .5, 74), (5.0, 1.0, 76), (6.0, .5, 74), (6.5, .5, 72), (7.0, 1.0, 69),
    (8.0, .5, 67), (8.5, .5, 69), (9.0, 1.0, 72), (10.0, .5, 76), (10.5, .5, 79), (11.0, 1.0, 81),
    (12.0, .5, 71), (12.5, .5, 74), (13.0, 1.0, 76), (14.0, 1.0, 74), (15.0, 1.0, 71),
]

# 主旋律 B：更高、更推进
MEL_B = [
    (0.0, 1.0, 81), (1.0, .5, 79), (1.5, .5, 76), (2.0, 1.5, 79), (3.5, .5, 81),
    (4.0, 1.0, 84), (5.0, .5, 81), (5.5, .5, 79), (6.0, 1.5, 76), (7.5, .5, 72),
    (8.0, 1.0, 79), (9.0, .5, 81), (9.5, .5, 84), (10.0, 1.0, 81), (11.0, 1.0, 79),
    (12.0, 1.0, 76), (13.0, .5, 74), (13.5, .5, 76), (14.0, 2.0, 74),
]


# ---------------------------------------------------------------- 编曲

lead = buf()
bass = buf()
arp = buf()
pad = buf()
drum = buf()
fx = buf()


def play_melody(b, bar0, mel, gain=0.20, octave=0):
    for (bt, dur, m) in mel:
        t = bar0 * BAR + bt * SPB
        tone(b, t, dur * SPB * 0.95, m + octave, gain, 'sq', duty=.5,
             atk=.008, dec=.55, rel=.05, vib=.0035)
        # 加一层正弦垫，削掉方波的毛刺
        tone(b, t, dur * SPB * 0.95, m + octave, gain * 0.42, 'sine',
             atk=.012, dec=.9, rel=.06)


def play_bass(bar, pattern, gain=0.30):
    ch = CHORDS[bar % 4]
    for k, off in enumerate(pattern):
        tone(bass, bar * BAR + k * SPB / 2, SPB * 0.44, ch['bass'] + off,
             gain, 'tri', atk=.004, dec=2.6, rel=.03)


def play_arp(bar, gain=0.075):
    ch = CHORDS[bar % 4]
    seq = [0, 1, 2, 1, 2, 1, 0, 1]
    for k in range(8):
        m = ch['triad'][seq[k]] + (12 if k % 4 == 3 else 0)
        tone(arp, bar * BAR + k * SPB / 2, SPB * 0.34, m, gain, 'sq',
             duty=.18, atk=.003, dec=7.0, rel=.02)


def play_pad(bar, gain=0.06):
    ch = CHORDS[bar % 4]
    for m in ch['triad']:
        tone(pad, bar * BAR, BAR * 1.05, m - 12, gain, 'sq', duty=.12,
             atk=.35, dec=0.25, rel=.5)


def play_drums(bar, level=1.0):
    b0 = bar * BAR
    kick(drum, b0, 0.80 * level)
    kick(drum, b0 + 2 * SPB, 0.70 * level)
    if bar % 2 == 1:
        kick(drum, b0 + 3.5 * SPB, 0.55 * level)
    for beat in (1, 3):
        snare(drum, b0 + beat * SPB, 0.30 * level)
    for k in range(8):
        hat(drum, b0 + k * SPB / 2, 0.085 * level if k % 2 else 0.055 * level)


BASE = [0, 0, 12, 0, 7, 0, 12, 7]
VAR = [0, 12, 0, 7, 12, 0, 7, 12]

# 小节 0：片头，只留 pad 与稀疏琶音
play_pad(0, 0.075)
for k in range(4):
    tone(arp, k * SPB, SPB * 0.5, CHORDS[k % 4]['triad'][0] + 12, 0.05, 'sq',
         duty=.2, atk=.02, dec=3.0, rel=.08)

# 小节 1–3：主旋律入场
for bar in range(1, 4):
    play_bass(bar, BASE)
    play_arp(bar, 0.05)
    play_drums(bar, 0.55)
    play_pad(bar, 0.045)
play_melody(lead, 1, MEL_A[0:12], 0.19)

# 小节 4–7：全编制，主旋律 A 走完
for bar in range(4, 8):
    play_bass(bar, BASE)
    play_arp(bar, 0.075)
    play_drums(bar, 1.0)
    play_pad(bar, 0.04)
crash(drum, 4 * BAR, 0.26)
play_melody(lead, 4, MEL_A, 0.20)

# 小节 8–11：B 段
for bar in range(8, 12):
    play_bass(bar, VAR)
    play_arp(bar, 0.08)
    play_drums(bar, 1.0)
    play_pad(bar, 0.04)
crash(drum, 8 * BAR, 0.28)
play_melody(lead, 8, MEL_B, 0.20)

# 小节 12：骤停
play_pad(12, 0.085)
tone(bass, 12 * BAR, BAR * 0.9, CHORDS[0]['bass'], 0.28, 'tri', atk=.01, dec=1.1, rel=.2)
tone(lead, 12 * BAR + 0.1, BAR * 0.8, 81, 0.15, 'sq', duty=.5, atk=.02, dec=.9, rel=.25, vib=.004)
tone(lead, 12 * BAR + 0.1, BAR * 0.8, 81, 0.06, 'sine', atk=.02, dec=.9, rel=.25)

# 小节 13–16：回归
for bar in range(13, 17):
    play_bass(bar, BASE)
    play_arp(bar, 0.075)
    play_drums(bar, 1.0)
    play_pad(bar, 0.04)
crash(drum, 13 * BAR, 0.26)
play_melody(lead, 13, MEL_A, 0.20)

# 小节 17–22：高潮
for bar in range(17, 23):
    play_bass(bar, VAR if bar >= 19 else BASE)
    play_arp(bar, 0.085)
    play_drums(bar, 1.05)
    play_pad(bar, 0.045)
crash(drum, 17 * BAR, 0.30)
play_melody(lead, 17, MEL_B, 0.21)
play_melody(lead, 21, MEL_A, 0.21)

# 小节 23：抽稀
play_pad(23, 0.075)
for k in range(4):
    tone(arp, 23 * BAR + k * SPB, SPB * 0.45, CHORDS[3]['triad'][k % 3] + 12,
         0.055, 'sq', duty=.2, atk=.01, dec=2.4, rel=.06)

# 小节 24：收尾
play_pad(24, 0.085)
tone(bass, 24 * BAR, BAR * 0.95, 45, 0.26, 'tri', atk=.01, dec=.55, rel=.5)
tone(lead, 24 * BAR, BAR * 0.8, 81, 0.16, 'sq', duty=.5, atk=.02, dec=.5, rel=.4, vib=.004)
tone(lead, 24 * BAR, BAR * 0.8, 81, 0.06, 'sine', atk=.02, dec=.5, rel=.4)
tone(lead, 24 * BAR + 0.06, BAR * 0.7, 76, 0.10, 'sq', duty=.5, atk=.02, dec=.6, rel=.4)
crash(drum, 24 * BAR, 0.18)


# ---------------------------------------------------------------- 音效

def sfx_click(t, g=1.0):
    tone(fx, t, 0.045, 88, 0.14 * g, 'sq', duty=.35, atk=.001, dec=60, rel=.005)
    tone(fx, t, 0.03, 95, 0.06 * g, 'sine', atk=.001, dec=80)


def sfx_blip(t, g=1.0):
    tone(fx, t, 0.07, 84, 0.10 * g, 'sq', duty=.25, atk=.001, dec=34, rel=.01)
    tone(fx, t + 0.07, 0.11, 91, 0.09 * g, 'sq', duty=.25, atk=.001, dec=22, rel=.02)


def sfx_coin(t, g=1.0):
    tone(fx, t, 0.06, 95, 0.10 * g, 'sq', duty=.5, atk=.001, dec=40)
    tone(fx, t + 0.055, 0.16, 100, 0.10 * g, 'sq', duty=.5, atk=.001, dec=14)


def sfx_paper(t, g=1.0):
    """拆信封：纸的摩擦 + 上行琶音"""
    i0 = int(t * SR)
    n = min(int(0.34 * SR), N - i0)
    prev = 0.0
    for i in range(n):
        tt = i / SR
        e = math.exp(-tt * 7.0) * min(1.0, tt / 0.01)
        x = rng.uniform(-1, 1)
        hp = x - prev * 0.75
        prev = x
        fx[i0 + i] += hp * e * 0.13 * g
    for k, m in enumerate([81, 84, 88, 93]):
        tone(fx, t + 0.16 + k * 0.055, 0.30, m, 0.075 * g, 'tri', atk=.004, dec=8, rel=.08)


def sfx_chime(t, g=1.0):
    for k, m in enumerate([81, 88, 93, 96]):
        tone(fx, t + k * 0.075, 0.85, m, 0.085 * g, 'tri', atk=.004, dec=3.6, rel=.3)
        tone(fx, t + k * 0.075, 0.85, m, 0.030 * g, 'sine', atk=.004, dec=3.6, rel=.3)


def sfx_whoosh(t, g=1.0, up=False):
    if up:
        sweep(fx, t, 0.5, 300, 5200, 0.13 * g)
    else:
        sweep(fx, t, 0.5, 4200, 260, 0.12 * g)


# 时间点与画面切换对齐（见 publish-video.mjs 的 TIMELINE）
sfx_whoosh(2.50, 0.9, up=True)
sfx_click(5.36, 0.7)
sfx_click(8.40, 0.7)
sfx_click(14.80, 0.85)
sfx_coin(14.92, 0.55)
sfx_blip(20.86, 0.7)
sfx_whoosh(30.06, 0.75)
sfx_click(30.16, 0.5)
sfx_paper(33.46, 0.9)
sfx_click(38.92, 0.6)
sfx_click(42.94, 0.85)
sfx_coin(43.06, 0.5)
sfx_chime(52.32, 0.8)
sfx_chime(57.02, 0.4)


# ---------------------------------------------------------------- 混音

def delay_into(dst, src, dt, gain, start=0):
    off = int(dt * SR)
    n = N - off
    for i in range(start, n):
        v = src[i] * gain
        if v:
            dst[i + off] += v


# 段落音量：让整首有起伏，而不是一堵墙
SECTIONS = [
    (0 * BAR, 0.55),    # 片头留白
    (1 * BAR, 0.70),    # 入场
    (4 * BAR, 0.86),    # 选标的
    (8 * BAR, 0.92),    # 对局
    (12 * BAR, 0.62),   # 骤停
    (13 * BAR, 0.92),   # 成绩单
    (17 * BAR, 1.00),   # 对决高潮
    (23 * BAR, 0.72),   # 收束
    (24 * BAR, 0.78),
    (TOTAL, 0.78),
]


def sec_gain(i):
    t = i / SR
    prev_t, prev_g = SECTIONS[0]
    if t <= prev_t:
        return prev_g
    for t1, g1 in SECTIONS[1:]:
        if t < t1:
            k = min(1.0, (t - prev_t) / 0.28)        # 0.28s 过渡
            return prev_g + (g1 - prev_g) * k
        prev_t, prev_g = t1, g1
    return prev_g


L = buf()
R = buf()

for i in range(N):
    m = (lead[i] * 0.86 + bass[i] * 0.70 + arp[i] * 0.38 +
         pad[i] * 0.50 + drum[i] * 0.50 + fx[i] * 0.85) * sec_gain(i)
    L[i] = m
    R[i] = m

# 主旋律乒乓延时，给单声道方波一点空间感
for k, (dt, g) in enumerate([(0.30, 0.20), (0.60, 0.11), (0.90, 0.06)]):
    dst = L if k % 2 == 0 else R
    delay_into(dst, lead, dt, g)

# 淡入淡出
fade_in = int(0.35 * SR)
fade_out = int(2.2 * SR)
for i in range(fade_in):
    g = i / fade_in
    L[i] *= g
    R[i] *= g
for i in range(fade_out):
    g = 1.0 - i / fade_out
    j = N - fade_out + i
    L[j] *= g
    R[j] *= g

peak = max(max(abs(v) for v in L), max(abs(v) for v in R))
scale = 0.89 / peak if peak else 1.0
rms = math.sqrt(sum(v * v for v in L[::7]) / len(L[::7])) * scale

OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frame = array.array('h', bytes(4 * N))
    for i in range(N):
        a = int(max(-1.0, min(1.0, L[i] * scale)) * 32767)
        b = int(max(-1.0, min(1.0, R[i] * scale)) * 32767)
        frame[2 * i] = a
        frame[2 * i + 1] = b
    w.writeframes(frame.tobytes())

kb = OUT.stat().st_size / 1024
print(f'✓ {OUT.relative_to(ROOT)}  {kb:.0f} KB  {TOTAL:.2f}s  peak {peak * scale:.2f}  rms {rms:.3f}')
