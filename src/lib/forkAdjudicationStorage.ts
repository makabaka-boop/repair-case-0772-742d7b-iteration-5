/**
 * 人工分叉裁决的本地存档（只追加、不改写、不删除、不静默丢弃）。
 *
 * 与放行单存档相互独立：裁决记录存在自己的键里，绝不改写任何原放行单、
 * 更正单；放行单存档损坏或为空也不影响裁决存档的只读取证，反之亦然。
 *
 * 与放行单存档一致的可信底线：
 *  1. 历史只增不减：不设条数上限，任何已记录裁决都不会被静默顶掉；
 *  2. 跨页签交错写入不丢裁决：读最新存档 → 合并 → 写回 → 再读校验的乐观循环，
 *     本页签记录过的裁决被其它页签旧列表覆盖时自动合并补写并明确提示；
 *  3. 编号冲突给出明确结果：同编号且内容一致的重复提交幂等成功；
 *     同编号但内容不同是不可调和冲突，拒绝写入并保留原记录；
 *  4. 分叉绑定在写入时按**最新放行单存档**复核：分叉点已不存在、直接后继
 *     集合已变化（迟到新分支）或所选分支不在集合内时拒绝写入（fork-mismatch），
 *     要求负责人基于最新存档重新裁决——两个页签的并发裁决因此都绑定同一现实，
 *     选择不一致时由链分析展示冲突，而不是“最后写入者获胜”。
 *
 * 失败保护：存档损坏 / 未知版本 / 记录损坏时转入保护态——保留最近一次完整
 * 记录（含冗余备份）只读取证、拒绝任何新写入、不覆盖原存档；写入配额 /
 * 权限失败、持续交错重试超限时同样明确告警，原存档逐字保留。
 */
import { analyzeCorrectionChains } from './correction';
import {
  isWellFormedAdjudication,
  sameIdSet,
  type ForkAdjudication
} from './forkAdjudication';
import { loadReleaseState } from './releaseStorage';

const STORAGE_KEY = 'braille-plate:release-fork-adjudication:v1';
/** 最近一次完整写入的冗余备份：主存档被外部改坏时仍可只读取证并明确告警。 */
const BACKUP_KEY = 'braille-plate:release-fork-adjudication:v1:backup';
const CURRENT_STORAGE_VERSION = 1;
/** 交错写入的乐观重试上限（与放行单存档同一策略）。 */
const MAX_APPEND_ATTEMPTS = 10;

export const FORK_ADJUDICATION_STORAGE_KEY = STORAGE_KEY;

/** 追加裁决的结果：失败类别与告警一一对应，调用方必须向负责人明确反馈。 */
export type AppendAdjudicationOutcome =
  | { ok: true }
  | {
      ok: false;
      kind: Extract<
        AdjudicationStorageWarningKind,
        'write-failed' | 'id-conflict' | 'write-contention' | 'fork-mismatch' | 'release-unavailable'
      >;
    };

export interface StoredAdjudications {
  /** 可安全复核的裁决记录（记录顺序），冻结为只读。 */
  adjudications: ForkAdjudication[];
  /** 存档无法安全恢复时的告警；此时禁止任何写入。 */
  warning: AdjudicationStorageWarning | null;
  /** true 表示当前 localStorage 裁决存档处于保护态（损坏 / 版本不符）。 */
  protected: boolean;
  /** 跨页签覆盖被自动修复等一次性状态提示（不阻断裁决）；读取后由界面清空。 */
  notice: AdjudicationStorageWarning | null;
}

export type AdjudicationStorageWarningKind =
  | 'corrupted-json'
  | 'corrupted-record'
  | 'unknown-version'
  | 'invalid-record'
  | 'write-failed'
  | 'id-conflict'
  | 'write-contention'
  | 'fork-mismatch'
  | 'release-unavailable'
  | 'cross-tab-repaired';

export interface AdjudicationStorageWarning {
  kind: AdjudicationStorageWarningKind;
  message: string;
}

interface VersionedAdjudications {
  version?: unknown;
  adjudications?: unknown;
}

/** 进程内最近一次完整记录：存档被外部改坏或写入失败时仍可只读取证。 */
let memoryRecords: ForkAdjudication[] = [];

/**
 * 本页签成功记录过的全部裁决（跨页签覆盖后的认领依据，与放行单存档同一策略）。
 */
const localDecided = new Map<string, ForkAdjudication>();
/** 跨页签修复等一次性状态提示，挂在下一次 loadAdjudicationState 的结果里。 */
let pendingNotice: AdjudicationStorageWarning | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function warningMessage(kind: AdjudicationStorageWarningKind): string {
  const prefix = '本地分叉裁决存档无法安全恢复：';
  const retain = ' 已保留最近一次完整记录与原始存档用于取证；请检查浏览器存储，在修复前不会自动覆盖。';
  switch (kind) {
    case 'corrupted-json':
      return `${prefix}存档不是合法 JSON。${retain}`;
    case 'corrupted-record':
      return `${prefix}存档字段缺失或类型损坏。${retain}`;
    case 'unknown-version':
      return `${prefix}存档版本无法识别，不能信任其中的裁决记录。${retain}`;
    case 'invalid-record':
      return `${prefix}存在结构损坏的裁决记录，已停止恢复并保留原存档。${retain}`;
    case 'write-failed':
      return '分叉裁决写入失败（可能是配额不足或权限受限）：本次裁决未写入，历史裁决与原存档仍保留。';
    case 'id-conflict':
      return '裁决编号与历史裁决相同但内容不一致：已拒绝本次写入，历史原裁决逐字保留。请重新裁决以生成新编号。';
    case 'write-contention':
      return '多个页签同时记录分叉裁决且持续交错：本次写入未能稳定落库，已停止重试，历史原存档逐字保留。请复核后重新裁决。';
    case 'fork-mismatch':
      return '分叉状态已变化：分叉点不存在、直接后继集合与裁决绑定不一致（可能有新增分支），或所选分支不在集合内。本次裁决未写入，请基于最新存档重新裁决。';
    case 'release-unavailable':
      return '放行单存档当前不可安全读取（保护态或不可用）：无法核对分叉绑定，本次裁决未写入。请先修复放行单存档。';
    case 'cross-tab-repaired':
      return '检测到其它页签的旧列表覆盖了分叉裁决存档（有已记录裁决丢失）：已自动把本页签记录的裁决合并补写回历史，全部裁决可只读复核。';
  }
}

function makeWarning(kind: AdjudicationStorageWarningKind): AdjudicationStorageWarning {
  return { kind, message: warningMessage(kind) };
}

function protectedState(records: ForkAdjudication[], kind: AdjudicationStorageWarningKind): StoredAdjudications {
  return {
    adjudications: records.map((record) => Object.freeze(record) as ForkAdjudication),
    warning: makeWarning(kind),
    protected: true,
    notice: pendingNotice
  };
}

/**
 * 读取全部分叉裁决。损坏时返回最近一次完整记录（内存缓存，或冗余备份）并告警，
 * 绝不返回半张损坏记录，也不覆盖 localStorage 原文。
 */
export function loadAdjudicationState(): StoredAdjudications {
  const notice = pendingNotice;
  pendingNotice = null;
  const empty: StoredAdjudications = {
    adjudications: memoryRecords.slice(),
    warning: null,
    protected: false,
    notice
  };
  const store = storage();
  if (!store) {
    return empty;
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { ...empty, warning: makeWarning('corrupted-record'), protected: true };
  }
  if (!raw) {
    // 存储被清空（或从未写入）：内存缓存与本页签认领集合一并清空。
    memoryRecords = [];
    localDecided.clear();
    return { adjudications: [], warning: null, protected: false, notice };
  }

  const parsedRecord = parseVersionedAdjudications(raw);
  if (parsedRecord.ok) {
    memoryRecords = parsedRecord.adjudications.slice();
    return { adjudications: parsedRecord.adjudications, warning: null, protected: false, notice };
  }

  // 主存档不可信：先看冗余备份里有没有“最近一次完整记录”可只读取证。
  const backup = readBackup(store);
  const fallback = memoryRecords.length > 0 ? memoryRecords : backup;
  return protectedState(fallback, parsedRecord.kind);
}

/**
 * 跨页签修复：收到其它页签的整表写入时，把本页签记录过、却不在新整表里的
 * 裁决合并补写。只做“补缺”：已在存档中的同编号裁决一律以存档原件为准。
 */
function healAfterCrossTabWrite(store: Storage): void {
  if (localDecided.size === 0) {
    return;
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) {
    return;
  }
  const parsed = parseVersionedAdjudications(raw);
  if (!parsed.ok) {
    return;
  }

  const presentIds = new Set(parsed.adjudications.map((record) => record.id));
  const missing = [...localDecided.values()].filter((record) => !presentIds.has(record.id));
  if (missing.length === 0) {
    memoryRecords = parsed.adjudications.slice();
    return;
  }

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const latest = readFreshAdjudications(store);
    if (!latest.ok) {
      return;
    }
    const stillMissing = missing.filter(
      (record) => !latest.adjudications.some((existing) => existing.id === record.id)
    );
    if (stillMissing.length === 0) {
      memoryRecords = latest.adjudications.slice();
      return;
    }
    const merged = [...latest.adjudications, ...stillMissing];
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_STORAGE_VERSION, adjudications: merged }));
    } catch {
      return;
    }
    const verified = readFreshAdjudications(store);
    if (!verified.ok) {
      return;
    }
    const healed = missing.every((record) =>
      verified.adjudications.some((existing) => existing.id === record.id)
    );
    if (healed) {
      memoryRecords = verified.adjudications.slice();
      pendingNotice = makeWarning('cross-tab-repaired');
      try {
        store.setItem(
          BACKUP_KEY,
          JSON.stringify({ version: CURRENT_STORAGE_VERSION, adjudications: verified.adjudications })
        );
      } catch {
        // 备份失败不影响已完成的修复。
      }
      return;
    }
  }
  pendingNotice = makeWarning('write-contention');
}

function onCrossTabStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) {
    return;
  }
  const store = storage();
  if (store) {
    healAfterCrossTabWrite(store);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onCrossTabStorage);
}

function readBackup(store: Storage): ForkAdjudication[] {
  let raw: string | null = null;
  try {
    raw = store.getItem(BACKUP_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  const parsed = parseVersionedAdjudications(raw);
  return parsed.ok ? parsed.adjudications : [];
}

type ParsedAdjudications =
  | { ok: true; adjudications: ForkAdjudication[] }
  | { ok: false; kind: AdjudicationStorageWarningKind };

function parseVersionedAdjudications(raw: string): ParsedAdjudications {
  let parsed: VersionedAdjudications;
  try {
    parsed = JSON.parse(raw) as VersionedAdjudications;
  } catch {
    return { ok: false, kind: 'corrupted-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, kind: 'corrupted-record' };
  }
  if (parsed.version !== undefined && parsed.version !== CURRENT_STORAGE_VERSION) {
    return { ok: false, kind: 'unknown-version' };
  }
  if (!Array.isArray(parsed.adjudications)) {
    return { ok: false, kind: 'corrupted-record' };
  }
  const adjudications: ForkAdjudication[] = [];
  for (const candidate of parsed.adjudications) {
    if (!isWellFormedAdjudication(candidate)) {
      return { ok: false, kind: 'invalid-record' };
    }
    adjudications.push(Object.freeze(candidate) as ForkAdjudication);
  }
  return { ok: true, adjudications };
}

/**
 * 追加一张人工分叉裁决。
 *
 * 采用与放行单存档相同的“读取最新存档 → 合并 → 写回 → 重新读取校验”
 * 乐观并发循环；并在每轮按**最新放行单存档**复核分叉绑定（分叉点存在、
 * 直接后继集合与裁决绑定逐字一致、所选分支在集合内），保证裁决永远绑定
 * 写入时的真实现实：迟到新分支会让基于旧集合的裁决写入失败并要求重新裁决。
 *
 * @returns 结构化结果；失败时原 localStorage 记录逐字不变，
 *          调用方必须把失败类别与文案反馈给负责人。
 */
export function appendForkAdjudication(adjudication: ForkAdjudication): AppendAdjudicationOutcome {
  if (!isWellFormedAdjudication(adjudication)) {
    return { ok: false, kind: 'write-failed' };
  }
  const store = storage();
  if (!store) {
    return { ok: false, kind: 'write-failed' };
  }

  // 写入前读取裁决存档：结构损坏 / 未知版本（保护态）时绝不写入。
  const initial = readForAppend(store);
  if (!initial.ok) {
    return { ok: false, kind: 'write-failed' };
  }

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const current = readForAppend(store);
    if (!current.ok) {
      return { ok: false, kind: 'write-failed' };
    }

    // 每轮都按最新放行单存档复核分叉绑定：两个页签并发裁决时，
    // 任何迟到的新分支都会让基于旧后继集合的裁决在这里被拦下。
    const binding = checkForkBinding(adjudication);
    if (!binding.ok) {
      return { ok: false, kind: binding.kind };
    }

    const existingIndex = current.adjudications.findIndex((existing) => existing.id === adjudication.id);
    if (existingIndex >= 0) {
      // 相同编号：内容逐字一致才是幂等的同一张裁决；否则是明确的编号冲突。
      if (adjudicationContentEqual(current.adjudications[existingIndex], adjudication)) {
        memoryRecords = current.adjudications.slice();
        localDecided.set(adjudication.id, current.adjudications[existingIndex]);
        return { ok: true };
      }
      return { ok: false, kind: 'id-conflict' };
    }

    // 历史只增不减：直接追加，不截断、不顶掉任何历史裁决。
    const next = [...current.adjudications, adjudication];
    const serialized = JSON.stringify({ version: CURRENT_STORAGE_VERSION, adjudications: next });
    try {
      store.setItem(STORAGE_KEY, serialized);
    } catch {
      return { ok: false, kind: 'write-failed' };
    }

    // 写回后立即重新读取校验：若本裁决已不在存档中，说明写间隙被其它页签
    // 的完整列表覆盖，带着最新列表进入下一轮合并重试。
    const verified = readFreshAdjudications(store);
    if (!verified.ok) {
      return { ok: false, kind: 'write-failed' };
    }
    if (!verified.adjudications.some((existing) => existing.id === adjudication.id)) {
      continue;
    }

    memoryRecords = verified.adjudications.slice();
    localDecided.set(adjudication.id, adjudication);
    try {
      store.setItem(
        BACKUP_KEY,
        JSON.stringify({ version: CURRENT_STORAGE_VERSION, adjudications: verified.adjudications })
      );
    } catch {
      // 忽略备份失败：主记录与内存缓存均已是完整记录。
    }
    return { ok: true };
  }

  // 重试上限：极端持续交错下也明确失败，绝不静默丢裁决或无限循环写爆配额。
  return { ok: false, kind: 'write-contention' };
}

/**
 * 按最新放行单存档复核裁决的分叉绑定：
 * 分叉点必须仍是分叉点、当前直接后继集合必须与裁决绑定逐字一致、
 * 所选分支必须在集合内。放行单存档处于保护态时无法核对，拒绝写入。
 */
function checkForkBinding(
  adjudication: ForkAdjudication
): { ok: true } | { ok: false; kind: 'fork-mismatch' | 'release-unavailable' } {
  const releases = loadReleaseState();
  if (releases.protected) {
    return { ok: false, kind: 'release-unavailable' };
  }
  const chains = analyzeCorrectionChains(releases.slips);
  const fork = chains.forks.find((candidate) => candidate.parentId === adjudication.forkParentId);
  if (!fork) {
    return { ok: false, kind: 'fork-mismatch' };
  }
  if (!sameIdSet(fork.slipIds, adjudication.successorIds)) {
    return { ok: false, kind: 'fork-mismatch' };
  }
  if (!fork.slipIds.includes(adjudication.chosenSuccessorId)) {
    return { ok: false, kind: 'fork-mismatch' };
  }
  return { ok: true };
}

/** 追加写入路径读取裁决存档（结构校验）。 */
function readForAppend(store: Storage): ParsedAdjudications {
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { ok: false, kind: 'corrupted-record' };
  }
  if (!raw) {
    return { ok: true, adjudications: [] };
  }
  return parseVersionedAdjudications(raw);
}

/** 不经内存缓存、直接读取并校验当前 localStorage 裁决主存档。 */
function readFreshAdjudications(store: Storage): ParsedAdjudications {
  return readForAppend(store);
}

/** 比较两张裁决内容是否逐字一致（编号已相等的前提下）。 */
function adjudicationContentEqual(left: ForkAdjudication, right: ForkAdjudication): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 供界面展示指定失败类别的告警文案（不产生任何写入）。 */
export function adjudicationFailureWarning(
  kind: 'write-failed' | 'id-conflict' | 'write-contention' | 'fork-mismatch' | 'release-unavailable'
): AdjudicationStorageWarning {
  return makeWarning(kind);
}

/** 测试辅助：清空进程内最近一次完整记录、跨页签认领集合与一次性提示。 */
export function __resetAdjudicationMemoryForTests(): void {
  memoryRecords = [];
  localDecided.clear();
  pendingNotice = null;
}

/** 清空所有分叉裁决本地存档（仅测试或未来显式管理入口使用）。失败时保留原存档。 */
export function clearAdjudicationState(): boolean {
  const store = storage();
  if (!store) {
    return false;
  }
  try {
    store.removeItem(STORAGE_KEY);
    store.removeItem(BACKUP_KEY);
    memoryRecords = [];
    return true;
  } catch {
    return false;
  }
}
