import { engine, useRig } from './state/useRig';
import { CapabilityPanel } from './ui/CapabilityPanel';
import { ChannelCard } from './ui/ChannelCard';
import {
  permissionBadge,
  permissionText,
  rigPhaseBadge,
  rigPhaseText,
} from './ui/labels';

export default function App() {
  const snap = useRig();

  return (
    <div className="app">
      <header className="app-header">
        <h1>同声传译麦克风切换校验台</h1>
        <p>
          纯前端离线运行：仅使用浏览器真实的 MediaDevices 与 Web Audio
          API，无任何服务端接口。请先授权，再分别选择主、备输入试听。
        </p>
      </header>

      {snap.phase === 'no-support' && (
        <div className="unsupported-banner" data-testid="unsupported-banner">
          当前浏览器缺少 MediaDevices 接口，无法使用麦克风。请改用最新版
          Chrome / Edge / Firefox，并通过 HTTPS 或 localhost 访问本页。
        </div>
      )}
      {snap.permission === 'denied' && (
        <div className="unsupported-banner" data-testid="denied-banner">
          麦克风权限被拒绝。请点击浏览器地址栏的站点权限图标，允许麦克风后重新授权。
        </div>
      )}

      <CapabilityPanel snap={snap} />

      <section className="panel">
        <h2>授权</h2>
        <div className="status-bar">
          <span
            className={`badge ${permissionBadge(snap.permission)}`}
            data-testid="permission-state"
          >
            权限：{permissionText(snap.permission)}
          </span>
          <span className="spacer" />
          <button
            className="primary"
            data-testid="request-permission"
            disabled={!snap.can.requestPermission}
            onClick={() => void engine.requestPermission()}
          >
            申请麦克风授权
          </button>
        </div>
        <p className="hint">
          授权弹窗由浏览器发起；拒绝授权不会清空任何已经工作的线路。
        </p>
      </section>

      <section className="panel">
        <h2>主 / 备输入与试听</h2>
        <div className="channels">
          <ChannelCard
            snap={snap}
            channel={snap.primary}
            devices={snap.devices}
            onAudition={() => void engine.audition('primary')}
            onStop={() => engine.stopAudition('primary')}
          />
          <ChannelCard
            snap={snap}
            channel={snap.backup}
            devices={snap.devices}
            onAudition={() => void engine.audition('backup')}
            onStop={() => engine.stopAudition('backup')}
          />
        </div>
      </section>

      <section className="panel">
        <h2>线路与切换控制</h2>
        <div className="status-bar" style={{ marginBottom: 12 }}>
          <span
            className={`badge ${rigPhaseBadge(snap.phase)}`}
            data-testid="rig-phase"
          >
            整机：{rigPhaseText(snap.phase)}
          </span>
          <span
            className={`badge ${snap.micInUse ? 'err' : 'ok'}`}
            data-testid="mic-in-use"
          >
            麦克风占用：{snap.micInUse ? '是' : '否'}
          </span>
        </div>
        <div className="row">
          <button
            className={snap.phase === 'armed' ? 'armed' : ''}
            data-testid="arm"
            disabled={!snap.can.arm}
            onClick={() => engine.arm()}
          >
            武装主路
          </button>
          <button
            className="primary"
            data-testid="switch"
            disabled={!snap.can.switch}
            onClick={() => void engine.switchToBackup()}
          >
            发起切换（80ms 交叉到备用）
          </button>
          <span className="spacer" />
          <button
            className="danger"
            data-testid="stop-all"
            disabled={!snap.can.stop}
            onClick={() => engine.stopAll()}
          >
            停止全部
          </button>
        </div>
        <p className="hint">
          武装后备用试听立即停止、主路持续输出；切换时备用就绪前主路不中断，就绪后以
          80 毫秒线性增减益交叉，再停止旧主轨道。停止会释放全部流与节点。
        </p>
      </section>

      <section className="panel">
        <h2>操作提示</h2>
        {snap.messages.length === 0 ? (
          <p className="hint" data-testid="messages-empty">
            暂无提示。
          </p>
        ) : (
          <div className="messages" data-testid="messages">
            {snap.messages
              .slice()
              .reverse()
              .map((m) => (
                <div key={m.id} className={`msg ${m.kind}`}>
                  {m.text}
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
