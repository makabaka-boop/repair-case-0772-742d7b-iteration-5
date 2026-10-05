import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReleaseSlip,
  isWellFormedSlip,
  type CalibrationGateView,
  type ReleaseSlip
} from '../../src/lib/release';
import {
  analyzeCorrectionChains,
  createCorrectionSlip,
  isInCorrectionChain
} from '../../src/lib/correction';
import {
  __resetReleaseMemoryForTests,
  appendReleaseSlip,
  loadReleaseState
} from '../../src/lib/releaseStorage';

const STORAGE_KEY = 'braille-plate:release:v1';
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
  return { now: () => new Date(Date.UTC(2026, 8, 24, 10, 30, tick)), random: () => tick / 4096 };
}

function makeOriginal(text = '12，三。', width: string | number = '4'): ReleaseSlip {
  return createReleaseSlip({ text, rawWidth: width, gate: passGate() }, sources()).slip!;
}

function makeCorrection(
  text: string,
  supersedesId: string | null,
  reason = '文字有误，更正重发'
): ReleaseSlip {
  return createCorrectionSlip(
    { text, rawWidth: '4', gate: passGate(), reason, supersedesId },
    sources()
  ).slip!;
}

describe('correction 更正单签发（领域服务）', () => {
  it('合格闸门 + 非空原因 + 原单编号：签发独立编号更正单并固化不可变关联', () => {
    const original = makeOriginal();
    const result = createCorrectionSlip(
      { text: '12，四。', rawWidth: '4', gate: passGate(), reason: '  楼层文字有误  ', supersedesId: original.id },
      sources()
    );
    expect(result.ok).toBe(true);
    const slip = result.slip!;
    expect(slip.id).toMatch(/^PF-\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(slip.id).not.toBe(original.id);
    // 更正原因去除首尾空白后固化；关联指向原单
    expect(slip.correction).toEqual({ reason: '楼层文字有误', supersedesId: original.id });
    // 快照与首次签发同一闸门：原文、行宽、编码、合格判定全部固化
    expect(slip.snapshot.draft.text).toBe('12，四。');
    expect(slip.snapshot.calibration.verdict).toBe('pass');
    // 递归冻结：关联数据同样不可变
    expect(Object.isFrozen(slip)).toBe(true);
    expect(Object.isFrozen(slip.correction)).toBe(true);
    expect(() => {
      (slip.correction as { reason: string }).reason = '篡改';
    }).toThrow(TypeError);
    // 原单内容绝不改写
    expect(original.correction).toBeUndefined();
    expect(original.snapshot.draft.text).toBe('12，三。');
  });

  it('原单编号可选：不关联时 supersedesId 固化为 null', () => {
    const result = createCorrectionSlip(
      { text: '12，四。', rawWidth: '4', gate: passGate(), reason: '补发更正', supersedesId: null },
      sources()
    );
    expect(result.ok).toBe(true);
    expect(result.slip!.correction).toEqual({ reason: '补发更正', supersedesId: null });
  });

  it('空原因或纯空白原因被阻断，不产生半成品', () => {
    for (const reason of ['', '   ', '\n\t ']) {
      const result = createCorrectionSlip(
        { text: '12，四。', rawWidth: '4', gate: passGate(), reason, supersedesId: 'PF-x' },
        sources()
      );
      expect(result.ok).toBe(false);
      expect(result.slip).toBeUndefined();
      expect(result.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ scope: 'correction', kind: 'correction-reason-empty' })])
      );
    }
  });

  it('空字符串原单编号被阻断（要么关联要么不关联）', () => {
    const result = createCorrectionSlip(
      { text: '12，四。', rawWidth: '4', gate: passGate(), reason: '更正', supersedesId: '   ' },
      sources()
    );
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'correction-target-invalid' })])
    );
  });

  it('更正必须重新通过现有编码、排版与合格试压闸门', () => {
    // 非法文字
    const illegal = createCorrectionSlip(
      { text: '12楼', rawWidth: '4', gate: passGate(), reason: '更正', supersedesId: 'PF-x' },
      sources()
    );
    expect(illegal.ok).toBe(false);
    expect(illegal.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'draft-illegal' })]));

    // 非法行宽
    const badWidth = createCorrectionSlip(
      { text: '12，四。', rawWidth: '3', gate: passGate(), reason: '更正', supersedesId: 'PF-x' },
      sources()
    );
    expect(badWidth.ok).toBe(false);
    expect(badWidth.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'draft-illegal' })]));

    // 需调机判定不能签发更正单
    const adjust = createCorrectionSlip(
      {
        text: '12，四。',
        rawWidth: '4',
        gate: passGate({
          verdict: 'adjust',
          result: {
            verdict: 'adjust',
            readings: [],
            threshold: {
              min: 0.7,
              max: 0.91,
              spread: 0.21,
              spreadLimit: 0.15,
              spreadOk: false,
              rangeMin: 0.6,
              rangeMax: 0.9
            },
            conclusion: '需调机'
          }
        }),
        reason: '更正',
        supersedesId: 'PF-x'
      },
      sources()
    );
    expect(adjust.ok).toBe(false);
    expect(adjust.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'calibration-adjust' })])
    );

    // 未判定（无新完成的合格试压）同样阻断
    const none = createCorrectionSlip(
      {
        text: '12，四。',
        rawWidth: '4',
        gate: passGate({ verdict: null, result: null, judgedRaws: null }),
        reason: '更正',
        supersedesId: 'PF-x'
      },
      sources()
    );
    expect(none.ok).toBe(false);
    expect(none.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calibration-none' })]));
  });
});

describe('correction 更正关联的存档结构校验', () => {
  it('带合法更正关联的单据通过校验；旧格式（无 correction 字段）照常通过', () => {
    const original = makeOriginal();
    const correction = makeCorrection('12，四。', original.id);
    expect(isWellFormedSlip(correction)).toBe(true);
    // 旧格式存档：单据没有 correction 字段，照常读取
    expect(original.correction).toBeUndefined();
    expect(isWellFormedSlip(original)).toBe(true);
  });

  it('更正原因缺失 / 为空 / 类型错误的单据不可信', () => {
    const base = structuredClone(makeCorrection('12，四。', 'PF-20260924-000000-00000001')) as unknown as Record<
      string,
      unknown
    >;
    const noReason = { ...base, correction: { supersedesId: 'PF-a' } };
    expect(isWellFormedSlip(noReason)).toBe(false);
    const emptyReason = { ...base, correction: { reason: '  ', supersedesId: 'PF-a' } };
    expect(isWellFormedSlip(emptyReason)).toBe(false);
    const wrongReason = { ...base, correction: { reason: 42, supersedesId: 'PF-a' } };
    expect(isWellFormedSlip(wrongReason)).toBe(false);
    const nullCorrection = { ...base, correction: null };
    expect(isWellFormedSlip(nullCorrection)).toBe(false);
  });

  it('原单编号类型错误或自指的单据不可信', () => {
    const correction = makeCorrection('12，四。', 'PF-20260924-000000-00000001');
    const base = structuredClone(correction) as unknown as Record<string, unknown>;
    const numberTarget = { ...base, correction: { reason: '更正', supersedesId: 7 } };
    expect(isWellFormedSlip(numberTarget)).toBe(false);
    const emptyTarget = { ...base, correction: { reason: '更正', supersedesId: '  ' } };
    expect(isWellFormedSlip(emptyTarget)).toBe(false);
    const selfTarget = {
      ...base,
      correction: { reason: '更正', supersedesId: (base as { id: string }).id }
    };
    expect(isWellFormedSlip(selfTarget)).toBe(false);
  });
});

describe('correction 更正链分析', () => {
  it('线性链：原单与中间更正单被取代，唯一终端是现行版本', () => {
    const original = makeOriginal();
    const first = makeCorrection('12，四。', original.id);
    const second = makeCorrection('12，五。', first.id);
    const info = analyzeCorrectionChains([original, first, second]);

    expect(info.statusById.get(original.id)).toBe('superseded');
    expect(info.statusById.get(first.id)).toBe('superseded');
    expect(info.statusById.get(second.id)).toBe('current');
    expect(info.forks).toEqual([]);
    expect(info.childrenById.get(original.id)?.map((slip) => slip.id)).toEqual([first.id]);
    expect(info.childrenById.get(first.id)?.map((slip) => slip.id)).toEqual([second.id]);
    // 链上三张单据都需要展示链状态
    expect(isInCorrectionChain(info, original)).toBe(true);
    expect(isInCorrectionChain(info, second)).toBe(true);
  });

  it('未卷入更正的单据是平凡现行，但不属于更正链', () => {
    const standalone = makeOriginal();
    const info = analyzeCorrectionChains([standalone]);
    expect(info.statusById.get(standalone.id)).toBe('current');
    expect(isInCorrectionChain(info, standalone)).toBe(false);
    expect(info.forks).toEqual([]);
  });

  it('分叉：两张更正单指向同一原单时标记冲突，绝不凭时间选出现行版本', () => {
    const original = makeOriginal();
    // 后签发的更正单时间更晚——若凭时间挑选就会选它，这是必须禁止的
    const earlier = makeCorrection('12，四。', original.id);
    const later = makeCorrection('12，五。', original.id);
    expect(Date.parse(later.issuedAt)).toBeGreaterThan(Date.parse(earlier.issuedAt));

    const info = analyzeCorrectionChains([original, earlier, later]);
    expect(info.statusById.get(original.id)).toBe('forked');
    expect(info.statusById.get(earlier.id)).toBe('fork-branch');
    expect(info.statusById.get(later.id)).toBe('fork-branch');
    // 链上没有任何单据被认定为现行版本
    expect([...info.statusById.values()]).not.toContain('current');
    expect(info.forks).toEqual([{ parentId: original.id, slipIds: [earlier.id, later.id] }]);
  });

  it('分叉的后继更正同样不作现行认定；全部原件保留在分析结果中', () => {
    const original = makeOriginal();
    const branchA = makeCorrection('12，四。', original.id);
    const branchB = makeCorrection('12，五。', original.id);
    const downstream = makeCorrection('12，六。', branchA.id);

    const info = analyzeCorrectionChains([original, branchA, branchB, downstream]);
    expect(info.statusById.get(original.id)).toBe('forked');
    expect(info.statusById.get(branchA.id)).toBe('fork-branch');
    expect(info.statusById.get(branchB.id)).toBe('fork-branch');
    // 后继更正虽在线性分支上，仍受分叉污染，不作现行认定
    expect(info.statusById.get(downstream.id)).toBe('fork-branch');
    expect([...info.statusById.values()]).not.toContain('current');
    // 全部分支原件都在分析结果中（取证）
    expect(info.childrenById.get(original.id)).toHaveLength(2);
    expect(info.childrenById.get(branchA.id)?.map((slip) => slip.id)).toEqual([downstream.id]);
  });

  it('分叉只影响所在链：其它独立链的现行认定不受污染', () => {
    const forkedRoot = makeOriginal();
    const branchA = makeCorrection('12，四。', forkedRoot.id);
    const branchB = makeCorrection('12，五。', forkedRoot.id);
    const cleanRoot = makeOriginal('一二三', '8');
    const cleanCorrection = makeCorrection('12，六。', cleanRoot.id);

    const info = analyzeCorrectionChains([forkedRoot, branchA, branchB, cleanRoot, cleanCorrection]);
    expect(info.statusById.get(forkedRoot.id)).toBe('forked');
    expect(info.statusById.get(cleanRoot.id)).toBe('superseded');
    expect(info.statusById.get(cleanCorrection.id)).toBe('current');
    expect(info.forks).toHaveLength(1);
  });

  it('更正关联指向存档外编号：标记为关联缺失，不参与链与分叉', () => {
    const orphan = makeCorrection('12，四。', 'PF-20990101-000000-0000000f');
    const info = analyzeCorrectionChains([orphan]);
    expect(info.statusById.get(orphan.id)).toBe('orphan');
    expect(info.forks).toEqual([]);
    expect(isInCorrectionChain(info, orphan)).toBe(true);
  });

  it('互相指向的异常数据不会让分析死循环', () => {
    const a = makeCorrection('12，四。', 'PF-a');
    const b = makeCorrection('12，五。', 'PF-b');
    const cyclicA = { ...structuredClone(a), id: 'PF-a', correction: { reason: 'x', supersedesId: 'PF-b' } };
    const cyclicB = { ...structuredClone(b), id: 'PF-b', correction: { reason: 'y', supersedesId: 'PF-a' } };
    const info = analyzeCorrectionChains([cyclicA as ReleaseSlip, cyclicB as ReleaseSlip]);
    expect(info.statusById.size).toBe(2);
  });
});

describe('correction 与只追加存档的一致性', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetReleaseMemoryForTests();
    vi.restoreAllMocks();
  });

  it('更正关联随单据只追加落库，重新加载后逐字一致（关联数据一致）', () => {
    const original = makeOriginal();
    const correction = makeCorrection('12，四。', original.id, '楼层指示文字有误');
    expect(appendReleaseSlip(original)).toEqual({ ok: true });
    expect(appendReleaseSlip(correction)).toEqual({ ok: true });

    const restored = loadReleaseState();
    expect(restored.protected).toBe(false);
    expect(restored.slips).toHaveLength(2);
    expect(restored.slips[0].correction).toBeUndefined();
    expect(restored.slips[1].correction).toEqual({ reason: '楼层指示文字有误', supersedesId: original.id });
    // 重新加载后的链分析与签发时一致
    const info = analyzeCorrectionChains(restored.slips);
    expect(info.statusById.get(original.id)).toBe('superseded');
    expect(info.statusById.get(correction.id)).toBe('current');
  });

  it('旧格式存档（无 correction 字段）照常读取，可在此基础上补发更正', () => {
    // 旧格式单据：createReleaseSlip 签发的普通放行单本就没有 correction 字段
    const legacy = makeOriginal('一二三', '8');
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, slips: [legacy] }));

    const restored = loadReleaseState();
    expect(restored.protected).toBe(false);
    expect(restored.slips).toHaveLength(1);
    expect(restored.slips[0].correction).toBeUndefined();

    const correction = makeCorrection('12，四。', legacy.id);
    expect(appendReleaseSlip(correction)).toEqual({ ok: true });
    const after = loadReleaseState();
    expect(after.slips).toHaveLength(2);
    expect(after.slips[1].correction?.supersedesId).toBe(legacy.id);
  });

  it('存档中更正关联损坏：转入保护态并保留原存档，不产生伪恢复', () => {
    const original = makeOriginal();
    appendReleaseSlip(original);
    const before = window.localStorage.getItem(STORAGE_KEY);

    const broken = structuredClone(original) as unknown as Record<string, unknown>;
    broken.id = 'PF-20260924-999999-0000000e';
    broken.correction = { reason: '', supersedesId: original.id };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, slips: [broken] }));

    const state = loadReleaseState();
    expect(state.protected).toBe(true);
    expect(state.warning?.kind).toBe('invalid-slip');
    // 最近一次完整记录仍可只读取证
    expect(state.slips.map((slip) => slip.id)).toEqual([original.id]);
    // 保护态下拒绝新写入，原存档逐字保留
    expect(appendReleaseSlip(makeCorrection('12，四。', original.id))).toEqual({ ok: false, kind: 'write-failed' });
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBe(before);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ version: 1, slips: [broken] }));
  });

  it('同编号但更正关联不同：明确编号冲突，历史原件逐字保留', () => {
    const correction = makeCorrection('12，四。', 'PF-20260924-000000-00000001', '首次更正原因');
    expect(appendReleaseSlip(correction)).toEqual({ ok: true });

    const conflicting = {
      ...structuredClone(makeCorrection('12，五。', 'PF-20260924-000000-00000002', '另一份原因')),
      id: correction.id
    } as ReleaseSlip;
    expect(appendReleaseSlip(conflicting)).toEqual({ ok: false, kind: 'id-conflict' });

    const restored = loadReleaseState();
    expect(restored.slips).toHaveLength(1);
    expect(restored.slips[0].correction?.reason).toBe('首次更正原因');
  });

  it('双页签各发一张指向同一原单的更正单：合并后两张都在，分析明确标记分叉', () => {
    const original = makeOriginal();
    expect(appendReleaseSlip(original)).toEqual({ ok: true });

    // 页签甲基于 [原单] 追加更正甲；页签乙基于 [原单] 追加更正乙（交错后合并）
    const correctionA = makeCorrection('12，四。', original.id, '甲页签更正');
    const correctionB = makeCorrection('12，五。', original.id, '乙页签更正');
    expect(appendReleaseSlip(correctionA)).toEqual({ ok: true });
    expect(appendReleaseSlip(correctionB)).toEqual({ ok: true });

    const restored = loadReleaseState();
    expect(restored.slips).toHaveLength(3);
    const info = analyzeCorrectionChains(restored.slips);
    expect(info.forks).toEqual([{ parentId: original.id, slipIds: [correctionA.id, correctionB.id] }]);
    expect(info.statusById.get(original.id)).toBe('forked');
    expect([...info.statusById.values()]).not.toContain('current');
  });
});
