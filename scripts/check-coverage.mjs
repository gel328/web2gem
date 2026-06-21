import { readFile } from "node:fs/promises";
import { relative } from "node:path";

const summaryPath = process.argv[2] || "coverage/coverage-summary.json";

const lineGates = [
  ["src/completion", 83],
  ["src/config", 96],
  ["src/gemini", 78],
  ["src/gemini/client", 67],
  ["src/gemini/transport", 83],
  ["src/gemini/uploads", 90],
  ["src/http/core", 92],
  ["src/http/google", 82],
  ["src/http/openai", 77],
  ["src/http/openai/responses-stream.ts", 88],
  ["src/http/stream", 100],
  ["src/models", 64],
  ["src/promptcompat", 85],
  ["src/promptcompat/history.ts", 97],
  ["src/promptcompat/responses-input.ts", 91],
  ["src/shared", 59],
  ["src/toolcall", 68],
  ["src/toolstream", 58],
];

const branchGates = [
  ["src/http/openai", 54],
  ["src/http/openai/responses-stream.ts", 65],
  ["src/promptcompat", 57],
  ["src/promptcompat/history.ts", 67],
  ["src/promptcompat/responses-input.ts", 59],
  ["src/shared/tokens.ts", 42],
  ["src/toolcall/structured.ts", 55],
];

const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const cwd = process.cwd();

function normalizePath(path) {
  const rel = path.startsWith(cwd) ? relative(cwd, path) : path;
  return rel.split("\\").join("/");
}

function statsForDir(dir, metric) {
  let covered = 0;
  let total = 0;

  for (const [key, entry] of Object.entries(summary)) {
    if (key === "total") continue;
    const rel = normalizePath(key);
    if (!rel.startsWith(`${dir}/`)) continue;
    if (!entry || typeof entry !== "object" || !entry[metric]) continue;
    const stats = entry[metric];
    covered += Number(stats.covered || 0);
    total += Number(stats.total || 0);
  }

  return { covered, total, pct: total > 0 ? (covered / total) * 100 : 0 };
}

function statsForPath(path, metric) {
  let covered = 0;
  let total = 0;
  const normalizedPath = path.split("\\").join("/");

  for (const [key, entry] of Object.entries(summary)) {
    if (key === "total") continue;
    const rel = normalizePath(key);
    if (rel !== normalizedPath) continue;
    if (!entry || typeof entry !== "object" || !entry[metric]) continue;
    const stats = entry[metric];
    covered += Number(stats.covered || 0);
    total += Number(stats.total || 0);
  }

  return { covered, total, pct: total > 0 ? (covered / total) * 100 : 0 };
}

function statsForTarget(target, metric) {
  if (/\.tsx?$/.test(target)) return statsForPath(target, metric);
  return statsForDir(target, metric);
}

const failures = [];

for (const [target, threshold] of lineGates) {
  checkGate(target, threshold, "lines");
}

for (const [target, threshold] of branchGates) {
  checkGate(target, threshold, "branches");
}

function checkGate(target, threshold, metric) {
  const stats = statsForTarget(target, metric);
  const pct = Number(stats.pct.toFixed(2));
  const rendered = `${target}: ${pct.toFixed(2)}% ${metric} (${stats.covered}/${stats.total}), required ${threshold.toFixed(2)}%`;

  if (stats.total === 0) {
    failures.push(`${target}: missing ${metric} coverage data`);
    return;
  }

  if (pct + 0.001 < threshold) {
    failures.push(rendered);
    return;
  }

  console.log(`coverage ok: ${rendered}`);
}

if (failures.length) {
  console.error("Coverage gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Coverage gates passed");
