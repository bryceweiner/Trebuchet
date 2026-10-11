// Signs a published release's SHA256SUMS.txt with the maintainer's SSH key
// and attaches the signature as SHA256SUMS.txt.sig.
//
//   node scripts/sign-release.mjs v1.2.3 [--dry-run] [--repo owner/name]
//                                        [--allowed-signers path]
//
// The key is a Secretive key in the maintainer's Secure Enclave, so this
// can't run in CI: run it after the Release workflow has published. See
// "Signing a release" in docs/releasing.md.
//
// Nothing is signed until SHA256SUMS.txt has been matched against the
// SHA-256 GitHub reports for every attached asset, and nothing is uploaded
// until the signature verifies against docs/allowed_signers — the same
// check the release notes give users. --dry-run stops before the upload.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SIGNATURE_ASSET_NAME,
  SIGNATURE_NAMESPACE,
  checksumCoverageProblems,
  parseAllowedSigners,
  parseChecksumFile,
  releaseSignatureSection,
  withReleaseSignatureSection,
} from './release-lib.mjs';

const USAGE =
  'Usage: node scripts/sign-release.mjs <tag> [--dry-run] [--repo owner/name] [--allowed-signers path]';

// Secretive runs its own agent next to the system one instead of replacing
// it, so SSH_AUTH_SOCK alone may not reach the key.
const SECRETIVE_SOCKET = path.join(
  os.homedir(),
  'Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh',
);

function parseArgs(argv) {
  const args = { tag: null, repo: null, allowedSigners: 'docs/allowed_signers', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--repo' && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (arg === '--allowed-signers' && argv[i + 1]) {
      args.allowedSigners = argv[++i];
    } else if (!arg.startsWith('-') && !args.tag) {
      args.tag = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    }
  }
  if (!args.tag) {
    throw new Error(USAGE);
  }
  return args;
}

function originRepo() {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec((result.stdout || '').trim());
  if (!match) {
    throw new Error('Could not tell the GitHub repo from the origin remote; pass --repo owner/name.');
  }
  return match[1];
}

// The credential git already uses to push to github.com. Used for the
// upload when GH_TOKEN / GITHUB_TOKEN (the variables gh reads) are unset.
function gitCredentialToken() {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return /^password=(.+)$/m.exec(result.stdout || '')?.[1] ?? null;
}

async function github(url, { token, method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(new URL(url, 'https://api.github.com'), {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${url} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
  }
  return response;
}

async function downloadAsset(asset, token) {
  const response = await github(asset.url, { token, headers: { Accept: 'application/octet-stream' } });
  return Buffer.from(await response.arrayBuffer());
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function agentHolding(key) {
  const sockets = [...new Set([process.env.SSH_AUTH_SOCK, SECRETIVE_SOCKET])].filter(
    (socket) => socket && existsSync(socket),
  );
  for (const socket of sockets) {
    const listed = spawnSync('ssh-add', ['-L'], {
      encoding: 'utf8',
      env: { ...process.env, SSH_AUTH_SOCK: socket },
    });
    if ((listed.stdout || '').split('\n').some((line) => line.split(/\s+/)[1] === key)) {
      return socket;
    }
  }
  return null;
}

function run(command, args, { input, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    input,
    env,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} exited with status ${result.status}.`);
  }
}

const args = parseArgs(process.argv.slice(2));
const repo = args.repo || originRepo();

if (!existsSync(args.allowedSigners)) {
  throw new Error(`${args.allowedSigners} not found. Set up the signing key first: see "Signing a release" in docs/releasing.md.`);
}

// Sign with whichever listed key an agent can reach, so a rotated-out key
// can stay listed (keeping old releases verifiable) without being used.
let signer = null;
let agentSocket = null;
for (const candidate of parseAllowedSigners(await readFile(args.allowedSigners, 'utf8'))) {
  agentSocket = agentHolding(candidate.key);
  if (agentSocket) {
    signer = candidate;
    break;
  }
}
if (!signer) {
  throw new Error(`No key in ${args.allowedSigners} is available from ssh-agent or Secretive. Is Secretive running?`);
}

// Resolved before signing so a missing token can't waste a Touch ID approval.
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (args.dryRun ? null : gitCredentialToken());
if (!args.dryRun && !token) {
  throw new Error('Uploading needs a GitHub token: set GH_TOKEN, or store a github.com credential for git.');
}

const release = await (await github(`/repos/${repo}/releases/tags/${encodeURIComponent(args.tag)}`, { token })).json();
const checksumAsset = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt');
if (!checksumAsset) {
  throw new Error(`${repo} ${args.tag} has no SHA256SUMS.txt attached.`);
}
const checksums = await downloadAsset(checksumAsset, token);
const entries = parseChecksumFile(checksums.toString('utf8'));

// GitHub reports a SHA-256 for each uploaded asset, which saves pulling
// ~1 GB of installers back down. Assets uploaded before GitHub reported
// digests are downloaded and hashed instead.
const assetDigests = new Map();
for (const asset of release.assets) {
  let digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1];
  if (!digest) {
    console.log(`[sign-release] GitHub reports no digest for ${asset.name}; downloading it to hash`);
    digest = sha256(await downloadAsset(asset, token));
  }
  assetDigests.set(asset.name, digest);
}

if (assetDigests.get('SHA256SUMS.txt') !== sha256(checksums)) {
  throw new Error('The SHA256SUMS.txt just downloaded does not match the digest GitHub reports for it.');
}
const problems = checksumCoverageProblems(entries, assetDigests);
if (problems.length > 0) {
  throw new Error(`Refusing to sign ${args.tag}:\n  ${problems.join('\n  ')}`);
}
console.log(`[sign-release] SHA256SUMS.txt matches all ${entries.length} files on ${repo} ${args.tag}`);

const workDir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-sign-'));
try {
  const checksumPath = path.join(workDir, 'SHA256SUMS.txt');
  const signaturePath = `${checksumPath}.sig`;
  const keyPath = path.join(workDir, 'signing-key.pub');
  await writeFile(checksumPath, checksums);
  await writeFile(keyPath, `${signer.keyType} ${signer.key}\n`);

  // Given a public key, ssh-keygen has the agent do the signing.
  console.log(`[sign-release] signing as ${signer.principals[0]}; approve the request if Secretive asks`);
  run('ssh-keygen', ['-Y', 'sign', '-f', keyPath, '-n', SIGNATURE_NAMESPACE, checksumPath], {
    env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
  });
  run(
    'ssh-keygen',
    ['-Y', 'verify', '-f', args.allowedSigners, '-I', signer.principals[0], '-n', SIGNATURE_NAMESPACE, '-s', signaturePath],
    { input: checksums },
  );

  if (args.dryRun) {
    console.log('[sign-release] dry run: signature verified, nothing uploaded');
  } else {
    const previous = release.assets.find((asset) => asset.name === SIGNATURE_ASSET_NAME);
    if (previous) {
      await github(`/repos/${repo}/releases/assets/${previous.id}`, { token, method: 'DELETE' });
    }
    const uploadUrl = new URL(release.upload_url.replace(/\{.*\}$/, ''));
    uploadUrl.searchParams.set('name', SIGNATURE_ASSET_NAME);
    await github(uploadUrl.href, {
      token,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: await readFile(signaturePath),
    });

    const body = withReleaseSignatureSection(
      release.body,
      releaseSignatureSection({ repo, tagName: args.tag, principal: signer.principals[0] }),
    );
    await github(`/repos/${repo}/releases/${release.id}`, {
      token,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log(`[sign-release] attached ${SIGNATURE_ASSET_NAME} to ${release.html_url}`);
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
