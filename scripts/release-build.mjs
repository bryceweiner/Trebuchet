import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appleApiKeyContents,
  builderEnvironment,
  collectFiles,
  electronBuilderInvocation,
  macSignatureChecks,
  resolveReleaseBuild,
} from './release-lib.mjs';

const target = process.env.TREBUCHET_RELEASE_TARGET;

if (!target) {
  throw new Error('TREBUCHET_RELEASE_TARGET is required.');
}

const plan = resolveReleaseBuild(target, process.env);
const projectRoot = process.cwd();
const distDir = path.join(projectRoot, 'dist');
const metadataDir = path.join(distDir, 'release-metadata');

await rm(distDir, { force: true, recursive: true });

// electron-builder downloads helper tools (e.g. the icons bundle's
// icon-tool.js, used to build the AppImage icon set) into its cache and
// runs them with node. Those tools are CommonJS. If the cache directory
// lives INSIDE this project — as it does when CI points
// ELECTRON_BUILDER_CACHE at the workspace so actions/cache can persist it
// — node walks up to our package.json, sees "type": "module", and refuses
// to run them ("require is not defined in ES module scope"). That failed
// release 1.0.49. Dropping a package.json that declares "commonjs" at the
// top of the cache dir makes it the nearest ancestor for everything below,
// so the tools run under the module system they were written for.
// Harmless when the cache is elsewhere (nothing under the project to
// shadow). The workflows ALSO move the cache out of the workspace; this is
// the second layer in case a workflow edit points it back inside.
{
  const cacheDir = process.env.ELECTRON_BUILDER_CACHE;
  const rel = cacheDir ? path.relative(projectRoot, path.resolve(cacheDir)) : null;
  const insideProject = rel !== null && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideProject) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, 'package.json'),
      JSON.stringify({
        type: 'commonjs',
        comment: 'Written by scripts/release-build.mjs so electron-builder\'s downloaded CommonJS tools run correctly under this ESM project. Safe to delete; it is recreated on every build.',
      }, null, 2) + '\n',
    );
    console.log(`[release-build] marked ${rel} as CommonJS scope for electron-builder tools`);
  }
}

const env = builderEnvironment(plan.target, process.env);

// notarytool reads the App Store Connect key from a file; see
// appleApiKeyContents. Removed again as soon as electron-builder exits.
const apiKeyContents = plan.target.startsWith('macos-') ? appleApiKeyContents(env) : null;
const apiKeyDir = apiKeyContents ? await mkdtemp(path.join(os.tmpdir(), 'trebuchet-notary-')) : null;
if (apiKeyDir) {
  env.APPLE_API_KEY = path.join(apiKeyDir, 'AuthKey.p8');
  await writeFile(env.APPLE_API_KEY, apiKeyContents.endsWith('\n') ? apiKeyContents : `${apiKeyContents}\n`, {
    mode: 0o600,
  });
}

const invocation = electronBuilderInvocation(plan.builderArgs);
const result = spawnSync(invocation.command, invocation.args, {
  cwd: projectRoot,
  env,
  shell: invocation.shell,
  stdio: 'inherit',
});

if (apiKeyDir) {
  await rm(apiKeyDir, { force: true, recursive: true });
}

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const builtFiles = await collectFiles(distDir);
const artifactPaths = builtFiles.filter((file) =>
  plan.expectedFiles.some((expected) => expected.matches(path.basename(file))),
);

for (const expected of plan.expectedFiles) {
  if (!artifactPaths.some((file) => expected.matches(path.basename(file)))) {
    throw new Error(`Missing ${expected.description} for ${plan.label}.`);
  }
}

// The release notes will say "signed and notarized", so prove it first on
// the unpacked app electron-builder leaves at dist/mac*/<name>.app.
if (plan.trust === 'signed and notarized') {
  const apps = [];
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('mac')) {
      for (const inner of await readdir(path.join(distDir, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory() && inner.name.endsWith('.app')) {
          apps.push(path.join(distDir, entry.name, inner.name));
        }
      }
    }
  }
  if (apps.length === 0) {
    throw new Error(`No .app found under dist/ to verify for ${plan.label}.`);
  }
  for (const appPath of apps) {
    for (const [command, args] of macSignatureChecks(appPath)) {
      const check = spawnSync(command, args, { stdio: 'inherit' });
      if (check.status !== 0) {
        throw new Error(
          `${command} ${args[0]} rejected ${path.relative(projectRoot, appPath)}; refusing to publish it as signed and notarized.`,
        );
      }
    }
  }
}

await mkdir(metadataDir, { recursive: true });

const metadata = {
  target: plan.target,
  label: plan.label,
  trust: plan.trust,
  files: artifactPaths.map((file) => path.basename(file)).sort(),
};

await writeFile(path.join(metadataDir, `${plan.target}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
