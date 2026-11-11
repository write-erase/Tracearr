import { Globe, Monitor, Smartphone, Tablet, Tv, type LucideIcon } from 'lucide-react';

export type DeviceKind = 'browser' | 'tv' | 'tablet' | 'phone' | 'desktop';

interface DeviceInfo {
  platform?: string | null;
  device?: string | null;
  product?: string | null;
}

/**
 * What kind of device a session plays on, from what the server reported.
 * TV is checked before phones: "tvOS" contains "ios", and Android TV contains "android".
 */
export function deviceKind({ platform, device, product }: DeviceInfo): DeviceKind {
  const p = platform?.toLowerCase() ?? '';
  const d = device?.toLowerCase() ?? '';
  const pr = product?.toLowerCase() ?? '';

  // The Channels DVR web player, and browser clients of other servers
  if (pr === 'channels web' || p === 'web' || /\b(chrome|firefox|safari|edge|browser)\b/.test(p)) {
    return 'browser';
  }
  if (
    p.startsWith('tvos') ||
    p.includes('android tv') ||
    p.includes('fire tv') ||
    p.includes('webos') ||
    p.includes('tizen') ||
    p.includes('roku') ||
    /\b(tv|television)\b/.test(p) ||
    d.includes('appletv') ||
    d.includes('apple tv') ||
    /\btv\b/.test(d) ||
    d.includes('roku') ||
    d.includes('firestick') ||
    d.includes('fire tv') ||
    /^aft[a-z]/.test(d) || // Amazon Fire TV model codes (AFTKM, AFTSSS)
    d.includes('chromecast') ||
    d.includes('shield') ||
    pr.includes(' tv')
  ) {
    return 'tv';
  }
  if (p.startsWith('ipados') || d.includes('ipad') || p.includes('tablet')) return 'tablet';
  if (p.startsWith('ios') || d.includes('iphone') || p.includes('android')) return 'phone';
  return 'desktop';
}

const ICONS: Record<DeviceKind, LucideIcon> = {
  browser: Globe,
  tv: Tv,
  tablet: Tablet,
  phone: Smartphone,
  desktop: Monitor,
};

export function DeviceTypeIcon({ className, ...info }: DeviceInfo & { className?: string }) {
  const Icon = ICONS[deviceKind(info)];
  return <Icon className={className} aria-hidden="true" />;
}
