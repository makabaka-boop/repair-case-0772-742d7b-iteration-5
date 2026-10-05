/**
 * 更正分叉的人工裁决领域服务。
 *
 * 裁决记录独立于放行单 / 更正单：它只引用分叉点、裁决时的完整直接后继集合、
 * 被选后继、原因和所取代的冲突裁决编号；原放行单与更正单永远不被修改或删除。
 *
 * 纯函数同时负责：
 *  - 校验一次裁决是否绑定当前分叉点及完整直接后继集合；
 *  - 识别迟到新分支导致的旧裁决失效；
 *  - 识别多页签不同选择造成的冲突，且不让“最后写入者获胜”；
 *  - 沿被选分支追溯终端，若内部仍有未裁决分叉，则不得宣布终端现行。
 */
import { createReleaseId, freezeSnapshot, type ReleaseIdSources, type ReleaseSlip } from './release';
import { analyzeCorrectionChains } from './correction';

/** 独立、只追加的人工分叉裁决记录。 */
export interface ReleaseForkDecision {
  /** 独立标识，如 “FD-20261005-093015-ab12cd34”。 */
  id: string;
  /** 裁决时刻（ISO 8601 字符串）。 */
  decidedAt: string;
  /** 分叉点单据编号。 */
  forkParentId: string;
  /** 裁决时该分叉点的完整直接后继编号集合（存档顺序逐字固化）。 */
  successorIds: readonly string[];
  /** 负责人选定继续作为现行版本的直接后继编号。 */
  selectedSuccessorId: string;
  /** 人工裁决原因（去除首尾空白后非空）。 */
  reason: string;
  /**
   * 本次明确取代的上一轮冲突 / 现行裁决编号。
   * 初次裁决为空数组；冲突后基于最新存档重新裁决时必须包含全部冲突裁决。
   */
  supersedesDecisionIds: readonly string[];
}

export type ForkDecisionErrorCode =
  | 'decision-reason-empty'
  | 'fork-parent-missing'
  | 'fork-not-found'
  | 'successor-set-stale'
  | 'selected-successor-invalid'
  | 'superseded-decision-missing'
  | 'superseded-decision-mismatch'
  | 'decision-stale'
  | 'decision-conflict';

export interface ForkDecisionError {
  code: ForkDecisionErrorCode;
  message: string;
}

export interface PrepareForkDecisionInput {
  forkParentId: string;
  /** 调用方页面在最新存档上看到的完整直接后继集合。 */
  successorIds: readonly string[];
  selectedSuccessorId: string;
  reason: string;
  /** 冲突后重新裁决时，填写最新存档中的全部活动冲突裁决编号。 */
  supersedesDecisionIds?: readonly string[];
}

export type PrepareForkDecisionResult =
  | { ok: true; duplicate: boolean; decision?: ReleaseForkDecision }
  | { ok: false; duplicate: false; errors: ForkDecisionError[] };

export type ForkAdjudicationStateKind = 'pending' | 'resolved' | 'conflicting';

export interface ForkAdjudicationState {
  forkParentId: string;
  /** 当前存档中的完整直接后继编号（存档顺序）。 */
  successorIds: string[];
  /** 与当前直接后继集合一致、仍参与本轮判断的裁决。 */
  activeDecisionIds: string[];
  /** 后来新增直接后继后，自动失效的旧裁决。 */
  staleDecisionIds: string[];
  state: ForkAdjudicationStateKind;
  /** state=resolved 时的被选直接后继。 */
  selectedSuccessorId: string | null;
  /** state=resolved 时形成该结论的活动裁决。 */
  resolvedDecisionIds: string[];
  /** state=conflicting 时，按选择分组的活动裁决。 */
  conflictingChoiceIds: ReadonlyMap<string, string[]>;
}

export type BranchTerminalStatus = 'terminal' | 'unresolved-fork' | 'cycle';

export interface BranchTerminalTrace {
  successorId: string;
  /** 从直接后继到可追溯终端的路径。 */
  path: string[];
  terminalId: string | null;
  status: BranchTerminalStatus;
  /** 追溯在哪个未裁决分叉 / 异常点停止。 */
  stoppedAtForkId: string | null;
}

export type AdjudicatedChainStatus =
  | 'fork-adjudicated'
  | 'adjudicated-path'
  | 'adjudicated-current'
  | 'adjudicated-blocked-path'
  | 'adjudicated-rejected-branch'
  | 'fork-conflict'
  | 'fork-decision-stale';

export interface ForkAdjudicationInfo {
  statusById: ReadonlyMap<string, AdjudicatedChainStatus | import('./correction').CorrectionChainStatus>;
  childrenById: ReadonlyMap<string, ReleaseSlip[]>;
  forks: ReadonlyMap<string, ForkAdjudicationState>;
  tracesByFork: ReadonlyMap<string, BranchTerminalTrace[]>;
  decisionsByFork: ReadonlyMap<string, ReleaseForkDecision[]>;
}

function stableIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))).sort();
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const a = stableIds(left);
  const b = stableIds(right);
  return a.length === left.length && b.length === right.length && a.length === b.length && a.every((id, i) => id === b[i]);
}

function error(code: ForkDecisionErrorCode, message: string): ForkDecisionError {
  return { code, message };
}

/**
 * 生成独立裁决标识：`FD-YYYYMMDD-HHMMSS-xxxxxxxx`。
 * 与放行单编号前缀区分，便于审计两类只追加记录。
 */
export function createForkDecisionId(sources: ReleaseIdSources = { now: () => new Date(), random: Math.random }): string {
  return createReleaseId(sources).replace(/^PF-/, 'FD-');
}

/** 基础结构校验；存档恢复用。跨分叉引用由存档层结合 slips / decisions 再校验。 */
export function isWellFormedForkDecision(value: unknown): value is ReleaseForkDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const decision = value as Record<string, unknown>;
  if (typeof decision.id !== 'string' || decision.id === '' || !decision.id.startsWith('FD-')) {
    return false;
  }
  if (typeof decision.decidedAt !== 'string' || Number.isNaN(Date.parse(decision.decidedAt))) {
    return false;
  }
  if (typeof decision.forkParentId !== 'string' || decision.forkParentId.trim() === '') {
    return false;
  }
  if (
    !Array.isArray(decision.successorIds) ||
    decision.successorIds.length < 2 ||
    !decision.successorIds.every((id) => typeof id === 'string' && id.trim() !== '') ||
    new Set(decision.successorIds).size !== decision.successorIds.length
  ) {
    return false;
  }
  if (
    typeof decision.selectedSuccessorId !== 'string' ||
    !decision.successorIds.includes(decision.selectedSuccessorId)
  ) {
    return false;
  }
  if (typeof decision.reason !== 'string' || decision.reason.trim() === '') {
    return false;
  }
  return (
    Array.isArray(decision.supersedesDecisionIds) &&
    !decision.supersedesDecisionIds.includes(decision.id) &&
    decision.supersedesDecisionIds.every((id) => typeof id === 'string' && id.trim() !== '') &&
    new Set(decision.supersedesDecisionIds).size === decision.supersedesDecisionIds.length
  );
}

function decisionMap(decisions: readonly ReleaseForkDecision[]): Map<string, ReleaseForkDecision> {
  const byId = new Map<string, ReleaseForkDecision>();
  for (const decision of decisions) {
    if (!byId.has(decision.id)) {
      byId.set(decision.id, decision);
    }
  }
  return byId;
}

/**
 * 计算当前存档中每个分叉的裁决轮次状态。纯函数，不决定存储是否允许写入。
 */
export function evaluateForkStates(
  slips: readonly ReleaseSlip[],
  decisions: readonly ReleaseForkDecision[] = []
): ReadonlyMap<string, ForkAdjudicationState> {
  const chains = analyzeCorrectionChains(slips);
  const states = new Map<string, ForkAdjudicationState>();

  for (const fork of chains.forks) {
    const currentSuccessors = (chains.childrenById.get(fork.parentId) ?? []).map((slip) => slip.id);
    const own = decisions.filter((decision) => decision.forkParentId === fork.parentId);
    const matching = own.filter((decision) => sameIdSet(decision.successorIds, currentSuccessors));
    const superseded = new Set<string>();
    for (const decision of matching) {
      for (const oldId of decision.supersedesDecisionIds) {
        if (matching.some((item) => item.id === oldId)) {
          superseded.add(oldId);
        }
      }
    }
    const active: ReleaseForkDecision[] = matching.filter((decision) => !superseded.has(decision.id));
    const stale: ReleaseForkDecision[] = own.filter((decision) => !active.includes(decision));

    const choices = new Map<string, string[]>();
    for (const decision of active) {
      const list = choices.get(decision.selectedSuccessorId) ?? [];
      list.push(decision.id);
      choices.set(decision.selectedSuccessorId, list);
    }
    const state: ForkAdjudicationStateKind = choices.size <= 1 ? (active.length === 0 ? 'pending' : 'resolved') : 'conflicting';
    const selected = state === 'resolved' && active.length > 0 ? active[0].selectedSuccessorId : null;
    states.set(fork.parentId, {
      forkParentId: fork.parentId,
      successorIds: currentSuccessors,
      activeDecisionIds: active.map((decision) => decision.id),
      staleDecisionIds: stale.map((decision) => decision.id),
      state,
      selectedSuccessorId: selected,
      resolvedDecisionIds: selected ? choices.get(selected) ?? [] : [],
      conflictingChoiceIds: choices
    });
  }

  return states;
}

/**
 * 在最新存档上准备一条裁决记录。
 *
 * 已 resolved 且重复选择同一后继时返回 duplicate=true，不生成新的裁决结论；
 * 不同选择必须显式携带当前活动裁决编号，不能靠更晚写入覆盖。
 */
export function prepareForkDecision(
  slips: readonly ReleaseSlip[],
  decisions: readonly ReleaseForkDecision[],
  input: PrepareForkDecisionInput,
  sources?: ReleaseIdSources
): PrepareForkDecisionResult {
  const errors: ForkDecisionError[] = [];
  const reason = input.reason.trim();
  if (reason === '') {
    errors.push(error('decision-reason-empty', '分叉裁决原因不能为空。'));
  }

  const chains = analyzeCorrectionChains(slips);
  const fork = chains.forks.find((item) => item.parentId === input.forkParentId);
  const children = chains.childrenById.get(input.forkParentId) ?? [];
  if (!slips.some((slip) => slip.id === input.forkParentId)) {
    errors.push(error('fork-parent-missing', '分叉点单据不在最新存档中，不能裁决。'));
  } else if (!fork) {
    errors.push(error('fork-not-found', '该单据当前不是分叉点，不能提交分叉裁决。'));
  }

  const currentSet = children.map((child) => child.id);
  const successorInput = (input.successorIds ?? []).slice();
  if (fork && !sameIdSet(successorInput, currentSet)) {
    errors.push(
      error(
        'successor-set-stale',
        '裁决绑定的直接后继集合已不是最新存档：请刷新到最新存档后重新裁决。'
      )
    );
  }
  if (fork && !currentSet.includes(input.selectedSuccessorId)) {
    errors.push(error('selected-successor-invalid', '被选分支必须是分叉点当前的直接后继之一。'));
  }

  const byDecisionId = decisionMap(decisions);
  const supersedeInput = stableIds(input.supersedesDecisionIds ?? []);
  for (const id of supersedeInput) {
    const old = byDecisionId.get(id);
    if (!old) {
      errors.push(error('superseded-decision-missing', `被取代裁决 ${id} 不在存档中。`));
      continue;
    }
    if (old.forkParentId !== input.forkParentId || !sameIdSet(old.successorIds, successorInput)) {
      errors.push(error('superseded-decision-mismatch', `裁决 ${id} 不属于当前分叉或后继集合。`));
    }
  }

  const states = evaluateForkStates(slips, decisions);
  const state = fork ? states.get(fork.parentId) : undefined;
  if (fork && state && errors.length === 0) {
    const activeSet = stableIds(state.activeDecisionIds);
    if (state.state === 'resolved' && state.selectedSuccessorId === input.selectedSuccessorId) {
      return { ok: true, duplicate: true };
    }
    if (state.state === 'resolved') {
      if (!sameIdSet(supersedeInput, activeSet)) {
        errors.push(
          error(
            'decision-conflict',
            '最新存档已选择另一条分支：不同选择不能最后写入者获胜，请基于最新裁决重新明确取代。'
          )
        );
      }
    } else if (state.state === 'conflicting') {
      if (!sameIdSet(supersedeInput, activeSet)) {
        errors.push(
          error(
            'decision-conflict',
            '两个页签已作出不同选择：必须同时列示全部冲突裁决并基于最新存档重新裁决。'
          )
        );
      }
    } else if (supersedeInput.length > 0) {
      errors.push(error('decision-stale', '当前分叉没有需要取代的活动裁决；迟到旧裁决已自动失效，请直接重新裁决。'));
    }
  }

  if (errors.length > 0) {
    return { ok: false, duplicate: false, errors };
  }

  const now = sources?.now ?? (() => new Date());
  const decision: ReleaseForkDecision = {
    id: createForkDecisionId(sources),
    decidedAt: now().toISOString(),
    forkParentId: input.forkParentId,
    successorIds: currentSet.slice(),
    selectedSuccessorId: input.selectedSuccessorId,
    reason,
    supersedesDecisionIds: supersedeInput
  };
  return { ok: true, duplicate: false, decision: freezeSnapshot(decision) as ReleaseForkDecision };
}

function traceBranch(
  startId: string,
  childrenById: ReadonlyMap<string, ReleaseSlip[]>,
  forks: ReadonlyMap<string, ForkAdjudicationState>
): BranchTerminalTrace {
  const path: string[] = [];
  const visited = new Set<string>();
  let current = startId;
  while (!visited.has(current)) {
    visited.add(current);
    path.push(current);
    const children = childrenById.get(current) ?? [];
    if (children.length === 0) {
      return { successorId: startId, path, terminalId: current, status: 'terminal', stoppedAtForkId: null };
    }
    if (children.length === 1) {
      current = children[0].id;
      continue;
    }
    const fork = forks.get(current);
    if (fork?.state === 'resolved' && fork.selectedSuccessorId && children.some((child) => child.id === fork.selectedSuccessorId)) {
      current = fork.selectedSuccessorId;
      continue;
    }
    return { successorId: startId, path, terminalId: null, status: 'unresolved-fork', stoppedAtForkId: current };
  }
  return { successorId: startId, path, terminalId: null, status: 'cycle', stoppedAtForkId: current };
}

/**
 * 分析裁决后的链状态与每条直接后继的可追溯终端。
 */
export function analyzeForkAdjudications(
  slips: readonly ReleaseSlip[],
  decisions: readonly ReleaseForkDecision[] = []
): ForkAdjudicationInfo {
  const chains = analyzeCorrectionChains(slips);
  const states = evaluateForkStates(slips, decisions);
  const traces = new Map<string, BranchTerminalTrace[]>();
  const statusById = new Map<string, AdjudicatedChainStatus | import('./correction').CorrectionChainStatus>(
    chains.statusById
  );
  const rejected = new Set<string>();
  const blockedPath = new Set<string>();

  for (const [parentId, state] of states) {
    const children = chains.childrenById.get(parentId) ?? [];
    const branchTraces = children.map((child) => traceBranch(child.id, chains.childrenById, states));
    traces.set(parentId, branchTraces);

    if (state.state === 'resolved' && state.selectedSuccessorId) {
      const selected = branchTraces.find((trace) => trace.successorId === state.selectedSuccessorId);
      for (const child of children) {
        if (child.id !== state.selectedSuccessorId) {
          const trace = branchTraces.find((item) => item.successorId === child.id);
          for (const id of trace?.path ?? [child.id]) {
            rejected.add(id);
          }
          // 未选分支内部即使还有嵌套分叉，其全部下游都不能成为外层链的现行版本。
          const stack = [child.id];
          const visited = new Set<string>();
          while (stack.length > 0) {
            const id = stack.pop()!;
            if (visited.has(id)) {
              continue;
            }
            visited.add(id);
            rejected.add(id);
            for (const descendant of chains.childrenById.get(id) ?? []) {
              stack.push(descendant.id);
            }
          }
        }
      }
      if (selected) {
        if (selected.status !== 'terminal') {
          // 停在未裁决嵌套分叉点：该点属于外层被选路径，但不能提前宣布其下游现行。
          selected.path.forEach((id) => blockedPath.add(id));
        }
      }
    }
  }

  for (const [parentId, state] of states) {
    if (state.state === 'conflicting') {
      statusById.set(parentId, 'fork-conflict');
    } else if (state.state === 'resolved') {
      statusById.set(parentId, 'fork-adjudicated');
    } else if (blockedPath.has(parentId)) {
      statusById.set(parentId, 'adjudicated-blocked-path');
    } else if (rejected.has(parentId)) {
      statusById.set(parentId, 'adjudicated-rejected-branch');
    } else if (state.staleDecisionIds.length > 0 && state.activeDecisionIds.length === 0) {
      statusById.set(parentId, 'fork-decision-stale');
    }
  }

  for (const id of rejected) {
    if (!states.has(id)) {
      statusById.set(id, 'adjudicated-rejected-branch');
    }
  }
  for (const id of blockedPath) {
    if (!rejected.has(id) && !states.has(id)) {
      statusById.set(id, 'adjudicated-blocked-path');
    }
  }
  // 选中路径的唯一终端才使用“现行”状态；路径上的中间单仍显示为裁决路径。
  for (const [, state] of states) {
    if (state.state === 'resolved' && state.selectedSuccessorId) {
      const trace = traces.get(state.forkParentId)?.find((item) => item.successorId === state.selectedSuccessorId);
      if (trace?.status === 'terminal' && trace.terminalId) {
        statusById.set(trace.terminalId, 'adjudicated-current');
        for (const id of trace.path.slice(0, -1)) {
          if (!rejected.has(id) && !states.has(id)) {
            statusById.set(id, 'adjudicated-path');
          }
        }
      }
    }
  }

  const decisionsByFork = new Map<string, ReleaseForkDecision[]>();
  for (const decision of decisions) {
    const list = decisionsByFork.get(decision.forkParentId) ?? [];
    list.push(decision);
    decisionsByFork.set(decision.forkParentId, list);
  }

  return {
    statusById,
    childrenById: chains.childrenById,
    forks: states,
    tracesByFork: traces,
    decisionsByFork
  };
}
