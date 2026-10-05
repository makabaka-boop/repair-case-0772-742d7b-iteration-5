import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReleaseSlip, type CalibrationGateView, type ReleaseSlip } from '../../src/lib/release';
import { analyzeCorrectionChains, createCorrectionSlip } from '../../src/lib/correction';
import {
  analyzeForkAdjudications,
  evaluateForkStates,
  prepareForkDecision,
  type ReleaseForkDecision
} from '../../src/lib/forkAdjudication';
import {
  __resetReleaseMemoryForTests,
  appendForkDecision,
  appendReleaseSlip,
  loadReleaseState
} from '../../src/lib/releaseStorage';

const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
const passGate = (): CalibrationGateView => ({
  verdict: 'pass',
  result: {
    verdict: 'pass',
    readings: legalReadings.map((raw, index) => ({ index, label: `${index + 1}`, raw, value: Number(raw), inRange: true, outReason: null })),
    threshold: { min: 0.7, max: 0.8, spread: 0.1, spreadLimit: 0.15, spreadOk: true, rangeMin: 0.6, rangeMax: 0.9 },
    conclusion: '合格'
  },
  judgedRaws: legalReadings.slice(),
  currentReadings: legalReadings.slice(),
  protected: false,
  recordVersion: 2
});

let seq = 0;
function sources() {
  seq += 1;
  const n = seq;
  return { now: () => new Date(Date.UTC(2026, 9, 5, 10, 0, n)), random: () => n / 4096 };
}

function original(text = '12，一。'): ReleaseSlip {
  return createReleaseSlip({ text, rawWidth: '4', gate: passGate() }, sources()).slip!;
}
function correction(text: string, parent: string | null, reason = '更正'): ReleaseSlip {
  return createCorrectionSlip({ text, rawWidth: '4', gate: passGate(), reason, supersedesId: parent }, sources()).slip!;
}
function appendAll(slips: ReleaseSlip[]) {
  slips.forEach((slip) => expect(appendReleaseSlip(slip)).toEqual({ ok: true }));
}
function decision(
  parent: string,
  successors: string[],
  selected: string,
  overrides: Partial<ReleaseForkDecision> = {}
): ReleaseForkDecision {
  seq += 1;
  const n = seq;
  return {
    id: `FD-${String(n).padStart(4, '0')}`,
    decidedAt: new Date(Date.UTC(2026, 9, 5, 11, 0, n)).toISOString(),
    forkParentId: parent,
    successorIds: successors,
    selectedSuccessorId: selected,
    reason: `选择 ${selected}`,
    supersedesDecisionIds: [],
    ...overrides
  };
}

describe('forkAdjudication 纯函数：嵌套分叉、迟到分支与重复裁决', () => {
  it('裁决绑定分叉点与完整直接后继集合，选择分支后只有无未裁决嵌套分叉的终端现行', () => {
    const root = original();
    const a = correction('12，二。', root.id, 'A');
    const b = correction('12，三。', root.id, 'B');
    const a1 = correction('12，四。', a.id, 'A1');
    const a2 = correction('12，五。', a.id, 'A2');
    const b1 = correction('12，六。', b.id, 'B1');
    const slips = [root, a, b, a1, a2, b1];

    const rootDecision = decision(root.id, [a.id, b.id], a.id);
    let info = analyzeForkAdjudications(slips, [rootDecision]);
    expect(info.forks.get(root.id)?.state).toBe('resolved');
    // A 内部仍有嵌套分叉，不能提前宣布 A1/A2 中任一终端现行。
    expect([...info.statusById.values()]).not.toContain('adjudicated-current');
    expect(info.statusById.get(a.id)).toBe('adjudicated-blocked-path');
    expect(info.statusById.get(b.id)).toBe('adjudicated-rejected-branch');
    expect(info.statusById.get(b1.id)).toBe('adjudicated-rejected-branch');
    const rootTraceA = info.tracesByFork.get(root.id)?.find((trace) => trace.successorId === a.id);
    expect(rootTraceA?.status).toBe('unresolved-fork');
    expect(rootTraceA?.stoppedAtForkId).toBe(a.id);

    const nestedDecision = decision(a.id, [a1.id, a2.id], a2.id);
    info = analyzeForkAdjudications(slips, [rootDecision, nestedDecision]);
    expect(info.statusById.get(root.id)).toBe('fork-adjudicated');
    expect(info.statusById.get(a.id)).toBe('fork-adjudicated');
    expect(info.statusById.get(a1.id)).toBe('adjudicated-rejected-branch');
    expect(info.statusById.get(a2.id)).toBe('adjudicated-current');
    expect(info.statusById.get(b1.id)).toBe('adjudicated-rejected-branch');
  });

  it('后来新增直接后继时，旧裁决自动失效，必须重新裁决', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    const oldDecision = decision(root.id, [a.id, b.id], a.id);
    const c = correction('12，四。', root.id);
    const states = evaluateForkStates([root, a, b, c], [oldDecision]);
    expect(states.get(root.id)?.state).toBe('pending');
    expect(states.get(root.id)?.staleDecisionIds).toEqual([oldDecision.id]);

    const prepared = prepareForkDecision(
      [root, a, b, c],
      [oldDecision],
      { forkParentId: root.id, successorIds: [a.id, b.id], selectedSuccessorId: a.id, reason: '旧选择' }
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.errors[0].code).toBe('successor-set-stale');
    }
  });

  it('相同选择的重复提交幂等，不制造不同现行结论', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    const first = prepareForkDecision(
      [root, a, b],
      [],
      { forkParentId: root.id, successorIds: [a.id, b.id], selectedSuccessorId: a.id, reason: '选 A' },
      sources()
    );
    expect(first.ok).toBe(true);
    if (first.ok && first.decision) {
      const duplicate = prepareForkDecision([root, a, b], [first.decision], {
        forkParentId: root.id,
        successorIds: [a.id, b.id],
        selectedSuccessorId: a.id,
        reason: '另一条相同选择'
      });
      expect(duplicate).toEqual({ ok: true, duplicate: true });
      const info = analyzeForkAdjudications([root, a, b], [first.decision]);
      expect(info.forks.get(root.id)?.selectedSuccessorId).toBe(a.id);
    }
  });
});

describe('forkAdjudication 纯函数：双页签冲突与重新裁决', () => {
  it('两个页签选择不同分支时显示冲突，不会最后写入者获胜；基于全部冲突记录可重新裁决', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    const chooseA = decision(root.id, [a.id, b.id], a.id, { id: 'FD-A', reason: '甲' });
    const chooseB = decision(root.id, [a.id, b.id], b.id, { id: 'FD-B', reason: '乙' });
    const conflicting = analyzeForkAdjudications([root, a, b], [chooseA, chooseB]);
    expect(conflicting.forks.get(root.id)?.state).toBe('conflicting');
    expect(conflicting.forks.get(root.id)?.activeDecisionIds).toEqual(['FD-A', 'FD-B']);
    expect(conflicting.statusById.get(root.id)).toBe('fork-conflict');

    const staleAttempt = prepareForkDecision([root, a, b], [chooseA, chooseB], {
      forkParentId: root.id,
      successorIds: [a.id, b.id],
      selectedSuccessorId: b.id,
      reason: '只带着旧存档再次选 B',
      supersedesDecisionIds: ['FD-A']
    });
    expect(staleAttempt.ok).toBe(false);

    const redecide = prepareForkDecision(
      [root, a, b],
      [chooseA, chooseB],
      {
        forkParentId: root.id,
        successorIds: [a.id, b.id],
        selectedSuccessorId: b.id,
        reason: '查看两条冲突后决定 B',
        supersedesDecisionIds: ['FD-A', 'FD-B']
      },
      sources()
    );
    expect(redecide.ok).toBe(true);
    if (redecide.ok && redecide.decision) {
      const resolved = analyzeForkAdjudications([root, a, b], [chooseA, chooseB, redecide.decision]);
      expect(resolved.forks.get(root.id)?.state).toBe('resolved');
      expect(resolved.forks.get(root.id)?.activeDecisionIds).toEqual([redecide.decision.id]);
      expect(resolved.forks.get(root.id)?.selectedSuccessorId).toBe(b.id);
    }
  });

  it('链分析仍然识别原始更正分叉；裁决只作为独立记录存在', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    expect(analyzeCorrectionChains([root, a, b]).forks).toEqual([{ parentId: root.id, slipIds: [a.id, b.id] }]);
  });
});

describe('forkAdjudication 与只追加存档 / 保护态', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetReleaseMemoryForTests();
    vi.restoreAllMocks();
  });

  it('裁决独立追加，原放行单和更正单字段不被修改；刷新后仍按同一状态分析', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    appendAll([root, a, b]);
    const rootDecision = decision(root.id, [a.id, b.id], a.id);
    expect(appendForkDecision(rootDecision)).toEqual({ ok: true, duplicate: false });

    const stored = JSON.parse(window.localStorage.getItem('braille-plate:release:v1') ?? '{}');
    expect(stored.slips).toHaveLength(3);
    expect(stored.forkDecisions).toEqual([rootDecision]);
    expect(stored.slips[0].forkDecision).toBeUndefined();

    const restored = loadReleaseState();
    const info = analyzeForkAdjudications(restored.slips, restored.forkDecisions);
    expect(info.forks.get(root.id)?.selectedSuccessorId).toBe(a.id);
  });

  it('迟到新分支使基于旧后继集合的裁决拒写，旧存档不被修改', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    appendAll([root, a, b]);
    const before = window.localStorage.getItem('braille-plate:release:v1');
    const late = correction('12，四。', root.id);
    appendReleaseSlip(late);

    const stale = decision(root.id, [a.id, b.id], a.id, { id: 'FD-STALE' });
    expect(appendForkDecision(stale)).toEqual({ ok: false, kind: 'decision-stale' });
    expect(window.localStorage.getItem('braille-plate:release:v1')).not.toContain('FD-STALE');
    expect(JSON.parse(window.localStorage.getItem('braille-plate:release:v1') ?? '{}').slips).toHaveLength(4);
    expect(before).not.toBeNull();
  });

  it('裁决结构损坏或引用损坏进入保护态并拒写；旧存档继续可从保护态只读取证', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    appendAll([root, a, b]);
    appendForkDecision(decision(root.id, [a.id, b.id], a.id, { id: 'FD-OLD' }));

    window.localStorage.setItem(
      'braille-plate:release:v1',
      JSON.stringify({ version: 1, slips: [root, a, b], forkDecisions: [{ id: 'bad' }] })
    );
    const protectedState = loadReleaseState();
    expect(protectedState.protected).toBe(true);
    expect(protectedState.warning?.kind).toBe('invalid-decision');
    expect(protectedState.slips.map((slip) => slip.id)).toEqual([root.id, a.id, b.id]);
    expect(appendForkDecision(decision(root.id, [a.id, b.id], a.id, { id: 'FD-NEW' }))).toEqual({
      ok: false,
      kind: 'write-failed'
    });
  });

  it('相同裁决编号和内容重复写入幂等；不同内容同编号拒绝', () => {
    const root = original();
    const a = correction('12，二。', root.id);
    const b = correction('12，三。', root.id);
    appendAll([root, a, b]);
    const first = decision(root.id, [a.id, b.id], a.id, { id: 'FD-SAME' });
    expect(appendForkDecision(first)).toEqual({ ok: true, duplicate: false });
    expect(appendForkDecision(first)).toEqual({ ok: true, duplicate: true });
    const different = decision(root.id, [a.id, b.id], b.id, { id: 'FD-SAME' });
    expect(appendForkDecision(different)).toEqual({ ok: false, kind: 'write-failed' });
    expect(loadReleaseState().forkDecisions).toEqual([first]);
  });
});
