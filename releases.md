# Releases

## v0.5.0

  - Add `Transport.closeLocal` and `Transport.closeRemote` for more granular control over transport shutdown.
  - Ensure `Handoff` sends a GOAWAY frame and closes the transport when the server initiates shutdown, to prevent hanging connections and prevent incidental writes from interfering with the protocol.

## v0.4.0

  - Streaming requests by default.

## v0.3.0

  - Suppress ordinary writes to `stdout` and `stderr` while `Server.open` is running so incidental logs don't interfere with HTTY protocol bytes.
  - Guard against non-TTY `stdin` in `Server.open`, which is not supported by interactive HTTY sessions.
  - Make `Client.request` streaming-first, with explicit `requestText` and `requestBuffer` helpers for buffered responses.

## v0.2.2

  - Current release.
