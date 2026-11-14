import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, CircleX, Loader2 } from 'lucide-react';
import type { ChannelsDvrCheck } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldTitle } from '@/components/ui/field';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/formatters';

type StepKey = keyof ChannelsDvrCheck;
const STEPS: StepKey[] = ['server', 'activity', 'disk', 'jobs', 'lineup'];

/**
 * "Check connection" for a Channels DVR server: one row per endpoint Tracearr reads, so a
 * setup problem names the part that's wrong. Checks the saved address, so it waits for a
 * changed address to be saved.
 */
export function ChannelsDvrCheckPanel({
  serverId,
  urlChanged,
}: {
  serverId: string;
  urlChanged: boolean;
}) {
  const { t } = useTranslation(['settings']);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ChannelsDvrCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.servers.check(serverId));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const okText = (check: ChannelsDvrCheck, key: StepKey): string => {
    const prefix = 'servers.dvrCheck';
    switch (key) {
      case 'server': {
        const step = check.server;
        if (!step.ok) return '';
        return step.version
          ? t(`${prefix}.serverOk`, { version: step.version })
          : t(`${prefix}.serverOkNoVersion`);
      }
      case 'activity':
        return check.activity.ok
          ? t(`${prefix}.activityOk`, { count: check.activity.recording })
          : '';
      case 'disk':
        return check.disk.ok
          ? t(`${prefix}.diskOk`, {
              free: formatBytes(check.disk.freeBytes),
              total: formatBytes(check.disk.totalBytes),
            })
          : '';
      case 'jobs':
        return check.jobs.ok ? t(`${prefix}.jobsOk`, { count: check.jobs.scheduled }) : '';
      case 'lineup':
        return check.lineup.ok
          ? t(`${prefix}.lineupOk`, {
              channels: check.lineup.channels,
              sources: check.lineup.sources,
            })
          : '';
    }
  };

  return (
    <Field>
      <FieldTitle>{t('servers.dvrCheck.button')}</FieldTitle>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={running || urlChanged}
          onClick={() => void run()}
        >
          {running && <Loader2 className="animate-spin" />}
          {running ? t('servers.dvrCheck.running') : t('servers.dvrCheck.button')}
        </Button>
      </div>
      <FieldDescription>
        {urlChanged ? t('servers.dvrCheck.saveFirst') : t('servers.dvrCheck.hint')}
      </FieldDescription>

      {error && (
        <p className="text-destructive text-sm">{t('servers.dvrCheck.failed', { error })}</p>
      )}

      {result && (
        <ul className="space-y-1.5 text-sm" aria-label={t('servers.dvrCheck.button')}>
          {STEPS.map((key) => {
            const step = result[key];
            return (
              <li key={key} className="flex items-start gap-2">
                {step.ok ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
                ) : (
                  <CircleX className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="font-medium">{t(`servers.dvrCheck.${key}`)}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {step.ok ? okText(result, key) : step.error}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Field>
  );
}
