import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only tg: JIDs', () => {
    storeChatMetadata('tg:group1', '2024-01-01T00:00:01.000Z', 'Group 1');
    storeChatMetadata('other:something', '2024-01-01T00:00:02.000Z', 'Other');
    storeChatMetadata('tg:group2', '2024-01-01T00:00:03.000Z', 'Group 2');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.jid.startsWith('tg:'))).toBe(true);
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:group', '2024-01-01T00:00:01.000Z', 'Group');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:group');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('tg:reg', '2024-01-01T00:00:01.000Z', 'Registered');
    storeChatMetadata('tg:unreg', '2024-01-01T00:00:02.000Z', 'Unregistered');

    _setRegisteredGroups({
      'tg:reg': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'tg:reg');
    const unreg = groups.find((g) => g.jid === 'tg:unreg');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('tg:old', '2024-01-01T00:00:01.000Z', 'Old');
    storeChatMetadata('tg:new', '2024-01-01T00:00:05.000Z', 'New');
    storeChatMetadata('tg:mid', '2024-01-01T00:00:03.000Z', 'Mid');

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('tg:new');
    expect(groups[1].jid).toBe('tg:mid');
    expect(groups[2].jid).toBe('tg:old');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
