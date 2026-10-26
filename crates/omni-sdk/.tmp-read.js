// 临时工具：按行号区间打印工作区外的 TS 源文件（UTF-8 输出）
const fs = require('node:fs');
const [file, startRaw, endRaw] = process.argv.slice(2);
const start = Number(startRaw || 1);
const end = Number(endRaw || start + 60);
const lines = fs.readFileSync(file, 'utf8').split('\n');
for (let i = start; i <= Math.min(end, lines.length); i++) console.log(`${i}: ${lines[i - 1]}`);
