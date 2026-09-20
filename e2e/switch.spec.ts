import { expect, test } from '@playwright/test';

/**
 * 授权流程：
 * - chromium-mic 项目自动授予麦克风（Chromium 合成输入设备）
 * - chromium-denied 项目用 --deny-permission-prompts 模拟用户拒绝
 */

test.describe('授权流程', () => {
  test('授权成功后可选设备并分别试听主备', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium-mic', '仅授权项目运行');
    await page.goto('/');

    await expect(page.getByTestId('permission-state')).toHaveText('权限：未授权');
    await page.getByTestId('request-permission').click();
    await expect(page.getByTestId('permission-state')).toHaveText('权限：已授权');

    // 合成设备至少枚举到一个音频输入
    const primarySelect = page.getByTestId('select-primary');
    await expect(primarySelect.locator('option')).not.toHaveCount(0);
    await primarySelect.selectOption({ index: 1 });
    await page.getByTestId('select-backup').selectOption({ index: 1 });

    await page.getByTestId('audition-primary').click();
    await expect(page.getByTestId('phase-primary')).toHaveText(
      '试听中（耳返输出）',
    );
    await expect(page.getByTestId('mic-on-primary')).toBeVisible();

    await page.getByTestId('audition-backup').click();
    await expect(page.getByTestId('phase-backup')).toHaveText(
      '试听中（耳返输出）',
    );

    await expect(page.getByTestId('arm')).toBeEnabled();
  });

  test('武装后禁止另开试听，切换到备用并释放主路，停止后无麦克风残留', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'chromium-mic', '仅授权项目运行');
    await page.goto('/');

    await page.getByTestId('request-permission').click();
    await expect(page.getByTestId('permission-state')).toHaveText('权限：已授权');

    await page.getByTestId('select-primary').selectOption({ index: 1 });
    await page.getByTestId('select-backup').selectOption({ index: 1 });

    await page.getByTestId('audition-primary').click();
    await expect(page.getByTestId('phase-primary')).toHaveText(
      '试听中（耳返输出）',
    );
    await page.getByTestId('audition-backup').click();
    await expect(page.getByTestId('phase-backup')).toHaveText(
      '试听中（耳返输出）',
    );

    // 武装
    await page.getByTestId('arm').click();
    await expect(page.getByTestId('rig-phase')).toHaveText('整机：主路已武装');
    // 武装期间试听按钮禁用，备用试听已停止（无麦克风占用标记）
    await expect(page.getByTestId('audition-primary')).toBeDisabled();
    await expect(page.getByTestId('audition-backup')).toBeDisabled();
    await expect(page.getByTestId('mic-on-backup')).toHaveCount(0);
    await expect(page.getByTestId('mic-on-primary')).toBeVisible();

    // 切换
    await page.getByTestId('switch').click();
    await expect(page.getByTestId('rig-phase')).toHaveText('整机：备用运行中');
    await expect(page.getByTestId('active-backup')).toBeVisible();
    await expect(page.getByTestId('phase-primary')).toHaveText('未试听');
    await expect(page.getByTestId('mic-on-backup')).toBeVisible();
    await expect(page.getByTestId('mic-on-primary')).toHaveCount(0);

    // 停止全部：界面不得残留麦克风占用
    await page.getByTestId('stop-all').click();
    await expect(page.getByTestId('mic-in-use')).toHaveText('麦克风占用：否');
    await expect(page.getByTestId('mic-on-primary')).toHaveCount(0);
    await expect(page.getByTestId('mic-on-backup')).toHaveCount(0);
    await expect(page.getByTestId('rig-phase')).toHaveText('整机：待命');
  });
});
