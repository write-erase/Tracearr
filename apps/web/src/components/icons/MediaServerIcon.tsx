import { assertNever, type ServerType } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { BASE_URL } from '@/lib/basePath';

interface MediaServerIconProps {
  /** Server type: 'plex', 'jellyfin', 'emby', 'dispatcharr', or 'channels_dvr' */
  type: ServerType;
  /** CSS class name for sizing (e.g., "h-4 w-4") */
  className?: string;
  /** Alt text for accessibility */
  alt?: string;
}

/**
 * Displays the appropriate icon for a media server type.
 */
export function MediaServerIcon({ type, className, alt }: MediaServerIconProps) {
  return (
    <img
      src={getIconPath(type)}
      alt={alt ?? `${type} server`}
      className={cn('object-contain', className)}
    />
  );
}

function getIconPath(type: ServerType): string {
  const base = BASE_URL;
  switch (type) {
    case 'plex':
      return `${base}images/servers/plex.png`;
    case 'jellyfin':
      return `${base}images/servers/jellyfin.png`;
    case 'emby':
      return `${base}images/servers/emby.png`;
    case 'dispatcharr':
      return `${base}images/servers/dispatcharr.png`;
    case 'channels_dvr':
      return `${base}images/servers/channels-dvr.svg`;
    default:
      return assertNever(type);
  }
}
