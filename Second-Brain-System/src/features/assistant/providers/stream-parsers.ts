/**
 * ============================================================================
 * الملف: src/features/assistant/providers/stream-parsers.ts
 * القسم: Features -> Assistant -> Providers (قارئات البثّ)
 * Hint بالعربي: قراءة الردود المتدفقة من المزوّدين:
 *               - Server-Sent Events (Claude و Gemini): أحداث "event:" و "data:" مفصولة بسطر فارغ.
 *               - NDJSON (Ollama): كائن JSON واحد في كل سطر.
 * ============================================================================
 */

/**
 * Hint بالعربي: دالة قراءة بثّ SSE واستدعاء onEvent لكل حدث مكتمل (اسم الحدث + نص البيانات).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventName: string, data: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string): void => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx < 0 ? line : line.slice(0, idx);
      let value = idx < 0 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length) onEvent(eventName, dataLines.join('\n'));
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      flush(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

/**
 * Hint بالعربي: دالة قراءة بثّ NDJSON واستدعاء onObject لكل سطر JSON صالح.
 */
export async function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onObject: (obj: Record<string, unknown>) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onObject(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // سطر غير مكتمل أو غير صالح: نتجاهله
    }
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  handle(buffer);
}
