#!/usr/bin/env node
/**
 * Script de release OmniAgent
 * Usage : npm run release -- 0.2.0
 *
 * 1. Vérifie que le repo est propre et sur la branche principale
 * 2. Met à jour la version dans package.json, tauri.conf.json et Cargo.toml
 * 3. Commit + tag v<version> + push (le tag déclenche le build GitHub Actions
 *    pour Windows, Linux et macOS)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? ['pipe', 'pipe', 'pipe'] : 'inherit', ...opts });
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// ── 1. Argument de version ─────────────────────────────────────────
const version = process.argv[2];
if (!version) {
  fail('Usage : npm run release -- <version>   (ex: npm run release -- 0.2.0)');
}
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`Version invalide : "${version}" (format attendu : X.Y.Z ou X.Y.Z-beta.1)`);
}

const tag = `v${version}`;

// ── 2. Vérifications git ───────────────────────────────────────────
const branch = run('git rev-parse --abbrev-ref HEAD', { silent: true }).trim();
if (!['main', 'master'].includes(branch)) {
  console.warn(`⚠ Vous êtes sur la branche "${branch}" (pas main/master). Continuer quand même ? (Ctrl+C pour annuler)`);
}

const status = run('git status --porcelain', { silent: true }).trim();
if (status) {
  fail('Le repo contient des modifications non commitées. Committez ou stash avant de release.');
}

// Le tag ne doit pas déjà exister
const existingTags = run('git tag', { silent: true }).trim().split('\n');
if (existingTags.includes(tag)) {
  fail(`Le tag ${tag} existe déjà. Choisissez une autre version.`);
}

// ── 3. Mise à jour des fichiers de version ─────────────────────────
console.log(`\n🚀 Release OmniAgent ${tag}\n`);

// package.json
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  ✔ package.json → ${version}`);

// src-tauri/tauri.conf.json
const confPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log(`  ✔ src-tauri/tauri.conf.json → ${version}`);

// src-tauri/Cargo.toml (seulement la ligne version sous [package])
const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
let cargo = readFileSync(cargoPath, 'utf8');
cargo = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargoPath, cargo);
console.log(`  ✔ src-tauri/Cargo.toml → ${version}`);

// ── 4. Commit, tag, push ───────────────────────────────────────────
console.log('\n📦 Commit, tag et push…');
run('git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml');

// Si la version est déjà à jour, il n'y a rien à commit — ce n'est pas une erreur
const staged = run('git diff --cached --quiet || echo dirty', { silent: true }).trim();
if (staged === 'dirty') {
  run(`git commit -m "chore: release ${tag}"`);
} else {
  console.log('  ℹ Version déjà à jour, rien à commit.');
}

run(`git tag ${tag}`);
run('git push');
run(`git push origin ${tag}`);

console.log(`
✅ Release ${tag} lancée !

Le workflow GitHub Actions build maintenant les 3 plateformes :
  • Windows  → .msi / .exe (NSIS)
  • Linux    → .deb / .AppImage / .rpm
  • macOS    → .dmg (Apple Silicon + Intel)

Suivez le build : https://github.com/Clarco-Mada-digital/omniagent/actions
Le release apparaîtra sur : https://github.com/Clarco-Mada-digital/omniagent/releases
`);
