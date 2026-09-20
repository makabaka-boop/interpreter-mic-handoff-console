import type { RigSnapshot } from '../core/types';

export function CapabilityPanel({ snap }: { snap: RigSnapshot }) {
  const items: { ok: boolean | null; label: string }[] = [
    {
      ok: snap.permission !== 'unsupported',
      label: 'MediaDevices（麦克风枚举/申请）',
    },
    { ok: snap.hasWebAudio, label: 'Web Audio API（AudioContext 耳返）' },
    { ok: snap.isSecureContext, label: '安全上下文（HTTPS 或 localhost）' },
    {
      ok: snap.permission === 'granted',
      label: `麦克风权限：${
        snap.permission === 'granted'
          ? '已获得'
          : snap.permission === 'denied'
            ? '被拒绝'
            : snap.permission === 'prompting'
              ? '请求中'
              : '未获得'
      }`,
    },
  ];
  return (
    <section className="panel">
      <h2>浏览器能力</h2>
      <ul className="capability-list">
        {items.map((it) => (
          <li key={it.label} data-testid={`cap-${it.label}`}>
            <span
              className={`dot ${it.ok ? 'ok' : 'err'}`}
              aria-hidden="true"
            />
            {it.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
