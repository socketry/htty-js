# Releases

## Unreleased

  - Suppress ordinary writes to `stdout` and `stderr` while `Server.open` is running so incidental logs don't interfere with HTTY protocol bytes.
  - Guard against non-TTY `stdin` in `Server.open`, which is not supported by interactive HTTY sessions.

## v0.2.2

  - Current release.
