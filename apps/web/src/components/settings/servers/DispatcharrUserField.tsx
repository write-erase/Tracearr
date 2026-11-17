import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, ChevronsUpDown } from 'lucide-react';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { selectTriggerClasses } from '@/components/ui/select';
import { useDispatcharrUsers } from '@/hooks/queries';
import type { DispatcharrUserOption } from '@/lib/api';
import { cn } from '@/lib/utils';

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Plain "contains" matching on the names; cmdk's default fuzzy match is too loose for logins. */
function filterNames(_value: string, search: string, keywords?: string[]): number {
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  return (keywords ?? []).some((word) => word.toLowerCase().includes(needle)) ? 1 : 0;
}

function labelOf(user: DispatcharrUserOption): string {
  return sameName(user.displayName, user.login)
    ? user.login
    : `${user.displayName} (${user.login})`;
}

/**
 * A Channels DVR server's "Dispatcharr user": a searchable list of Dispatcharr's XC users (saved
 * as the XC sign-in name, the one in the M3U link). Typing narrows the list; a name it doesn't
 * have can still be saved with "Use …".
 */
export function DispatcharrUserField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(['settings']);
  const { data: users = [] } = useDispatcharrUsers(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // A name saved before the list showed sign-in names may be the display name; it still matches.
  const selected = users.find(
    (user) => sameName(user.login, value) || sameName(user.displayName, value)
  );

  const byServer = useMemo(() => {
    const groups = new Map<string, DispatcharrUserOption[]>();
    for (const user of users) {
      groups.set(user.serverName, [...(groups.get(user.serverName) ?? []), user]);
    }
    return [...groups];
  }, [users]);
  const grouped = byServer.length > 1;

  const typed = search.trim();
  const typedIsListed = users.some(
    (user) => sameName(user.login, typed) || sameName(user.displayName, typed)
  );

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          className={cn(selectTriggerClasses, 'w-full')}
        >
          <span className={cn('truncate', !value.trim() && 'text-muted-foreground')}>
            {selected
              ? labelOf(selected)
              : value.trim() || t('servers.dispatcharrUser.placeholder')}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command filter={filterNames}>
          <CommandInput
            placeholder={t('servers.dispatcharrUser.search')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList id={`${id}-list`}>
            <CommandGroup>
              <CommandItem value="__none__" keywords={['none']} onSelect={() => choose('')}>
                <span className="flex-1">{t('servers.dispatcharrUser.none')}</span>
                {!value.trim() && <CheckIcon className="size-4 shrink-0" />}
              </CommandItem>
            </CommandGroup>
            {byServer.map(([serverName, serverUsers]) => (
              <CommandGroup key={serverName} heading={grouped ? serverName : undefined}>
                {serverUsers.map((user) => (
                  <CommandItem
                    key={`${user.serverId}:${user.login}`}
                    value={`${user.serverId}:${user.login}`}
                    keywords={[user.login, user.displayName]}
                    onSelect={() => choose(user.login)}
                  >
                    <span className="flex-1 truncate">{labelOf(user)}</span>
                    {selected === user && <CheckIcon className="size-4 shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {!typed && (
              <p className="text-muted-foreground px-3 py-2 text-xs">
                {t('servers.dispatcharrUser.notListed')}
              </p>
            )}
            {typed && !typedIsListed && (
              <>
                <CommandSeparator alwaysRender />
                <CommandGroup forceMount>
                  <CommandItem value="__use_typed__" forceMount onSelect={() => choose(typed)}>
                    {t('servers.dispatcharrUser.useTyped', { name: typed })}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
