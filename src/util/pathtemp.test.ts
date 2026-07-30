/**
 * Tests for the pure-path helper that decides whether a directory lives inside
 * the OS temporary directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isInsideDir } from './pathtemp.ts';

// ---------------------------------------------------------------------------
// Positive cases — a child genuinely inside the parent
// ---------------------------------------------------------------------------

test('child deep inside temp dir is detected', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const child = 'C:\\Users\\richm\\AppData\\Local\\Temp\\forge-bench-20260726\\scratch\\A4\\repo';
  assert.equal(isInsideDir(child, temp), true);
});

test('child directly inside temp dir', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const child = 'C:\\Users\\richm\\AppData\\Local\\Temp\\my-project';
  assert.equal(isInsideDir(child, temp), true);
});

test('child IS the temp dir itself', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  assert.equal(isInsideDir(temp, temp), true);
});

test('unix-style temp', () => {
  const temp = '/tmp';
  const child = '/tmp/forge-bench-20260726/repo';
  assert.equal(isInsideDir(child, temp), true);
});

// ---------------------------------------------------------------------------
// Negative cases — a sibling, not a child
// ---------------------------------------------------------------------------

test('sibling that merely starts with same prefix is NOT inside', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const sibling = 'C:\\Users\\richm\\AppData\\Local\\Temp2\\repo';
  assert.equal(isInsideDir(sibling, temp), false);
});

test('real project path is NOT inside temp', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const project = 'C:\\Users\\richm\\OneDrive\\Desktop\\forge';
  assert.equal(isInsideDir(project, temp), false);
});

test('totally unrelated path', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const unrelated = 'D:\\projects\\my-app';
  assert.equal(isInsideDir(unrelated, temp), false);
});

test('parent dir of temp is NOT inside temp', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const parent = 'C:\\Users\\richm\\AppData\\Local';
  assert.equal(isInsideDir(parent, temp), false);
});

// ---------------------------------------------------------------------------
// Case-insensitivity
// ---------------------------------------------------------------------------

test('different letter case still matches', () => {
  const temp = 'C:\\Users\\RichM\\AppData\\Local\\Temp';
  const child = 'c:\\users\\richm\\appdata\\local\\temp\\forge-bench\\repo';
  assert.equal(isInsideDir(child, temp), true);
});

test('all-lowercase temp vs all-uppercase child matches', () => {
  const temp = 'c:\\users\\richm\\appdata\\local\\temp';
  const child = 'C:\\USERS\\RICHM\\APPDATA\\LOCAL\\TEMP\\PROJECT';
  assert.equal(isInsideDir(child, temp), true);
});

// ---------------------------------------------------------------------------
// Separator-insensitivity — mixed forward and back slashes
// ---------------------------------------------------------------------------

test('mixed forward and back slashes still match', () => {
  const temp = 'C:/Users/richm/AppData/Local/Temp';
  const child = 'C:\\Users\\richm\\AppData\\Local\\Temp\\forge-bench\\repo';
  assert.equal(isInsideDir(child, temp), true);
});

test('child with forward slashes, parent with backslashes', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const child = 'C:/Users/richm/AppData/Local/Temp/forge-bench/repo';
  assert.equal(isInsideDir(child, temp), true);
});

test('both paths use mixed slashes', () => {
  const temp = 'C:/Users\\richm/AppData\\Local/Temp';
  const child = 'C:\\Users/richm/AppData\\Local\\Temp\\project';
  assert.equal(isInsideDir(child, temp), true);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('temp dir with trailing slash still works', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp\\';
  const child = 'C:\\Users\\richm\\AppData\\Local\\Temp\\project';
  assert.equal(isInsideDir(child, temp), true);
});

test('child with trailing slash still works', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const child = 'C:\\Users\\richm\\AppData\\Local\\Temp\\project\\';
  assert.equal(isInsideDir(child, temp), true);
});

test('short temp like /tmp with sibling /tmp2', () => {
  const temp = '/tmp';
  const sibling = '/tmp2/project';
  assert.equal(isInsideDir(sibling, temp), false);
});

test('exact match with different slashes', () => {
  const temp = 'C:\\Users\\richm\\AppData\\Local\\Temp';
  const child = 'C:/Users/richm/AppData/Local/Temp';
  assert.equal(isInsideDir(child, temp), true);
});
