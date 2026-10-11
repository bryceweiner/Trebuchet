import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SIGNATURE_ASSET_NAME,
  checksumCoverageProblems,
  parseAllowedSigners,
  parseChecksumFile,
  releaseSignatureSection,
  withReleaseSignatureSection,
  writeChecksumFile,
} from '../scripts/release-lib.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('checksum parser reads exactly what writeChecksumFile writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-sums-'));
  try {
    const mac = path.join(dir, 'Trebuchet-1.2.3-arm64.dmg');
    const win = path.join(dir, 'Trebuchet Setup 1.2.3.exe');
    await writeFile(mac, 'mac');
    await writeFile(win, 'win');
    const listing = path.join(dir, 'SHA256SUMS.txt');
    await writeChecksumFile(listing, [mac, win]);

    assert.deepEqual(parseChecksumFile(await readFile(listing, 'utf8')), [
      { digest: sha256('mac'), name: 'Trebuchet-1.2.3-arm64.dmg' },
      { digest: sha256('win'), name: 'Trebuchet Setup 1.2.3.exe' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checksum parser rejects anything it would be unsafe to sign', () => {
  assert.throws(() => parseChecksumFile(`${A}  app.dmg\r\n`), /line 1/);
  assert.throws(() => parseChecksumFile(`${A.slice(1)}  app.dmg\n`), /line 1/);
  assert.throws(() => parseChecksumFile(`${A} app.dmg\n`), /line 1/);
  assert.throws(() => parseChecksumFile(`${A}  app.dmg\n${B}  app.dmg\n`), /more than once/);
  assert.throws(() => parseChecksumFile('\n'), /empty/);
});

test('signing is refused unless SHA256SUMS.txt matches every attached asset', () => {
  const entries = [
    { digest: A, name: 'app.dmg' },
    { digest: B, name: 'app.exe' },
  ];
  // The listing and its signature are attached but never listed.
  const attached = (changes = {}) =>
    new Map(
      Object.entries({ 'app.dmg': A, 'app.exe': B, 'SHA256SUMS.txt': C, [SIGNATURE_ASSET_NAME]: C, ...changes }),
    );

  assert.deepEqual(checksumCoverageProblems(entries, attached()), []);
  assert.deepEqual(checksumCoverageProblems(entries, attached({ 'app.exe': A })), [
    'app.exe on the release does not match its SHA256SUMS.txt entry',
  ]);
  assert.deepEqual(checksumCoverageProblems(entries, attached({ 'extra.AppImage': C })), [
    'extra.AppImage is attached to the release but missing from SHA256SUMS.txt',
  ]);

  const missingExe = attached();
  missingExe.delete('app.exe');
  assert.deepEqual(checksumCoverageProblems(entries, missingExe), [
    'app.exe is listed in SHA256SUMS.txt but not attached to the release',
  ]);
});

test('allowed_signers entries yield the principals and key to sign with', () => {
  const key = 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBO';

  assert.deepEqual(
    parseAllowedSigners(
      [
        '# Trebuchet release signing',
        '',
        `me@example.com,alt@example.com namespaces="file,git" ecdsa-sha2-nistp256 ${key} comment`,
        `old@example.com ssh-ed25519 ${key}`,
      ].join('\n'),
    ),
    [
      { principals: ['me@example.com', 'alt@example.com'], keyType: 'ecdsa-sha2-nistp256', key },
      { principals: ['old@example.com'], keyType: 'ssh-ed25519', key },
    ],
  );
  assert.throws(() => parseAllowedSigners('me@example.com not-a-key'), /Unrecognised allowed_signers line/);
});

test('release notes gain one maintainer-signature section, replaced on re-signing', () => {
  const section = releaseSignatureSection({ repo: 'owner/Trebuchet', tagName: 'v1.2.3', principal: 'me@example.com' });

  assert.match(section, /releases\/download\/v1\.2\.3\/SHA256SUMS\.txt\.sig/);
  assert.match(section, /raw\.githubusercontent\.com\/owner\/Trebuchet\/main\/docs\/allowed_signers/);
  assert.match(
    section,
    /ssh-keygen -Y verify -f allowed_signers -I me@example\.com -n file -s SHA256SUMS\.txt\.sig < SHA256SUMS\.txt/,
  );

  const notes = '# v1.2.3\n\n## Verification\n\n- Verify checksums.\n';
  const signed = withReleaseSignatureSection(notes, section);
  assert.ok(signed.startsWith(notes.trimEnd()));
  assert.equal(withReleaseSignatureSection(signed, section), signed);
  assert.equal(signed.split('## Maintainer signature').length, 2);
  assert.equal(withReleaseSignatureSection(null, section), section);
});
