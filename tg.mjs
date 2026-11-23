// Читает публичное веб-превью канала (t.me/s/<канал>). Работает только для публичных каналов.
const ent = s => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseTg(html) {
  const out = [];
  for (const blk of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = blk.match(/data-post="([^"]+)"/)?.[1];
    const raw = blk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!post || !raw) continue;
    const text = ent(raw.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim();
    const d = blk.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
    out.push({ id: post, url: 'https://t.me/' + post, text, pub: d ? Date.parse(d) : null });
  }
  return out;
}

export async function fetchChannel(ch, base = 'https://t.me/s/') {
  const r = await fetch(base + ch, { headers: { 'user-agent': 'Mozilla/5.0 (personal lead monitor)' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const items = parseTg(await r.text());
  if (!items.length) throw new Error('Нет публичного превью или сообщений');
  return items;
}
