import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { copyText } from '../copy';
import { isPlainHttp, toCurl } from '../curl';
import type { NetworkDto, NetworkFrameDto } from '../protocol';

type Tab = 'req' | 'rsp' | 'frames';

interface Props {
  network: NetworkDto[];
  onClear: () => void;
}

export function NetworkPanel({ network, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('rsp');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return network;
    return network.filter(
      (record) =>
        record.url.toLowerCase().includes(needle) ||
        record.stack.toLowerCase().includes(needle) ||
        record.method.toLowerCase().includes(needle) ||
        (record.hdr ?? '').toLowerCase().includes(needle)
    );
  }, [network, query]);

  const selected = selectedId ? network.find((record) => record.id === selectedId) ?? null : null;
  const frames = selected?.msgs ?? [];
  const payloadText = tab === 'req' ? selected?.req : selected?.rsp;
  const payloadNote = selected && tab !== 'frames' ? transferNote(selected, tab) : null;

  return (
    <div className="panel-body">
      <div className="split-left">
        <div className="toolbar">
          <input
            className="grow"
            placeholder="按地址或通道筛选…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="badge">
            {filtered.length}/{network.length}
          </span>
          <button onClick={onClear} title="仅清空本页展示。服务端会保留历史，直到页面销毁。">
            清空
          </button>
        </div>
        <div className="scroll net-list">
          {filtered.length === 0 ? (
            <div className="empty">暂未捕获到请求。</div>
          ) : (
            <table className="net">
              <thead>
                <tr>
                  <th style={{ width: 64 }}>状态</th>
                  <th style={{ width: 52 }}>方法</th>
                  <th>地址</th>
                  <th style={{ width: 64 }}>耗时</th>
                  <th style={{ width: 150 }}>通道</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr
                    key={record.id}
                    className={record.id === selectedId ? 'selected' : ''}
                    onClick={() => {
                      setSelectedId(record.id);
                      setTab(record.kind === 'stream' ? 'frames' : 'rsp');
                    }}
                  >
                    <td className={statusClass(record)}>{statusLabel(record)}</td>
                    <td>{record.method}</td>
                    <td title={record.url}>{shortUrl(record.url)}</td>
                    <td>{timeLabel(record)}</td>
                    <td>{record.stack}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="split-right">
        {!selected ? (
          <div className="empty">请选择一条请求查看内容。</div>
        ) : (
          <>
            <div className="toolbar">
              <button className={tab === 'req' ? 'active' : ''} onClick={() => setTab('req')}>
                请求
              </button>
              <button className={tab === 'rsp' ? 'active' : ''} onClick={() => setTab('rsp')}>
                响应
              </button>
              {selected.kind === 'stream' && (
                <button className={tab === 'frames' ? 'active' : ''} onClick={() => setTab('frames')}>
                  帧（{frames.length}）
                </button>
              )}
              {tab !== 'frames' && (
                <>
                  <span className="grow" />
                  {isPlainHttp(selected) && (
                    <CopyButton
                      key={`curl-${selected.id}`}
                      text={toCurl(selected)}
                      label="复制为 curl"
                      title="复制为 curl 命令，可在终端直接重放该 HTTP 请求"
                    />
                  )}
                  <CopyButton key={tab} text={pretty(payloadText)} />
                </>
              )}
            </div>
            <div className="scroll">
              {payloadNote && <div className="shot-err">{payloadNote}</div>}
              <div className="kv">
                <div className="k">地址</div>
                <div className="v">{selected.url}</div>
                <div className="k">方法</div>
                <div className="v">{selected.method}</div>
                <div className="k">通道</div>
                <div className="v">{selected.stack}</div>
                <div className="k">callbackId</div>
                <div className="v">{selected.id}</div>
                <div className="k">状态</div>
                <div className={`v ${statusClass(selected)}`}>{statusLabel(selected)}</div>
                <div className="k">耗时</div>
                <div className="v num">{selected.cost !== undefined ? `${selected.cost} ms` : '—'}</div>
                {selected.kind === 'stream' && (
                  <>
                    <div className="k">帧数</div>
                    <div className="v num">{selected.frames ?? frames.length}</div>
                  </>
                )}
                {selected.err && (
                  <>
                    <div className="k">错误</div>
                    <div className="v unreadable">{selected.err}</div>
                  </>
                )}
              </div>
              {tab === 'frames' ? (
                <FrameList frames={frames} />
              ) : tab === 'req' ? (
                <RequestPayload record={selected} note={payloadNote} />
              ) : (
                <pre className="payload">{payloadNote && !payloadText ? payloadNote : pretty(payloadText)}</pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RequestPayload({ record, note }: { record: NetworkDto; note: string | null }) {
  return (
    <>
      <PayloadBlock title="请求头" text={pretty(record.hdr)} />
      <PayloadBlock
        title="请求体"
        text={note && !record.req ? note : pretty(record.req)}
      />
    </>
  );
}

function PayloadBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="payload-block">
      <div className="payload-head">
        <span>{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="payload">{text}</pre>
    </div>
  );
}

function FrameList({ frames }: { frames: NetworkFrameDto[] }) {
  if (frames.length === 0) {
    return <div className="empty">暂无帧数据，等待长连接 / MQTT 推送。</div>;
  }
  return (
    <div className="frame-list">
      {frames.map((frame) => (
        <FrameItem key={frame.seq} frame={frame} />
      ))}
    </div>
  );
}

function FrameItem({ frame }: { frame: NetworkFrameDto }) {
  const text = frame.data
    ? pretty(frame.data)
    : frame.dataChars
      ? `分片接收中 / ${frame.dataChars} 字符…`
      : pretty(undefined);
  return (
    <div className="frame">
      <div className="frame-meta">
        <span className={frame.dir === 'up' ? 'frame-up' : 'frame-down'}>
          {frame.dir === 'up' ? '↑ 上行' : '↓ 下行'}
        </span>
        <span>#{frame.seq}</span>
        <span className="num">{new Date(frame.ts).toLocaleTimeString()}</span>
        <span className="grow" />
        <CopyButton text={text} />
      </div>
      <pre className="payload">{text}</pre>
    </div>
  );
}

function statusClass(record: NetworkDto): string {
  if (record.kind === 'stream' && record.status === undefined) return 'status-open';
  if (record.status === undefined) return 'status-pending';
  return record.ok && record.status >= 200 && record.status < 400 ? 'status-ok' : 'status-bad';
}

function statusLabel(record: NetworkDto): string {
  if (record.kind === 'stream' && record.status === undefined) return '连接中';
  if (record.kind === 'stream' && record.status !== undefined) return record.ok ? '已关闭' : '错误';
  if (record.status === undefined) return '等待';
  return String(record.status);
}

function timeLabel(record: NetworkDto): string {
  if (record.kind === 'stream') {
    const count = record.frames ?? record.msgs?.length ?? 0;
    return count > 0 ? `${count} 条` : '—';
  }
  return record.cost !== undefined ? `${record.cost}ms` : '—';
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || parsed.host;
  } catch {
    return url;
  }
}

function pretty(text?: string): string {
  if (!text) return '（空）';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function transferNote(record: NetworkDto, field: 'req' | 'rsp'): string | null {
  const text = field === 'req' ? record.req : record.rsp;
  const chars = field === 'req' ? record.reqChars : record.rspChars;
  const got = field === 'req' ? record.reqGot : record.rspGot;
  if (text && (!chars || text.length >= chars)) return null;
  if (!chars) return null;
  return `分片接收中 ${got ?? 0} / ${chars} 字符…`;
}

function CopyButton({
  text,
  label = '复制',
  title = '复制当前内容',
}: {
  text: string;
  label?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button type="button" className="copy-btn" onClick={onCopy} title={title}>
      {copied ? '已复制' : label}
    </button>
  );
}
