#!/bin/sh
# Keep execution at the end so an incomplete download cannot start installation.
orca_install() (
  set -eu
  umask 022

  modify_path=yes
  case "${1-}" in
    '') ;;
    --no-modify-path) modify_path=no; shift ;;
    --help)
      echo 'usage: sh install.sh [--no-modify-path]'
      echo 'requires macOS or Linux, git, tmux, and Bun >= 1.4.2'
      echo 'installs ~/.orca/app and ~/.local/bin/orca; preserves saved state'
      return ;;
    *) echo "orca install: unknown option: $1" >&2; exit 1 ;;
  esac
  [ "$#" -eq 0 ] || { echo 'orca install: too many arguments' >&2; exit 1; }
  for dependency in git tmux bun; do
    command -v "$dependency" >/dev/null 2>&1 || {
      echo "orca install: missing $dependency; install it first (Bun: https://bun.sh, tmux: your package manager)" >&2
      exit 1
    }
  done

  # Check destinations before cloning. The existing local installer independently
  # validates the executable receipt and atomically publishes the finished build.
  bun - <<'JS'
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
function fail(message) { console.error(`orca install: ${message}`); process.exit(1); }
if (!['darwin', 'linux'].includes(process.platform)) fail('requires macOS or Linux');
const [major, minor, patch] = Bun.version.split('.').map(Number);
if (!(major > 1 || major === 1 && (minor > 4 || minor === 4 && patch >= 2))) fail('Bun 1.4.2 or newer is required; upgrade Bun first');
if (!process.env.HOME) fail('HOME must be set');
const home = realpathSync(process.env.HOME);
for (const path of [home, join(home, '.orca'), join(home, '.local'), join(home, '.local', 'bin')]) {
  let s;
  try { s = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o022)
    fail(`unsafe directory: ${path}; must be owned by you, not a symlink, and not group/world writable`);
}
const app = join(home, '.orca', 'app');
try { lstatSync(app); fail(`existing app at ${app}; use orca pull for updates, or see docs/REFERENCE.md#installer-ownership-and-recovery`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
JS

  mkdir -p "$HOME/.orca"
  echo 'orca install: downloading the app…'
  GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch https://github.com/wabarurse/parallels.git "$HOME/.orca/app"
  cd "$HOME/.orca/app"
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
    writeFileSync(profile, `\n# orca\n${line}\n`, { flag: exists ? 'a' : 'wx', mode: 0o644 });
    console.log(`orca install: added PATH to ${profile}`);
  }
} catch (error) {
  console.log(`orca install: ${error.message}; PATH was not changed. Add ~/.local/bin to PATH manually.`);
}
JS
  fi
  echo 'orca installed. For this terminal, run:'
  echo '  export PATH="$HOME/.local/bin:$PATH"'
  echo 'Then open your project directory and run: orca'
  echo 'Existing settings, logins, and conversations are unchanged. Future updates: orca pull'
)

orca_install "$@"
