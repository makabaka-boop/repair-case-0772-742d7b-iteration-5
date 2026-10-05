import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReleaseWorkspace from '../../src/components/ReleaseWorkspace.vue';
import {
  __resetReleaseMemoryForTests,
  appendReleaseSlip
} from '../../src/lib/releaseStorage';
import { createReleaseSlip, type CalibrationGateView, type ReleaseSlip } from '../../src/lib/release';
import { createCorrectionSlip } from '../../src/lib/correction';
import {
  __resetCalibrationSessionForTests
} from '../../src/lib/calibrationSession';
import { __resetDraftSessionForTests } from '../../src/lib/draftSession';
import { __resetReleaseSessionForTests } from '../../src/lib/releaseSession';

const readings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
function gate(): CalibrationGateView {
  return {
    verdict: 'pass',
    result: {
      verdict: 'pass',
      readings: readings.map((raw, index) => ({ index, label: `${index}`, raw, value: Number(raw), inRange: true, outReason: null })),
      threshold: { min: 0.7, max: 0.8, spread: 0.1, spreadLimit: 0.15, spreadOk: true, rangeMin: 0.6, rangeMax: 0.9 },
      conclusion: '合格'
    },
    judgedRaws: readings.slice(),
    currentReadings: readings.slice(),
    protected: false,
    recordVersion: 2
  };
}
let seq = 0;
function sources() {
  seq += 1;
  const n = seq;
  return { now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, n)), random: () => n / 4096 };
}
function original() {
  return createReleaseSlip({ text: '12，一。', rawWidth: '4', gate: gate() }, sources()).slip!;
}
function correction(text: string, parent: string): ReleaseSlip {
  return createCorrectionSlip({ text, rawWidth: '4', gate: gate(), reason: text, supersedesId: parent }, sources()).slip!;
}
function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(ReleaseWorkspace);
  app.mount(container);
  return {
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}
async function tick(times = 2) {
  for (let i = 0; i < times; i += 1) {
    await nextTick();
  }
}

describe('ReleaseWorkspace 人工分叉裁决集成', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetReleaseMemoryForTests();
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

  it('历史详情展示直接后继和终端；提交独立只追加裁决后共享徽标认定现行终端', async () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    appendReleaseSlip(root);
    appendReleaseSlip(a);
    appendReleaseSlip(b);

    const mounted = mount();
    await tick();

    const panel = document.querySelector<HTMLElement>('[data-testid="fork-adjudication"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain(a.id);
    expect(panel?.textContent).toContain(b.id);
    expect(panel?.textContent).toContain(`可追溯终端：${a.id}`);
    expect(panel?.textContent).toContain(`可追溯终端：${b.id}`);

    const button = panel?.querySelector<HTMLButtonElement>('[data-testid="fork-decide"]');
    expect(button?.disabled).toBe(true);
    const choice = panel?.querySelector<HTMLInputElement>(`[data-testid="fork-choice"][value="${a.id}"]`);
    choice?.click();
    const reason = panel?.querySelector('textarea');
    if (reason) {
      reason.value = '经负责人核对采用 A';
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await tick();
    button?.click();
    await tick(3);

    expect(document.querySelector('[data-testid="fork-resolved"]')?.textContent).toContain(a.id);
    const statuses = [...document.querySelectorAll<HTMLElement>('[data-testid="chain-status"]')].map((el) => el.textContent);
    expect(statuses).toContain('人工裁决后的现行终端');
    const stored = JSON.parse(window.localStorage.getItem('braille-plate:release:v1') ?? '{}');
    expect(stored.slips).toHaveLength(3);
    expect(stored.forkDecisions).toHaveLength(1);
    expect(stored.forkDecisions[0]).toMatchObject({
      forkParentId: root.id,
      selectedSuccessorId: a.id,
      reason: '经负责人核对采用 A'
    });
    mounted.unmount();
  });
});
