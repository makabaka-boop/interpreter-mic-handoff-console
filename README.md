# 同声传译麦克风切换校验台

纯前端（TypeScript + React + Vite）的主/备麦克风切换流程离线校验台。
**不联网、无服务端、无任何假接口**：生产代码只调用浏览器真实的
`MediaDevices`（`getUserMedia` / `enumerateDevices`）与 Web Audio API
（`AudioContext`、`MediaStreamSource`、`GainNode`、`AnalyserNode`）。

## 要解决的问题

- 主话筒切到备用的动作若失败，耳返会被静音；
- 快速连续点击时，较早返回的授权/流结果可能“反夺线路”，把新状态覆盖掉。

本校验台把这些时序显式建模为**代次（generation）**与**线路状态机**，
并在界面上展示设备、轨道状态与实时电平，便于彩排前核对。

## 浏览器能力要求

| 能力 | 用途 | 缺失时表现 |
| --- | --- | --- |
| `navigator.mediaDevices`（MediaDevices） | 申请麦克风权限、枚举音频输入设备 | 页面顶部显示“缺少 MediaDevices 接口”，禁止后续操作 |
| Web Audio API（`AudioContext`） | 耳返接线、增益交叉、电平分析 | 试听被拒绝并提示原因 |
| 安全上下文（HTTPS 或 localhost） | 浏览器只在安全上下文暴露麦克风 | 提示需要 HTTPS/localhost |
| 麦克风授权 | `getUserMedia({ audio: true })` | 用户拒绝时显示“拒绝了麦克风权限”，可重新申请 |

建议使用最新版 Chrome / Edge / Firefox。
注意：通过 IP 直连非 `localhost` 的 HTTP 地址时，浏览器会禁用麦克风，请改用 HTTPS。

## 操作流程与规则

1. **授权**：点击“申请麦克风授权”。浏览器弹窗由真实浏览器发起；
   授权成功后枚举设备（此时设备 label 可见）。拒绝授权或设备不可用时显示具体原因，
   **已经工作的线路不会被清空**。
2. **选择并分别试听主、备输入**：每路独立 `source → analyser / gain → destination`，
   页面显示轨道状态与实时电平。停止试听会停止该路全部轨道并断开节点。
3. **武装主路**：两路都试听成功后才可武装。武装时：
   - 递增代次，立即停止备用试听轨道并释放其节点；
   - 主路加冕为“活动主路”，**持续输出不中断**；
   - 武装期间禁止另开试听、禁止更改设备选择。
4. **发起切换**：
   - 备用候选流就绪前，主路保持输出；
   - 就绪后以 **80 毫秒线性增减益交叉**（主 1→0，备 0→1）；
   - 交叉结束后才停止旧主轨道、断开节点。
5. **失败保留原主路**：候选被拒绝、候选提前结束、`AudioContext.resume()`
   失败时，候选被释放、主路增益恢复并继续输出；须重新试听后方可再次武装。
6. **故障态**：活动主路（武装后的主路，或切换后的备用活动路）一旦发生
   `ended`（设备拔出/系统回收），整机进入故障态，释放全部流与节点；
   切换中迟到返回的候选也会立即停止。**重新试听两路后方可武装**。
7. **停止全部**：停止所有轨道、断开全部音频节点、关闭 `AudioContext`、
   取消在途交叉与代次；授权结果与设备列表保留。界面“麦克风占用”必须为“否”，
   不残留任何麦克风占用状态。

### 代次（generation）规则

每次**试听、武装、切换（及停止）**都递增代次。所有异步操作在 `await`
返回后核对代次：

- 不是最新代次 → 刚拿到的流立即 `stop()` 并释放，**不接管线路、不改写提示**；
- 因此快速连点只会让最新一次操作生效，较早返回的结果无法反夺线路。

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173 （localhost 本身就是安全上下文）
```

其他脚本：

```bash
npm run typecheck     # 仅类型检查
npm run test:unit     # Vitest：可控媒体替身核对流/节点释放与代次接管
npm run build         # tsc --noEmit + vite build，产物在 dist/
npm run preview       # 本地预览构建产物
npm run test:e2e      # Playwright：授权成功/拒绝 + 武装/切换/停止全流程
npm run verify        # typecheck + 单测 + 构建 + e2e 一键验收
```

`.gitignore` 已排除 `node_modules/`、`dist/`、Playwright 报告等产物。

## 测试策略

- **Vitest（`src/core/RigEngine.test.ts`，替身见 `src/test/fakes.ts`）**
  使用手写的可控 `MediaDevices` / `AudioContext` / `requestAnimationFrame`
  替身（仅测试环境引用，生产代码零假接口），覆盖：
  - 授权成功/拒绝、探针流释放；缺少 MediaDevices / AudioContext / 非安全上下文；
  - 试听建链与实时电平、停止时轨道停止与节点断开；
  - 设备不存在（`OverconstrainedError`）、设备从列表消失；
  - 快速连点的代次接管：旧流立即停止且提示不被覆盖；迟到流在停止后返回；
  - 武装：备路释放、主路保持、武装期间封锁试听；
  - 80ms 线性交叉、旧主轨在交叉结束后停止；
  - 候选拒绝 / 候选提前结束 / resume 失败 → 保留原主路；
  - 活动主路结束 → 故障态；切换中主路结束后迟到候选也释放；
  - 停止全部释放所有流/节点、关闭上下文、无 rAF 与麦克风残留。
- **Playwright（`e2e/`）** 用 Chromium 合成音频输入
  （`--use-fake-device-for-media-stream`）跑真实浏览器：
  - `chromium-mic` 项目：授权 → 选设备 → 主/备试听 → 武装（试听被封锁）→
    80ms 交叉切换 → 停止后“麦克风占用：否”；
  - `chromium-denied` 项目（`--deny-permission-prompts`）：授权被拒绝时显示原因。

首次运行 e2e 前需要安装浏览器：`npx playwright install chromium`。

## Docker

```bash
# 发布页面，宿主机端口可用 WEB_PORT 覆盖（默认 8080）
docker compose up --build web
# 自定义端口
WEB_PORT=9000 docker compose up --build web

# 一次性验收服务：构建并运行 类型检查 + 单测 + 构建 + Playwright e2e，
# 成功后容器退出
docker compose build verify
docker compose run --rm verify
```

`web` 服务最终镜像仅含 nginx 与 `dist/` 静态文件，没有任何上游代理或接口；
应用在运行期完全离线，所有音频处理均在浏览器内完成。

## 目录结构

```
src/
  core/
    types.ts          # 域类型（通道/权限/整机阶段、快照、运行环境注入）
    RigEngine.ts      # 全部业务规则：代次、音频图、交叉、故障、释放
    RigEngine.test.ts # Vitest 单测
  test/fakes.ts       # 可控媒体/WebAudio/rAF 替身（仅测试用）
  state/useRig.ts     # useSyncExternalStore 绑定，全局唯一引擎实例
  ui/                 # React 组件与中文文案/状态映射
  App.tsx, main.tsx, styles.css
e2e/                  # Playwright 授权与切换流程
Dockerfile            # build / verify / web 多阶段
docker-compose.yml    # web（WEB_PORT 可覆盖）+ verify（一次性）
```
