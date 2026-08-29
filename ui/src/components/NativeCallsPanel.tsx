import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { copyText } from '../copy';
import type { NativeCallDto, NetworkFrameDto } from '../protocol';
import { isLogOrNetworkNative } from '../protocol';

type Tab = 'args' | 'rsp' | 'frames';

interface Props {
  native: NativeCallDto[];
  onClear: () => void;
}

export function NativeCallsPanel({ native, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('rsp');

  const visible = useMemo(
    () => native.filter((record) => !isLogOrNetworkNative(record.mod)),
    [native]
  );

  const modules = useMemo(() => {
    const seen = new Set<string>();
    for (const record of visible) seen.add(record.mod);
    return Array.from(seen).sort();
  }, [visible]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visible.filter((record) => {
      if (moduleFilter && record.mod !== moduleFilter) return false;
      if (!needle) return true;
      return (
        record.mod.toLowerCase().includes(needle) ||
        record.method.toLowerCase().includes(needle) ||
        record.via.toLowerCase().includes(needle) ||
        (record.args ?? '').toLowerCase().includes(needle)
      );
    });
  }, [visible, query, moduleFilter]);

  const selected = selectedId ? visible.find((record) => record.id === selectedId) ?? null : null;
  const frames = selected?.msgs ?? [];
  const payloadText = tab === 'args' ? selected?.args : selected?.rsp;
  const payloadNote = selected && tab !== 'frames' ? transferNote(selected, tab) : null;

  return (
    <div className="panel-body">
      <div className="split-left">
        <div className="toolbar">
          <input
            className="grow"
            placeholder="按模块、方法或入参筛选…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}>
            <option value="">全部模块</option>
            {modules.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="badge">
            {filtered.length}/{visible.length}
          </span>
          <button onClick={onClear} title="仅清空本页展示。服务端会保留历史，直到页面销毁。">
            清空
          </button>
        </div>
        <div className="scroll net-list">
          {filtered.length === 0 ? (
            <div className="empty">暂未捕获到原生调用。</div>
          ) : (
            <table className="net">
              <thead>
                <tr>
                  <th style={{ width: 64 }}>状态</th>
                  <th style={{ width: 52 }}>调用</th>
                  <th style={{ width: 160 }}>模块</th>
                  <th>方法</th>
                  <th style={{ width: 64 }}>耗时</th>
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
                    <td>{record.sync ? '同步' : '异步'}</td>
                    <td title={record.mod}>{record.mod}</td>
                    <td title={record.method}>{record.method}</td>
                    <td>{timeLabel(record)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="split-right">
        {!selected ? (
          <div className="empty">请选择一条调用查看入参和返回值。</div>
        ) : (
          <>
            <div className="toolbar">
              <button className={tab === 'args' ? 'active' : ''} onClick={() => setTab('args')}>
                入参
              </button>
              <button className={tab === 'rsp' ? 'active' : ''} onClick={() => setTab('rsp')}>
                返回值
              </button>
              {selected.kind === 'stream' && (
                <button className={tab === 'frames' ? 'active' : ''} onClick={() => setTab('frames')}>
                  回调（{frames.length}）
                </button>
              )}
              {tab !== 'frames' && (
                <>
                  <span className="grow" />
                  <CopyButton key={tab} text={pretty(payloadText)} />
                </>
              )}
            </div>
            <div className="scroll">
              {payloadNote && <div className="shot-err">{payloadNote}</div>}
              <div className="kv">
                <div className="k">模块</div>
                <div className="v">{selected.mod}</div>
                <div className="k">方法</div>
                <div className="v">{selected.method}</div>
                <div className="k">通道</div>
                <div className="v">{selected.via}</div>
                <div className="k">callbackId</div>
                <div className="v">{selected.id}</div>
                <div className="k">调用</div>
                <div className="v">{selected.sync ? '同步' : '异步'}</div>
                <div className="k">状态</div>
                <div className={`v ${statusClass(selected)}`}>{statusLabel(selected)}</div>
                <div className="k">耗时</div>
                <div className="v num">{selected.cost !== undefined ? `${selected.cost} ms` : '—'}</div>
                {selected.kind === 'stream' && (
                  <>
                    <div className="k">回调次数</div>
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
              ) : tab === 'args' ? (
                <pre className="payload">{payloadNote && !selected.args ? payloadNote : pretty(selected.args)}</pre>
              ) : selected.sync && !selected.rsp && selected.ok ? (
                <div className="empty">
                  未采到同步返回值。请重新插桩编译（会在 NativeBridge.toNative 统一拦截返回值）。若该方法另有异步回调，回调仍会显示在这里。
                </div>
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

function FrameList({ frames }: { frames: NetworkFrameDto[] }) {
  if (frames.length === 0) {
    return <div className="empty">暂无回调数据。</div>;
  }
  return (
    <div className="frame-list">
      {frames.map((frame) => {
        const text = frame.data
          ? pretty(frame.data)
          : frame.dataChars
            ? `分片接收中 / ${frame.dataChars} 字符…`
            : pretty(undefined);
        return (
          <div className="frame" key={frame.seq}>
            <div className="frame-meta">
              <span className="frame-down">↓ 回调</span>
              <span>#{frame.seq}</span>
              <span className="num">{new Date(frame.ts).toLocaleTimeString()}</span>
              <span className="grow" />
              <CopyButton text={text} />
            </div>
            <pre className="payload">{text}</pre>
          </div>
        );
      })}
    </div>
  );
}

function statusClass(record: NativeCallDto): string {
  if (record.kind === 'stream' && record.ok === undefined) return 'status-open';
  if (record.ok === undefined) return 'status-pending';
  if (record.sync && !record.rsp && record.ok) return 'status-open';
  return record.ok ? 'status-ok' : 'status-bad';
}

function statusLabel(record: NativeCallDto): string {
  if (record.kind === 'stream') return record.ok === false ? '错误' : '监听';
  if (record.ok === undefined) return '等待';
  if (record.sync && !record.rsp && record.ok) return '同步';
  if (!record.sync && !record.rsp && record.ok) return '已调用';
  return record.ok ? '完成' : '失败';
}

function timeLabel(record: NativeCallDto): string {
  if (record.kind === 'stream') {
    const count = record.frames ?? record.msgs?.length ?? 0;
    return count > 0 ? `${count} 次` : '—';
  }
  return record.cost !== undefined ? `${record.cost}ms` : '—';
}

function pretty(text?: string): string {
  if (!text) return '（空）';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function transferNote(record: NativeCallDto, field: 'args' | 'rsp'): string | null {
  const text = field === 'args' ? record.args : record.rsp;
  const chars = field === 'args' ? record.argsChars : record.rspChars;
  const got = field === 'args' ? record.argsGot : record.rspGot;
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
