import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogDto, LogLevel } from '../protocol';

const LOG_ESTIMATED_HEIGHT = 22;
const LOG_OVERSCAN = 8;

const LEVELS: Array<{ id: LogLevel; label: string }> = [
  { id: 'i', label: '信息' },
  { id: 'd', label: '调试' },
  { id: 'e', label: '错误' },
  { id: 'p', label: '打印' },
];

interface Props {
  logs: LogDto[];
  droppedLogs: number;
  onClear: () => void;
}

export function ConsolePanel({ logs, droppedLogs, onClear }: Props) {
  const [enabled, setEnabled] = useState<Set<LogLevel>>(() => new Set<LogLevel>(['i', 'd', 'e', 'p']));
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [tag, setTag] = useState('');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(
    () => new Map()
  );
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const log of logs) seen.add(log.tag);
    return Array.from(seen).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((log) => {
      if (!enabled.has(log.lv)) return false;
      if (tag && log.tag !== tag) return false;
      if (needle && !log.msg.toLowerCase().includes(needle) && !log.tag.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [logs, enabled, tag, query]);

  const searchNeedle = query.trim();
  const matches = useMemo(
    () => (searchNeedle ? findLogMatches(filtered, searchNeedle) : []),
    [filtered, searchNeedle]
  );
  const matchCount = matches.length;

  // A new query/filter changes the result set, so keep the current match valid and
  // start at the first result. This also handles logs being appended while searching.
  useEffect(() => {
    setMatchIndex((previous) => (matchCount > 0 ? Math.min(previous, matchCount - 1) : 0));
  }, [matchCount]);

  useEffect(() => {
    setMatchIndex(0);
  }, [enabled, searchNeedle, tag]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateViewport = () => {
      const next = { height: element.clientHeight, width: element.clientWidth };
      setViewport((previous) =>
        previous.height === next.height && previous.width === next.width ? previous : next
      );
    };
    updateViewport();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rowKeys = useMemo(() => filtered.map(logKey), [filtered]);
  const offsets = useMemo(() => {
    const next = new Array<number>(filtered.length + 1);
    next[0] = 0;
    for (let index = 0; index < filtered.length; index += 1) {
      next[index + 1] = next[index] + (measuredHeights.get(rowKeys[index]) ?? LOG_ESTIMATED_HEIGHT);
    }
    return next;
  }, [filtered, measuredHeights, rowKeys]);

  useLayoutEffect(() => {
    if (!follow) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setScrollTop(element.scrollTop);
  }, [filtered, follow, offsets[offsets.length - 1]]);

  const startIndex = Math.max(0, findIndexAtOffset(offsets, scrollTop) - LOG_OVERSCAN);
  const endIndex = Math.min(
    filtered.length,
    findIndexAtOffset(offsets, scrollTop + Math.max(viewport.height, 440)) + LOG_OVERSCAN + 1
  );
  const visibleLogs = filtered.slice(startIndex, endIndex);

  useLayoutEffect(() => {
    let next: Map<string, number> | null = null;
    for (let index = startIndex; index < endIndex; index += 1) {
      const key = rowKeys[index];
      const element = rowRefs.current.get(key);
      if (!element) continue;
      const height = element.offsetHeight;
      if (!height || measuredHeights.get(key) === height) continue;
      if (!next) next = new Map(measuredHeights);
      next.set(key, height);
    }
    if (!next) return;

    const nextOffsets = buildOffsets(filtered, rowKeys, next);
    const beforeAnchor = offsets[startIndex] ?? 0;
    const afterAnchor = nextOffsets[startIndex] ?? 0;
    if (!follow && afterAnchor !== beforeAnchor) {
      const element = scrollRef.current;
      if (element) {
        element.scrollTop += afterAnchor - beforeAnchor;
        setScrollTop(element.scrollTop);
      }
    }
    setMeasuredHeights(next);
  }, [endIndex, filtered, follow, measuredHeights, offsets, rowKeys, startIndex, viewport.width]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
    setFollow(atBottom);
  };

  const jumpToMatch = (nextIndex: number) => {
    if (!matchCount) return;
    const index = (nextIndex + matchCount) % matchCount;
    setMatchIndex(index);
    setFollow(false);
    const element = scrollRef.current;
    if (!element) return;
    // The virtual list's offsets are already based on the complete filtered set,
    // so the target row can be positioned before it is mounted.
    const target = matches[index];
    element.scrollTop = offsets[target?.logIndex ?? 0] ?? 0;
    setScrollTop(element.scrollTop);
  };

  return (
    <div className="panel-body" style={{ flexDirection: 'column' }}>
      <div className="toolbar">
        {LEVELS.map((level) => (
          <button
            key={level.id}
            className={enabled.has(level.id) ? 'active' : ''}
            onClick={() =>
              setEnabled((previous) => {
                const next = new Set(previous);
                if (next.has(level.id)) next.delete(level.id);
                else next.add(level.id);
                return next;
              })
            }
          >
            {level.label}
          </button>
        ))}
        <select value={tag} onChange={(event) => setTag(event.target.value)}>
          <option value="">全部标签（{tags.length}）</option>
          {tags.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          className="grow"
          placeholder="筛选日志…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setMatchIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !matchCount) return;
            event.preventDefault();
            jumpToMatch(matchIndex + (event.shiftKey ? -1 : 1));
          }}
        />
        {searchNeedle && (
          <>
            <span className="search-count" aria-live="polite">
              {matchCount ? `${matchIndex + 1}/${matchCount}` : '0/0'}
            </span>
            <button
              type="button"
              className="search-nav"
              onClick={() => jumpToMatch(matchIndex - 1)}
              disabled={!matchCount}
              title="上一个命中（Shift+Enter）"
              aria-label="上一个命中"
            >
              ↑
            </button>
            <button
              type="button"
              className="search-nav"
              onClick={() => jumpToMatch(matchIndex + 1)}
              disabled={!matchCount}
              title="下一个命中（Enter）"
              aria-label="下一个命中"
            >
              ↓
            </button>
          </>
        )}
        <span className="badge">
          {filtered.length}/{logs.length}
        </span>
        {droppedLogs > 0 && (
          <span
            className="badge"
            style={{ color: 'var(--yellow)' }}
            title="设备缓冲区溢出，已丢弃部分日志。可降低采样间隔或提前过滤"
          >
            已丢弃 {droppedLogs} 条
          </span>
        )}
        <button className={follow ? 'active' : ''} onClick={() => setFollow((value) => !value)}>
          跟随
        </button>
          <button onClick={onClear} title="仅清空本页展示。服务端会保留历史，直到页面销毁。">
            清空
          </button>
      </div>
      <div className="scroll log-list" ref={scrollRef} onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <div className="empty">没有符合当前筛选条件的日志。</div>
        ) : (
          <div className="log-virtual-content" style={{ height: offsets[offsets.length - 1] }}>
            {visibleLogs.map((log, offset) => (
              <div
                className={`log-row ${log.lv} ${searchNeedle && matches[matchIndex]?.logIndex === startIndex + offset ? 'search-current' : ''}`}
                key={rowKeys[startIndex + offset]}
                ref={(element) => {
                  const key = rowKeys[startIndex + offset];
                  if (element) rowRefs.current.set(key, element);
                  else rowRefs.current.delete(key);
                }}
                style={{ top: offsets[startIndex + offset] }}
              >
                <span className="ts">{formatTime(log.ts)}</span>
                <span className="lv">{log.lv.toUpperCase()}</span>
                <span className="tag">
                  {highlightText(log.tag, searchNeedle, currentMatchInField(matches, matchIndex, startIndex + offset, 'tag'))}
                </span>
                <span className="msg">
                  {highlightText(log.msg, searchNeedle, currentMatchInField(matches, matchIndex, startIndex + offset, 'msg'))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type LogMatch = { logIndex: number; field: 'tag' | 'msg'; occurrence: number };

function findLogMatches(logs: LogDto[], needle: string): LogMatch[] {
  const matches: LogMatch[] = [];
  logs.forEach((log, logIndex) => {
    (['tag', 'msg'] as const).forEach((field) => {
      const text = log[field];
      let from = 0;
      let occurrence = 0;
      const normalized = text.toLowerCase();
      const normalizedNeedle = needle.toLowerCase();
      while (from < text.length) {
        const position = normalized.indexOf(normalizedNeedle, from);
        if (position < 0) break;
        matches.push({ logIndex, field, occurrence });
        occurrence += 1;
        from = position + needle.length;
      }
    });
  });
  return matches;
}

function currentMatchInField(
  matches: LogMatch[],
  matchIndex: number,
  logIndex: number,
  field: LogMatch['field']
): number | undefined {
  const match = matches[matchIndex];
  return match?.logIndex === logIndex && match.field === field ? match.occurrence : undefined;
}

function highlightText(text: string, needle: string, currentOccurrence?: number): React.ReactNode {
  if (!needle) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'ig'));
  let occurrence = 0;
  return parts.map((part, index) =>
    part.toLowerCase() === needle.toLowerCase() ? (
      <mark className={occurrence++ === currentOccurrence ? 'search-current-match' : ''} key={index}>
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logKey(log: LogDto): string {
  return `${log.seq}-${log.ts}`;
}

function buildOffsets(logs: LogDto[], keys: string[], heights: Map<string, number>): number[] {
  const next = new Array<number>(logs.length + 1);
  next[0] = 0;
  for (let index = 0; index < logs.length; index += 1) {
    next[index + 1] = next[index] + (heights.get(keys[index]) ?? LOG_ESTIMATED_HEIGHT);
  }
  return next;
}

function findIndexAtOffset(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  const target = Math.max(0, offset);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3
  )}`;
}
