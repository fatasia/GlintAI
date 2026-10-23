import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutable, developmentEnvironment } from './dev.mjs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('uses an installed executable directly without a command shell', () => {
  assert.equal(resolveExecutable(process.execPath), realpathSync(process.execPath));
});

test('missing executable fails actionably', () => {
  assert.throws(() => resolveExecutable('glint-nonexistent-node-8452', { PATH: '' }), /Executable not found/);
});

test('rejects absent built UI and service before launching cargo', () => {
  assert.throws(() => developmentEnvironment(tmpdir()), /build the web UI first/);
});
