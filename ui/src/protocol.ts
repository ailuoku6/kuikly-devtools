/** Mirrors PROTOCOL.md. Keys are short on purpose: a full tree carries thousands of nodes.
 *  Device ingest extras: `sid` (session identity) and `destroyed` (pager gone, drop the archive).
 */

export interface NodeDto {
  id: number;
  pid: number;
  /** index within the parent's templateChildren(), so siblings keep DSL order */
  ci?: number;
  /** viewName(), the native component name */
  n: string;
  /** Kotlin class simple name */
  c: string;
  /** has a RenderView (false = virtual / flattened) */
  r: boolean;
  /** is a ComposeView */
  cv: boolean;
  /** [x, y, w, h] in page-root coordinates */
  f?: [number, number, number, number];
  /** [x, y] within the dom parent */
  lf?: [number, number];
  /** attr.copyPropsMap() */
  p?: Record<string, unknown>;
  /** a state dumper is installed */
  hs?: boolean;
  /** instrumented member variables of the view */
  s?: Record<string, unknown>;
  /** instrumented member variables of the ComposeAttr */
  as?: Record<string, unknown>;
}

export type LogLevel = 'i' | 'd' | 'e' | 'p';

export interface LogDto {
  seq: number;
  lv: LogLevel;
  tag: string;
  msg: string;
  ts: number;
}

export interface NetworkFrameDto {
  seq: number;
  dir: 'up' | 'down';
  ts: number;
  data?: string;
  dataChars?: number;
}

export interface NetworkDto {
  id: string;
  url: string;
  method: string;
  stack: string;
  req?: string;
  /** Request headers as a JSON object string (`{"Content-Type":"application/json"}`). */
  hdr?: string;
  ts: number;
  cost?: number;
  status?: number;
  ok?: boolean;
  rsp?: string;
  err?: string;
  /** Present when the body is (or was) chunked. */
  reqChars?: number;
  rspChars?: number;
  reqGot?: number;
  rspGot?: number;
  reqChunks?: number;
  rspChunks?: number;
  /** http (default) or a long-lived subscribe (TMLongLink / QMLink / MQTT) */
  kind?: 'http' | 'stream';
  /** Incremental frames; the server concatenates them for the lifetime of the subscribe. */
  msgs?: NetworkFrameDto[];
  frames?: number;
}

export interface BodyBlobDto {
  id: string;
  field: 'req' | 'rsp' | 'frame' | string;
  index: number;
  count: number;
  data: string;
  seq?: number;
  dir?: 'up' | 'down';
  ts?: number;
}

export interface ScreenshotDto {
  id: number;
  ts: number;
  sample: number;
  /** `data:image/png;base64,...` when the capture succeeded */
  data?: string;
  err?: string;
  /** Page-root origin and size of the captured view; same units as NodeDto.f */
  ox?: number;
  oy?: number;
  ow?: number;
  oh?: number;
  live?: boolean;
}

export interface DeviceInfo {
  platform?: string;
  osVersion?: string;
  appVersion?: string;
  density?: number;
  pageWidth?: number;
  pageHeight?: number;
  deviceWidth?: number;
  deviceHeight?: number;
  statusBarHeight?: number;
  params?: unknown;
  error?: string;
}

export interface SessionSummary {
  pagerId: string;
  page: string;
  className: string;
  platform: string;
  nodeCount: number;
  logCount: number;
  networkCount: number;
  /** Logs the device's ring buffer had to drop; surfaced so the console never silently lies. */
  droppedLogs: number;
  sampleMs: number;
  lastSeenAt: number;
  firstSeenAt: number;
  stale: boolean;
}

export interface FullSessionState extends SessionSummary {
  device: DeviceInfo | null;
  nodes: NodeDto[];
  logs: LogDto[];
  network: NetworkDto[];
  stateNodeIds: number[];
  screenshot?: ScreenshotDto | null;
}

export interface DeltaMessage {
  type: 'delta';
  pagerId: string;
  full: boolean;
  meta: SessionSummary;
  device: DeviceInfo | null;
  nodes: NodeDto[];
  removed: number[];
  logs: LogDto[];
  network: NetworkDto[];
  screenshot?: ScreenshotDto;
  blobs?: BodyBlobDto[];
}

export type ServerMessage =
  | { type: 'hello'; sessions: SessionSummary[] }
  | { type: 'snapshot'; session: FullSessionState }
  | DeltaMessage
  | { type: 'session-added'; summary: SessionSummary }
  | { type: 'session-removed'; pagerId: string }
  | { type: 'cleared'; pagerId: string }
  | { type: 'error'; message: string };

export type DeviceCommand =
  | { type: 'full' }
  | { type: 'state'; ids: number[] }
  | { type: 'sample'; value: number }
  | { type: 'clear' }
  | { type: 'shot'; id?: number; sample?: number }
  | { type: 'live'; on: boolean; interval?: number; sample?: number };

/** Live page capture. Kept well below a video stream so toImage does not cook the device. */
export const LIVE_SHOT_INTERVAL_MS = 2000;
/** Default sampleSize for live frames (larger = fewer pixels, cheaper encode). */
export const LIVE_SHOT_SAMPLE = 4;
