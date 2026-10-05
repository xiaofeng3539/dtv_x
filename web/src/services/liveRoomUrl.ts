// 直播间链接规则移植自 dart_simple_live 的 search_room_url.dart（GPL-3.0）。
export type LiveRoomTarget = { platform: 'bilibili' | 'huya' | 'douyu' | 'douyin'; roomId: string };

export function parseLiveRoomUrl(input: string): LiveRoomTarget | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const numeric = (value: string | undefined) => !!value && /^\d+$/.test(value);
  const slug = (value: string | undefined) => !!value && /^[a-zA-Z0-9_-]+$/.test(value);

  if (url.hostname === 'live.bilibili.com' && parts.length === 1 && numeric(parts[0])) {
    return { platform: 'bilibili', roomId: parts[0] };
  }
  if (url.hostname === 'www.huya.com' && parts.length === 1 && slug(parts[0]) &&
      !['search', 'index', 'g', 'all', 'video', 'match', 'live', 'l', 'hot', 'home', 'category', 'zhubo', 'topic'].includes(parts[0])) {
    return { platform: 'huya', roomId: parts[0] };
  }
  if (url.hostname === 'www.douyu.com') {
    if (parts.length === 2 && parts[0] === 'topic') {
      const roomId = url.searchParams.get('rid');
      return roomId && numeric(roomId) ? { platform: 'douyu', roomId } : null;
    }
    if (parts.length === 1 && slug(parts[0]) && !parts[0].startsWith('g_') &&
        !['search', 'topic', 'directory', 'category'].includes(parts[0])) {
      return { platform: 'douyu', roomId: parts[0] };
    }
  }
  if (url.hostname === 'live.douyin.com' && parts.length === 1 && numeric(parts[0])) {
    return { platform: 'douyin', roomId: parts[0] };
  }
  if (url.hostname === 'www.douyin.com' && parts.length === 3 && parts[0] === 'root' &&
      parts[1] === 'live' && numeric(parts[2])) {
    return { platform: 'douyin', roomId: parts[2] };
  }
  return null;
}
