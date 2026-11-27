import type { Server } from "node:http";

// F25: the backend talks only to one source address: by default loopback, where the HTTPS proxy on this
// machine (such as `tailscale serve`) connects from. A connection from any other address is destroyed
// before a byte is read, so neither an HTTP request nor a WebSocket upgrade from it is ever served.
export const DEFAULT_ALLOWED_SOURCE = "127.0.0.1";

/** `::ffff:1.2.3.4` is how Node shows an IPv4 peer on a dual-stack socket. */
export function normalizeAddress(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/iu, "");
}

export function isAllowedSource(remote: string | undefined, allowed: string): boolean {
  return remote !== undefined && normalizeAddress(remote) === normalizeAddress(allowed);
}

/** Drop every connection to `server` whose source address is not `allowed`. */
export function guardSource(server: Server, allowed: string): void {
  server.on("connection", (socket) => {
    if (!isAllowedSource(socket.remoteAddress, allowed)) socket.destroy();
  });
}
