import { expect, test, type Page } from '@playwright/test';

const RELEASE_KEY = 'braille-plate:release:v1';
const ADJ_KEY = 'braille-plate:release-fork-adjudication:v1';
const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

async function fillDraft(page: Page, text: string, width: string) {
  await page.getByTestId('mode-single').click();
  await page.getByTestId('phrase-input').fill(text);
  await page.getByTestId('width-input').fill(width);
}

async function judgePass(page: Page, values = legalReadings) {
  await page.getByTestId('mode-calibration').click();
  for (const [index, value] of values.entries()) {
    await page.getByTestId(`height-input-${index + 1}`).fill(value);
  }
  await page.getByTestId('calibration-judge').click();
  await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
}

/** 完成首次签发，返回原单编号。 */
async function issueOriginal(page: Page): Promise<string> {
  await fillDraft(page, '12，三。', '4');
  await judgePass(page);
  await page.getByTestId('mode-release').click();
  await page.getByTestId('release-issue').click();
  await expect(page.getByTestId('release-active')).toBeVisible();
  const id = await page.getByTestId('release-history-item').first().getAttribute('data-slip-id');
  expect(id).toMatch(/^PF-/);
  return id as string;
}

/** 在指定页签对原单补发一张更正单，返回更正单编号。 */
async function issueCorrection(page: Page, originalId: string, text: string, reason: string): Promise<string> {
  await page.locator(`[data-slip-id="${originalId}"]`).getByTestId('correct-with-slip').click();
  await page.getByTestId('correction-confirm-yes').click();
  await expect(page.getByTestId('correction-panel')).toBeVisible();
  await page.getByTestId('mode-single').click();
  await page.getByTestId('phrase-input').fill(text);
  await page.getByTestId('mode-release').click();
  await page.getByTestId('correction-reason').fill(reason);
  await page.getByTestId('correction-issue').click();
  await expect(page.getByTestId('correction-panel')).toHaveCount(0);
  const id = ((await page.getByTestId('release-active').getByTestId('slip-id').textContent()) ?? '').replace(
    '放行单号：',
    ''
  );
  expect(id).toMatch(/^PF-/);
  return id;
}

/** 在分叉裁决面板选择分支、填写原因并提交。 */
async function adjudicate(page: Page, forkParentId: string, chosenSuccessorId: string, reason: string) {
  const panel = page.locator(`[data-fork-id="${forkParentId}"]`);
  await panel.locator(`input[data-testid="fork-choice"][value="${chosenSuccessorId}"]`).check();
  await panel.getByTestId('fork-reason').fill(reason);
  await panel.getByTestId('fork-decide').click();
}

/** 让另一页签感知跨标签存档更新（与既有更正 e2e 同一手法）。 */
async function notify(page: Page, key: string) {
  await page.evaluate((storageKey) => {
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey }));
  }, key);
}

test.describe('人工分叉裁决：双页签', () => {
  test('两页签对同一分叉作出不同选择：展示冲突而非最后写入者获胜，基于最新存档重新裁决后定案', async ({
    page,
    context
  }) => {
    await page.goto('/');
    const originalId = await issueOriginal(page);

    // 第二个页签共享同一存档：两页签各补发一张更正单，形成分叉
    const other = await context.newPage();
    await other.goto('/');
    await other.getByTestId('mode-release').click();
    const correctionA = await issueCorrection(page, originalId, '12，四。', '页签甲更正');
    await notify(other, RELEASE_KEY);
    const correctionB = await issueCorrection(other, originalId, '12，五。', '页签乙更正');
    await notify(page, RELEASE_KEY);

    // 两页签都看到分叉冲突与裁决面板：每个直接后继及其可追溯终端
    for (const tab of [page, other]) {
      await expect(tab.getByTestId('correction-fork-warning')).toContainText('分叉冲突');
      const panel = tab.locator(`[data-fork-id="${originalId}"]`);
      await expect(panel.getByTestId('fork-adjudication-state')).toContainText('尚未人工裁决');
      await expect(panel.getByTestId('fork-branch-item').filter({ hasText: correctionA })).toContainText(
        `可追溯终端：${correctionA}`
      );
      await expect(panel.getByTestId('fork-branch-item').filter({ hasText: correctionB })).toContainText(
        `可追溯终端：${correctionB}`
      );
    }

    // 页签甲选 A、页签乙选 B：两份裁决都落库，展示冲突，不作现行认定
    await adjudicate(page, originalId, correctionA, '页签甲选 A');
    await notify(other, ADJ_KEY);
    await adjudicate(other, originalId, correctionB, '页签乙选 B');
    await notify(page, ADJ_KEY);

    for (const tab of [page, other]) {
      const panel = tab.locator(`[data-fork-id="${originalId}"]`);
      await expect(panel.getByTestId('fork-adjudication-state')).toContainText('裁决冲突');
      await expect(tab.locator(`[data-slip-id="${originalId}"]`).getByTestId('chain-status')).toContainText(
        '裁决不一致'
      );
      await expect(tab.getByTestId('chain-status').filter({ hasText: '更正链现行版本' })).toHaveCount(0);
    }
    // 冲突双方全部保留取证，绝不是“最后写入者获胜”
    const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), ADJ_KEY);
    expect(stored.adjudications).toHaveLength(2);
    expect(stored.adjudications.map((a: { chosenSuccessorId: string }) => a.chosenSuccessorId).sort()).toEqual(
      [correctionA, correctionB].sort()
    );

    // 负责人基于最新存档重新裁决：新裁决显式取代冲突中的旧裁决
    await adjudicate(page, originalId, correctionA, '负责人复核后定甲分支');
    await notify(other, ADJ_KEY);
    for (const tab of [page, other]) {
      await expect(tab.locator(`[data-slip-id="${correctionA}"]`).getByTestId('chain-status')).toContainText(
        '现行版本'
      );
      await expect(tab.locator(`[data-slip-id="${correctionB}"]`).getByTestId('chain-status')).toContainText(
        '未被人工裁决选中'
      );
      await expect(tab.locator(`[data-slip-id="${originalId}"]`).getByTestId('chain-status')).toContainText(
        '已经人工裁决'
      );
    }
    const after = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), ADJ_KEY);
    expect(after.adjudications).toHaveLength(3);
    expect(after.adjudications[2].supersedesAdjudicationIds.sort()).toEqual(
      [after.adjudications[0].id, after.adjudications[1].id].sort()
    );
    // 放行单存档三张原件逐字未动
    const releases = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), RELEASE_KEY);
    expect(releases.slips).toHaveLength(3);
    await other.close();
  });

  test('两页签相同选择幂等；迟到新分支让旧裁决自动失效并可基于最新存档重新裁决', async ({
    page,
    context
  }) => {
    await page.goto('/');
    const originalId = await issueOriginal(page);
    const other = await context.newPage();
    await other.goto('/');
    await other.getByTestId('mode-release').click();
    const correctionA = await issueCorrection(page, originalId, '12，四。', '页签甲更正');
    await notify(other, RELEASE_KEY);
    const correctionB = await issueCorrection(other, originalId, '12，五。', '页签乙更正');
    await notify(page, RELEASE_KEY);

    // 两页签都选 A：重复提交幂等，现行结论一致且唯一
    await adjudicate(page, originalId, correctionA, '页签甲选 A');
    await notify(other, ADJ_KEY);
    await adjudicate(other, originalId, correctionA, '页签乙也选 A');
    await notify(page, ADJ_KEY);
    for (const tab of [page, other]) {
      await expect(tab.locator(`[data-slip-id="${correctionA}"]`).getByTestId('chain-status')).toContainText(
        '现行版本'
      );
      await expect(tab.getByTestId('chain-status').filter({ hasText: '更正链现行版本' })).toHaveCount(1);
    }

    // 迟到新分支：第三张更正单指向同一原单，旧裁决自动失效
    const late = await issueCorrection(other, originalId, '12，六。', '迟到的新分支');
    await notify(page, RELEASE_KEY);
    for (const tab of [page, other]) {
      const panel = tab.locator(`[data-fork-id="${originalId}"]`);
      await expect(panel.getByTestId('fork-adjudication-state')).toContainText('旧裁决已失效');
      await expect(tab.getByTestId('chain-status').filter({ hasText: '更正链现行版本' })).toHaveCount(0);
      await expect(tab.locator(`[data-slip-id="${originalId}"]`).getByTestId('chain-status')).toContainText(
        '旧裁决已失效'
      );
    }

    // 基于最新存档（含新分支）重新裁决：绑定新的完整后继集合
    await adjudicate(page, originalId, late, '复核后改选迟到分支');
    await notify(other, ADJ_KEY);
    for (const tab of [page, other]) {
      await expect(tab.locator(`[data-slip-id="${late}"]`).getByTestId('chain-status')).toContainText('现行版本');
    }
    const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), ADJ_KEY);
    // 旧裁决保留取证；新裁决绑定三个直接后继
    expect(stored.adjudications).toHaveLength(3);
    expect(stored.adjudications[2].successorIds.sort()).toEqual([correctionA, correctionB, late].sort());
    await other.close();
  });

  test('嵌套分叉：被选分支内部仍有未裁决分叉时不宣布现行，内层裁决后终端才现行', async ({ page }) => {
    await page.goto('/');
    const originalId = await issueOriginal(page);
    const correctionA = await issueCorrection(page, originalId, '12，四。', '更正一');
    const correctionB = await issueCorrection(page, originalId, '12，五。', '更正二');
    // 分支 A 内部再分叉
    const innerA = await issueCorrection(page, correctionA, '12，六。', '内层更正一');
    const innerB = await issueCorrection(page, correctionA, '12，七。', '内层更正二');
    expect(innerB).not.toBe(innerA);

    // 外层裁决选 A：内层分叉未裁决，不得提前宣布任何终端现行
    await adjudicate(page, originalId, correctionA, '外层选定甲分支');
    await expect(page.locator(`[data-slip-id="${originalId}"]`).getByTestId('chain-status')).toContainText(
      '已经人工裁决'
    );
    await expect(page.getByTestId('chain-status').filter({ hasText: '更正链现行版本' })).toHaveCount(0);

    // 内层也裁决后，内层被选终端才成为现行版本
    await adjudicate(page, correctionA, innerA, '内层选定更正一');
    await expect(page.locator(`[data-slip-id="${innerA}"]`).getByTestId('chain-status')).toContainText('现行版本');
    await expect(page.locator(`[data-slip-id="${innerB}"]`).getByTestId('chain-status')).toContainText(
      '未被人工裁决选中'
    );
    await expect(page.locator(`[data-slip-id="${correctionB}"]`).getByTestId('chain-status')).toContainText(
      '未被人工裁决选中'
    );
  });

  test('拒写保护：裁决存档损坏转入保护态，明确告警、禁止提交、原存档逐字保留', async ({ page }) => {
    await page.goto('/');
    const originalId = await issueOriginal(page);
    const correctionA = await issueCorrection(page, originalId, '12，四。', '更正一');
    await issueCorrection(page, originalId, '12，五。', '更正二');
    await adjudicate(page, originalId, correctionA, '选定甲分支');
    await expect(page.locator(`[data-slip-id="${correctionA}"]`).getByTestId('chain-status')).toContainText(
      '现行版本'
    );

    // 裁决存档被外部改坏：保护态告警，历史裁决只读取证，表单禁止提交
    await page.evaluate((key) => {
      window.localStorage.setItem(key, '{不是合法 JSON');
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, ADJ_KEY);
    await expect(page.getByTestId('fork-adjudication-warning')).toContainText('无法安全恢复');
    const panel = page.locator(`[data-fork-id="${originalId}"]`);
    await expect(panel.getByTestId('fork-choice').first()).toBeDisabled();
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), ADJ_KEY);
    expect(raw).toBe('{不是合法 JSON');
    // 放行单存档不受影响，三张原件照常只读复核
    await expect(page.getByTestId('release-history-item')).toHaveCount(3);
    await expect(page.getByTestId('release-archive-warning')).toHaveCount(0);
  });
});
