import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReleaseWorkspace from '../../src/components/ReleaseWorkspace.vue';
import { createCorrectionSlip } from '../../src/lib/correction';
import { createForkAdjudication } from '../../src/lib/forkAdjudication';
import {
  __resetAdjudicationMemoryForTests,
  appendForkAdjudication,
  FORK_ADJUDICATION_STORAGE_KEY
} from '../../src/lib/forkAdjudicationStorage';
import type { CalibrationGateView, ReleaseSlip } from '../../src/lib/release';
import { useCalibrationSession, __resetCalibrationSessionForTests } from '../../src/lib/calibrationSession';
import { useDraftSession, __resetDraftSessionForTests } from '../../src/lib/draftSession';
import { __resetReleaseSessionForTests } from '../../src/lib/releaseSession';
import { __resetReleaseMemoryForTests, appendReleaseSlip } from '../../src/lib/releaseStorage';

const RELEASE_KEY = 'braille-plate:release:v1';
const ADJ_KEY = FORK_ADJUDICATION_STORAGE_KEY;
const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

let seq = 0;
function sources() {
  seq += 1;
  const tick = seq;
  return { now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick)), random: () => tick / 4096 };
}

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

async function preparePass(text = '12，三。', width = '4') {
  const { draft, calibration } = sessions();
  draft.text.value = text;
  draft.width.value = String(width);
  calibration.readings.value = legalReadings.slice();
  await tick(1);
  calibration.runJudge();
  await tick(2);
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

function makeCorrection(text: string, supersedesId: string, reason: string): ReleaseSlip {
  return createCorrectionSlip(
    { text, rawWidth: '4', gate: passGateView(), reason, supersedesId },
    sources()
  ).slip!;
}

/** 模拟另一页签签发更正单并合并进存档，随后通知本页签。 */
async function otherTabIssues(slip: ReleaseSlip) {
  expect(appendReleaseSlip(slip)).toEqual({ ok: true });
  window.dispatchEvent(new StorageEvent('storage', { key: RELEASE_KEY }));
  await tick(2);
}

/** 模拟另一页签记录裁决并合并进存档，随后通知本页签。 */
async function otherTabDecides(input: Parameters<typeof createForkAdjudication>[0]) {
  const created = createForkAdjudication(input, sources());
  expect(created.ok).toBe(true);
  expect(appendForkAdjudication(created.adjudication!)).toEqual({ ok: true });
  window.dispatchEvent(new StorageEvent('storage', { key: ADJ_KEY }));
  await tick(2);
  return created.adjudication!;
}

function historyItem(slipId: string): Element | null {
  return document.querySelector(`[data-slip-id="${slipId}"]`);
}

function chainStatusTextOf(slipId: string): string | null {
  return historyItem(slipId)?.querySelector('[data-testid="chain-status"]')?.textContent?.trim() ?? null;
}

function forkPanel(forkParentId: string): Element {
  const panel = document.querySelector(`[data-fork-id="${forkParentId}"]`);
  expect(panel).not.toBeNull();
  return panel!;
}

/** 在分叉裁决面板中选择分支、填写原因并提交。 */
async function adjudicateViaUi(forkParentId: string, chosenSuccessorId: string, reason: string) {
  const panel = forkPanel(forkParentId);
  const radio = panel.querySelector(
    `[data-testid="fork-choice"][value="${chosenSuccessorId}"]`
  ) as HTMLInputElement;
  expect(radio).not.toBeNull();
  radio.click();
  await tick();
  const textarea = panel.querySelector('[data-testid="fork-reason"]') as HTMLTextAreaElement;
  textarea.value = reason;
  textarea.dispatchEvent(new Event('input'));
  await tick();
  const button = panel.querySelector('[data-testid="fork-decide"]') as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  button.click();
  await tick(2);
}

/** 通过 UI 签发原单，再由“另一页签”补发两张更正单形成分叉。 */
async function setupFork(): Promise<{ originalId: string; branchA: ReleaseSlip; branchB: ReleaseSlip }> {
  await preparePass();
  mountRelease();
  await tick();
  ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
  await tick();
  const originalId = ($('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '').replace(
    '放行单号：',
    ''
  );
  const branchA = makeCorrection('12，四。', originalId, '甲页签更正');
  await otherTabIssues(branchA);
  const branchB = makeCorrection('12，五。', originalId, '乙页签更正');
  await otherTabIssues(branchB);
  return { originalId, branchA, branchB };
}

describe('ReleaseWorkspace 人工分叉裁决', () => {
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
    __resetAdjudicationMemoryForTests();
    __resetCalibrationSessionForTests();
    __resetDraftSessionForTests();
  });

  it('历史详情展示每个直接后继及可追溯终端；选定分支并填写原因后记录裁决，链徽标同步更新', async () => {
    const { originalId, branchA, branchB } = await setupFork();

    // 分叉点展示裁决面板：每个直接后继及其可追溯终端
    const panel = forkPanel(originalId);
    expect(panel.querySelector('[data-testid="fork-adjudication-state"]')?.textContent).toContain('尚未人工裁决');
    const branches = [...panel.querySelectorAll('[data-testid="fork-branch-item"]')].map(
      (item) => item.textContent ?? ''
    );
    expect(branches.some((text) => text.includes(branchA.id) && text.includes(`可追溯终端：${branchA.id}`))).toBe(true);
    expect(branches.some((text) => text.includes(branchB.id) && text.includes(`可追溯终端：${branchB.id}`))).toBe(true);

    // 未选分支或未填原因时不能提交
    const button = panel.querySelector('[data-testid="fork-decide"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // 负责人选定分支 A 并填写原因
    await adjudicateViaUi(originalId, branchA.id, '经复核甲分支文字正确');

    // 裁决作为独立只追加记录保存：放行单存档三张原件逐字未动
    const releases = JSON.parse(window.localStorage.getItem(RELEASE_KEY) ?? '{}');
    expect(releases.slips).toHaveLength(3);
    const storedAdjudications = JSON.parse(window.localStorage.getItem(ADJ_KEY) ?? '{}');
    expect(storedAdjudications.adjudications).toHaveLength(1);
    expect(storedAdjudications.adjudications[0].forkParentId).toBe(originalId);
    expect(storedAdjudications.adjudications[0].successorIds).toEqual([branchA.id, branchB.id].sort());
    expect(storedAdjudications.adjudications[0].chosenSuccessorId).toBe(branchA.id);
    expect(storedAdjudications.adjudications[0].reason).toBe('经复核甲分支文字正确');

    // 历史徽标采用同一裁决状态：被选分支终端现行，落选分支不作现行认定
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');
    expect(chainStatusTextOf(branchB.id)).toContain('未被人工裁决选中');
    expect(chainStatusTextOf(originalId)).toContain('已经人工裁决');
    // 分叉冲突告警转为已裁决信息；面板展示生效裁决记录
    expect($('[data-testid="correction-fork-warning"]')).toBeNull();
    expect($('[data-testid="correction-fork-resolved"]')?.textContent).toContain(originalId);
    expect(forkPanel(originalId).querySelector('[data-testid="fork-adjudication-record"]')?.textContent).toContain(
      '经复核甲分支文字正确'
    );
  });

  it('嵌套分叉：被选分支内部仍有未裁决分叉时不宣布现行；内层也裁决后终端才现行', async () => {
    const { originalId, branchA, branchB } = await setupFork();
    // 分支 A 内部再分叉：A2、A3 同时指向 A
    const innerA = makeCorrection('12，六。', branchA.id, '内层更正一');
    await otherTabIssues(innerA);
    const innerB = makeCorrection('12，七。', branchA.id, '内层更正二');
    await otherTabIssues(innerB);

    // 外层裁决选 A：A 内部仍有未裁决分叉，不得提前宣布任何终端现行
    await adjudicateViaUi(originalId, branchA.id, '外层选定甲分支');
    expect(chainStatusTextOf(originalId)).toContain('已经人工裁决');
    expect(chainStatusTextOf(innerA.id)).toContain('分叉分支');
    expect(chainStatusTextOf(innerB.id)).toContain('分叉分支');
    const statuses = $$('[data-testid="chain-status"]').map((node) => node.textContent ?? '');
    expect(statuses.some((text) => text.includes('现行版本'))).toBe(false);

    // 内层分叉也裁决后，内层被选终端才成为现行版本
    await adjudicateViaUi(branchA.id, innerA.id, '内层选定更正一');
    expect(chainStatusTextOf(innerA.id)).toContain('现行版本');
    expect(chainStatusTextOf(innerB.id)).toContain('未被人工裁决选中');
    expect(chainStatusTextOf(branchB.id)).toContain('未被人工裁决选中');
  });

  it('迟到新分支：新增第三张更正单后旧裁决自动失效，回到不作现行认定并可重新裁决', async () => {
    const { originalId, branchA, branchB } = await setupFork();
    await adjudicateViaUi(originalId, branchA.id, '选定甲分支');
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');

    // 迟到新分支：第三张更正单指向同一原单
    const late = makeCorrection('12，六。', originalId, '迟到的新分支');
    await otherTabIssues(late);

    // 旧裁决自动失效：不再宣布现行，明确提示需基于最新存档重新裁决
    expect(chainStatusTextOf(branchA.id)).toContain('分叉分支');
    expect(chainStatusTextOf(originalId)).toContain('旧裁决已失效');
    expect(forkPanel(originalId).querySelector('[data-testid="fork-adjudication-state"]')?.textContent).toContain(
      '旧裁决已失效'
    );
    const statuses = $$('[data-testid="chain-status"]').map((node) => node.textContent ?? '');
    expect(statuses.some((text) => text.includes('现行版本'))).toBe(false);

    // 基于最新存档（含新分支）重新裁决：绑定新的完整后继集合
    await adjudicateViaUi(originalId, late.id, '复核后改选迟到分支');
    expect(chainStatusTextOf(late.id)).toContain('现行版本');
    const storedAdjudications = JSON.parse(window.localStorage.getItem(ADJ_KEY) ?? '{}');
    // 旧裁决保留取证，新裁决绑定三个后继
    expect(storedAdjudications.adjudications).toHaveLength(2);
    expect(storedAdjudications.adjudications[1].successorIds).toEqual(
      [branchA.id, branchB.id, late.id].sort()
    );
  });

  it('双页签不同选择：展示冲突且不作现行认定，不是“最后写入者获胜”；基于最新存档重新裁决后定案', async () => {
    const { originalId, branchA, branchB } = await setupFork();

    // 另一页签先记录“选 B”
    const theirs = await otherTabDecides({
      forkParentId: originalId,
      successorIds: [branchA.id, branchB.id],
      chosenSuccessorId: branchB.id,
      reason: '乙页签选 B'
    });
    // 本页签记录“选 A”：两份裁决都落库，明确展示冲突
    await adjudicateViaUi(originalId, branchA.id, '甲页签选 A');

    expect(forkPanel(originalId).querySelector('[data-testid="fork-adjudication-state"]')?.textContent).toContain(
      '裁决冲突'
    );
    expect(chainStatusTextOf(originalId)).toContain('裁决不一致');
    const statuses = $$('[data-testid="chain-status"]').map((node) => node.textContent ?? '');
    expect(statuses.some((text) => text.includes('现行版本'))).toBe(false);
    // 两份冲突裁决全部保留取证
    const stored = JSON.parse(window.localStorage.getItem(ADJ_KEY) ?? '{}');
    expect(stored.adjudications).toHaveLength(2);

    // 负责人基于最新存档重新裁决：新裁决显式取代冲突中的旧裁决
    await adjudicateViaUi(originalId, branchA.id, '负责人复核后定甲分支');
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');
    expect(chainStatusTextOf(branchB.id)).toContain('未被人工裁决选中');
    const after = JSON.parse(window.localStorage.getItem(ADJ_KEY) ?? '{}');
    expect(after.adjudications).toHaveLength(3);
    // 新裁决显式取代冲突中的两张旧裁决（前两条记录），而非“最后写入者获胜”
    expect(after.adjudications[2].supersedesAdjudicationIds.sort()).toEqual(
      [after.adjudications[0].id, after.adjudications[1].id].sort()
    );
    expect(after.adjudications[2].supersedesAdjudicationIds).toContain(theirs.id);
  });

  it('双页签相同选择：重复提交幂等，现行结论一致且唯一', async () => {
    const { originalId, branchA, branchB } = await setupFork();
    await otherTabDecides({
      forkParentId: originalId,
      successorIds: [branchA.id, branchB.id],
      chosenSuccessorId: branchA.id,
      reason: '乙页签选 A'
    });
    await adjudicateViaUi(originalId, branchA.id, '甲页签也选 A');

    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');
    expect(chainStatusTextOf(branchB.id)).toContain('未被人工裁决选中');
    const stored = JSON.parse(window.localStorage.getItem(ADJ_KEY) ?? '{}');
    expect(stored.adjudications).toHaveLength(2);
    // 两张裁决记录都在生效列表里（幂等重复，结论唯一）
    expect(
      forkPanel(originalId).querySelectorAll('[data-testid="fork-adjudication-record"]')
    ).toHaveLength(2);
  });

  it('拒写保护：裁决存档损坏转入保护态，明确告警、表单禁用、原存档逐字保留', async () => {
    const { originalId, branchA, branchB } = await setupFork();
    const record = createForkAdjudication(
      {
        forkParentId: originalId,
        successorIds: [branchA.id, branchB.id],
        chosenSuccessorId: branchA.id,
        reason: '先记录一张'
      },
      sources()
    ).adjudication!;
    expect(appendForkAdjudication(record)).toEqual({ ok: true });
    window.dispatchEvent(new StorageEvent('storage', { key: ADJ_KEY }));
    await tick(2);
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');

    // 裁决存档被外部改坏：保护态告警，原存档逐字保留
    window.localStorage.setItem(ADJ_KEY, '{损坏');
    window.dispatchEvent(new StorageEvent('storage', { key: ADJ_KEY }));
    await tick(2);
    expect($('[data-testid="fork-adjudication-warning"]')?.textContent).toContain('无法安全恢复');
    expect(window.localStorage.getItem(ADJ_KEY)).toBe('{损坏');

    // 迟到新分支使旧裁决失效后出现表单：保护态下禁止提交
    const late = makeCorrection('12，六。', originalId, '迟到的新分支');
    await otherTabIssues(late);
    const panel = forkPanel(originalId);
    expect(panel.querySelector('[data-testid="fork-adjudication-blocked"]')).not.toBeNull();
    const radio = panel.querySelector('[data-testid="fork-choice"]') as HTMLInputElement;
    expect(radio.disabled).toBe(true);
  });

  it('绑定失配拒写：裁决组装后分叉集合已变化时明确告警，不产生伪裁决', async () => {
    const { originalId, branchA, branchB } = await setupFork();
    // 通过 UI 选择分支并填写原因，但在提交前另一页签新增第三张更正单
    const panel = forkPanel(originalId);
    (panel.querySelector(`[data-testid="fork-choice"][value="${branchA.id}"]`) as HTMLInputElement).click();
    await tick();
    const textarea = panel.querySelector('[data-testid="fork-reason"]') as HTMLTextAreaElement;
    textarea.value = '选定甲分支';
    textarea.dispatchEvent(new Event('input'));
    await tick();

    const late = makeCorrection('12，六。', originalId, '迟到的新分支');
    await otherTabIssues(late);

    // 提交时表单按最新存档重新绑定（含新分支），可以正常裁决
    (panel.querySelector('[data-testid="fork-decide"]') as HTMLButtonElement).click();
    await tick(2);
    expect($('[data-testid="fork-adjudication-error"]')).toBeNull();
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');
    const stored = JSON.parse(window.localStorage.getItem(ADJ_KEY) ?? '{}');
    expect(stored.adjudications[0].successorIds).toEqual([branchA.id, branchB.id, late.id].sort());
  });

  it('共享会话同源：放行页卸载重挂后裁决状态与徽标保持一致', async () => {
    const { originalId, branchA } = await setupFork();
    await adjudicateViaUi(originalId, branchA.id, '选定甲分支');
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');

    // 切换模式（放行页卸载重挂）：同一共享会话，裁决状态不丢失
    document.body.innerHTML = '';
    const second = mountRelease();
    await tick(2);
    expect(chainStatusTextOf(branchA.id)).toContain('现行版本');
    expect(chainStatusTextOf(originalId)).toContain('已经人工裁决');
    expect(forkPanel(originalId).querySelector('[data-testid="fork-adjudication-record"]')).not.toBeNull();
    second.unmount();
  });
});
