import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReleaseWorkspace from '../../src/components/ReleaseWorkspace.vue';
import { createCorrectionSlip } from '../../src/lib/correction';
import type { CalibrationGateView } from '../../src/lib/release';
import { useCalibrationSession, __resetCalibrationSessionForTests } from '../../src/lib/calibrationSession';
import { useDraftSession, __resetDraftSessionForTests } from '../../src/lib/draftSession';
import { __resetReleaseSessionForTests } from '../../src/lib/releaseSession';
import { __resetReleaseMemoryForTests, appendReleaseSlip } from '../../src/lib/releaseStorage';

const RELEASE_KEY = 'braille-plate:release:v1';

const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

function mountRelease() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(ReleaseWorkspace);
  app.mount(container);
  return {
    container,
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}

function $(selector: string): Element | null {
  return document.querySelector(selector);
}

function $$(selector: string): Element[] {
  return [...document.querySelectorAll(selector)];
}

async function tick(times = 2) {
  for (let i = 0; i < times; i += 1) {
    await nextTick();
  }
}

function sessions() {
  return { draft: useDraftSession(), calibration: useCalibrationSession() };
}

async function preparePass(text = '12，三。', width = '4', values: string[] = legalReadings) {
  const { draft, calibration } = sessions();
  draft.text.value = text;
  draft.width.value = String(width);
  calibration.readings.value = values.slice();
  await tick(1);
  calibration.runJudge();
  await tick(2);
  return { draft, calibration };
}

async function issueViaUi() {
  ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
  await tick();
}

function passGateView(): CalibrationGateView {
  const { calibration } = sessions();
  return {
    verdict: 'pass',
    result: calibration.result.value!,
    judgedRaws: calibration.judgedRaws.value,
    currentReadings: calibration.readings.value,
    protected: false,
    recordVersion: 2
  };
}

function historyItem(slipId: string): Element | null {
  return document.querySelector(`[data-slip-id="${slipId}"]`);
}

function chainStatusTextOf(slipId: string): string | null {
  return historyItem(slipId)?.querySelector('[data-testid="chain-status"]')?.textContent?.trim() ?? null;
}

describe('ReleaseWorkspace 更正补发', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.restoreAllMocks();
    __resetReleaseSessionForTests();
    __resetReleaseMemoryForTests();
    __resetCalibrationSessionForTests();
    __resetDraftSessionForTests();
  });

  it('正常补发：确认后带入原单文字行宽，重新过闸门并填写原因后签发独立编号更正单', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();
    const originalId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );
    expect(originalId).toMatch(/^PF-/);

    // 历史详情提供“以此单更正”入口；点击后先要求明确确认，不直接改草稿
    const startButton = $('[data-testid="correct-with-slip"]') as HTMLButtonElement;
    expect(startButton).not.toBeNull();
    startButton.click();
    await tick();
    expect($('[data-testid="correction-confirm"]')?.textContent).toContain(originalId);
    expect(sessions().draft.text.value).toBe('12，三。');

    // 明确确认：原单文字与行宽带入共享可编辑草稿
    sessions().draft.text.value = '草稿被改动';
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    expect(sessions().draft.text.value).toBe('12，三。');
    expect(sessions().draft.width.value).toBe('4');
    expect($('[data-testid="correction-panel"]')).not.toBeNull();
    expect($('[data-testid="correction-target-id"]')?.textContent).toBe(originalId);

    // 操作员在共享草稿中修正文字（等价于在单稿预检页编辑）
    sessions().draft.text.value = '12，四。';
    await tick(2);

    // 空更正原因不能签发
    const correctionIssue = $('[data-testid="correction-issue"]') as HTMLButtonElement;
    expect(correctionIssue.disabled).toBe(true);
    expect($('[data-testid="correction-reason-hint"]')?.textContent).toContain('不能为空');

    // 填写非空原因后签发
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '楼层文字有误';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();
    expect(correctionIssue.disabled).toBe(false);
    correctionIssue.click();
    await tick(2);

    // 新单独立编号、成为当前授权；更正规程退出
    const activeId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );
    expect(activeId).toMatch(/^PF-/);
    expect(activeId).not.toBe(originalId);
    expect($('[data-testid="correction-panel"]')).toBeNull();

    // 历史两份：原单已被取代，更正单是现行版本
    expect($$('[data-testid="release-history-item"]')).toHaveLength(2);
    expect(chainStatusTextOf(originalId)).toContain('已被更正单');
    expect(chainStatusTextOf(originalId)).toContain(activeId);
    expect(chainStatusTextOf(activeId)).toContain('现行版本');

    // 更正单卡片展示不可变关联；原单内容绝不改写
    const correctionCard = historyItem(activeId)!;
    expect(correctionCard.querySelector('[data-testid="slip-correction-reason"]')?.textContent).toContain(
      '楼层文字有误'
    );
    expect(correctionCard.querySelector('[data-testid="slip-correction-target"]')?.textContent).toContain(originalId);
    expect(correctionCard.querySelector('[data-testid="slip-draft-text"]')?.textContent).toContain('12，四。');
    expect(historyItem(originalId)!.querySelector('[data-testid="slip-draft-text"]')?.textContent).toContain(
      '12，三。'
    );
    expect(historyItem(originalId)!.querySelector('[data-testid="slip-correction"]')).toBeNull();

    // 存档层一致性：新单固化更正关联，原单无 correction 字段
    const stored = JSON.parse(window.localStorage.getItem(RELEASE_KEY) ?? '{}');
    expect(stored.slips).toHaveLength(2);
    expect(stored.slips[0].correction).toBeUndefined();
    expect(stored.slips[1].correction).toEqual({ reason: '楼层文字有误', supersedesId: originalId });
    mounted.unmount();
  });

  it('确认前可取消：不带入草稿、不进入更正规程', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();

    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="correction-confirm"]')).not.toBeNull();
    ($('[data-testid="correction-confirm-no"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="correction-confirm"]')).toBeNull();
    expect($('[data-testid="correction-panel"]')).toBeNull();
    expect(sessions().draft.text.value).toBe('12，三。');
    mounted.unmount();
  });

  it('更正规程中可取消更正：面板关闭，不产生任何单据', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();

    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="correction-panel"]')).not.toBeNull();

    ($('[data-testid="correction-cancel"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="correction-panel"]')).toBeNull();
    expect($$('[data-testid="release-history-item"]')).toHaveLength(1);
    mounted.unmount();
  });

  it('更正同样受闸门约束：修正后的文字非法或读数判定后改动时不能签发', async () => {
    const { calibration } = await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();

    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '更正原因';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(false);

    // 修正后的文字含非法字符：编码闸门阻断
    sessions().draft.text.value = '12楼';
    await tick(2);
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(true);

    // 恢复合法文字后，任一读数改动让合格判定失效：试压闸门阻断
    sessions().draft.text.value = '12，四。';
    calibration.readings.value[0] = '0.66';
    await tick(3);
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(true);

    // 重新执行一次合格判定后恢复可签发（先让失效监听落定，再重新判定）
    calibration.readings.value[0] = '0.70';
    await tick(2);
    calibration.runJudge();
    await tick(2);
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(false);
    mounted.unmount();
  });

  it('更正规程跨模式切换保持：放行页卸载重挂后更正状态与原因草稿仍在', async () => {
    await preparePass();
    const first = mountRelease();
    await tick();
    await issueViaUi();
    const originalId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );

    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '楼层文字';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();

    // 切换到单稿预检页修改文字（放行页卸载），再切回（重新挂载）
    first.unmount();
    sessions().draft.text.value = '12，四。';
    await tick(2);
    const second = mountRelease();
    await tick(2);

    // 更正规程仍在：面板、原单编号与已填原因都保留，可直接继续签发
    expect($('[data-testid="correction-panel"]')).not.toBeNull();
    expect($('[data-testid="correction-target-id"]')?.textContent).toBe(originalId);
    expect(($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value).toBe('楼层文字');
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(false);
    ($('[data-testid="correction-issue"]') as HTMLButtonElement).click();
    await tick(2);
    expect($$('[data-testid="release-history-item"]')).toHaveLength(2);
    second.unmount();
  });

  it('双页签分叉：两张更正单指向同一原单，合并后明确标记冲突且不认定现行版本', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();
    const originalId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );

    // 模拟另一页签签发了一张指向同一原单的更正单（跨页签合并进存档）
    const theirs = createCorrectionSlip(
      { text: '12，五。', rawWidth: '4', gate: passGateView(), reason: '另一页签更正', supersedesId: originalId },
      { now: () => new Date(Date.UTC(2026, 8, 26, 11, 0, 1)), random: () => 0.5 }
    ).slip!;
    expect(appendReleaseSlip(theirs)).toEqual({ ok: true });
    window.dispatchEvent(new StorageEvent('storage', { key: RELEASE_KEY }));
    await tick(2);

    // 本页签也对该原单发起更正并签发
    ($(`[data-slip-id="${originalId}"] [data-testid="correct-with-slip"]`) as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    sessions().draft.text.value = '12，四。';
    await tick(2);
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '本页签更正';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();
    ($('[data-testid="correction-issue"]') as HTMLButtonElement).click();
    await tick(2);

    // 三张原件全部保留；分叉冲突明确标记，没有任何单据被认定为现行版本
    expect($$('[data-testid="release-history-item"]')).toHaveLength(3);
    const warning = $('[data-testid="correction-fork-warning"]');
    expect(warning?.textContent).toContain('分叉冲突');
    expect(warning?.textContent).toContain(originalId);
    expect(warning?.textContent).toContain(theirs.id);
    expect(chainStatusTextOf(originalId)).toContain('分叉冲突');
    expect(chainStatusTextOf(theirs.id)).toContain('分叉分支');
    const statuses = $$('[data-testid="chain-status"]').map((node) => node.textContent ?? '');
    expect(statuses.some((text) => text.includes('现行版本'))).toBe(false);
    mounted.unmount();
  });

  it('旧格式存档照常读取：无 correction 字段的历史单可只读复核并发起更正', async () => {
    await preparePass();
    const first = mountRelease();
    await tick();
    await issueViaUi();
    const originalId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );
    first.unmount();

    // 旧格式存档：单据没有 correction 字段（历史版本签发的格式）
    const stored = JSON.parse(window.localStorage.getItem(RELEASE_KEY) ?? '{}');
    expect(stored.slips[0].correction).toBeUndefined();

    // 模拟刷新后重新进入：旧档照常读取，无链状态徽标
    __resetReleaseSessionForTests();
    const second = mountRelease();
    await tick(2);
    expect($('[data-testid="release-archive-warning"]')).toBeNull();
    expect($$('[data-testid="release-history-item"]')).toHaveLength(1);
    expect(historyItem(originalId)!.querySelector('[data-testid="chain-status"]')).toBeNull();

    // 旧单仍可发起更正并建立关联
    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '旧单更正';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();
    ($('[data-testid="correction-issue"]') as HTMLButtonElement).click();
    await tick(2);
    expect($$('[data-testid="release-history-item"]')).toHaveLength(2);
    expect(chainStatusTextOf(originalId)).toContain('已被更正单');
    second.unmount();
  });

  it('更正单写入失败：明确告警、原存档保留、不产生伪签发', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();
    const originalId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );
    const before = window.localStorage.getItem(RELEASE_KEY);

    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '更正原因';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === RELEASE_KEY) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
    });
    ($('[data-testid="correction-issue"]') as HTMLButtonElement).click();
    await tick(2);

    expect($('[data-testid="release-write-error"]')?.textContent).toContain('历史放行单与原存档仍保留');
    // 不产生伪签发：没有新当前授权，历史仍只有原单，原存档逐字保留
    expect($$('[data-testid="release-history-item"]')).toHaveLength(1);
    expect(window.localStorage.getItem(RELEASE_KEY)).toBe(before);
    const activeId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
      '放行单号：',
      ''
    );
    expect(activeId).toBe(originalId);

    // 恢复写入后同一更正规程可继续完成
    spy.mockRestore();
    ($('[data-testid="correction-issue"]') as HTMLButtonElement).click();
    await tick(2);
    expect($$('[data-testid="release-history-item"]')).toHaveLength(2);
    expect($('[data-testid="release-write-error"]')).toBeNull();
    mounted.unmount();
  });

  it('存档损坏进入保护态：更正与首次签发都被阻断，原档逐字保留', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    await issueViaUi();
    ($('[data-testid="correct-with-slip"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-confirm-yes"]') as HTMLButtonElement).click();
    await tick();
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).value = '更正原因';
    ($('[data-testid="correction-reason"]') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    await tick();
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(false);

    // 存档被外部改坏（跨标签同步进来）
    window.localStorage.setItem(RELEASE_KEY, '{损坏');
    window.dispatchEvent(new StorageEvent('storage', { key: RELEASE_KEY }));
    await tick(2);

    expect($('[data-testid="release-archive-warning"]')?.textContent).toContain('无法安全恢复');
    expect(($('[data-testid="correction-issue"]') as HTMLButtonElement).disabled).toBe(true);
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);
    // 原档逐字保留，历史最近一次完整记录仍可只读复核
    expect(window.localStorage.getItem(RELEASE_KEY)).toBe('{损坏');
    expect($$('[data-testid="release-history-item"]')).toHaveLength(1);
    mounted.unmount();
  });
});
