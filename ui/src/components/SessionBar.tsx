import type { ConnectionState } from '../store';
import type { DeviceInfo, SessionSummary } from '../protocol';

interface Props {
  connection: ConnectionState;
  sessions: SessionSummary[];
  activePagerId: string | null;
  device: DeviceInfo | null;
  sampleMs: number;
  onSelect: (pagerId: string) => void;
  onSampleChange: (value: number) => void;
}

const SAMPLE_CHOICES = [100, 200, 300, 500, 1000, 2000];

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
};

export function SessionBar({
  connection,
  sessions,
  activePagerId,
  device,
  sampleMs,
  onSelect,
  onSampleChange,
}: Props) {
  return (
    <div className="session-bar">
      <span className="brand">Kuikly 调试面板</span>
      <span>
        <span className={`dot ${connection}`} />
        {CONNECTION_LABEL[connection]}
      </span>

      <select value={activePagerId ?? ''} onChange={(event) => onSelect(event.target.value)}>
        {sessions.length === 0 && <option value="">未接入页面</option>}
        {sessions.map((session) => (
          <option key={session.pagerId} value={session.pagerId}>
            {session.page || session.className || '页面'} #{session.pagerId}
            {session.stale ? '（已失效）' : ''}
          </option>
        ))}
      </select>

      <label className="meta">
        采样{' '}
        <select value={sampleMs || 300} onChange={(event) => onSampleChange(Number(event.target.value))}>
          {SAMPLE_CHOICES.map((value) => (
            <option key={value} value={value}>
              {value}ms
            </option>
          ))}
        </select>
      </label>

      <span className="spacer" />

      {device && (
        <span className="meta">
          {[
            device.platform,
            device.osVersion && `系统 ${device.osVersion}`,
            device.appVersion && `应用 ${device.appVersion}`,
            device.density && `@${device.density}x`,
            device.pageWidth && device.pageHeight && `${round(device.pageWidth)}×${round(device.pageHeight)}`,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </span>
      )}
    </div>
  );
}

function round(value: number): number {
  return Math.round(value);
}
