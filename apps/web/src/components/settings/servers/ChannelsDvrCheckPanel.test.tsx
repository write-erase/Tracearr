import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelsDvrCheck } from '@tracearr/shared';
import { ChannelsDvrCheckPanel } from './ChannelsDvrCheckPanel';
import { api } from '@/lib/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/lib/api', () => ({ api: { servers: { check: vi.fn() } } }));

const CHECK: ChannelsDvrCheck = {
  server: { ok: true, version: '2026.11.11.2228' },
  activity: { ok: true, recording: 1 },
  disk: { ok: true, freeBytes: 200396926976, totalBytes: 315923169280 },
  jobs: { ok: true, scheduled: 12 },
  lineup: { ok: false, error: 'connect ECONNREFUSED' },
};

describe('ChannelsDvrCheckPanel', () => {
  beforeEach(() => {
    vi.mocked(api.servers.check).mockReset();
  });

  it('runs the check and shows a row for each part, with the reason one failed', async () => {
    vi.mocked(api.servers.check).mockResolvedValue(CHECK);
    render(<ChannelsDvrCheckPanel serverId="srv" urlChanged={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'servers.dvrCheck.button' }));

    expect(api.servers.check).toHaveBeenCalledWith('srv');
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('servers.dvrCheck.serverOk {"version":"2026.11.11.2228"}');
    expect(rows[3]).toHaveTextContent('servers.dvrCheck.jobsOk {"count":12}');
    expect(rows[4]).toHaveTextContent('servers.dvrCheck.lineup');
    expect(rows[4]).toHaveTextContent('connect ECONNREFUSED');
  });

  it('says when the check itself could not run', async () => {
    vi.mocked(api.servers.check).mockRejectedValue(new Error('Server not found'));
    render(<ChannelsDvrCheckPanel serverId="srv" urlChanged={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'servers.dvrCheck.button' }));

    expect(
      await screen.findByText('servers.dvrCheck.failed {"error":"Server not found"}')
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('waits for a changed address to be saved', () => {
    render(<ChannelsDvrCheckPanel serverId="srv" urlChanged />);
    expect(screen.getByRole('button', { name: 'servers.dvrCheck.button' })).toBeDisabled();
    expect(screen.getByText('servers.dvrCheck.saveFirst')).toBeInTheDocument();
  });
});
