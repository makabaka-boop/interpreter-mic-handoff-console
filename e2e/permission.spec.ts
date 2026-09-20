import { expect, test } from '@playwright/test';

test.describe('授权被拒绝', () => {
  test('拒绝权限时显示原因，不影响重新授权按钮可用', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium-denied', '仅拒绝项目运行');
    await page.goto('/');

    await page.getByTestId('request-permission').click();

    await expect(page.getByTestId('permission-state')).toHaveText('权限：已拒绝');
    await expect(page.getByTestId('denied-banner')).toBeVisible();
    await expect(page.getByTestId('messages')).toContainText('拒绝');

    // 可以再次发起授权尝试
    await expect(page.getByTestId('request-permission')).toBeEnabled();
    // 未授权时试听不可用
    await expect(page.getByTestId('audition-primary')).toBeDisabled();
  });
});
