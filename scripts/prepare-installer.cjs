const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// Keep the stock installer, including signing/extraction/registry handling.
// Only replace its misleading generic retry dialog with our guarded recovery.
const originalHash = '97bd546b5cd2aaf16b77bc9e2be8a18962dd74ab5c4d23b35b163ca89bf4dd2a';
const replacements = [
  ['  OneMoreAttempt:\n', '  ; AUTHGATE_RECOVERY_REMOVED_UNUSED_RETRY_LABEL\n'],
  [
    '      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt\n      Return',
    '      Goto AuthGateRecoverOldInstallation ; AUTHGATE_RECOVERY_PATCH',
  ],
  [
    '  DoesNotExist:\n    SetErrors\nFunctionEnd',
    '  DoesNotExist:\n    StrCpy $R0 -1\n  AuthGateRecoverOldInstallation:\n    !insertmacro authgateRecoverOldInstallation\nFunctionEnd',
  ],
];
function patchInstaller(source) {
  let original = source.replace(/\r\n/g, '\n');
  for (const [before, after] of replacements) original = original.replace(after, before);
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  assert.equal(hash, originalHash, 'NSIS template changed: review the recovery integration before building.');
  for (const [before, after] of replacements) original = original.replace(before, after);
  return original;
}
if (require.main === module) {
  const root = path.dirname(require.resolve('app-builder-lib/package.json'));
  const template = path.join(root, 'templates/nsis/include/installUtil.nsh');
  fs.writeFileSync(template, patchInstaller(fs.readFileSync(template, 'utf8')));
  console.log('NSIS: recovery hook applied to the verified electron-builder template.');
}
module.exports = { patchInstaller };
