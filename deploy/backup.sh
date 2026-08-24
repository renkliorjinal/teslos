#!/usr/bin/env bash
#
# Backing up the part that cannot be re-created.
#
# The code is in git and can be restored with a checkout. What cannot is the
# state directory: the YouTube cookie jar, the Google client and its tokens, and
# the watch history with every resume position in it. Signing in again is a
# ten-step chore on a phone at the roadside, so it is worth a tar file.
#
#   sudo bash deploy/backup.sh                 # take one
#   sudo bash deploy/backup.sh --list          # what is there
#   sudo bash deploy/backup.sh --restore FILE  # put one back
#
set -euo pipefail

STATE_DIR="${TESLOS_STATE:-/var/lib/teslos}"
BACKUP_DIR="${TESLOS_BACKUPS:-/var/backups/teslos}"
KEEP="${TESLOS_KEEP:-10}"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

list() {
  if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    echo "No backups in $BACKUP_DIR yet."
    return
  fi
  echo "Backups in $BACKUP_DIR, newest last:"
  ls -lh --time-style=long-iso "$BACKUP_DIR" | awk 'NR>1 {print "  " $6, $7, "\t", $5, "\t", $8}'
}

restore() {
  local archive="$1"
  [ -f "$archive" ] || { echo "No such backup: $archive" >&2; exit 1; }

  # The running service holds these files open and would write over a restored
  # jar within seconds of it landing.
  local was_running=0
  if systemctl is-active --quiet teslos 2>/dev/null; then
    was_running=1
    echo "Stopping teslos"
    systemctl stop teslos
  fi

  # Never overwrite without a way back, even during a restore.
  if [ -d "$STATE_DIR" ] && [ -n "$(ls -A "$STATE_DIR" 2>/dev/null)" ]; then
    local aside="$BACKUP_DIR/replaced-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    mkdir -p "$BACKUP_DIR"
    tar -czf "$aside" -C "$STATE_DIR" .
    echo "Current state set aside as $aside"
  fi

  mkdir -p "$STATE_DIR"
  tar -xzf "$archive" -C "$STATE_DIR"
  chown -R teslos:teslos "$STATE_DIR" 2>/dev/null || true
  echo "Restored $archive into $STATE_DIR"

  if [ "$was_running" = 1 ]; then
    systemctl start teslos
    echo "teslos restarted"
  fi
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  --list) list; exit 0 ;;
  --restore)
    [ $# -ge 2 ] || { echo "--restore needs a file" >&2; usage 1; }
    restore "$2"
    exit 0
    ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; usage 1 ;;
esac

if [ ! -d "$STATE_DIR" ]; then
  echo "Nothing to back up: $STATE_DIR does not exist." >&2
  echo "If the service has never run, there is no state yet." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/teslos-state-$STAMP.tar.gz"

# Owner-only: this contains a live YouTube session and a Google refresh token.
umask 077
tar -czf "$ARCHIVE" -C "$STATE_DIR" .
chmod 600 "$ARCHIVE"

echo "Backed up $STATE_DIR -> $ARCHIVE"
tar -tzf "$ARCHIVE" | sed 's/^/  /'

# Keep the last few and no more; these are small, but not free.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/teslos-state-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
if [ "${#OLD[@]}" -gt 0 ]; then
  printf 'Removing %d old backup(s)\n' "${#OLD[@]}"
  rm -f "${OLD[@]}"
fi

echo
echo "Restore with:  sudo bash deploy/backup.sh --restore $ARCHIVE"
