import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { copyText } from '../copy';
import { editHint } from '../editHints';
import type { SupportedPropHandlers, PropDefinition, PropSchemaResult, EditHandler, NodeDto, ScreenshotDto } from '../protocol';
import { LIVE_SHOT_INTERVAL_MS, LIVE_SHOT_SAMPLE } from '../protocol';
import { hitTestNode, overlayBox, pathTo, visualFrame } from '../tree';

interface InspectorProps extends SupportedPropHandlers {
  onEdit: EditHandler;
  node: NodeDto | null;
  nodes: Map<number, NodeDto>;
  stateRequested: boolean;
  onRequestState: () => void;
  onSelect: (id: number) => void;
}

interface ScreenshotProps {
  node: NodeDto | null;
  nodes: Map<number, NodeDto>;
  screenshot: ScreenshotDto | null;
  onSelect: (id: number) => void;
  onCapture: (id: number, sample: number) => void;
  onLive: (on: boolean, sample: number) => void;
}

export function Inspector({
  node,
  nodes,
  stateRequested,
  onRequestState,
  onSelect,
  onEdit,
  ...supportedHandlers
}: InspectorProps) {
  return (
    <div className="scroll">
      {node ? (
        <NodeInspector
          key={node.id}
          {...supportedHandlers}
          onEdit={onEdit}
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

const FALLBACK_SHOT_W = 393;
const FALLBACK_SHOT_H = 852;

export function ScreenshotPane({
  node,
  nodes,
  screenshot,
  onSelect,
  onCapture,
  onLive,
}: ScreenshotProps) {
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
  const fitW = originW > 0 ? originW : FALLBACK_SHOT_W;
  const fitH = originH > 0 ? originH : FALLBACK_SHOT_H;

  const pickAt = (event: MouseEvent<HTMLDivElement>) => {
    if (!canPick || !screenshot) return null;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const fx = (event.clientX - box.left) / box.width;
    const fy = (event.clientY - box.top) / box.height;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
    const x = (screenshot.ox ?? 0) + fx * originW;
    const y = (screenshot.oy ?? 0) + fy * originH;
    return hitTestNode(nodes, x, y);
  };

  const hover = hoverId !== null ? nodes.get(hoverId) ?? null : null;
  const hoverBox = hover
    ? overlayBox(hover, screenshot?.ox ?? 0, screenshot?.oy ?? 0, originW, originH, nodes)
    : null;
  const selectedBox = node
    ? overlayBox(node, screenshot?.ox ?? 0, screenshot?.oy ?? 0, originW, originH, nodes)
    : null;

  const waitingHint = live
    ? liveArmed
      ? `树变化时更新，最快每 ${LIVE_SHOT_INTERVAL_MS / 1000}s 一次。正在等待首帧…`
      : '实时截图已暂停（标签页或预览不可见）。'
    : '开启实时，或手动截取一次。';

  return (
    <div className="split-shot">
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
          {[1, 2].map((value) => (
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
      <div ref={previewRef} className="shot-stage">
        {screenshot?.data ? (
          <div
            className={`shot-fit${canPick ? ' pickable' : ''}`}
            style={
              {
                '--shot-w': fitW,
                '--shot-h': fitH,
              } as CSSProperties
            }
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
        ) : (
          !screenshot?.err && <div className="shot-placeholder">{waitingHint}</div>
        )}
      </div>
      <div className="shot-meta">
        {screenshot?.data
          ? `${screenshot.live ? '实时 · ' : ''}nativeRef ${screenshot.id} · 采样 ${screenshot.sample}${
              canPick ? ' · 点击可选中节点' : ''
            }${hover ? ` · ${hover.c} #${hover.id}` : ''}`
          : '预览尺寸固定，采样只影响清晰度'}
      </div>
    </div>
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
  onEdit,
  ...supportedHandlers
}: SupportedPropHandlers & {
  onEdit: EditHandler;
  node: NodeDto;
  nodes: Map<number, NodeDto>;
  stateRequested: boolean;
  onRequestState: () => void;
  onSelect: (id: number) => void;
}) {
  const ancestry = pathTo(nodes, node.id);
  const visual = visualFrame(nodes, node);
  const layout = node.f;
  const showVisual =
    visual &&
    layout &&
    (visual[0] !== layout[0] || visual[1] !== layout[1] || visual[2] !== layout[2] || visual[3] !== layout[3]);

  return (
    <>
      {!node.e && (
        <div className="editing-notice" role="status">
          当前页面未提供编辑能力，属性和状态暂为只读。请使用新版 DevTools 重新插桩编译并重新加载设备页面，再点击“重新同步”。
        </div>
      )}
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
          {showVisual && visual && (
            <>
              <Row k="可视 X" v={roundVisual(visual[0])} />
              <Row k="可视 Y" v={roundVisual(visual[1])} />
              <Row k="可视宽" v={roundVisual(visual[2])} />
              <Row k="可视高" v={roundVisual(visual[3])} />
            </>
          )}
          <Row k="相对父级 X" v={node.lf?.[0] ?? '-'} />
          <Row k="相对父级 Y" v={node.lf?.[1] ?? '-'} />
        </div>
      </Section>

      <Section title={`属性 (${Object.keys(node.p ?? {}).length})`} defaultOpen>
        <Properties node={node} {...supportedHandlers} onEdit={(key, value) => onEdit('p', key, value)} />
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
                <KeyValues key={`s-${node.id}`} values={node.s} editable={node.e?.s} onEdit={(key, value) => onEdit('s', key, value)} emptyLabel="空" />
              </>
            )}
            {node.as && (
              <>
                <SubTitle>attr</SubTitle>
                <KeyValues key={`as-${node.id}`} values={node.as} editable={node.e?.as} onEdit={(key, value) => onEdit('as', key, value)} emptyLabel="空" />
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

function roundVisual(value: number): number {
  return Math.round(value * 100) / 100;
}

type BoxSides = { top: number; right: number; bottom: number; left: number };

function BoxModel({ node }: { node: NodeDto }) {
  const [x, y, w, h] = node.f ?? [0, 0, 0, 0];
  const margin = boxSides(node.p?.margin);
  const padding = boxSides(node.p?.padding);
  return (
    <div className="box-model">
      <BoxRing kind="margin" sides={margin}>
        <BoxRing kind="padding" sides={padding}>
          <div className="box-content">
            <span className="box-label">content</span>
            <div className="box-size">
              {w} × {h}
            </div>
            <div className="box-origin">
              {x}, {y}
            </div>
          </div>
        </BoxRing>
      </BoxRing>
    </div>
  );
}

function BoxRing({
  kind,
  sides,
  children,
}: {
  kind: string;
  sides: BoxSides;
  children: ReactNode;
}) {
  return (
    <div className={`box-ring ${kind}`}>
      <span className="box-label">{kind}</span>
      <span className="box-side top">{formatBoxNum(sides.top)}</span>
      <span className="box-side right">{formatBoxNum(sides.right)}</span>
      <span className="box-side bottom">{formatBoxNum(sides.bottom)}</span>
      <span className="box-side left">{formatBoxNum(sides.left)}</span>
      <div className="box-ring-inner">{children}</div>
    </div>
  );
}

/** Agent emits a number for `margin(10f)` and `{top,left,bottom,right}` for mixed sides. */
function boxSides(value: unknown): BoxSides {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { top: value, right: value, bottom: value, left: value };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const num = (key: string) => {
      const item = record[key];
      return typeof item === 'number' && Number.isFinite(item) ? item : 0;
    };
    return { top: num('top'), right: num('right'), bottom: num('bottom'), left: num('left') };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function formatBoxNum(value: number): string {
  if (value === 0) return '0';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function KeyValues({ values, emptyLabel, editable, onEdit }: {
  values?: Record<string, unknown>; emptyLabel: string;
  editable?: Record<string, string>;
  onEdit: (key: string, value: unknown) => Promise<void>;
}) {
  const entries = sortedEntries(values);
  if (entries.length === 0) return <div className="empty">{emptyLabel}</div>;
  return (
    <>
      {editable && !entries.some(([key]) => editable[key]) && (
        <div className="editing-notice">
          当前字段均为只读；仅支持可写的基础类型、Color 和布局属性。
        </div>
      )}
      <div className="kv">
        {entries.map(([key, value]) => (
          <Row key={key} k={key} v={value} editType={editable?.[key]} onEdit={(value) => onEdit(key, value)} />
        ))}
      </div>
    </>
  );
}

const FOLD_CHARS = 80;
const FOLD_LINES = 3;

function Row({ k, v, editType, onEdit, hint }: {
  k: string; v: unknown; editType?: string; hint?: string; onEdit?: (value: unknown) => Promise<void>;
}) {
  const hex = typeof v === 'string' && /^0x[0-9A-F]{8}$/.test(v) ? v : null;
  const colorEditable = editType?.startsWith('Color') || (/color|tint/i.test(k) && /^(String|Int|Long)\??$/.test(editType ?? ''));
  const editable = Boolean(editType && onEdit);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const editActive = useRef(false);
  const savePending = useRef(false);
  const initialDraft = useRef('');
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = () => {
    if (!editable || savePending.current || editActive.current) return;
    initialDraft.current = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
    setDraft(initialDraft.current);
    setEditError('');
    composing.current = false;
    editActive.current = true;
    setEditing(true);
  };

  const cancelEdit = () => {
    editActive.current = false;
    setEditing(false);
    setDraft(initialDraft.current);
  };

  const save = async () => {
    // Enter unmounts the editor and can also cause blur. Claim the edit synchronously,
    // before React renders or the device responds, so it is only submitted once.
    if (!editActive.current || savePending.current || !onEdit || !editType) return;
    editActive.current = false;
    setEditing(false);
    if (draft === initialDraft.current) return;
    try {
      let value: unknown = draft;
      if (draft === 'null' && editType.endsWith('?')) value = null;
      else if (colorEditable || editType.startsWith('String') || editType.startsWith('Char') || editType.startsWith('enum:')) {
        value = draft.startsWith('"') ? JSON.parse(draft) : draft;
      } else value = JSON.parse(draft);
      savePending.current = true;
      setSaving(true);
      setEditError('');
      await onEdit(value);
    } catch (error) {
      // The displayed value comes from device readback, never from the invalid draft.
      setDraft(initialDraft.current);
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };
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
        {editing ? (
          <div className="inline-value-editor">
            <textarea
              ref={inputRef}
              className="value-input"
              aria-label={`编辑 ${k}`}
              rows={Math.min(6, Math.max(1, draft.split('\n').length))}
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void save()}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={(event) => {
                // Let Enter confirm Chinese/Japanese input before it can submit a value.
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEdit();
                } else if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            <div className="edit-hint">{hint ?? (editType && editHint(k, editType))}</div>
            <div className="edit-hint">回车或失焦应用 · Esc 取消 · Shift+Enter 换行</div>
          </div>
        ) : (
          <span
            className={`v-body${editable ? ' editable' : ''}${saving ? ' saving' : ''}`}
            role={editable ? 'button' : undefined}
            tabIndex={editable && !saving ? 0 : undefined}
            aria-label={editable ? `编辑 ${k}：${text}` : undefined}
            aria-disabled={editable && saving ? true : undefined}
            title={editable ? '点击编辑，回车或失焦应用；Esc 取消，Shift+Enter 换行' : undefined}
            onClick={editable ? beginEdit : long && !open ? () => setOpen(true) : undefined}
            onKeyDown={editable ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                beginEdit();
              }
            } : undefined}
          >
            {hex && <span className="color-chip" style={{ backgroundColor: argbCss(hex) }} />}
            {shown || (editable ? '\u00a0' : '')}
          </span>
        )}
        {!long && !editing && copyButton}
        {saving && <span className="edit-status" role="status">应用中…</span>}
        {editError && <div className="edit-error" role="alert">{editError}</div>}
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

function valueClass(_key: string, value: unknown): string {
  if (typeof value === 'string' && /^0x[0-9A-F]{8}$/.test(value)) return 'color';
  if (typeof value === 'number') return 'num';
  if (typeof value === 'boolean') return 'bool';
  // The agent writes this marker when a getter threw or a lateinit was still unset.
  if (typeof value === 'string' && value.startsWith('<unreadable')) return 'unreadable';
  return '';
}

function format(_key: string, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    try {
      const sorted = sortedJson(value);
      const compact = JSON.stringify(sorted);
      if (compact.length <= FOLD_CHARS) return compact;
      return JSON.stringify(sorted, null, 2);
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
      out[key] = sortedJson(nested);
    }
    return out;
  }
  return value;
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

function schemaEditType(def: PropDefinition): string {
  return def.inputType === 'color' ? 'Color' : def.inputType === 'enum'
    ? `enum:${def.enumValues?.join(',')}` : def.wireType;
}

function Properties({ node, canSetSupported, onQueryProps, onSetSupported, onEdit }:
  SupportedPropHandlers & { node: NodeDto; onEdit: (key: string, value: unknown) => Promise<void> }) {
  const [schema, setSchema] = useState<PropSchemaResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let active = true;
    setSchema(null);
    setAdding(false);
    if (canSetSupported) void onQueryProps(node.id).then((value) => {
      if (active) setSchema(value);
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; alive.current = false; };
    // Query once per selected node/capability; callbacks change on every live snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, canSetSupported]);
  const open = async () => {
    setLoading(true); setError('');
    try {
      const fresh = await onQueryProps(node.id);
      if (alive.current) { setSchema(fresh); setAdding(true); }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setLoading(false); }
  };
  const definitions = schema?.properties ?? [];
  const missing = definitions.filter((def) => !Object.prototype.hasOwnProperty.call(node.p ?? {}, def.key));
  const set = async (key: string, value: unknown) => {
    if (!schema) throw new Error('请重新查询属性');
    await onSetSupported(node.id, key, value, schema.schemaToken);
  };
  return <>
    <div className="prop-toolbar">
      <button disabled={!canSetSupported || loading || node.r === false} onClick={() => void open()}
        title={!canSetSupported ? '需要新版服务和重新构建加载的页面' : node.r === false ? '虚拟节点暂不支持新增属性' : '选择当前节点支持的属性'}>
        {loading ? '查询中…' : '＋ 添加属性'}
      </button>
      {!canSetSupported && <span className="edit-hint">更新服务并重新构建、加载页面后可添加属性</span>}
    </div>
    {error && <div className="edit-error" role="alert">{error}</div>}
    {adding && <AddProperty key={schema?.schemaToken} definitions={missing} reason={schema?.reason}
      onCancel={() => setAdding(false)} onApply={async (key, value) => { await set(key, value); setAdding(false); }} />}
    {Object.keys(node.p ?? {}).length === 0 && <div className="empty">未设置属性</div>}
    <div className="kv">
      {sortedEntries(node.p).map(([key, value]) => {
        const def = definitions.find((item) => item.key === key);
        // Do not change legacy p/e wire types; only the semantic editor displays Boolean inputs.
        const semanticValue = def?.inputType === 'boolean' && typeof value === 'number' ? value !== 0 : value;
        return <Row key={key} k={key} v={semanticValue} editType={def ? schemaEditType(def) : node.e?.p?.[key]}
          hint={def?.description} onEdit={(v) => def ? set(key, v) : onEdit(key, v)} />;
      })}
    </div>
  </>;
}

function AddProperty({ definitions, reason, onCancel, onApply }: {
  definitions: PropDefinition[]; reason?: string; onCancel: () => void;
  onApply: (key: string, value: unknown) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  const pending = useRef(false);
  const composing = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const def = definitions.find((item) => item.key === key);
  useEffect(() => { if (key) field.current?.focus(); }, [key]);
  const save = async () => {
    if (!def || !dirty.current || pending.current) return;
    dirty.current = false; pending.current = true; setSaving(true); setError('');
    try {
      const value = ['color', 'string', 'enum'].includes(def.inputType)
        ? (draft.startsWith('"') ? JSON.parse(draft) : draft) : JSON.parse(draft);
      await onApply(def.key, value);
    } catch (e) {
      setDraft(''); setError(e instanceof Error ? e.message : String(e));
    } finally { pending.current = false; setSaving(false); }
  };
  return <div className="add-property">
    <div className="prop-toolbar">
      <input aria-label="搜索可添加属性" placeholder="搜索属性" value={query} disabled={saving} onChange={(e) => setQuery(e.target.value)} />
      <button disabled={saving} onMouseDown={() => { dirty.current = false; }} onClick={onCancel}>关闭</button>
    </div>
    {definitions.length === 0 ? <div className="edit-hint">{reason || '当前支持的属性均已展示'}</div> :
      <select aria-label="选择新增属性" value={key} disabled={saving} onChange={(e) => {
        dirty.current = false; setKey(e.target.value); setDraft(''); setError('');
      }}>
        <option value="">选择属性…</option>
        {['基础外观', '布局', '文本'].map((group) => <optgroup key={group} label={group}>
          {definitions.filter((item) => item.group === group && item.key.toLowerCase().includes(query.toLowerCase()))
            .map((item) => <option key={item.key} value={item.key}>{item.key}</option>)}
        </optgroup>)}
      </select>}
    {def && <>
      <textarea ref={field} className="value-input" aria-label={`新增 ${key}`} value={draft} disabled={saving}
        placeholder={def.examples?.[0] ?? (def.readable ? `当前值：${JSON.stringify(def.currentValue)}` : '输入属性值')}
        onChange={(e) => { dirty.current = true; setDraft(e.target.value); }} onBlur={() => { if (!composing.current) void save(); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(e) => {
          if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Escape') { e.preventDefault(); dirty.current = false; onCancel(); }
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); }
        }} />
      <div className="edit-hint">{def.description}</div>
      <div className="edit-hint">回车或失焦应用 · Esc 取消 · Shift+Enter 换行</div>
    </>}
    {saving && <div className="edit-hint">等待设备确认…</div>}
    {error && <div className="edit-error" role="alert">{error}；草稿已清空，请以设备实际值为准</div>}
  </div>;
}
