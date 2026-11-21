/**
 * Which Channels DVR viewers Tracearr can stop (fork). Channels DVR has no stop command of its
 * own, so Tracearr calls the Channels app on the viewer's device at the address Channels DVR
 * reports, which must be reachable from the Tracearr server.
 */

/**
 * A Docker network gateway (172.17.0.1 for the default bridge, 172.18.0.1 and up for Compose
 * networks). Channels DVR reports this address when the viewer reaches it through a proxy into
 * its container (such as Tailscale Services), so the device itself is out of reach. Only the
 * gateway addresses count: some home networks use 172.16-31.x.x for real devices.
 */
export function isDockerGatewayAddress(ip: string | null | undefined): boolean {
  return !!ip && /^172\.(1[7-9]|2\d|3[01])\.0\.1$/.test(ip);
}

/**
 * A Tailscale address (100.64.0.0/10). Channels DVR reports it when the viewer connects over
 * Tailscale to the DVR's own address on the tailnet; a Tracearr server on the same tailnet can
 * reach the device there, so a stop is attempted.
 */
export function isTailscaleAddress(ip: string | null | undefined): boolean {
  const match = ip ? /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip) : null;
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}
