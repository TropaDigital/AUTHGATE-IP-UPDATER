const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { patchInstaller } = require('../scripts/prepare-installer.cjs');

test('installer recovery hook is idempotent and leaves unknown templates untouched', () => {
  const template = fs.readFileSync(path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include/installUtil.nsh'), 'utf8');
  const patched = patchInstaller(template);
  assert.equal(patchInstaller(patched), patched);
  assert.match(patched, /!insertmacro authgateRecoverOldInstallation/);
  assert.doesNotMatch(patched, /MessageBox.*\$\(appCannotBeClosed\)/);
  assert.throws(() => patchInstaller(template + '\nchanged'), /NSIS template changed/);
});
