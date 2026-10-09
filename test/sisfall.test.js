import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySisFallFile, parseSisFallFile, sisfallWindows } from '../tools/sisfall.js';

const line = (ax, ay, az) => `${ax};${ay};${az};0;0;0;`;

test('classifies SisFall filenames', () => {
  assert.deepEqual(classifySisFallFile('SA01-F01-05_1.txt'), { subject: 'SA01', activity: 'F01', kind: 'fall' });
  assert.deepEqual(classifySisFallFile('SE02-D12-03_2.txt'), { subject: 'SE02', activity: 'D12', kind: 'adl' });
  assert.equal(classifySisFallFile('mystery.txt').kind, null);
});

test('parses semicolon-separated lines with scaling and skips malformed ones', () => {
  const text = [line(256, -128, 0), '1;2;3', line(0, 256, 0), ''].join('\n');
  const parsed = parseSisFallFile('SA01-D01-01_1.txt', text);
  assert.equal(parsed.samples.length, 2);
  assert.equal(parsed.skippedLines, 1);
  assert.equal(parsed.samples[0].ax, 1);
  assert.equal(parsed.samples[0].ay, -0.5);
  assert.ok(Math.abs(parsed.samples[1].t - 1 / 200) < 1e-12);
});

test('fall fixture yields positive windows around the impact', () => {
  const lines = [];
  const hz = 200;
  for (let i = 0; i < 2 * hz; i += 1) lines.push(line(0, 256, 0)); // upright
  for (let i = 0; i < Math.round(0.4 * hz); i += 1) lines.push(line(0, 40, 0)); // free fall
  for (let i = 0; i < Math.round(0.1 * hz); i += 1) lines.push(line(0, 900, 0)); // impact spike (≈3.5 g)
  for (let i = 0; i < 2 * hz; i += 1) lines.push(line(256, 20, 0)); // lying (axis rotated 90°)
  const parsed = parseSisFallFile('SA01-F01-01_1.txt', lines.join('\n'));
  const windows = sisfallWindows(parsed);
  assert.ok(windows.length > 3, `windows ${windows.length}`);
  const positives = windows.filter((w) => w.label === 1);
  const negatives = windows.filter((w) => w.label === 0);
  assert.ok(positives.length >= 1, 'has positives');
  assert.ok(negatives.length >= 1, 'has negatives');
  assert.ok(positives.every((w) => w.tEnd > 1.5), 'positives cluster at the fall');
});

test('adl fixture is all-negative', () => {
  const lines = [];
  for (let i = 0; i < 4 * 200; i += 1) lines.push(line(0, 256, 0));
  const parsed = parseSisFallFile('SA01-D01-01_1.txt', lines.join('\n'));
  const windows = sisfallWindows(parsed);
  assert.ok(windows.length > 0);
  assert.ok(windows.every((w) => w.label === 0));
});
