/**
 * 放行单更正（补发更正单）领域服务。
 *
 * 印制厂发现已签发放行单所用文字有误时，不修改原单，而是补发一张
 * 带不可变关联的更正单：
 *
 *  - 更正单把原单文字与行宽带入可编辑草稿后，必须重新通过既有放行闸门
 *   （编码、排版、当前会话新完成的一次“合格”试压判定），并填写非空更正原因；
 *  - 新单有独立编号，以可选的原单编号建立不可变关联；原单内容绝不改写；
 *  - 历史展示更正链与当前状态：线性链的唯一终端是现行版本；
 *    两张更正单同时指向同一原单（跨页签交错合并后的分叉）时明确标记冲突，
 *    停止自动认定现行单，但全部原件保留取证。
 *
 * 本模块只做纯函数式判定、快照组装与链分析，不访问网络与存储；
 * 关联数据与 release.ts / releaseStorage.ts / 页面展示共用同一份 `correction` 字段。
 */
import {
  buildCalibrationSnapshot,
  buildDraftSnapshot,
  createReleaseId,
  evaluateReleaseGate,
  freezeSnapshot,
  type CalibrationGateView,
  type CreateReleaseResult,
  type ReleaseBlocker,
  type ReleaseIdSources,
  type ReleaseSlip,
  type ReleaseSnapshot
} from './release';

export interface CreateCorrectionInput {
  text: string;
  rawWidth: string | number;
  gate: CalibrationGateView;
  /** 更正原因：去除首尾空白后必须非空。 */
  reason: string;
  /** 可选的原单编号；不传或传 null 表示不关联原单。 */
  supersedesId?: string | null;
}

/**
 * 签发更正单。复用既有放行闸门（编码、排版、当前会话新完成的合格判定），
 * 并额外要求非空更正原因；原单编号可选，但绝不等于新单自身编号。
 * 任一条件不满足时只返回阻断原因，绝不产生半成品。
 */
export function createCorrectionSlip(input: CreateCorrectionInput, sources?: ReleaseIdSources): CreateReleaseResult {
  const blockers: ReleaseBlocker[] = [];

  const reason = input.reason.trim();
  if (reason === '') {
    blockers.push({
      scope: 'correction',
      kind: 'correction-reason-empty',
      message: '更正原因不能为空：请填写本次更正的具体原因后再签发更正单。'
    });
  }

  const supersedesId = typeof input.supersedesId === 'string' ? input.supersedesId.trim() : '';
  if (input.supersedesId !== undefined && input.supersedesId !== null && supersedesId === '') {
    blockers.push({
      scope: 'correction',
      kind: 'correction-target-invalid',
      message: '原单编号无效：要么关联一张已签发的放行单，要么不关联。'
    });
  }

  // 更正必须重新通过现有编码、排版及合格试压判定（与首次签发同一闸门）。
  const gate = evaluateReleaseGate(input.text, input.rawWidth, input.gate);
  const all = [...blockers, ...gate.blockers];
  if (all.length > 0) {
    return { ok: false, blockers: all };
  }

  const snapshot: ReleaseSnapshot = {
    draft: buildDraftSnapshot(input.text, input.rawWidth),
    calibration: buildCalibrationSnapshot(input.gate)
  };
  freezeSnapshot(snapshot);

  const now = sources?.now ?? (() => new Date());
  const id = createReleaseId(sources);
  if (supersedesId !== '' && supersedesId === id) {
    // 理论上随机编号不会撞上原单编号；一旦撞上按不可调和冲突处理，绝不自指。
    return {
      ok: false,
      blockers: [
        {
          scope: 'correction',
          kind: 'correction-target-invalid',
          message: '新单编号与原单编号相同，无法建立更正关联：请重新签发。'
        }
      ]
    };
  }

  const slip: ReleaseSlip = {
    id,
    issuedAt: now().toISOString(),
    snapshot,
    correction: { reason, supersedesId: supersedesId === '' ? null : supersedesId }
  };
  return { ok: true, slip: freezeSnapshot(slip) as ReleaseSlip };
}

/** 更正链中一张单据的状态。 */
export type CorrectionChainStatus =
  /** 链终端且链内无分叉：更正链的现行版本。 */
  | 'current'
  /** 已被唯一后继更正单取代。 */
  | 'superseded'
  /** 分叉冲突点：多张更正单同时指向它，停止自动认定现行。 */
  | 'forked'
  /** 分叉分支（含其后继）：不作现行认定，保留取证。 */
  | 'fork-branch'
  /** 更正关联指向存档中不存在的原单编号。 */
  | 'orphan';

export interface CorrectionFork {
  /** 被多张更正单同时指向的单据编号。 */
  parentId: string;
  /** 指向它的更正单编号（按存档顺序）。 */
  slipIds: string[];
}

export interface CorrectionChainInfo {
  /** 每张单据 id → 更正链状态。 */
  statusById: ReadonlyMap<string, CorrectionChainStatus>;
  /** 每张单据 id → 指向它的更正单（按存档顺序）。 */
  childrenById: ReadonlyMap<string, ReleaseSlip[]>;
  /** 全部分叉冲突（跨页签合并后可能出现）。 */
  forks: CorrectionFork[];
}

/**
 * 分析一组放行单的更正链。纯函数：领域校验、只追加存档、共享会话与
 * 页面展示都依据同一份 `correction` 关联数据得出一致结论。
 *
 * 关键规则：分叉（两张及以上更正单指向同一单据）绝不凭时间先后
 * 悄悄选出现行版本——分叉点与其全部后继都不作现行认定，只标记冲突。
 */
export function analyzeCorrectionChains(slips: readonly ReleaseSlip[]): CorrectionChainInfo {
  const byId = new Map<string, ReleaseSlip>();
  for (const slip of slips) {
    if (!byId.has(slip.id)) {
      byId.set(slip.id, slip);
    }
  }

  const childrenById = new Map<string, ReleaseSlip[]>();
  const dangling = new Set<string>();
  for (const slip of slips) {
    const target = slip.correction?.supersedesId;
    if (target === undefined || target === null) {
      continue;
    }
    if (!byId.has(target)) {
      // 原单编号不在存档中：关联悬空的更正单单独标记，不参与任何链与分叉。
      dangling.add(slip.id);
      continue;
    }
    const list = childrenById.get(target) ?? [];
    list.push(slip);
    childrenById.set(target, list);
  }

  // 分叉点：同一单据被两张及以上更正单指向。
  const forks: CorrectionFork[] = [];
  const forkedIds = new Set<string>();
  for (const [parentId, children] of childrenById) {
    if (children.length >= 2) {
      forkedIds.add(parentId);
      forks.push({ parentId, slipIds: children.map((child) => child.id) });
    }
  }

  // 分叉污染传播：分叉点的全部后继（分支上的更正链）同样不作现行认定。
  //  visited 集合同时保证异常数据（如互相指向成环）不会死循环。
  const tainted = new Set<string>();
  const stack = [...forkedIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (tainted.has(id)) {
      continue;
    }
    tainted.add(id);
    for (const child of childrenById.get(id) ?? []) {
      stack.push(child.id);
    }
  }

  const statusById = new Map<string, CorrectionChainStatus>();
  for (const slip of slips) {
    const children = childrenById.get(slip.id) ?? [];
    let status: CorrectionChainStatus;
    if (forkedIds.has(slip.id)) {
      status = 'forked';
    } else if (tainted.has(slip.id)) {
      status = 'fork-branch';
    } else if (dangling.has(slip.id)) {
      status = 'orphan';
    } else if (children.length === 1) {
      status = 'superseded';
    } else {
      status = 'current';
    }
    statusById.set(slip.id, status);
  }

  return { statusById, childrenById, forks };
}

/** 该单据是否卷入更正链（本身是更正单，或已被更正单指向）：决定历史页是否展示链状态徽标。 */
export function isInCorrectionChain(info: CorrectionChainInfo, slip: ReleaseSlip): boolean {
  return slip.correction !== undefined || (info.childrenById.get(slip.id)?.length ?? 0) > 0;
}
