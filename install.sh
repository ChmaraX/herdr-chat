#!/bin/sh
# herdr-chat's installer, for the Herdr desktop app:
#
#   curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app
#   ./install.sh                  in a clone: installs the clone, as it always has
#
#   install.sh [--app] [--uninstall] [--version X.Y.Z] [--from FILE|DIR] [options]
#
# The options (--no-layout, --no-subagents, --take-agents-slot, --take-menu)
# go to the installer, install/app.sh, which says what each does
# (install/app.sh --help); a `--` before them is fine too.
#
# In a clone (this file beside install/app.sh, no --version or --from): runs
# install/app.sh on the clone; the chat's host is the clone's bin/pi-chat-host.
#
# Otherwise a release, with no clone, no TypeScript and no npm install: it
# downloads herdr-chat-<version>.tar.gz and SHA256SUMS from the latest release
# (--version picks one), checks the archive's SHA-256, unpacks it to
# ~/.local/share/herdr-chat/<version> ($XDG_DATA_HOME if set), points
# `current` there, and runs that version's install/app.sh: the chat's host is
# current/bin/pi-chat-host. Run it again to update. --from takes a local
# archive (its SHA256SUMS beside it) or a folder of them instead of a download.
#
# --uninstall: from a clone, the clone's uninstall; otherwise the installed
# release's uninstall, then ~/.local/share/herdr-chat is removed.
set -eu

repo=ChmaraX/herdr-chat
one_liner="curl -fsSL https://raw.githubusercontent.com/$repo/main/install.sh | sh -s --"
base="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-chat"
uninstall= version= from= rest=
die() { echo "herdr-chat: $*" >&2; exit 1; }
say() { echo "herdr-chat: $*"; }

# Our own flags out; the installer's kept in "$@", in order.
n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  if [ -n "$rest" ]; then set -- "$@" "$a"; continue; fi
  case $a in
    --app) ;; # the only target: the Herdr app (gitview's and nvim's flag, for the same one-liner)
    --uninstall) uninstall=1 ;;
    --version|--from)
      [ "$n" -ge 1 ] || die "$a needs a value"
      if [ "$a" = --version ]; then version=${1#v}; else from=$1; fi
      shift; n=$((n - 1)) ;;
    --) rest=1 ;;
    -h|--help)
      if [ -f "$0" ]; then sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; else echo "see https://github.com/$repo#install"; fi
      exit 0 ;;
    *) set -- "$@" "$a" ;;
  esac
done

# --- a clone (or an unpacked release run in place) ------------------------------------
here=$(dirname "$0")
case $0 in *install.sh) local_tree=1 ;; *) local_tree= ;; esac
if [ -n "$local_tree" ] && [ -f "$here/install/app.sh" ] && [ -z "$version$from" ]; then
  [ ! -e "$base/current" ] || [ -n "$uninstall" ] ||
    say "a release install is in $base; this tree's install takes its place ($one_liner --uninstall removes that copy)"
  exec bash "$here/install/app.sh" ${uninstall:+--uninstall} "$@"
fi

# --- uninstall a release ----------------------------------------------------------------
if [ -n "$uninstall" ]; then
  [ -f "$base/current/install/app.sh" ] ||
    die "no release install in $base (installed from a clone? run ./install.sh --uninstall there)"
  HERDR_CHAT_ROOT="$base/current" HERDR_CHAT_LINK="$base/current" HERDR_CHAT_INSTALL_CMD="$one_liner" \
    bash "$base/current/install/app.sh" --uninstall "$@"
  rm -rf "$base"
  say "removed $base"
  exit 0
fi

# --- requirements, before any download ---------------------------------------------------
# install/app.sh checks the versions (Herdr's, node's) from the release's package.json.
command -v node >/dev/null 2>&1 || die "node not found: a release needs Node 20 or newer (https://nodejs.org)"
command -v hc >/dev/null 2>&1 || die "hc (herdr-core) not on PATH: it comes with the Herdr app (https://herdr.dev)"
app=${HERDR_APP_BIN:-$(command -v herdr-app 2>/dev/null || true)}
if [ -z "$app" ]; then
  for c in /Applications/*.app/Contents/MacOS/Herdr "$HOME"/Applications/*.app/Contents/MacOS/Herdr; do
    if [ -x "$c" ]; then app=$c; break; fi
  done
fi
[ -n "$app" ] || die "the Herdr app isn't installed (https://herdr.dev), or set HERDR_APP_BIN=/path/to/herdr-app"
command -v tar >/dev/null 2>&1 || die "tar not found"

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1
}

# --- the archive and its checksums into $work ---------------------------------------------
mkdir -p "$base"
work=$(mktemp -d "$base/.download.XXXXXX")
trap 'rm -rf "$work"' EXIT
if [ -n "$from" ]; then
  if [ -d "$from" ]; then
    dir=$from
    if [ -z "$version" ]; then
      version=$(cd "$dir" && ls herdr-chat-*.tar.gz 2>/dev/null | sed 's/^herdr-chat-//; s/\.tar\.gz$//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
      [ -n "$version" ] || die "no herdr-chat-<version>.tar.gz in $dir"
    fi
  else
    [ -f "$from" ] || die "no archive at $from"
    dir=$(dirname "$from")
    version=$(basename "$from" | sed -n 's/^herdr-chat-\(.*\)\.tar\.gz$/\1/p')
    [ -n "$version" ] || die "$from isn't named herdr-chat-<version>.tar.gz"
  fi
  name=herdr-chat-$version.tar.gz
  [ -f "$dir/$name" ] || die "no $name in $dir"
  [ -f "$dir/SHA256SUMS" ] || die "no SHA256SUMS beside $dir/$name; nothing installed"
  cp "$dir/$name" "$dir/SHA256SUMS" "$work/"
else
  command -v curl >/dev/null 2>&1 || die "curl not found"
  if [ -z "$version" ]; then
    # releases/latest redirects to releases/tag/v<version>.
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
      die "could not reach https://github.com/$repo/releases/latest"
    version=${url##*/}; version=${version#v}
    case $version in [0-9]*.[0-9]*.[0-9]*) ;; *) die "no release of $repo yet (https://github.com/$repo/releases)" ;; esac
  fi
  name=herdr-chat-$version.tar.gz
  dl=https://github.com/$repo/releases/download/v$version
  say "downloading $name"
  curl -fsSL "$dl/$name" -o "$work/$name" || die "could not download $dl/$name (is there a release v$version?)"
  curl -fsSL "$dl/SHA256SUMS" -o "$work/SHA256SUMS" || die "could not download $dl/SHA256SUMS"
fi
want=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS has no line for $name; nothing installed"
[ "$(sha256 "$work/$name")" = "$want" ] || die "$name does not match its SHA-256 in SHA256SUMS; nothing installed"

# --- unpack to $base/<version>, point current at it, run its installer ----------------------
tar -xzf "$work/$name" -C "$work"
tree=$work/herdr-chat-$version
[ -f "$tree/install/app.sh" ] && [ -f "$tree/host/main.js" ] || die "$name has no herdr-chat-$version/ with install/app.sh and host/main.js"
grep -q "\"version\": \"$version\"" "$tree/package.json" || die "$name's package.json isn't version $version"

prev=$(readlink "$base/current" 2>/dev/null || true)
dest=$base/$version
old=
if [ -e "$dest" ]; then old=$work/.old; mv "$dest" "$old"; fi
mv "$tree" "$dest"
ln -sfn "$version" "$base/current"
if ! HERDR_CHAT_ROOT="$dest" HERDR_CHAT_LINK="$base/current" HERDR_CHAT_INSTALL_CMD="$one_liner" \
  bash "$dest/install/app.sh" "$@"; then
  # Nothing of this version stays: the link and the folder go back to what they were.
  rm -rf "$dest"
  if [ -n "$old" ]; then mv "$old" "$dest"; fi
  if [ -n "$prev" ]; then ln -sfn "$prev" "$base/current"; else rm -f "$base/current"; fi
  die "herdr-chat $version not installed (see above)"
fi

# Keep this version and the one before it; a running host has its code loaded already.
for d in "$base"/*/; do
  v=$(basename "$d")
  [ "$v" = "$version" ] || [ "$v" = "$prev" ] || [ "$v" = current ] || rm -rf "${d%/}"
done
if [ -n "$prev" ] && [ "$prev" != "$version" ]; then
  say "updated $prev → $version in $base: open chats keep the old version until you reopen them"
else
  say "installed $version in $base"
fi
