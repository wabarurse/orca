#!/bin/sh
orca2_install() (
  set -eu
  umask 022

  modify_path=yes
  case "${1-}" in
    '') ;;
    --no-modify-path) modify_path=no; shift ;;
    --help)
      echo 'usage: sh install.sh [--no-modify-path]'
      echo 'requires macOS or Linux, git, and Bun >= 1.4.2'
      echo 'installs ~/.orca2/.runtime/app and ~/.local/bin/orca2; keeps saved state in ~/.orca2'
      return ;;
    *) echo "orca2 install: unknown option: $1" >&2; exit 1 ;;
  esac
  [ "$#" -eq 0 ] || { echo 'orca2 install: too many arguments' >&2; exit 1; }
  for dependency in git bun; do
    command -v "$dependency" >/dev/null 2>&1 || {
      echo "orca2 install: missing $dependency; install it first (Bun: https://bun.sh)" >&2
      exit 1
    }
  done

  bun - <<'JS'
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
function fail(message) { console.error(`orca2 install: ${message}`); process.exit(1); }
if (!['darwin', 'linux'].includes(process.platform)) fail('requires macOS or Linux');
const [major, minor, patch] = Bun.version.split('.').map(Number);
if (!(major > 1 || major === 1 && (minor > 4 || minor === 4 && patch >= 2))) fail('Bun 1.4.2 or newer is required; upgrade Bun first');
if (!process.env.HOME) fail('HOME must be set');
const home = realpathSync(process.env.HOME);
for (const path of [home, join(home, '.orca2'), join(home, '.orca2', '.runtime'), join(home, '.local'), join(home, '.local', 'bin')]) {
  let s;
  try { s = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o022)
    fail(`unsafe directory: ${path}; must be owned by you, not a symlink, and not group/world writable`);
}
const app = join(home, '.orca2', '.runtime', 'app');
try { lstatSync(app); fail(`existing app at ${app}; use orca2 pull for updates`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const name of ['orca2', '.orca2-install.json']) {
  const path = join(home, '.local', 'bin', name);
  try { lstatSync(path); if (name === 'orca2') fail(`existing ${path} (a launcher you made yourself?); remove it, then run this again`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
JS

  mkdir -p -m 700 "$HOME/.orca2/.runtime"
  echo 'orca2 install: downloading the app…'
  GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch https://github.com/wabarurse/orca.git "$HOME/.orca2/.runtime/app"
  cd "$HOME/.orca2/.runtime/app/v2"
  bun install --frozen-lockfile
  bun run install:local

  if [ "$modify_path" = yes ]; then
    bun - <<'JS'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const home = process.env.HOME, shell = basename(process.env.SHELL || 'sh');
const profile = shell === 'zsh' ? join(process.env.ZDOTDIR || home, '.zshrc')
  : shell === 'bash' ? join(home, '.bashrc') : shell === 'sh' ? join(home, '.profile') : null;
const line = 'export PATH="$HOME/.local/bin:$PATH"';
try {
  if (!profile) throw new Error(`configure PATH in your ${shell} startup file`);
  const parent = lstatSync(dirname(profile));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o022)
    throw new Error(`inspect the directory containing ${profile} before editing it`);
  let before = '', exists = false;
  try {
    const s = lstatSync(profile);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o022)
      throw new Error(`inspect ${profile} before editing it`);
    before = readFileSync(profile, 'utf8'); exists = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!before.split('\n').some(value => value.trim() === line)) {
    writeFileSync(profile, `\n# orca2\n${line}\n`, { flag: exists ? 'a' : 'wx', mode: 0o644 });
    console.log(`orca2 install: added PATH to ${profile}`);
  }
} catch (error) {
  console.log(`orca2 install: ${error.message}; PATH was not changed. Add ~/.local/bin to PATH manually.`);
}
JS
  fi
  echo 'orca2 installed. For this terminal, run:'
  echo '  export PATH="$HOME/.local/bin:$PATH"'
  echo 'Then open your project directory and run: orca2'
  echo 'Existing settings, logins, bubbles and conversations are unchanged. Future updates: orca2 pull'
)

orca2_install "$@"
