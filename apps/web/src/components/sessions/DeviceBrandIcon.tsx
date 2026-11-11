import { DeviceTypeIcon, deviceKind } from './DeviceTypeIcon';

export type DeviceBrand = 'apple' | 'amazon' | 'google' | 'android';

interface DeviceInfo {
  platform?: string | null;
  device?: string | null;
  product?: string | null;
}

/**
 * The maker of the device a session plays on. Channels apps run on Apple (Apple TV, iPhone,
 * iPad, Mac), Android (phones, Android TV, Google TV) and Fire TV. Amazon and Google are checked
 * before Android because Fire TV and Chromecast run Android. Returns null for the web player,
 * which doesn't say which browser it runs in, and for anything unrecognised.
 */
export function deviceBrand({ platform, device, product }: DeviceInfo): DeviceBrand | null {
  const p = platform?.toLowerCase() ?? '';
  const d = device?.toLowerCase() ?? '';

  if (deviceKind({ platform, device, product }) === 'browser') return null;
  if (
    /^(tvos|ios|ipados|macos|mac os)/.test(p) ||
    /\b(apple ?tv|iphone|ipad|ipod|imac|mac(book|mini| mini|pro| pro)?)\b/.test(d) ||
    /^(appletv|iphone|ipad|ipod|macbook|imac|macmini)/.test(d)
  ) {
    return 'apple';
  }
  if (
    p.includes('fire') ||
    p.includes('amazon') ||
    /^aft[a-z]/.test(d) ||
    d.includes('firestick') ||
    d.includes('fire tv') ||
    d.includes('kindle')
  ) {
    return 'amazon';
  }
  if (d.includes('chromecast') || p.includes('google tv') || d.includes('google tv'))
    return 'google';
  if (p.includes('android') || d.includes('shield')) return 'android';
  return null;
}

// Filled logo paths from Phosphor Icons (MIT, https://phosphoricons.com), 256x256 view box.
const LOGO_PATHS: Record<DeviceBrand, string> = {
  apple:
    'M128.23,30A40,40,0,0,1,167,0h1a8,8,0,0,1,0,16h-1a24,24,0,0,0-23.24,18,8,8,0,1,1-15.5-4ZM223.3,169.59a8.07,8.07,0,0,0-2.8-3.4C203.53,154.53,200,134.64,200,120c0-17.67,13.47-33.06,21.5-40.67a8,8,0,0,0,0-11.62C208.82,55.74,187.82,48,168,48a72.23,72.23,0,0,0-40,12.13,71.56,71.56,0,0,0-90.71,9.09A74.63,74.63,0,0,0,16,123.4a127,127,0,0,0,40.14,89.73A39.8,39.8,0,0,0,83.59,224h87.68a39.84,39.84,0,0,0,29.12-12.57,125,125,0,0,0,17.82-24.6C225.23,174,224.33,172,223.3,169.59Z',
  android:
    'M207.06,80.67c-.74-.74-1.49-1.46-2.24-2.17l24.84-24.84a8,8,0,0,0-11.32-11.32l-26,26a111.43,111.43,0,0,0-128.55.19L37.66,42.34A8,8,0,0,0,26.34,53.66L51.4,78.72A113.38,113.38,0,0,0,16,161.13V184a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V160A111.25,111.25,0,0,0,207.06,80.67ZM92,160a12,12,0,1,1,12-12A12,12,0,0,1,92,160Zm72,0a12,12,0,1,1,12-12A12,12,0,0,1,164,160Z',
  amazon:
    'M152,136a24,24,0,1,1-24-24A24,24,0,0,1,152,136Zm80-8A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-80-24v0a40,40,0,1,0,0,64v0a8,8,0,0,0,16,0V104A40,40,0,0,0,94.13,82.71a8,8,0,0,0,13.54,8.52A24,24,0,0,1,152,104Zm44.81,65.61a8,8,0,0,0-11.2,1.58,72,72,0,0,1-115.22,0,8,8,0,1,0-12.78,9.62,88,88,0,0,0,140.78,0A8,8,0,0,0,196.81,169.61Z',
  google:
    'M128,24A104,104,0,1,0,232,128,104,104,0,0,0,128,24Zm0,184A80,80,0,1,1,181.34,68.37a8,8,0,0,1-10.67,11.92A64,64,0,1,0,191.5,136H128a8,8,0,0,1,0-16h72a8,8,0,0,1,8,8A80.09,80.09,0,0,1,128,208Z',
};

// The logos aren't drawn centred in their 256x256 squares (Apple's leaf pushes its body down and
// left), so each gets a view box shifted to put the middle of its shape in the middle of the icon.
const LOGO_VIEW_BOX: Record<DeviceBrand, string> = {
  apple: '-8.5 -16 256 256',
  android: '0 -8.5 256 256',
  amazon: '0 0 256 256',
  google: '0 0 256 256',
};

/** The device maker's logo, or the kind-of-device icon when there's no logo for it. */
export function DeviceBrandIcon({ className, ...info }: DeviceInfo & { className?: string }) {
  const brand = deviceBrand(info);
  if (!brand) return <DeviceTypeIcon className={className} {...info} />;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={LOGO_VIEW_BOX[brand]}
      fill="currentColor"
      className={className}
      aria-hidden="true"
      data-brand={brand}
    >
      <path d={LOGO_PATHS[brand]} />
    </svg>
  );
}
