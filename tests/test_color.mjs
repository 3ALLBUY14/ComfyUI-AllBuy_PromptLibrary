// 随机取色自检：node tests/test_color.mjs
// 校验 randomColor() 输出格式、饱和/亮度区间、全色相覆盖与离散度
import { randomColor, COLOR_PRESETS } from "../web/editor_dialog.js";
import assert from "node:assert";

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, s * 100, l * 100];
}

const N = 500;
const colors = Array.from({ length: N }, randomColor);

for (const c of colors) assert.match(c, /^#[0-9A-F]{6}$/, "格式必须是 #RRGGBB");
for (const c of colors) {
  const [h, s, l] = hexToHsl(c);
  assert.ok(s >= 55 && s <= 81, `饱和度越界: ${c} s=${s.toFixed(1)}`);
  assert.ok(l >= 50 && l <= 69, `亮度越界: ${c} l=${l.toFixed(1)}`);
}
// 全色相覆盖：500 次采样应覆盖 6 个 60° 区间
const buckets = new Set(colors.map((c) => Math.floor(hexToHsl(c)[0] / 60)));
assert.equal(buckets.size, 6, `色相覆盖不足 6 区间: ${[...buckets]}`);
// 离散度：不应大量重复（真随机 360×22×16 空间内 500 次采样重复应极少）
assert.ok(new Set(colors).size > N * 0.9, `重复过多: ${new Set(colors).size}/${N}`);

// 对照：绝大多数随机色不应恰好落在 12 个预设上（预设是固定老色，用户明确要求跳出）
const presetHits = colors.filter((c) => COLOR_PRESETS.includes(c)).length;
assert.ok(presetHits <= N * 0.05, `命中预设过多: ${presetHits}/${N}`);

console.log(`randomColor 自检通过：${N} 次采样，去重 ${new Set(colors).size}，覆盖色相区间 ${buckets.size}/6，命中预设 ${presetHits}`);
