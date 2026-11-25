// The three.js package the build places at dist/web/three: what games load their addons from, and what a harness
// turn's node_modules/three links to.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { tempDir, triangleGlb } from './helpers.ts';

const files = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll('\\', '/'),
    )
    .sort();

test('the build places three.js and every addon at dist/web/three, as a package of its own', () => {
  const upstream = JSON.parse(readFileSync('node_modules/three/package.json', 'utf8')) as Record<string, unknown> & {
    exports: Record<string, unknown>;
  };
  const manifest = JSON.parse(readFileSync('dist/web/three/package.json', 'utf8')) as Record<string, unknown>;
  assert.deepEqual(manifest, {
    name: 'three',
    version: upstream.version,
    license: 'MIT',
    type: 'module',
    main: upstream.main,
    module: upstream.module,
    exports: { '.': upstream.exports['.'], './addons/*': './examples/jsm/*' },
  });
  // The version is the exact pin in package.json.
  assert.equal(
    (JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> }).dependencies.three,
    upstream.version,
  );
  assert.deepEqual(files('dist/web/three/build'), ['three.cjs', 'three.core.js', 'three.module.js']);
  assert.deepEqual(readFileSync('dist/web/three/LICENSE'), readFileSync('node_modules/three/LICENSE'));
  // Every addon and decoder, and none of the docs.
  const addons = files('dist/web/three/examples/jsm');
  assert.deepEqual(
    addons,
    files('node_modules/three/examples/jsm').filter((file) => !file.endsWith('.md')),
  );
  for (const file of [
    'loaders/GLTFLoader.js',
    'loaders/DRACOLoader.js',
    'loaders/KTX2Loader.js',
    'libs/meshopt_decoder.module.js',
    'libs/draco/draco_decoder.js',
    'libs/draco/draco_decoder.wasm',
    'libs/draco/draco_wasm_wrapper.js',
    'libs/draco/gltf/draco_decoder.wasm',
    'libs/basis/basis_transcoder.js',
    'libs/basis/basis_transcoder.wasm',
  ])
    assert.ok(addons.includes(file), file);
});

test('Node resolves three and three/addons/... to the package, and both share one three', (t) => {
  const turn = tempDir(t, 'zirbel-three-');
  mkdirSync(join(turn, 'node_modules'));
  symlinkSync(resolve('dist/web/three'), join(turn, 'node_modules', 'three'), 'junction');
  const script = `
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    const glb = Buffer.from(process.argv[1], 'base64');
    const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), '');
    console.log(JSON.stringify({ revision: THREE.REVISION, mesh: gltf.scene.getObjectByName('Tri') instanceof THREE.Mesh,
      three: import.meta.resolve('three'), loader: import.meta.resolve('three/addons/loaders/GLTFLoader.js') }));`;
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script, triangleGlb().toString('base64')],
    { cwd: turn, encoding: 'utf8' },
  );
  const result = JSON.parse(output) as { revision: string; mesh: boolean; three: string; loader: string };
  const version = (JSON.parse(readFileSync('dist/web/three/package.json', 'utf8')) as { version: string }).version;
  assert.equal(result.revision, version.split('.')[1]);
  assert.equal(result.mesh, true, 'the addon builds its objects from the same three the game imports');
  assert.match(result.three, /\/dist\/web\/three\/build\/three\.module\.js$/);
  assert.match(result.loader, /\/dist\/web\/three\/examples\/jsm\/loaders\/GLTFLoader\.js$/);
});

test('a bundler resolves three and three/addons/... to the package, with one copy of three', async (t) => {
  const turn = tempDir(t, 'zirbel-three-bundle-');
  mkdirSync(join(turn, 'node_modules'));
  symlinkSync(resolve('dist/web/three'), join(turn, 'node_modules', 'three'), 'junction');
  const contents =
    "import * as THREE from 'three'; import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';" +
    'console.log(THREE.REVISION, GLTFLoader);';
  const { metafile } = await build({
    stdin: { contents, resolveDir: turn },
    bundle: true,
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const three = Object.keys(metafile.inputs).filter((file) => /\/three\/build\//.test(file.replaceAll('\\', '/')));
  assert.deepEqual(three.map((file) => file.replaceAll('\\', '/').replace(/^.*\/three\/build\//, '')).sort(), [
    'three.core.js',
    'three.module.js',
  ]);
  for (const file of three) assert.match(resolve(file).replaceAll('\\', '/'), /\/dist\/web\/three\/build\//);
});
