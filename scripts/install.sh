#!/usr/bin/env bash
# D2 (install study): one command onto a clean machine.
#
#   scripts/install.sh [--from <release-dir | file://… | https://…>] [--home <dir>]
#
# Defaults: --from $NATALIA_INSTALL_BASE (or the release URL D5 will host),
#           --home $NATALIA_HOME (or ~/.natalia).
#
# What it guarantees, per the study:
#   * supply chain: every file is verified against SHA256SUMS BEFORE the
#     install touches the destination (a tampered byte aborts with nothing
#     installed);
#   * layout: versions/<version>/<files> + bin/natalia (a relative symlink,
#     so the store never moves with a renamed home);
#   * immediately usable: the installed binary answers --version or the
#     install fails;
#   * it is not a data command: stores/, logs/ and config.json are never
#     opened for writing — uninstall/purge own data, and only those.
set -euo pipefail

VERSION_TOOL="$(cd "$(dirname "$0")/.." && pwd)"
FROM="${NATALIA_INSTALL_BASE:-https://natalia.dev/releases}"
HOME_DIR="${NATALIA_HOME:-$HOME/.natalia}"

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# sha256sum on Linux, shasum on macOS — same standard output format.
sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
  else
    shasum -a 256 -c "$1"
  fi
}

fetch() { # fetch <relative-path> <destination>
  local rel="$1" dest="$2"
  if [ -d "$FROM" ]; then
    cp "$FROM/$rel" "$dest"
  else
    curl -fsSL --retry 2 "${FROM%/}/$rel" -o "$dest"
  fi
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 1. The plain-text metadata first: no JSON parsing in a shell installer —
#    the file list AND its digests live in SHA256SUMS.
fetch VERSION "$STAGE/VERSION" || {
  echo "install.sh: cannot read VERSION from $FROM" >&2
  exit 1
}
VERSION="$(tr -d '[:space:]' < "$STAGE/VERSION")"
[ -n "$VERSION" ] || { echo "install.sh: empty VERSION" >&2; exit 1; }
fetch SHA256SUMS "$STAGE/SHA256SUMS" || {
  echo "install.sh: cannot read SHA256SUMS from $FROM" >&2
  exit 1
}
fetch manifest.json "$STAGE/manifest.json" || true

# 2. Download every listed file into the staging tree (paths relative to
#    the staging root, exactly as the build emitted them).
mkdir -p "$STAGE/files"
while read -r _hash file; do
  [ -n "$file" ] || continue
  mkdir -p "$STAGE/files/$(dirname "$file")"
  fetch "$file" "$STAGE/files/$file"
done <"$STAGE/SHA256SUMS"

# 3. Verify BEFORE anything touches the destination (校验和验证生效).
if ! (cd "$STAGE/files" && sha256_check "$STAGE/SHA256SUMS" >/dev/null); then
  echo "install.sh: checksum verification FAILED — nothing was installed" >&2
  (cd "$STAGE/files" && sha256_check "$STAGE/SHA256SUMS") >&2 || true
  exit 1
fi

# 4. Land it: versions/<version>/ is the only directory this script writes
#    under HOME_DIR besides bin/ — stores/, logs/ and config.json are not
#    ours to touch.
TARGET="$HOME_DIR/versions/$VERSION"
mkdir -p "$TARGET"
rm -rf "${TARGET:?}/."* "$TARGET"/* 2>/dev/null || true
cp -R "$STAGE/files/." "$TARGET/"
# The release manifest is NOT in SHA256SUMS (it is not self-listed), so
# the files loop above never lands it — but it is the build's identity
# (and carries the P4 layer census the installed doctor reports from).
if [ -f "$STAGE/manifest.json" ]; then
  cp "$STAGE/manifest.json" "$TARGET/manifest.json"
fi
chmod +x "$TARGET/natalia"
mkdir -p "$HOME_DIR/bin"
# A relative symlink: moving/renaming the home keeps bin -> versions valid.
# The previous pointer is captured BEFORE it is overwritten: an upgrade
# re-points bin/natalia, and a rollback that merely DELETED it would leave a
# working older install with no way to start it (measured: install A, then a
# failed install B into the same home took A's bin/natalia with it).
PREV_LINK="$(readlink "$HOME_DIR/bin/natalia" 2>/dev/null || true)"
ln -sfn "../versions/$VERSION/natalia" "$HOME_DIR/bin/natalia"

# Restores what the landing disturbed: the previous pointer if there was one,
# nothing if there was not. A rollback that leaves the home as it found it is
# the difference between "the install failed" and "the install uninstalled
# something".
rollback_landing() {
  rm -rf "$TARGET"
  if [ -n "$PREV_LINK" ]; then
    ln -sfn "$PREV_LINK" "$HOME_DIR/bin/natalia"
  else
    rm -f "$HOME_DIR/bin/natalia"
  fi
  # The two directories this script created, removed only when this rollback
  # emptied them: rmdir refuses a non-empty directory, so a previous install's
  # versions/ and bin/ survive untouched, and a fresh home is left with no
  # empty husks where the install "almost" happened.
  rmdir "$HOME_DIR/versions" "$HOME_DIR/bin" 2>/dev/null || true
}

# 5. Immediately usable, or the install did not happen.
if ! INSTALLED="$("$HOME_DIR/bin/natalia" --version 2>/dev/null)"; then
  echo "install.sh: the installed binary failed its --version check — rolling back" >&2
  rollback_landing
  exit 1
fi
if [ "$INSTALLED" != "$VERSION" ]; then
  echo "install.sh: installed binary reports '$INSTALLED', expected '$VERSION' — rolling back" >&2
  # What a rollback cannot restore is a re-install of the SAME version over a
  # working one: step 4 has already overwritten that tree by the time this
  # check runs. The supply-chain gate above is what keeps that case rare — a
  # mismatched release identity is the last resort, not the first line.
  rollback_landing
  exit 1
fi

echo "natalia $VERSION installed at $HOME_DIR/bin/natalia"
if [ -d "$HOME_DIR/stores" ]; then
  echo "existing stores preserved untouched at $HOME_DIR/stores"
fi
echo "next: natalia doctor   # first run: platform report + provider guidance"
