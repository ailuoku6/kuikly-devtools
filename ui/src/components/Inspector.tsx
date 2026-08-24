import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { copyText } from '../copy';
import type { NodeDto, ScreenshotDto } from '../protocol';
import { LIVE_SHOT_INTERVAL_MS, LIVE_SHOT_SAMPLE } from '../protocol';
import { hitTestNode, overlayBox, pathTo } from '../tree';

interface Props {
  node: NodeDto | null;
  nodes: Map<number, NodeDto>;
  stateRequested: boolean;
  screenshot: ScreenshotDto | null;
  onRequestState: () => void;
  onSelect: (id: number) => void;
  onCapture: (id: number, sample: number) => void;
  onLive: (on: boolean, sample: number) => void;
}

export function Inspector({
  node,
  nodes,
  stateRequested,
  screenshot,
  onRequestState,
  onSelect,
  onCapture,
  onLive,
}: Props) {
  return (
    <div className="scroll">
      <ScreenshotSection
        node={node}
        nodes={nodes}
        screenshot={screenshot}
        onSelect={onSelect}
        onCapture={onCapture}
        onLive={onLive}
      />
      {node ? (
        <NodeInspector
          node={node}
          nodes={nodes}
          stateRequested={stateRequested}
          onRequestState={onRequestState}
          onSelect={onSelect}
        />
      ) : (
        <div className="empty">请选择一个节点查看属性。</div>
      )}
    </div>
  );
}

function ScreenshotSection({
  node,
  nodes,
  screenshot,
  onSelect,
  onCapture,
  onLive,
}: {
  node: NodeDto | null;
  nodes: Map<number, NodeDto>;
  screenshot: ScreenshotDto | null;
  onSelect: (id: number) => void;
  onCapture: (id: number, sample: number) => void;
  onLive: (on: boolean, sample: number) => void;
}) {
  const [sample, setSample] = useState(LIVE_SHOT_SAMPLE);
  const [live, setLive] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  const [previewVisible, setPreviewVisible] = useState(true);
  const previewRef = useRef<HTMLDivElement>(null);
  const lastTs = screenshot?.ts ?? 0;

  useEffect(() => {
    setWaiting(false);
  }, [lastTs]);

  useEffect(() => {
    const sync = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setPreviewVisible(entry.isIntersecting);
      },
      { threshold: 0.05 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const liveArmed = live && tabVisible && previewVisible;

  useEffect(() => {
    onLive(liveArmed, sample);
    return () => onLive(false, sample);
  }, [liveArmed, sample, onLive]);

  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setTimeout(() => setWaiting(false), 12000);
    return () => window.clearTimeout(timer);
  }, [waiting, lastTs]);

  const nodeDisabled = !node || node.r === false;
  const nodeTitle = !node
    ? '请先选择一个节点'
    : node.r === false
      ? '虚拟节点没有 RenderView，无法截图'
      : '通过 toImage 截取当前节点';

  const originW = screenshot?.ow ?? 0;
  const originH = screenshot?.oh ?? 0;
  const canPick = originW > 0 && originH > 0 && nodes.size > 0;

  const pickAt = (event: MouseEvent<HTMLDivElement>) => {
    if (!canPick || !screenshot) return null;
    const stage = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - stage.left) / stage.width;
    const fy = (event.clientY - stage.top) / stage.height;
    const x = (screenshot.ox ?? 0) + fx * originW;
    const y = (screenshot.oy ?? 0) + fy * originH;
    return hitTestNode(nodes, x, y);
  };

  const hover = hoverId !== null ? nodes.get(hoverId) ?? null : null;
  const hoverBox = hover
    ? overlayBox(hover, screenshot?.ox ?? 0, screenshot?.oy ?? 0, originW, originH)
    : null;
  const selectedBox = node
    ? overlayBox(node, screenshot?.ox ?? 0, screenshot?.oy ?? 0, originW, originH)
    : null;

  return (
    <Section title="截图" defaultOpen>
      <div ref={previewRef}>
      <div className="shot-toolbar">
        <button
          className={live ? 'active' : ''}
          title={`树发生变化时截取，最快每 ${LIVE_SHOT_INTERVAL_MS}ms 一次。标签页或预览不可见时会暂停。`}
          onClick={() => setLive((value) => !value)}
        >
          {live ? `实时 ${LIVE_SHOT_INTERVAL_MS / 1000}s` : '关闭实时'}
        </button>
        <button
          disabled={waiting}
          title="通过 Pager.toImage 截取整页"
          onClick={() => {
            setWaiting(true);
            onCapture(0, sample);
          }}
        >
          {waiting ? '截取中…' : '截取页面'}
        </button>
        <button
          disabled={waiting || nodeDisabled}
          title={nodeTitle}
          onClick={() => {
            if (!node) return;
            setWaiting(true);
            onCapture(node.id, sample);
          }}
        >
          截取节点
        </button>
        <span className="shot-sample">
          采样
          {[1, 2, 4].map((value) => (
            <button
              key={value}
              className={sample === value ? 'active' : ''}
              title="采样越大，图片越小、越快"
              onClick={() => setSample(value)}
            >
              {value}
            </button>
          ))}
        </span>
      </div>
      {screenshot?.err && <div className="shot-err">{screenshot.err}</div>}
      {screenshot?.data ? (
        <div className="shot-preview">
          <div
            className={`shot-stage${canPick ? ' pickable' : ''}`}
            onMouseMove={(event) => {
              const hit = pickAt(event);
              setHoverId(hit?.id ?? null);
            }}
            onMouseLeave={() => setHoverId(null)}
            onClick={(event) => {
              const hit = pickAt(event);
              if (hit) onSelect(hit.id);
            }}
          >
            <img src={screenshot.data} alt={`节点 ${screenshot.id} 的截图`} draggable={false} />
            {selectedBox && <div className="shot-box selected" style={boxStyle(selectedBox)} />}
            {hoverBox && hover?.id !== node?.id && (
              <div className="shot-box hover" style={boxStyle(hoverBox)} />
            )}
          </div>
          <div className="shot-meta">
            {screenshot.live ? '实时 · ' : ''}
            nativeRef {screenshot.id} · 采样 {screenshot.sample}
            {canPick ? ' · 点击可选中节点' : ''}
            {hover ? ` · ${hover.n} #${hover.id}` : ''}
          </div>
        </div>
      ) : (
        !screenshot?.err && (
          <div className="empty" style={{ padding: '12px 10px' }}>
            {live
              ? liveArmed
                ? `实时截图：树变化时更新，最快每 ${LIVE_SHOT_INTERVAL_MS / 1000}s 一次。正在等待首帧…`
                : '实时截图已暂停（标签页或预览不可见）。'
              : '基于 DeclarativeBaseView.toImage。可开启实时，或手动截取一次。'}
          </div>
        )
      )}
      </div>
    </Section>
  );
}

function boxStyle(box: { left: number; top: number; width: number; height: number }): CSSProperties {
  return {
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
  };
}

function NodeInspector({
  node,
  nodes,
  stateRequested,
  onRequestState,
  onSelect,
}: {
  node: NodeDto;
  nodes: Map<number, NodeDto>;
  stateRequested: boolean;
  onRequestState: () => void;
  onSelect: (id: number) => void;
}) {
  const ancestry = pathTo(nodes, node.id);

  return (
    <>
      <Section title="节点" defaultOpen>
        <div className="kv">
          <Row k="nativeRef" v={node.id} />
          <Row k="viewName" v={node.n} />
          <Row k="class" v={node.c} />
          <Row k="renderView" v={node.r} />
          <Row k="composeView" v={node.cv} />
          <div className="k">路径</div>
          <div className="v">
            {ancestry.map((step, index) => (
              <span key={step.id}>
                {index > 0 && ' › '}
                <a
                  href="#"
                  style={{ color: 'var(--accent)' }}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(step.id);
                  }}
                >
                  {step.n}
                </a>
              </span>
            ))}
          </div>
        </div>
      </Section>

      <Section title="布局" defaultOpen>
        <BoxModel node={node} />
        <div className="kv">
          <Row k="页面 X" v={node.f?.[0] ?? '-'} />
          <Row k="页面 Y" v={node.f?.[1] ?? '-'} />
          <Row k="宽度" v={node.f?.[2] ?? '-'} />
          <Row k="高度" v={node.f?.[3] ?? '-'} />
          <Row k="相对父级 X" v={node.lf?.[0] ?? '-'} />
          <Row k="相对父级 Y" v={node.lf?.[1] ?? '-'} />
        </div>
      </Section>

      <Section title={`属性 (${Object.keys(node.p ?? {}).length})`} defaultOpen>
        <KeyValues key={`p-${node.id}`} values={node.p} emptyLabel="未设置属性" />
      </Section>

      <Section title="状态" defaultOpen>
        {!node.hs ? (
          <div className="empty">
            该节点没有可调试的状态。
            <br />
            <span style={{ fontSize: 11 }}>
              成员变量仅对插桩编译的模块中的类可用。
            </span>
          </div>
        ) : !node.s && !node.as ? (
          <div className="empty">
            {stateRequested ? (
              '等待下一次采样…'
            ) : (
              <button onClick={onRequestState}>拉取成员变量</button>
            )}
          </div>
        ) : (
          <>
            {node.s && (
              <>
                <SubTitle>view</SubTitle>
                <KeyValues key={`s-${node.id}`} values={node.s} emptyLabel="空" />
              </>
            )}
            {node.as && (
              <>
                <SubTitle>attr</SubTitle>
                <KeyValues key={`as-${node.id}`} values={node.as} emptyLabel="空" />
              </>
            )}
          </>
        )}
      </Section>
    </>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '4px 10px', color: 'var(--text-faint)', fontSize: 10 }}>
      {children}
    </div>
  );
}

function BoxModel({ node }: { node: NodeDto }) {
  const [x, y, w, h] = node.f ?? [0, 0, 0, 0];
  return (
    <div className="box-model">
      <div className="outer">
        <span className="corner tl">
          {x}, {y}
        </span>
        <div className="inner">
          {w} × {h}
        </div>
      </div>
    </div>
  );
}

function KeyValues({ values, emptyLabel }: { values?: Record<string, unknown>; emptyLabel: string }) {
  const entries = sortedEntries(values);
  if (entries.length === 0) return <div className="empty">{emptyLabel}</div>;
  return (
    <div className="kv">
      {entries.map(([key, value]) => (
        <Row key={key} k={key} v={value} />
      ))}
    </div>
  );
}

const FOLD_CHARS = 80;
const FOLD_LINES = 3;

function Row({ k, v }: { k: string; v: unknown }) {
  const hex = isColorKey(k) ? toArgbHex(v) : null;
  const text = format(k, v);
  const long = needsFold(text);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const shown = !long || open ? text : foldPreview(text);

  const copyValue = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const copyButton = (
    <button type="button" className="v-copy" onClick={copyValue} title="复制属性值">
      {copied ? '已复制' : '复制'}
    </button>
  );

  return (
    <>
      <div className="k">{k}</div>
      <div className={`v ${valueClass(k, v)}${long ? ' foldable' : ''}${long && !open ? ' collapsed' : ''}`}>
        {long && (
          <span className="v-actions">
            <button
              type="button"
              className="v-toggle"
              onClick={() => setOpen((value) => !value)}
              title={open ? '收起' : '展开'}
            >
              {open ? '▾ 收起' : `▸ 展开（${formatSize(text.length)}）`}
            </button>
            {copyButton}
          </span>
        )}
        <span className="v-body" onClick={long && !open ? () => setOpen(true) : undefined}>
          {hex && <span className="color-chip" style={{ backgroundColor: argbCss(hex) }} />}
          {shown}
        </span>
        {!long && copyButton}
      </div>
    </>
  );
}

function needsFold(text: string): boolean {
  if (text.length > FOLD_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > FOLD_LINES) return true;
    }
  }
  return false;
}

function foldPreview(text: string): string {
  const lines = text.split('\n');
  if (lines.length > FOLD_LINES) return `${lines.slice(0, FOLD_LINES).join('\n')}\n…`;
  if (text.length > FOLD_CHARS) return `${text.slice(0, FOLD_CHARS)}…`;
  return text;
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}`;
  if (chars < 10000) return `${(chars / 1000).toFixed(1)}k`;
  return `${Math.round(chars / 1000)}k`;
}

function valueClass(key: string, value: unknown): string {
  if (isColorKey(key) && toArgbHex(value)) return 'color';
  if (typeof value === 'number') return 'num';
  if (typeof value === 'boolean') return 'bool';
  // The agent writes this marker when a getter threw or a lateinit was still unset.
  if (typeof value === 'string' && value.startsWith('<unreadable')) return 'unreadable';
  return '';
}

function format(key: string, value: unknown): string {
  if (isColorKey(key)) {
    const hex = toArgbHex(value);
    if (hex) return hex;
  }
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(sortedJson(value), null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Stable A→Z order so a single prop update does not reshuffle the inspector. */
function sortedEntries(values?: Record<string, unknown>): [string, unknown][] {
  return Object.entries(values ?? {}).sort((left, right) => {
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    return 0;
  });
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of sortedEntries(value as Record<string, unknown>)) {
      out[key] = isColorKey(key) ? toArgbHex(nested) ?? sortedJson(nested) : sortedJson(nested);
    }
    return out;
  }
  return value;
}

function isColorKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('color') || lower.includes('tint');
}

/** Signed ARGB Int `-14101165` and unsigned decimal from Color.toString() both become `0xAARRGGBB`. */
function toArgbHex(value: unknown): string | null {
  let bits: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) === value) {
    bits = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (/^0x[0-9a-fA-F]{1,8}$/i.test(text)) bits = parseInt(text, 16);
    else if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)) {
      const body = text.length === 7 ? `FF${text.slice(1)}` : text.slice(1);
      bits = parseInt(body, 16);
    } else if (/^-?\d+$/.test(text)) bits = Number(text);
  }
  if (bits === null) return null;
  return `0x${(bits >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function argbCss(hex: string): string {
  const n = parseInt(hex.slice(2), 16) >>> 0;
  const alpha = ((n >>> 24) & 0xff) / 255;
  const red = (n >>> 16) & 0xff;
  const green = (n >>> 8) & 0xff;
  const blue = n & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="inspector-section">
      <h3 onClick={() => setOpen((value) => !value)}>
        <span>{open ? '▾' : '▸'}</span>
        {title}
      </h3>
      {open && children}
    </div>
  );
}
