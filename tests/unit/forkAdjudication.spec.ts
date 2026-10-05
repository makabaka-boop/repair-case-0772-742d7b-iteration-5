import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReleaseSlip,
  type CalibrationGateView,
  type ReleaseSlip
} from '../../src/lib/release';
import { analyzeCorrectionChains, createCorrectionSlip } from '../../src/lib/correction';
import {
  branchTerminals,
  createForkAdjudication,
  isWellFormedAdjudication,
  resolveForkAdjudication,
  sameIdSet,
  type ForkAdjudication
} from '../../src/lib/forkAdjudication';
import {
  __resetAdjudicationMemoryForTests,
  appendForkAdjudication,
  clearAdjudicationState,
  FORK_ADJUDICATION_STORAGE_KEY,
  loadAdjudicationState
} from '../../src/lib/forkAdjudicationStorage';
import {
  __resetReleaseMemoryForTests,
  appendReleaseSlip,
  loadReleaseState
} from '../../src/lib/releaseStorage';

const RELEASE_KEY = 'braille-plate:release:v1';
const ADJ_KEY = FORK_ADJUDICATION_STORAGE_KEY;
const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

function passGate(overrides: Partial<CalibrationGateView> = {}): CalibrationGateView {
  return {
    verdict: 'pass',
    result: {
      verdict: 'pass',
      readings: legalReadings.map((raw, index) => ({
        index,
        label: `${index + 1} 号点`,
        raw,
        value: Number(raw),
        inRange: true,
        outReason: null
      })),
      threshold: {
        min: 0.7,
        max: 0.8,
        spread: 0.1,
        spreadLimit: 0.15,
        spreadOk: true,
        rangeMin: 0.6,
        rangeMax: 0.9
      },
      conclusion: '整机结论：合格。'
    },
    judgedRaws: legalReadings.slice(),
    currentReadings: legalReadings.slice(),
    protected: false,
    recordVersion: 2,
    ...overrides
  };
}

let seq = 0;
function sources() {
  seq += 1;
  const tick = seq;
  return { now: () => new Date(Date.UTC(2026, 9, 5, 10, 30, tick)), random: () => tick / 4096 };
}

function makeOriginal(text = '12，三。', width: string | number = '4'): ReleaseSlip {
  return createReleaseSlip({ text, rawWidth: width, gate: passGate() }, sources()).slip!;
}

function makeCorrection(text: string, supersedesId: string | null, reason = '文字有误，更正重发'): ReleaseSlip {
  return createCorrectionSlip({ text, rawWidth: '4', gate: passGate(), reason, supersedesId }, sources()).slip!;
}

function makeAdjudication(
  forkParentId: string,
  successorIds: readonly string[],
  chosenSuccessorId: string,
  reason = '负责人选定现行分支',
  supersedesAdjudicationIds: readonly string[] = []
): ForkAdjudication {
  const result = createForkAdjudication(
    { forkParentId, successorIds, chosenSuccessorId, reason, supersedesAdjudicationIds },
    sources()
  );
  expect(result.ok).toBe(true);
  return result.adjudication!;
}

/** 搭建最常用分叉：原单 O 被更正单 A、B 同时指向。 */
function makeFork() {
  const original = makeOriginal();
  const branchA = makeCorrection('12，四。', original.id, '甲更正');
  const branchB = makeCorrection('12，五。', original.id, '乙更正');
  return { original, branchA, branchB, slips: [original, branchA, branchB] };
}

describe('forkAdjudication 裁决记录创建（纯函数）', () => {
  it('合法输入：生成独立编号、绑定分叉点与完整后继集合、递归冻结', () => {
    const { original, branchA, branchB } = makeFork();
    const result = createForkAdjudication(
      {
        forkParentId: original.id,
        successorIds: [branchB.id, branchA.id],
        chosenSuccessorId: branchA.id,
        reason: '  经复核甲分支文字正确  '
      },
      sources()
    );
    expect(result.ok).toBe(true);
    const record = result.adjudication!;
    expect(record.id).toMatch(/^ADJ-\d{8}-\d{6}-[0-9a-f]{8}$/);
    // 后继集合升序固化；原因去除首尾空白
    expect(record.successorIds).toEqual([branchA.id, branchB.id].sort());
    expect(record.chosenSuccessorId).toBe(branchA.id);
    expect(record.reason).toBe('经复核甲分支文字正确');
    expect(record.supersedesAdjudicationIds).toEqual([]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.successorIds)).toBe(true);
    expect(() => {
      (record as { reason: string }).reason = '篡改';
    }).toThrow(TypeError);
  });

  it('空原因、后继集合不足两个、后继重复或含空串、选择不在集合内都被阻断', () => {
    const { original, branchA, branchB } = makeFork();
    const emptyReason = createForkAdjudication(
      { forkParentId: original.id, successorIds: [branchA.id, branchB.id], chosenSuccessorId: branchA.id, reason: '  ' },
      sources()
    );
    expect(emptyReason.ok).toBe(false);
    expect(emptyReason.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'adjudication-reason-empty' })])
    );

    const tooFew = createForkAdjudication(
      { forkParentId: original.id, successorIds: [branchA.id], chosenSuccessorId: branchA.id, reason: 'r' },
      sources()
    );
    expect(tooFew.ok).toBe(false);
    expect(tooFew.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'adjudication-fork-invalid' })])
    );

    const duplicated = createForkAdjudication(
      { forkParentId: original.id, successorIds: [branchA.id, branchA.id], chosenSuccessorId: branchA.id, reason: 'r' },
      sources()
    );
    expect(duplicated.ok).toBe(false);
    expect(duplicated.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'adjudication-fork-invalid' })])
    );

    const outsider = createForkAdjudication(
      { forkParentId: original.id, successorIds: [branchA.id, branchB.id], chosenSuccessorId: 'PF-x', reason: 'r' },
      sources()
    );
    expect(outsider.ok).toBe(false);
    expect(outsider.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'adjudication-choice-invalid' })])
    );
  });

  it('结构校验：合法记录通过；缺字段、空原因、自指取代、后继不足都不可信', () => {
    const { original, branchA, branchB } = makeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    expect(isWellFormedAdjudication(record)).toBe(true);

    const base = structuredClone(record) as unknown as Record<string, unknown>;
    expect(isWellFormedAdjudication({ ...base, reason: ' ' })).toBe(false);
    expect(isWellFormedAdjudication({ ...base, successorIds: [branchA.id] })).toBe(false);
    expect(isWellFormedAdjudication({ ...base, chosenSuccessorId: 'PF-x' })).toBe(false);
    expect(isWellFormedAdjudication({ ...base, supersedesAdjudicationIds: [record.id] })).toBe(false);
    expect(isWellFormedAdjudication({ ...base, decidedAt: '不是日期' })).toBe(false);
    expect(isWellFormedAdjudication(null)).toBe(false);
    expect(isWellFormedAdjudication({ ...base, supersedesAdjudicationIds: 'x' })).toBe(false);
  });
});

describe('forkAdjudication 分叉裁决解析（纯函数）', () => {
  it('无裁决：unresolved；绑定当前集合且选择一致：resolved', () => {
    const { original, branchA, branchB } = makeFork();
    const successors = [branchA.id, branchB.id];
    expect(resolveForkAdjudication(original.id, successors, []).state).toBe('unresolved');

    const record = makeAdjudication(original.id, successors, branchA.id);
    const resolved = resolveForkAdjudication(original.id, successors, [record]);
    expect(resolved.state).toBe('resolved');
    expect(resolved.chosenSuccessorId).toBe(branchA.id);
    expect(resolved.active.map((a) => a.id)).toEqual([record.id]);
  });

  it('相同选择的重复提交幂等：多张裁决同一选择仍是同一个 resolved 结论', () => {
    const { original, branchA, branchB } = makeFork();
    const successors = [branchA.id, branchB.id];
    const first = makeAdjudication(original.id, successors, branchA.id, '第一次');
    const second = makeAdjudication(original.id, successors, branchA.id, '重复提交');
    const third = makeAdjudication(original.id, successors, branchA.id, '又一次');
    const resolved = resolveForkAdjudication(original.id, successors, [first, second, third]);
    expect(resolved.state).toBe('resolved');
    expect(resolved.chosenSuccessorId).toBe(branchA.id);
    expect(resolved.active).toHaveLength(3);
  });

  it('不同选择不是“最后写入者获胜”：冲突全部保留，须显式取代后重新裁决', () => {
    const { original, branchA, branchB } = makeFork();
    const successors = [branchA.id, branchB.id];
    // 页签甲选 A、页签乙选 B（乙更晚）：绝不能按时间挑选
    const tabA = makeAdjudication(original.id, successors, branchA.id, '甲页签');
    const tabB = makeAdjudication(original.id, successors, branchB.id, '乙页签');
    expect(Date.parse(tabB.decidedAt)).toBeGreaterThan(Date.parse(tabA.decidedAt));

    const conflict = resolveForkAdjudication(original.id, successors, [tabA, tabB]);
    expect(conflict.state).toBe('conflict');
    expect(conflict.chosenSuccessorId).toBeNull();
    expect(conflict.conflictingChoices).toEqual([branchA.id, branchB.id]);

    // 基于最新存档重新裁决：新裁决显式取代冲突中的两张旧裁决
    const re = makeAdjudication(original.id, successors, branchA.id, '负责人复核后定甲', [tabA.id, tabB.id]);
    const resolved = resolveForkAdjudication(original.id, successors, [tabA, tabB, re]);
    expect(resolved.state).toBe('resolved');
    expect(resolved.chosenSuccessorId).toBe(branchA.id);
    expect(resolved.active.map((a) => a.id)).toEqual([re.id]);
    // 旧裁决并未删除，仍留在记录里取证
    expect([tabA, tabB, re]).toHaveLength(3);
  });

  it('只取代部分冲突裁决时仍是冲突：未列出的有效裁决继续参与认定', () => {
    const { original, branchA, branchB } = makeFork();
    const successors = [branchA.id, branchB.id];
    const tabA = makeAdjudication(original.id, successors, branchA.id, '甲页签');
    const tabB = makeAdjudication(original.id, successors, branchB.id, '乙页签');
    // 新裁决只取代甲、选 B：乙的旧选择仍然有效 → 与 B 一致，resolved(B)
    const partial = makeAdjudication(original.id, successors, branchB.id, '只取代甲', [tabA.id]);
    const resolved = resolveForkAdjudication(original.id, successors, [tabA, tabB, partial]);
    expect(resolved.state).toBe('resolved');
    expect(resolved.chosenSuccessorId).toBe(branchB.id);
  });

  it('迟到新分支：旧裁决绑定的后继集合与当前不一致时自动失效（stale）', () => {
    const { original, branchA, branchB } = makeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    // 后来新增分支 C：当前后继集合变成三个
    const late = makeCorrection('12，六。', original.id, '迟到的新分支');
    const stale = resolveForkAdjudication(original.id, [branchA.id, branchB.id, late.id], [record]);
    expect(stale.state).toBe('stale');
    expect(stale.chosenSuccessorId).toBeNull();
    expect(stale.active).toHaveLength(0);
    expect(stale.stale.map((a) => a.id)).toEqual([record.id]);
    // 失效的旧裁决不能“隔空”取代新裁决
    const fresh = makeAdjudication(original.id, [branchA.id, branchB.id, late.id], late.id);
    const resolved = resolveForkAdjudication(original.id, [branchA.id, branchB.id, late.id], [record, fresh]);
    expect(resolved.state).toBe('resolved');
    expect(resolved.chosenSuccessorId).toBe(late.id);
  });

  it('sameIdSet 与 branchTerminals 工具行为', () => {
    expect(sameIdSet(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
    const { original, branchA, branchB } = makeFork();
    const downstream = makeCorrection('12，六。', branchA.id);
    const info = analyzeCorrectionChains([original, branchA, branchB, downstream]);
    expect(branchTerminals(info.childrenById, branchA.id)).toEqual([downstream.id]);
    expect(branchTerminals(info.childrenById, branchB.id)).toEqual([branchB.id]);
  });
});

describe('forkAdjudication 与更正链分析的一致性', () => {
  it('已裁决分叉：被选分支终端恢复现行，落选分支不作现行认定', () => {
    const { original, branchA, branchB, slips } = makeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    const info = analyzeCorrectionChains(slips, [record]);

    expect(info.forkResolutions.get(original.id)?.state).toBe('resolved');
    expect(info.statusById.get(branchA.id)).toBe('current');
    expect(info.statusById.get(branchB.id)).toBe('fork-branch');
    expect(info.forkBranchCauseById.get(branchB.id)).toBe('unchosen');
    // 分叉点本身仍标记为分叉点（徽标由裁决状态补充说明）
    expect(info.statusById.get(original.id)).toBe('forked');
  });

  it('嵌套分叉：被选分支内部仍有未裁决分叉时，不得提前宣布任何终端现行', () => {
    const { original, branchA, branchB } = makeFork();
    // 分支 A 内部又分叉：A2、A3 同时指向 A
    const innerA = makeCorrection('12，六。', branchA.id, '内层更正一');
    const innerB = makeCorrection('12，七。', branchA.id, '内层更正二');
    const slips = [original, branchA, branchB, innerA, innerB];

    // 外层分叉已裁决选 A，但内层分叉未裁决
    const outer = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    const pending = analyzeCorrectionChains(slips, [outer]);
    expect(pending.forkResolutions.get(original.id)?.state).toBe('resolved');
    expect(pending.forkResolutions.get(branchA.id)?.state).toBe('unresolved');
    expect(pending.statusById.get(branchA.id)).toBe('forked');
    expect(pending.statusById.get(innerA.id)).toBe('fork-branch');
    expect(pending.statusById.get(innerB.id)).toBe('fork-branch');
    expect([...pending.statusById.values()]).not.toContain('current');

    // 内层分叉也裁决后，内层被选终端才成为现行版本
    const inner = makeAdjudication(branchA.id, [innerA.id, innerB.id], innerA.id);
    const resolved = analyzeCorrectionChains(slips, [outer, inner]);
    expect(resolved.statusById.get(innerA.id)).toBe('current');
    expect(resolved.statusById.get(innerB.id)).toBe('fork-branch');
    expect(resolved.forkBranchCauseById.get(innerB.id)).toBe('unchosen');
    expect(resolved.statusById.get(branchB.id)).toBe('fork-branch');
  });

  it('嵌套分叉：外层未裁决时，内层裁决不能让任何终端先行现行', () => {
    const { original, branchA, branchB } = makeFork();
    const innerA = makeCorrection('12，六。', branchA.id, '内层更正一');
    const innerB = makeCorrection('12，七。', branchA.id, '内层更正二');
    const slips = [original, branchA, branchB, innerA, innerB];

    // 只裁决内层分叉：外层未裁决，污染照常传播
    const inner = makeAdjudication(branchA.id, [innerA.id, innerB.id], innerA.id);
    const info = analyzeCorrectionChains(slips, [inner]);
    expect(info.forkResolutions.get(branchA.id)?.state).toBe('resolved');
    expect([...info.statusById.values()]).not.toContain('current');
    expect(info.statusById.get(innerA.id)).toBe('fork-branch');
  });

  it('迟到新分支让旧裁决自动失效：链分析回到不作现行认定', () => {
    const { original, branchA, branchB, slips } = makeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    const resolved = analyzeCorrectionChains(slips, [record]);
    expect(resolved.statusById.get(branchA.id)).toBe('current');

    // 第三张更正单指向同一原单（迟到新分支）：旧裁决绑定集合失效
    const late = makeCorrection('12，六。', original.id, '迟到的新分支');
    const after = analyzeCorrectionChains([...slips, late], [record]);
    expect(after.forkResolutions.get(original.id)?.state).toBe('stale');
    expect([...after.statusById.values()]).not.toContain('current');
    expect(after.statusById.get(late.id)).toBe('fork-branch');
    expect(after.forkBranchCauseById.get(late.id)).toBe('unresolved');
  });

  it('裁决冲突：不作现行认定，冲突双方全部保留取证', () => {
    const { original, branchA, branchB, slips } = makeFork();
    const tabA = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id, '甲页签');
    const tabB = makeAdjudication(original.id, [branchA.id, branchB.id], branchB.id, '乙页签');
    const info = analyzeCorrectionChains(slips, [tabA, tabB]);
    expect(info.forkResolutions.get(original.id)?.state).toBe('conflict');
    expect([...info.statusById.values()]).not.toContain('current');
    expect(info.statusById.get(branchA.id)).toBe('fork-branch');
    expect(info.statusById.get(branchB.id)).toBe('fork-branch');
  });

  it('无裁决时行为与旧版完全一致（向后兼容）', () => {
    const { original, branchA, branchB, slips } = makeFork();
    const info = analyzeCorrectionChains(slips);
    expect(info.statusById.get(original.id)).toBe('forked');
    expect(info.statusById.get(branchA.id)).toBe('fork-branch');
    expect(info.statusById.get(branchB.id)).toBe('fork-branch');
    expect(info.forkResolutions.get(original.id)?.state).toBe('unresolved');
    expect([...info.statusById.values()]).not.toContain('current');
  });
});

describe('forkAdjudication 只追加存档', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetReleaseMemoryForTests();
    __resetAdjudicationMemoryForTests();
    vi.restoreAllMocks();
  });

  /** 把分叉单据写入放行存档，返回分叉信息。 */
  function storeFork() {
    const { original, branchA, branchB, slips } = makeFork();
    for (const slip of slips) {
      expect(appendReleaseSlip(slip)).toEqual({ ok: true });
    }
    return { original, branchA, branchB, slips };
  }

  it('首次加载为空且不保护；成功记录后按顺序恢复并冻结', () => {
    const empty = loadAdjudicationState();
    expect(empty.adjudications).toEqual([]);
    expect(empty.protected).toBe(false);

    const { original, branchA, branchB } = storeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    expect(appendForkAdjudication(record)).toEqual({ ok: true });

    const restored = loadAdjudicationState();
    expect(restored.protected).toBe(false);
    expect(restored.adjudications.map((a) => a.id)).toEqual([record.id]);
    expect(Object.isFrozen(restored.adjudications[0])).toBe(true);
    // 裁决存档独立于放行单存档：原放行单、更正单逐字未动
    const releases = loadReleaseState();
    expect(releases.slips).toHaveLength(3);
    expect(releases.slips.every((slip) => slip.correction === undefined || slip.id !== original.id)).toBe(true);
  });

  it('同编号同内容幂等成功；同编号不同内容是明确编号冲突，原裁决逐字保留', () => {
    const { original, branchA, branchB } = storeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    expect(appendForkAdjudication(record)).toEqual({ ok: true });
    expect(appendForkAdjudication(record)).toEqual({ ok: true });
    expect(loadAdjudicationState().adjudications).toHaveLength(1);

    const conflicting = {
      ...structuredClone(makeAdjudication(original.id, [branchA.id, branchB.id], branchB.id, '另一选择')),
      id: record.id
    } as ForkAdjudication;
    expect(appendForkAdjudication(conflicting)).toEqual({ ok: false, kind: 'id-conflict' });
    const restored = loadAdjudicationState();
    expect(restored.adjudications).toHaveLength(1);
    expect(restored.adjudications[0].chosenSuccessorId).toBe(branchA.id);
  });

  it('拒写保护一：迟到新分支后，基于旧后继集合的裁决被拒绝（fork-mismatch）', () => {
    const { original, branchA, branchB } = storeFork();
    // 裁决基于 [A, B] 组装；写入前第三张更正单先到
    const stale = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    const late = makeCorrection('12，六。', original.id, '迟到的新分支');
    expect(appendReleaseSlip(late)).toEqual({ ok: true });

    expect(appendForkAdjudication(stale)).toEqual({ ok: false, kind: 'fork-mismatch' });
    expect(loadAdjudicationState().adjudications).toHaveLength(0);

    // 基于最新存档（含新分支）重新裁决即可写入
    const fresh = makeAdjudication(original.id, [branchA.id, branchB.id, late.id], branchA.id);
    expect(appendForkAdjudication(fresh)).toEqual({ ok: true });
  });

  it('拒写保护二：分叉点不存在或所选分支不在集合内时拒绝写入', () => {
    const { original, branchA, branchB } = storeFork();
    // 分叉点不存在（线性链没有分叉）
    const linear = makeOriginal('一二三', '8');
    const only = makeCorrection('12，四。', linear.id);
    expect(appendReleaseSlip(linear)).toEqual({ ok: true });
    expect(appendReleaseSlip(only)).toEqual({ ok: true });
    const noFork = makeAdjudication(linear.id, [only.id, branchA.id], only.id);
    expect(appendForkAdjudication(noFork)).toEqual({ ok: false, kind: 'fork-mismatch' });

    // 放行单存档保护态：无法核对绑定，拒绝写入
    window.localStorage.setItem(RELEASE_KEY, '{损坏');
    __resetReleaseMemoryForTests();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    expect(appendForkAdjudication(record)).toEqual({ ok: false, kind: 'release-unavailable' });
    expect(loadAdjudicationState().adjudications).toHaveLength(0);
  });

  it('拒写保护三：裁决存档损坏转入保护态，拒绝新写入且原存档逐字保留', () => {
    const { original, branchA, branchB } = storeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    expect(appendForkAdjudication(record)).toEqual({ ok: true });

    window.localStorage.setItem(ADJ_KEY, '{不是合法 JSON');
    __resetAdjudicationMemoryForTests();
    const state = loadAdjudicationState();
    expect(state.protected).toBe(true);
    expect(state.warning?.kind).toBe('corrupted-json');

    const fresh = makeAdjudication(original.id, [branchA.id, branchB.id], branchB.id, '保护态下尝试');
    expect(appendForkAdjudication(fresh)).toEqual({ ok: false, kind: 'write-failed' });
    expect(window.localStorage.getItem(ADJ_KEY)).toBe('{不是合法 JSON');
  });

  it('拒写保护四：裁决记录字段损坏转入保护态；未知版本同样保护', () => {
    const { original, branchA, branchB } = storeFork();
    const broken = { ...structuredClone(makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id)), reason: '' };
    window.localStorage.setItem(ADJ_KEY, JSON.stringify({ version: 1, adjudications: [broken] }));
    __resetAdjudicationMemoryForTests();
    expect(loadAdjudicationState().warning?.kind).toBe('invalid-record');

    window.localStorage.setItem(ADJ_KEY, JSON.stringify({ version: 99, adjudications: [] }));
    __resetAdjudicationMemoryForTests();
    expect(loadAdjudicationState().warning?.kind).toBe('unknown-version');
  });

  it('拒写保护五：写入配额 / 权限失败明确告警，原存档逐字保留', () => {
    const { original, branchA, branchB } = storeFork();
    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === ADJ_KEY) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
    });
    expect(appendForkAdjudication(record)).toEqual({ ok: false, kind: 'write-failed' });
    expect(window.localStorage.getItem(ADJ_KEY)).toBeNull();
    spy.mockRestore();
    expect(appendForkAdjudication(record)).toEqual({ ok: true });
  });

  it('冲突合并：两个页签各记录不同选择，两份裁决都落库，解析为冲突而非最后写入者获胜', () => {
    const { original, branchA, branchB } = storeFork();
    // 页签甲基于空存档追加“选 A”；页签乙基于空存档追加“选 B”（交错后合并）
    const tabA = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id, '甲页签选 A');
    const tabB = makeAdjudication(original.id, [branchA.id, branchB.id], branchB.id, '乙页签选 B');
    expect(appendForkAdjudication(tabA)).toEqual({ ok: true });
    expect(appendForkAdjudication(tabB)).toEqual({ ok: true });

    const restored = loadAdjudicationState();
    expect(restored.adjudications.map((a) => a.id)).toEqual([tabA.id, tabB.id]);
    const releases = loadReleaseState();
    const info = analyzeCorrectionChains(releases.slips, restored.adjudications);
    expect(info.forkResolutions.get(original.id)?.state).toBe('conflict');
    expect([...info.statusById.values()]).not.toContain('current');
  });

  it('相同选择的重复提交（双页签）不产生不同现行结论', () => {
    const { original, branchA, branchB } = storeFork();
    const tabA = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id, '甲页签选 A');
    const tabB = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id, '乙页签也选 A');
    expect(appendForkAdjudication(tabA)).toEqual({ ok: true });
    expect(appendForkAdjudication(tabB)).toEqual({ ok: true });

    const restored = loadAdjudicationState();
    expect(restored.adjudications).toHaveLength(2);
    const info = analyzeCorrectionChains(loadReleaseState().slips, restored.adjudications);
    expect(info.forkResolutions.get(original.id)?.state).toBe('resolved');
    expect(info.forkResolutions.get(original.id)?.chosenSuccessorId).toBe(branchA.id);
    expect(info.statusById.get(branchA.id)).toBe('current');
  });

  it('清空裁决存档后可重新记录；旧格式放行存档（无裁决键）照常可读', () => {
    const { original, branchA, branchB } = storeFork();
    // 旧格式：放行存档存在、裁决键从未写入
    const empty = loadAdjudicationState();
    expect(empty.protected).toBe(false);
    expect(empty.adjudications).toEqual([]);
    const info = analyzeCorrectionChains(loadReleaseState().slips, empty.adjudications);
    expect(info.forkResolutions.get(original.id)?.state).toBe('unresolved');

    const record = makeAdjudication(original.id, [branchA.id, branchB.id], branchA.id);
    expect(appendForkAdjudication(record)).toEqual({ ok: true });
    expect(clearAdjudicationState()).toBe(true);
    __resetAdjudicationMemoryForTests();
    expect(loadAdjudicationState().adjudications).toEqual([]);
  });
});
