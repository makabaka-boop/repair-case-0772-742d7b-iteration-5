/**
 * 更正链分叉的人工裁决（负责人选定现行分支）领域服务。
 *
 * 同一张放行单被两名制版员分别补发更正后，链分析只能标出分叉，
 * 无法替负责人决定哪条更正链继续作为现行版本。人工分叉裁决：
 *
 *  - 负责人在历史详情看到分叉点的每个直接后继及其可追溯终端，
 *    选择一条分支并填写非空原因，形成一张独立的裁决记录；
 *  - 裁决是**只追加**记录：不修改、不删除任何原放行单与更正单，
 *    也不修改其它裁决；旧格式存档（没有任何裁决记录）照常可读；
 *  - 裁决**绑定分叉点及当时完整的直接后继编号集合**：后来新增分支时，
 *    旧裁决绑定的集合与当前集合不再一致，旧裁决自动失效（须重新裁决）；
 *  - 两个页签对同一分叉作出不同选择时，绝不是“最后写入者获胜”：
 *    相互冲突的裁决全部保留取证并明确展示冲突，要求基于最新存档
 *    重新裁决（新裁决显式取代冲突中的旧裁决）；相同选择的重复提交
 *    是幂等的，不会制造不同现行结论；
 *  - 被选分支内部若仍有未裁决分叉，链分析依旧不为该分支宣布现行终端。
 *
 * 本模块只做纯函数式判定与记录组装，不访问网络与存储；
 * 持久化由 forkAdjudicationStorage.ts 负责，链分析在 correction.ts。
 */
import { freezeSnapshot, type ReleaseIdSources, type ReleaseSlip } from './release';

/**
 * 一张人工分叉裁决记录（不可变、只追加）。
 */
export interface ForkAdjudication {
  /** 独立标识，如 “ADJ-20261005-093015-ab12cd34”。 */
  id: string;
  /** 裁决时刻（ISO 8601 字符串）。 */
  decidedAt: string;
  /** 分叉点：被多张更正单同时指向的单据编号。 */
  forkParentId: string;
  /** 裁决时分叉点完整的直接后继编号集合（升序固化，用于迟到新分支的自动失效判定）。 */
  successorIds: string[];
  /** 负责人选定的直接后继编号（必须属于 successorIds）。 */
  chosenSuccessorId: string;
  /** 非空裁决原因。 */
  reason: string;
  /**
   * 本裁决显式取代的旧裁决编号：重新裁决冲突时，把冲突中的旧裁决逐一列出，
   * 它们随即退出现行认定；未列出的其它有效裁决仍参与认定（防“最后写入者获胜”）。
   */
  supersedesAdjudicationIds: string[];
}

/** 裁决阻断原因类别。 */
export type AdjudicationBlockerKind =
  | 'adjudication-reason-empty'
  | 'adjudication-fork-invalid'
  | 'adjudication-choice-invalid'
  | 'adjudication-supersedes-invalid';

export interface AdjudicationBlocker {
  scope: 'adjudication';
  kind: AdjudicationBlockerKind;
  message: string;
}

export interface CreateAdjudicationInput {
  forkParentId: string;
  /** 裁决时分叉点完整的直接后继编号集合（至少两个、互不重复）。 */
  successorIds: readonly string[];
  chosenSuccessorId: string;
  /** 裁决原因：去除首尾空白后必须非空。 */
  reason: string;
  /** 重新裁决冲突时显式取代的旧裁决编号；首次裁决为空数组。 */
  supersedesAdjudicationIds?: readonly string[];
}

export interface CreateAdjudicationResult {
  ok: boolean;
  /** ok=true 时为已冻结的裁决记录。 */
  adjudication?: ForkAdjudication;
  /** ok=false 时为全部阻断原因。 */
  blockers?: AdjudicationBlocker[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 生成独立裁决标识：`ADJ-YYYYMMDD-HHMMSS-xxxxxxxx`。 */
export function createAdjudicationId(
  sources: ReleaseIdSources = { now: () => new Date(), random: Math.random }
): string {
  const date = sources.now();
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const suffix = Math.floor(sources.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8);
  return `ADJ-${stamp}-${suffix}`;
}

/** 编号集合的规范化：去空白、去空串、去重、升序，便于逐字比较“同一后继集合”。 */
export function normalizeSuccessorIds(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids.filter((id) => typeof id === 'string').map((id) => id.trim()).filter((id) => id !== '')
    )
  ].sort();
}

/** 两个编号集合是否完全相同（与顺序无关）。 */
export function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeSuccessorIds(left);
  const b = normalizeSuccessorIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * 组装一张人工分叉裁决。任一条件不满足时只返回阻断原因，绝不产生半成品：
 * 非空原因、分叉点编号、至少两个互不重复的直接后继、被选分支必须在后继集合内；
 * 显式取代的旧裁决编号不得包含本裁决自身（不可能，编号此时才生成）或空串。
 */
export function createForkAdjudication(
  input: CreateAdjudicationInput,
  sources?: ReleaseIdSources
): CreateAdjudicationResult {
  const blockers: AdjudicationBlocker[] = [];

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') {
    blockers.push({
      scope: 'adjudication',
      kind: 'adjudication-reason-empty',
      message: '裁决原因不能为空：请填写选定该分支作为现行版本的具体原因后再记录裁决。'
    });
  }

  const rawSuccessorIds: readonly unknown[] = Array.isArray(input.successorIds) ? input.successorIds : [];
  const forkParentId = typeof input.forkParentId === 'string' ? input.forkParentId.trim() : '';
  const successorIds = normalizeSuccessorIds(rawSuccessorIds as readonly string[]);
  if (forkParentId === '' || successorIds.length < 2 || successorIds.length !== rawSuccessorIds.length) {
    blockers.push({
      scope: 'adjudication',
      kind: 'adjudication-fork-invalid',
      message: '分叉绑定无效：裁决必须绑定分叉点编号及当时完整的直接后继编号集合（至少两个、互不重复）。'
    });
  }

  const chosenSuccessorId = typeof input.chosenSuccessorId === 'string' ? input.chosenSuccessorId.trim() : '';
  if (chosenSuccessorId === '' || !successorIds.includes(chosenSuccessorId)) {
    blockers.push({
      scope: 'adjudication',
      kind: 'adjudication-choice-invalid',
      message: '选定的分支不在该分叉的直接后继集合内：请基于最新存档重新选择。'
    });
  }

  const rawSupersedes: readonly unknown[] = Array.isArray(input.supersedesAdjudicationIds)
    ? input.supersedesAdjudicationIds
    : [];
  const supersedesAdjudicationIds = normalizeSuccessorIds(rawSupersedes as readonly string[]);
  if (supersedesAdjudicationIds.length !== rawSupersedes.length) {
    blockers.push({
      scope: 'adjudication',
      kind: 'adjudication-supersedes-invalid',
      message: '被取代的旧裁决编号无效：只能列出冲突中已有的裁决编号。'
    });
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const now = sources?.now ?? (() => new Date());
  const adjudication: ForkAdjudication = {
    id: createAdjudicationId(sources),
    decidedAt: now().toISOString(),
    forkParentId,
    successorIds,
    chosenSuccessorId,
    reason,
    supersedesAdjudicationIds
  };
  return { ok: true, adjudication: freezeSnapshot(adjudication) as ForkAdjudication };
}

/**
 * 校验一份外部（如 localStorage 恢复）裁决记录的结构完整性。
 * 损坏或字段不符时返回 false，调用方只能告警并保留原记录。
 */
export function isWellFormedAdjudication(value: unknown): value is ForkAdjudication {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '' || typeof record.decidedAt !== 'string') {
    return false;
  }
  if (Number.isNaN(Date.parse(record.decidedAt))) {
    return false;
  }
  if (typeof record.forkParentId !== 'string' || record.forkParentId.trim() === '') {
    return false;
  }
  if (
    !Array.isArray(record.successorIds) ||
    record.successorIds.length < 2 ||
    !record.successorIds.every((id) => typeof id === 'string' && id.trim() !== '') ||
    new Set(record.successorIds).size !== record.successorIds.length
  ) {
    return false;
  }
  if (
    typeof record.chosenSuccessorId !== 'string' ||
    !(record.successorIds as string[]).includes(record.chosenSuccessorId)
  ) {
    return false;
  }
  if (typeof record.reason !== 'string' || record.reason.trim() === '') {
    return false;
  }
  if (
    !Array.isArray(record.supersedesAdjudicationIds) ||
    !record.supersedesAdjudicationIds.every((id) => typeof id === 'string' && id.trim() !== '') ||
    (record.supersedesAdjudicationIds as string[]).includes(record.id)
  ) {
    return false;
  }
  return true;
}

/** 一个分叉点的裁决解析状态。 */
export type ForkResolutionState =
  /** 尚无任何绑定当前后继集合的裁决。 */
  | 'unresolved'
  /** 存在旧裁决，但其绑定的后继集合已与当前不一致（迟到新分支）：旧裁决自动失效。 */
  | 'stale'
  /** 多张有效裁决选择了不同分支：冲突，不作现行认定，须重新裁决。 */
  | 'conflict'
  /** 全部有效裁决一致选定同一分支。 */
  | 'resolved';

export interface ForkResolution {
  state: ForkResolutionState;
  /** state=resolved 时被一致选定的直接后继编号；否则为 null。 */
  chosenSuccessorId: string | null;
  /**
   * 参与现行认定的裁决：绑定当前后继集合、且未被其它有效裁决显式取代。
   * 相同选择的重复提交都在这里（幂等，不改变结论）。
   */
  active: ForkAdjudication[];
  /** 绑定过时后继集合的旧裁决（迟到新分支后自动失效），仅取证展示。 */
  stale: ForkAdjudication[];
  /** state=conflict 时互相冲突的选择集合（按存档顺序去重）。 */
  conflictingChoices: string[];
}

/**
 * 解析一个分叉点的裁决状态。纯函数：链分析、共享会话与历史徽标都依据它。
 *
 * 关键规则：
 *  - 只追加语义：旧裁决永不删除；绑定集合与当前不一致的旧裁决进入 stale 自动失效；
 *  - 被其它有效裁决显式取代（supersedesAdjudicationIds）的裁决退出认定；
 *  - 剩余有效裁决选择一致 → resolved；不一致 → conflict（绝不按时间先后挑选）；
 *  - 相同选择的重复提交 → 选择集合仍只有一个元素 → 同样的 resolved 结论（幂等）。
 */
export function resolveForkAdjudication(
  forkParentId: string,
  currentSuccessorIds: readonly string[],
  adjudications: readonly ForkAdjudication[]
): ForkResolution {
  const bound = adjudications.filter((record) => record.forkParentId === forkParentId);
  const setMatched = bound.filter((record) => sameIdSet(record.successorIds, currentSuccessorIds));
  const stale = bound.filter((record) => !sameIdSet(record.successorIds, currentSuccessorIds));

  // 只有绑定当前集合的裁决才有资格取代其它裁决（过期裁决不能“隔空”取代）。
  const supersededIds = new Set<string>();
  for (const record of setMatched) {
    for (const id of record.supersedesAdjudicationIds) {
      supersededIds.add(id);
    }
  }
  const active = setMatched.filter((record) => !supersededIds.has(record.id));

  if (active.length === 0) {
    return {
      state: stale.length > 0 ? 'stale' : 'unresolved',
      chosenSuccessorId: null,
      active,
      stale,
      conflictingChoices: []
    };
  }
  const choices: string[] = [];
  for (const record of active) {
    if (!choices.includes(record.chosenSuccessorId)) {
      choices.push(record.chosenSuccessorId);
    }
  }
  if (choices.length === 1) {
    return { state: 'resolved', chosenSuccessorId: choices[0], active, stale, conflictingChoices: [] };
  }
  return { state: 'conflict', chosenSuccessorId: null, active, stale, conflictingChoices: choices };
}

/**
 * 追溯一个直接后继分支的全部终端单据编号（无后继的链末端）。
 * 历史详情据此向负责人展示“选这条分支最终认到哪张单”。
 * visited 集合保证异常成环数据不会死循环。
 */
export function branchTerminals(
  childrenById: ReadonlyMap<string, readonly ReleaseSlip[]>,
  startId: string
): string[] {
  const terminals: string[] = [];
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    const children = childrenById.get(id) ?? [];
    if (children.length === 0) {
      terminals.push(id);
    } else {
      for (const child of children) {
        stack.push(child.id);
      }
    }
  }
  return terminals;
}
