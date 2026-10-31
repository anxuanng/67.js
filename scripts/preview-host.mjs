// The preview listens on loopback, and a web page can still reach it through DNS rebinding. The Host header gives that away.
export function isPreviewHost(host, port) {
  return host === `127.0.0.1:${port}`;
}
