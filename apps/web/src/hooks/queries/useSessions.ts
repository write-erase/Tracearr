import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { serverScopeFromIds, serverScopeKey } from '@tracearr/shared';
import { api } from '@/lib/api';

interface SessionsParams {
  page?: number;
  pageSize?: number;
  userId?: string;
  serverId?: string;
  state?: string;
}

export function useSessions(params: SessionsParams = {}) {
  return useQuery({
    queryKey: ['sessions', 'list', params],
    queryFn: () => api.sessions.list(params),
    staleTime: 1000 * 30, // 30 seconds
  });
}

function activeSessionsOptions(serverIds: string[], socketConnected: boolean, self: boolean) {
  const serverIdsKey = serverScopeKey(serverScopeFromIds(serverIds));
  return {
    queryKey: ['sessions', 'active', serverIdsKey, self],
    queryFn: () => api.sessions.getActive(serverIds.length ? serverIds : undefined, self),
    staleTime: 1000 * 15, // 15 seconds
    // Socket events keep this fresh when connected; polling is the fallback
    refetchInterval: socketConnected ? 1000 * 60 : 1000 * 30,
  };
}

export function useActiveSessions(serverIds: string[], socketConnected = false, self = false) {
  return useQuery({
    ...activeSessionsOptions(serverIds, socketConnected, self),
    select: (response) => response.data,
  });
}

/** Same request as useActiveSessions, so it costs nothing extra. Undefined unless the server sends it. */
export function useOthersActive(serverIds: string[], socketConnected = false, self = false) {
  return useQuery({
    ...activeSessionsOptions(serverIds, socketConnected, self),
    select: (response) => response.othersActive,
  });
}

/** Channels DVR recordings in progress; only fetched when a Channels DVR server exists. */
export function useChannelsRecordings(enabled: boolean) {
  return useQuery({
    queryKey: ['sessions', 'recordings'],
    queryFn: () => api.sessions.recordings(),
    enabled,
    staleTime: 1000 * 5,
    refetchInterval: 1000 * 10,
  });
}

/** Stop a Channels DVR recording; refreshes the Recording Now panel. */
export function useStopRecording() {
  const { t } = useTranslation('pages');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, jobId }: { serverId: string; jobId: string }) =>
      api.sessions.stopRecording(serverId, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'recordings'] });
      toast.success(
        t('dashboard.recording.stopped', {
          defaultValue: 'Recording stopped. What was recorded is kept in Channels DVR.',
        })
      );
    },
    onError: (error: Error) => {
      toast.error(
        t('dashboard.recording.stopFailed', { defaultValue: 'Could not stop the recording' }),
        { description: error.message }
      );
    },
  });
}

/**
 * Cancel a queued Channels DVR recording. Channels takes the same request it uses to stop
 * one in progress (DELETE /dvr/jobs/<id>), which removes the job from its schedule.
 */
export function useCancelRecording() {
  const { t } = useTranslation('pages');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, jobId }: { serverId: string; jobId: string }) =>
      api.sessions.stopRecording(serverId, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'recordings'] });
      toast.success(t('dashboard.recording.cancelled', { defaultValue: 'Recording cancelled.' }));
    },
    onError: (error: Error) => {
      toast.error(
        t('dashboard.recording.cancelFailed', {
          defaultValue: 'Could not cancel the recording',
        }),
        { description: error.message }
      );
    },
  });
}

/**
 * Skip one airing a Channels DVR series pass scheduled, or undo that. The pass keeps going, and
 * a skipped airing stays in Coming Up so it can be unskipped.
 */
export function useSkipRecording() {
  const { t } = useTranslation('pages');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      serverId,
      jobId,
      skipped,
    }: {
      serverId: string;
      jobId: string;
      skipped: boolean;
    }) => api.sessions.setRecordingSkipped(serverId, jobId, skipped),
    onSuccess: (_data, { skipped }) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'recordings'] });
      toast.success(
        skipped
          ? t('dashboard.recording.skippedToast', {
              defaultValue: 'Skipped. The series pass will record the rest.',
            })
          : t('dashboard.recording.unskippedToast', { defaultValue: 'It will record again.' })
      );
    },
    onError: (error: Error, { skipped }) => {
      toast.error(
        skipped
          ? t('dashboard.recording.skipFailed', { defaultValue: 'Could not skip the recording' })
          : t('dashboard.recording.unskipFailed', {
              defaultValue: 'Could not unskip the recording',
            }),
        { description: error.message }
      );
    },
  });
}

export function useSession(id: string, startedAt?: Date | string) {
  return useQuery({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api.sessions.get(id, startedAt),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useBulkDeleteSessions() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) => api.sessions.bulkDelete(ids),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      toast.success(t('toast.success.sessionsDeleted.title'), {
        description: t('toast.success.sessionsDeleted.message', { count: data.deleted }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.sessionsDeleteFailed'), { description: error.message });
    },
  });
}
