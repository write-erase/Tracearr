import { useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { JellyfinEmbyServerType, ServerConnectionStatus } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ISSUE_KEYS = {
  blocked: 'servers.realtimeDialog.issueBlocked',
  restart_required: 'servers.realtimeDialog.issueRestartRequired',
  malfunctioned: 'servers.realtimeDialog.issueMalfunctioned',
} as const;

const PLUGIN_GUIDES = {
  jellyfin: {
    description: 'servers.realtimeDialog.jellyfinDescription',
    updateDescription: 'servers.realtimeDialog.jellyfinUpdateDescription',
    steps: [
      'servers.realtimeDialog.jellyfinStep1',
      'servers.realtimeDialog.jellyfinStep2',
      'servers.realtimeDialog.jellyfinStep3',
      'servers.realtimeDialog.jellyfinStep4',
    ],
    repoUrl: 'servers.realtimeDialog.jellyfinRepoUrl',
  },
  emby: {
    description: 'servers.realtimeDialog.embyDescription',
    updateDescription: 'servers.realtimeDialog.embyUpdateDescription',
    steps: [
      'servers.realtimeDialog.embyStep1',
      'servers.realtimeDialog.embyStep2',
      'servers.realtimeDialog.embyStep3',
    ],
    repoUrl: null,
  },
} as const;

const BOLD = { strong: <strong /> };

/** Dispatcharr's metrics plugin is d4rk-4lchemy's, installed from its releases (fork). */
const DISPATCHARR_PLUGIN_RELEASES =
  'https://github.com/d4rk-4lchemy/Tracearr-SSE-Metrics/releases/latest';

function DispatcharrPluginSteps() {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <>
      <p>
        Edit this server and select Username + Password authentication to enable WebSocket real-time
        updates. For older token-based configurations, enter your credentials again. API key mode
        uses REST polling.
      </p>
      <ol className="list-decimal space-y-2 pl-4">
        <li>Download the latest Tracearr SSE Metrics release ZIP.</li>
        <li>Import it from Dispatcharr&apos;s My Plugins screen.</li>
        <li>Refresh or restart the plugin so Tracearr can detect the new version.</li>
      </ol>
      <a
        href={DISPATCHARR_PLUGIN_RELEASES}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary inline-flex items-center gap-1 hover:underline"
      >
        {t('servers.realtimeDialog.openReleases')}
        <ExternalLink className="h-3 w-3" />
      </a>
    </>
  );
}

export function RealtimeSetupDialog({
  serverType,
  open,
  onClose,
  mode = 'setup',
  connectionStatus,
}: {
  serverType: JellyfinEmbyServerType | 'dispatcharr';
  open: boolean;
  onClose: () => void;
  mode?: 'setup' | 'update';
  connectionStatus?: ServerConnectionStatus;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const isDispatcharr = serverType === 'dispatcharr';
  const guide = isDispatcharr ? null : PLUGIN_GUIDES[serverType];
  const repoUrl = guide?.repoUrl ? t(guide.repoUrl) : null;
  const repoUrlRef = useRef<HTMLElement>(null);
  const issueKey =
    connectionStatus?.pluginIssue && connectionStatus.pluginIssue in ISSUE_KEYS
      ? ISSUE_KEYS[connectionStatus.pluginIssue as keyof typeof ISSUE_KEYS]
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isDispatcharr
              ? mode === 'update'
                ? 'Update the Tracearr SSE Metrics plugin'
                : 'Enable Tracearr SSE Metrics'
              : mode === 'update'
                ? t('servers.realtimeDialog.updateTitle')
                : t('servers.realtimeDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {guide
              ? t(mode === 'update' ? guide.updateDescription : guide.description)
              : 'Install the Tracearr SSE Metrics plugin to provide server metrics and plugin version information to Tracearr.'}
          </DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground space-y-3 text-sm">
          {issueKey && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>
                <span>{t(issueKey)}</span>
                {connectionStatus?.error && (
                  <code className="text-muted-foreground block truncate text-xs">
                    {connectionStatus.error}
                  </code>
                )}
              </AlertDescription>
            </Alert>
          )}
          {guide ? (
            <ol className="list-decimal space-y-2 pl-4">
              {guide.steps.map((step) => (
                <li key={step}>
                  <Trans t={t} i18nKey={step} components={BOLD} />
                </li>
              ))}
            </ol>
          ) : (
            <DispatcharrPluginSteps />
          )}
          {repoUrl && (
            <div className="space-y-1">
              <p className="text-foreground text-xs font-medium">
                {t('servers.realtimeDialog.repositoryUrl')}
              </p>
              <div className="flex items-center gap-2">
                <code
                  ref={repoUrlRef}
                  className="bg-muted flex-1 truncate rounded px-2 py-1 text-xs"
                >
                  {repoUrl}
                </code>
                <CopyButton
                  value={repoUrl}
                  label={t('servers.realtimeDialog.copyUrl')}
                  selectTarget={() => repoUrlRef.current}
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                />
              </div>
            </div>
          )}
          <p className="text-xs">
            {isDispatcharr
              ? 'Tracearr detects the plugin version automatically after the Dispatcharr WebSocket reconnects.'
              : t('servers.realtimeDialog.autoDetectNote')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
