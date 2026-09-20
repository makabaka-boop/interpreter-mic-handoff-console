import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

// 两个项目：
// - chromium-mic：自动授予麦克风权限并使用 Chromium 合成音频输入，覆盖试听/武装/切换
// - chromium-denied：自动拒绝权限弹窗，覆盖拒绝授权流程
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        ...(isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
    },
  },
  projects: [
    {
      name: 'chromium-mic',
      testMatch: /switch\.spec\.ts/,
      use: {
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            ...(isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
          ],
        },
      },
    },
    {
      name: 'chromium-denied',
      testMatch: /permission\.spec\.ts/,
      use: {
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--deny-permission-prompts',
            ...(isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
