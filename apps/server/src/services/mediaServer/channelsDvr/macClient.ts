/**
 * The Channels Mac app is the iPad app running on an Apple Silicon Mac, so /dvr/clients/info
 * lists it as an iPad: `device: "iPad8,6"`, `platform: "iPadOS 27.2"`, and usually
 * `hostname: "iPad"`. What gives it away is its machine_id: iPhones, iPads and Apple TVs report
 * a random (version 4) UUID, while the Mac app reports a name-based (version 5) one.
 */
const NAME_BASED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ChannelsClientIdentity {
  machine_id?: string;
  hostname?: string;
  alias?: string;
  device?: string;
  platform?: string;
}

export function isChannelsMacClient(client: ChannelsClientIdentity): boolean {
  return /^ipados\b/i.test(client.platform ?? '') && NAME_BASED_UUID.test(client.machine_id ?? '');
}

/** Report the Mac app as a Mac, keeping the OS version (macOS and iPadOS share version numbers). */
export function describeChannelsClient(client: ChannelsClientIdentity): {
  name?: string;
  device?: string;
  platform?: string;
} {
  if (!isChannelsMacClient(client)) {
    return {
      name: client.hostname || client.alias,
      device: client.device,
      platform: client.platform,
    };
  }
  const hostname = client.hostname === 'iPad' ? undefined : client.hostname;
  return {
    name: hostname || client.alias || 'Mac',
    device: 'Mac',
    platform: (client.platform ?? '').replace(/^ipados/i, 'macOS'),
  };
}
