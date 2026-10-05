import { expect, test } from '@playwright/test';

const RELEASE_KEY = 'braille-plate:release:v1';
const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

async function fillDraft(page: import('@playwright/test').Page, text: string, width: string) {
  await page.getByTestId('mode-single').click();
  await page.getByTestId('phrase-input').fill(text);
  await page.getByTestId('width-input').fill(width);
}

async function judgeCalibration(page: import('@playwright/test').Page, values: string[]) {
  await page.getByTestId('mode-calibration').click();
  for (const [index, value] of values.entries()) {
    await page.getByTestId(`height-input-${index + 1}`).fill(value);
  }
  await page.getByTestId('calibration-judge').click();
}

async function judgePass(page: import('@playwright/test').Page, values = legalReadings) {
  await judgeCalibration(page, values);
  await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
}

/** 完成一次首次签发，返回原单编号。 */
async function issueOriginal(page: import('@playwright/test').Page): Promise<string> {
  await fillDraft(page, '12，三。', '4');
  await judgePass(page);
  await page.getByTestId('mode-release').click();
  await page.getByTestId('release-issue').click();
  await expect(page.getByTestId('release-active')).toBeVisible();
  const id = await page.getByTestId('release-history-item').first().getAttribute('data-slip-id');
  expect(id).toMatch(/^PF-/);
  return id as string;
}

/** 在历史详情点击“以此单更正”并明确确认，进入更正规程。 */
async function beginCorrection(page: import('@playwright/test').Page, slipId: string) {
  await page.locator(`[data-slip-id="${slipId}"]`).getByTestId('correct-with-slip').click();
  await expect(page.getByTestId('correction-confirm')).toContainText(slipId);
  await page.getByTestId('correction-confirm-yes').click();
  await expect(page.getByTestId('correction-panel')).toBeVisible();
  await expect(page.getByTestId('correction-target-id')).toHaveText(slipId);
}

test.describe('放行单更正：正常补发', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('确认带入草稿、重新合格判定、填写原因后签发独立编号更正单，原单绝不改写', async ({ page }) => {
    const originalId = await issueOriginal(page);

    // 历史详情提供“以此单更正”入口，操作员明确确认后进入更正规程
    await beginCorrection(page, originalId);

    // 原单文字与行宽已带入共享可编辑草稿：切到单稿预检页可见并修正文字
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('phrase-input')).toHaveValue('12，三。');
    await expect(page.getByTestId('width-input')).toHaveValue('4');
    await page.getByTestId('phrase-input').fill('12，四。');

    // 一次新的合格试压判定：改动读数后重新判定合格（新读数 0.81）
    const newReadings = [...legalReadings];
    newReadings[5] = '0.81';
    await judgePass(page, newReadings);

    // 回到放行页：更正规程跨模式保持；空更正原因不能签发
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('correction-panel')).toBeVisible();
    await expect(page.getByTestId('correction-issue')).toBeDisabled();
    await expect(page.getByTestId('correction-reason-hint')).toContainText('不能为空');

    await page.getByTestId('correction-reason').fill('楼层文字有误');
    await expect(page.getByTestId('correction-issue')).toBeEnabled();
    await page.getByTestId('correction-issue').click();

    // 新单独立编号并成为当前授权；更正规程退出
    const active = page.getByTestId('release-active');
    await expect(active).toBeVisible();
    const correctionId = ((await active.getByTestId('slip-id').textContent()) ?? '').replace('放行单号：', '');
    expect(correctionId).toMatch(/^PF-/);
    expect(correctionId).not.toBe(originalId);
    await expect(page.getByTestId('correction-panel')).toHaveCount(0);

    // 历史更正链与当前状态：原单已被取代，更正单为现行版本
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    const originalItem = page.locator(`[data-slip-id="${originalId}"]`);
    const correctionItem = page.locator(`[data-slip-id="${correctionId}"]`);
    await expect(originalItem.getByTestId('chain-status')).toContainText('已被更正单');
    await expect(originalItem.getByTestId('chain-status')).toContainText(correctionId);
    await expect(correctionItem.getByTestId('chain-status')).toContainText('现行版本');

    // 更正单固化不可变关联与新的合格判定读数；原单内容绝不改写
    await expect(correctionItem.getByTestId('slip-correction-reason')).toContainText('楼层文字有误');
    await expect(correctionItem.getByTestId('slip-correction-target')).toContainText(originalId);
    await expect(correctionItem.getByTestId('slip-draft-text')).toContainText('12，四。');
    await expect(correctionItem.getByTestId('slip-point-raw').nth(5)).toHaveText('0.81');
    await expect(originalItem.getByTestId('slip-draft-text')).toContainText('12，三。');
    await expect(originalItem.getByTestId('slip-point-raw').nth(5)).toHaveText('0.80');
    await expect(originalItem.getByTestId('slip-correction')).toHaveCount(0);

    // 存档层一致：新单带更正关联，原单仍是无更正字段的旧格式
    const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), RELEASE_KEY);
    expect(stored.slips).toHaveLength(2);
    expect(stored.slips[0].correction).toBeUndefined();
    expect(stored.slips[1].correction).toEqual({ reason: '楼层文字有误', supersedesId: originalId });
  });

  test('未确认前草稿不被触碰；确认对话框与更正规程都可取消', async ({ page }) => {
    const originalId = await issueOriginal(page);

    // 先把草稿改成别的内容：点击“以此单更正”但未确认前，草稿保持不变
    await fillDraft(page, '三四五', '8');
    await page.getByTestId('mode-release').click();
    await page.locator(`[data-slip-id="${originalId}"]`).getByTestId('correct-with-slip').click();
    await expect(page.getByTestId('correction-confirm')).toBeVisible();
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('phrase-input')).toHaveValue('三四五');

    // 取消确认：不进入更正规程，草稿仍是改动后的内容
    // （待确认提示是瞬时的：离开放行页后不保留，需重新点击“以此单更正”）
    await page.getByTestId('mode-release').click();
    await page.locator(`[data-slip-id="${originalId}"]`).getByTestId('correct-with-slip').click();
    await expect(page.getByTestId('correction-confirm')).toBeVisible();
    await page.getByTestId('correction-confirm-no').click();
    await expect(page.getByTestId('correction-confirm')).toHaveCount(0);
    await expect(page.getByTestId('correction-panel')).toHaveCount(0);

    // 再次进入并确认，然后取消更正：不产生任何新单据
    await beginCorrection(page, originalId);
    await page.getByTestId('correction-cancel').click();
    await expect(page.getByTestId('correction-panel')).toHaveCount(0);
    await expect(page.getByTestId('release-history-item')).toHaveCount(1);
  });
});

test.describe('放行单更正：旧格式存档兼容', () => {
  test('无更正字段的旧格式历史单照常只读复核，并可在此基础上补发更正单', async ({ page }) => {
    await page.goto('/');
    const originalId = await issueOriginal(page);

    // 确认这就是旧格式存档：单据没有 correction 字段
    const before = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), RELEASE_KEY);
    expect(before.slips[0].correction).toBeUndefined();

    // 刷新后旧档照常读取：历史完整、无链状态徽标、不自动授权
    await page.reload();
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-archive-warning')).toHaveCount(0);
    await expect(page.getByTestId('release-history-item')).toHaveCount(1);
    const originalItem = page.locator(`[data-slip-id="${originalId}"]`);
    await expect(originalItem.getByTestId('slip-draft-text')).toContainText('12，三。');
    await expect(originalItem.getByTestId('chain-status')).toHaveCount(0);

    // 旧单可直接发起更正并建立不可变关联
    await beginCorrection(page, originalId);
    await page.getByTestId('correction-reason').fill('旧单文字更正');
    await page.getByTestId('correction-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    await expect(originalItem.getByTestId('chain-status')).toContainText('已被更正单');
  });
});

test.describe('放行单更正：双页签分叉', () => {
  test('两页签同时更正同一原单：合并后明确标记冲突，停止自动认定现行单，全部原件保留', async ({
    page,
    context
  }) => {
    await page.goto('/');
    const originalId = await issueOriginal(page);

    // 第二个页签在任何更正前打开：共享同一份草稿与合格判定存档
    const other = await context.newPage();
    await other.goto('/');
    await other.getByTestId('mode-release').click();
    await expect(other.getByTestId('release-history-item')).toHaveCount(1);

    // 页签甲更正原单：修正文字为“12，四。”后签发 C1
    await beginCorrection(page, originalId);
    await page.getByTestId('mode-single').click();
    await page.getByTestId('phrase-input').fill('12，四。');
    await page.getByTestId('mode-release').click();
    await page.getByTestId('correction-reason').fill('页签甲更正');
    await page.getByTestId('correction-issue').click();
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    const correctionAId = (
      (await page.getByTestId('release-active').getByTestId('slip-id').textContent()) ?? ''
    ).replace('放行单号：', '');

    // 页签乙也更正同一原单：修正文字为“12，五。”后签发 C2（合并后两张更正单指向同一原单）
    await beginCorrection(other, originalId);
    await other.getByTestId('mode-single').click();
    await other.getByTestId('phrase-input').fill('12，五。');
    await other.getByTestId('mode-release').click();
    await other.getByTestId('correction-reason').fill('页签乙更正');
    await other.getByTestId('correction-issue').click();
    await expect(other.getByTestId('release-history-item')).toHaveCount(3);
    const correctionBId = (
      (await other.getByTestId('release-active').getByTestId('slip-id').textContent()) ?? ''
    ).replace('放行单号：', '');
    expect(correctionBId).not.toBe(correctionAId);

    // 页签乙立即看到分叉冲突：不凭时间先后选出现行版本
    await expect(other.getByTestId('correction-fork-warning')).toContainText('分叉冲突');
    await expect(other.getByTestId('correction-fork-warning')).toContainText(originalId);
    await expect(other.getByTestId('correction-fork-item')).toContainText(correctionAId);
    await expect(other.getByTestId('correction-fork-item')).toContainText(correctionBId);
    await expect(other.locator(`[data-slip-id="${originalId}"]`).getByTestId('chain-status')).toContainText(
      '分叉冲突'
    );
    await expect(other.getByTestId('chain-status').filter({ hasText: '现行版本' })).toHaveCount(0);

    // 通知页签甲同步：同样明确标记冲突，三张原件全部保留取证
    await page.evaluate((key) => {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, RELEASE_KEY);
    await expect(page.getByTestId('correction-fork-warning')).toContainText('分叉冲突');
    await expect(page.getByTestId('release-history-item')).toHaveCount(3);
    await expect(page.getByTestId('chain-status').filter({ hasText: '现行版本' })).toHaveCount(0);
    await expect(page.locator(`[data-slip-id="${correctionAId}"]`).getByTestId('chain-status')).toContainText(
      '分叉分支'
    );
    await expect(page.locator(`[data-slip-id="${correctionBId}"]`).getByTestId('chain-status')).toContainText(
      '分叉分支'
    );

    // 存档层：三张单据都在，两张更正单都指向同一原单，内容各自保持
    const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), RELEASE_KEY);
    expect(stored.slips).toHaveLength(3);
    const corrections = stored.slips.filter((slip: { correction?: unknown }) => slip.correction);
    expect(corrections).toHaveLength(2);
    for (const slip of corrections) {
      expect(slip.correction.supersedesId).toBe(originalId);
    }
    await expect(page.locator(`[data-slip-id="${correctionAId}"]`).getByTestId('slip-draft-text')).toContainText(
      '12，四。'
    );
    await expect(page.locator(`[data-slip-id="${correctionBId}"]`).getByTestId('slip-draft-text')).toContainText(
      '12，五。'
    );
    await other.close();
  });
});

test.describe('放行单更正：失败保护', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('更正规程中存档损坏：保护态阻断更正与签发，原档逐字保留', async ({ page }) => {
    const originalId = await issueOriginal(page);
    await beginCorrection(page, originalId);
    await page.getByTestId('correction-reason').fill('更正原因');
    await expect(page.getByTestId('correction-issue')).toBeEnabled();

    // 存档被外部改坏（跨标签同步进来）
    await page.evaluate((key) => {
      window.localStorage.setItem(key, '{不是合法 JSON');
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, RELEASE_KEY);

    await expect(page.getByTestId('release-archive-warning')).toContainText('无法安全恢复');
    await expect(page.getByTestId('correction-issue')).toBeDisabled();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    // 原档逐字保留；最近一次完整记录仍可只读复核
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_KEY);
    expect(raw).toBe('{不是合法 JSON');
    await expect(page.getByTestId('release-history-item')).toHaveCount(1);
    await expect(page.locator(`[data-slip-id="${originalId}"]`).getByTestId('slip-draft-text')).toContainText(
      '12，三。'
    );
  });

  test('更正单写入配额失败：明确告警、不产生伪签发、原存档保留；恢复后可完成更正', async ({ page }) => {
    const originalId = await issueOriginal(page);
    const before = await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_KEY);

    await beginCorrection(page, originalId);
    await page.getByTestId('correction-reason').fill('楼层文字有误');

    await page.evaluate(() => {
      Storage.prototype.setItem = (key: string) => {
        if (key === 'braille-plate:release:v1') {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        }
      };
    });

    await page.getByTestId('correction-issue').click();
    await expect(page.getByTestId('release-write-error')).toContainText('历史放行单与原存档仍保留');
    // 不产生伪签发：没有新单据进入历史，原存档逐字保留
    await expect(page.getByTestId('release-history-item')).toHaveCount(1);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_KEY)).toBe(before);

    // 恢复写入后重新走更正规程即可完成补发
    await page.reload();
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-write-error')).toHaveCount(0);
    await beginCorrection(page, originalId);
    await page.getByTestId('correction-reason').fill('楼层文字有误');
    await page.getByTestId('correction-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    await expect(page.locator(`[data-slip-id="${originalId}"]`).getByTestId('chain-status')).toContainText(
      '已被更正单'
    );
  });
});
