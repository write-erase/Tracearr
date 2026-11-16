import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { DispatcharrUserField } from './DispatcharrUserField';
import { useDispatcharrUsers } from '@/hooks/queries';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/hooks/queries', () => ({ useDispatcharrUsers: vi.fn() }));

const USERS = [
  { serverId: 'd1', serverName: 'Dispatcharr', login: 'moms-house', displayName: 'Mom Lennemann' },
  { serverId: 'd1', serverName: 'Dispatcharr', login: 'my-house', displayName: 'my-house' },
];

function Harness({ initial = '', onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="du">Dispatcharr user</label>
      <DispatcharrUserField
        id="du"
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
      />
    </>
  );
}

const trigger = () => screen.getByRole('combobox', { name: 'Dispatcharr user' });

describe('DispatcharrUserField', () => {
  beforeEach(() => {
    vi.mocked(useDispatcharrUsers).mockReturnValue({ data: USERS } as never);
  });

  it('picks an XC user from the list and saves its sign-in name', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);

    expect(trigger()).toHaveTextContent('servers.dispatcharrUser.placeholder');
    await user.click(trigger());
    expect(await screen.findByRole('option', { name: 'my-house' })).toBeInTheDocument();
    expect(screen.getByText('servers.dispatcharrUser.notListed')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Mom Lennemann (moms-house)' }));

    expect(onValue).toHaveBeenLastCalledWith('moms-house');
    expect(trigger()).toHaveTextContent('Mom Lennemann (moms-house)');
  });

  it('narrows the list as you type, by sign-in or display name', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    await user.type(await screen.findByPlaceholderText('servers.dispatcharrUser.search'), 'mom');

    expect(screen.getByRole('option', { name: 'Mom Lennemann (moms-house)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'my-house' })).not.toBeInTheDocument();
  });

  it('saves a name the list does not have with "Use"', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);

    await user.click(trigger());
    await user.type(
      await screen.findByPlaceholderText('servers.dispatcharrUser.search'),
      'grandmas'
    );
    await user.click(
      screen.getByRole('option', { name: 'servers.dispatcharrUser.useTyped {"name":"grandmas"}' })
    );

    expect(onValue).toHaveBeenLastCalledWith('grandmas');
    expect(trigger()).toHaveTextContent('grandmas');
  });

  it('clears the user with None', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial="moms-house" onValue={onValue} />);

    await user.click(trigger());
    await user.click(await screen.findByRole('option', { name: 'servers.dispatcharrUser.none' }));

    expect(onValue).toHaveBeenLastCalledWith('');
  });

  it('still recognises a saved display name, and shows a saved name the list lacks', () => {
    const { unmount } = render(<Harness initial="Mom Lennemann" />);
    expect(trigger()).toHaveTextContent('Mom Lennemann (moms-house)');
    unmount();

    render(<Harness initial="old-login" />);
    expect(trigger()).toHaveTextContent('old-login');
  });

  it('still allows typing a name when Dispatcharr gives no users', async () => {
    vi.mocked(useDispatcharrUsers).mockReturnValue({ data: [] } as never);
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);

    await user.click(trigger());
    await user.type(await screen.findByPlaceholderText('servers.dispatcharrUser.search'), 'x1');
    await user.click(
      screen.getByRole('option', { name: 'servers.dispatcharrUser.useTyped {"name":"x1"}' })
    );

    expect(onValue).toHaveBeenLastCalledWith('x1');
  });
});
