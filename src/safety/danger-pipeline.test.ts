/**
 * Read-only pipelines must not be treated as destructive.
 *
 * A real approval prompt demanded type-to-arm for
 * `npm test 2>&1 | Select-String -Pattern "fail|FAIL|Error" | Select-Object -First 20`
 * — a command that only reads. Two bugs combined: the segment splitter cut on
 * the `|` characters INSIDE the quoted regex, and `select-object` was missing
 * from the read-only heads. The result trained the highest-friction gate onto
 * an ordinary test run, which is how a safety control stops being read.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { assessCommand, splitCommandSegments } from './danger.ts';
import { deriveArmWord } from '../util/arm-word.ts';

describe('splitCommandSegments', () => {
  test('does not split on separators inside double quotes', () => {
    assert.deepEqual(splitCommandSegments('grep -e "a|b|c" file'), ['grep -e "a|b|c" file']);
  });

  test('does not split on separators inside single quotes', () => {
    assert.deepEqual(splitCommandSegments("echo 'a;b|c'"), ["echo 'a;b|c'"]);
  });

  test('still splits on real pipes, semicolons and && ||', () => {
    assert.deepEqual(splitCommandSegments('ls | wc -l'), ['ls', 'wc -l']);
    assert.deepEqual(splitCommandSegments('ls; pwd'), ['ls', 'pwd']);
    assert.deepEqual(splitCommandSegments('ls && pwd'), ['ls', 'pwd']);
    assert.deepEqual(splitCommandSegments('ls || pwd'), ['ls', 'pwd']);
  });

  test('treats || as one separator, not two empty splits', () => {
    assert.deepEqual(splitCommandSegments('a || b'), ['a', 'b']);
  });
});

describe('read-only pipelines are safe', () => {
  test('the reported npm test pipeline is safe, not dangerous', () => {
    const command =
      'npm test 2>&1 | Select-String -Pattern "fail|FAIL|Error|error" -CaseSensitive:$false | Select-Object -First 20';
    assert.equal(assessCommand(command).level, 'safe');
  });

  test('quoted pipes in a grep pattern do not make it unrecognised', () => {
    assert.equal(assessCommand('rg "foo|bar" src').level, 'safe');
  });

  test('read-only PowerShell stages are recognised', () => {
    assert.equal(assessCommand('git log | Select-Object -First 5').level, 'safe');
    assert.equal(assessCommand('ls | Sort-Object | Format-Table').level, 'safe');
  });
});

describe('genuinely risky commands are still caught', () => {
  test('a destructive command inside a pipeline is not laundered by quoting', () => {
    assert.notEqual(assessCommand('echo "safe|text" | rm -rf /').level, 'safe');
  });

  test('script-block cmdlets are not on the read-only list', () => {
    assert.notEqual(assessCommand('ls | ForEach-Object { rm $_ }').level, 'safe');
  });

  test('an unknown command is still caution, not safe', () => {
    assert.equal(assessCommand('frobnicate --wat').level, 'caution');
  });
});

describe('deriveArmWord', () => {
  test('skips bare numbers so the prompt never demands "type 20"', () => {
    assert.notEqual(deriveArmWord('npm test | Select-Object -First 20'), '20');
  });

  test('still returns a meaningful final token', () => {
    assert.equal(deriveArmWord('rm -rf build/dist'), 'dist');
  });
});
