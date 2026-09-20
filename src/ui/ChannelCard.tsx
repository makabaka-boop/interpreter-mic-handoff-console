import type { ChannelSnapshot, DeviceItem, RigSnapshot } from '../core/types';
import { engine } from '../state/useRig';
import {
  ROLE_LABEL,
  channelPhaseBadge,
  channelPhaseText,
} from './labels';

interface Props {
  snap: RigSnapshot;
  channel: ChannelSnapshot;
  devices: DeviceItem[];
  onAudition: () => void;
  onStop: () => void;
}

export function ChannelCard({
  snap,
  channel,
  devices,
  onAudition,
  onStop,
}: Props) {
  const role = channel.role;
  const isLive = channel.phase === 'live-audition';
  const armedPrimary =
    role === 'primary' && (snap.phase === 'armed' || snap.phase === 'switching');
  const selectDisabled =
    snap.phase === 'arming' ||
    snap.phase === 'armed' ||
    snap.phase === 'switching' ||
    snap.phase === 'running-backup';
  const auditionDisabled =
    role === 'primary' ? !snap.can.auditionPrimary : !snap.can.auditionBackup;

  const selected = devices.find((d) => d.deviceId === channel.deviceId);
  const levelPct = Math.round(channel.level * 100);

  const cardClass = [
    'channel-card',
    armedPrimary ? 'armed' : '',
    isLive ? 'live' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cardClass} data-testid={`card-${role}`}>
      <div className="channel-title">
        {role === 'primary' ? '🎙️ 主输入' : '🔈 备输入'}
        {channel.active && (
          <span className="badge ok" data-testid={`active-${role}`}>
            活动输出
          </span>
        )}
        {isLive && (
          <span className="mic-on" data-testid={`mic-on-${role}`}>
            <span className="dot" aria-hidden="true" />
            麦克风占用中
          </span>
        )}
      </div>

      <select
        aria-label={`${ROLE_LABEL[role]}设备`}
        data-testid={`select-${role}`}
        value={channel.deviceId ?? ''}
        disabled={selectDisabled}
        onChange={(e) => engine.selectDevice(role, e.target.value)}
      >
        <option
          value=""
          disabled
        >
          {devices.length === 0 ? '暂无可用音频输入设备' : '选择音频输入设备…'}
        </option>
        {devices.map((d) => (
          <option
            key={d.deviceId}
            value={d.deviceId}
          >
            {d.label}
          </option>
        ))}
      </select>

      <div className="meter" aria-hidden="true">
        <div
          className="meter-fill"
          data-testid={`meter-${role}`}
          style={{ width: `${levelPct}%` }}
        />
      </div>

      <div className="kv">
        <span>轨道状态</span>
        <b>
          <span
            className={`badge ${channelPhaseBadge(channel.phase)}`}
            data-testid={`phase-${role}`}
          >
            {channelPhaseText(channel.phase)}
          </span>
        </b>
        <span>当前设备</span>
        <b data-testid={`device-${role}`}>{selected?.label ?? '—'}</b>
      </div>

      <div className="channel-actions">
        <button
          className="primary"
          data-testid={`audition-${role}`}
          disabled={auditionDisabled}
          onClick={onAudition}
        >
          试听
        </button>
        <button
          data-testid={`stop-audition-${role}`}
          disabled={
            !isLive ||
            snap.phase === 'switching' ||
            snap.phase === 'running-backup'
          }
          onClick={onStop}
        >
          停止试听
        </button>
      </div>
    </div>
  );
}
