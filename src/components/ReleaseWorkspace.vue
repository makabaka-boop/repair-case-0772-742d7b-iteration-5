<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  createReleaseSlip,
  evaluateReleaseGate,
  type CalibrationGateView,
  type ReleaseBlocker,
  type ReleaseSlip
} from '../lib/release';
import {
  analyzeCorrectionChains,
  createCorrectionSlip,
  isInCorrectionChain,
  type CorrectionChainStatus,
  type CorrectionFork
} from '../lib/correction';
import {
  branchTerminals,
  createForkAdjudication,
  type ForkResolution
} from '../lib/forkAdjudication';
import { FORK_ADJUDICATION_STORAGE_KEY } from '../lib/forkAdjudicationStorage';
import { useDraftSession } from '../lib/draftSession';
import { useCalibrationSession } from '../lib/calibrationSession';
import { useReleaseSession } from '../lib/releaseSession';
import { formatHeight } from '../lib/calibration';
import ReleaseSlipCard from './ReleaseSlipCard.vue';

/**
 * 压点放行工作区：
 * 只读共享单稿预检的原文 / 行宽与试压校准会话，本身不录入任何数据。
 * 只有“预检合法 + 当前六点试压合格（新判定、读数未改动、版本相符）”才放行；
 * 放行后把单稿与校准固化为不可变快照。历史放行单只读复核，草稿改动立即让
 * 当前可放行状态失效，但不覆盖任何历史单据。当前授权放在单例会话中，
 * 切换模式（本组件卸载重挂）不丢失；刷新页面后才不自动恢复。
 *
 * 更正补发：历史单据提供“以此单更正”入口，操作员明确确认后把原单文字与
 * 行宽带入共享可编辑草稿；更正单必须重新通过同一放行闸门并填写非空更正原因，
 * 签发后以不可变关联指向原单（原单内容绝不改写）。历史区展示更正链与当前状态，
 * 跨页签合并出的分叉明确标记冲突并停止自动认定现行版本。
 */
const draft = useDraftSession();
const calibration = useCalibrationSession();
const session = useReleaseSession();

// 模板需要直接访问的响应式字段（顶层 ref 会自动解包；嵌套在对象里则不会）。
const { text: draftText, width: draftWidth } = draft;
const { result: calibrationResult } = calibration;
const { activeSlip, invalidatedSlip, archive, adjudications: adjudicationArchive } = session;

const storageWarning = computed(() => archive.value.warning?.message ?? null);
/** 跨页签覆盖被自动修复等一次性状态提示（不阻断签发）。 */
const archiveNotice = computed(() => archive.value.notice?.message ?? null);
/** 分叉裁决存档的保护态告警与一次性提示（与放行单存档相互独立）。 */
const adjudicationWarning = computed(() => adjudicationArchive.value.warning?.message ?? null);
const adjudicationNotice = computed(() => adjudicationArchive.value.notice?.message ?? null);
const writeError = ref<string | null>(null);
/** 分叉裁决写入失败 / 绑定失配的明确告警。 */
const adjudicationError = ref<string | null>(null);

const gateView = computed<CalibrationGateView>(() => ({
  verdict: calibration.result.value?.verdict ?? null,
  result: calibration.result.value,
  judgedRaws: calibration.judgedRaws.value,
  currentReadings: calibration.readings.value,
  protected: calibration.isProtectedArchive.value,
  recordVersion: calibration.recordVersion.value
}));

const gate = computed(() => evaluateReleaseGate(draft.text.value, draft.width.value, gateView.value));
const canRelease = computed(() => gate.value.canRelease && !archive.value.protected);
const draftBlockers = computed(() => gate.value.blockers.filter((blocker) => blocker.scope === 'draft'));
const calibrationBlockers = computed(() =>
  gate.value.blockers.filter((blocker) => blocker.scope === 'calibration')
);

/** 历史放行单（最新在前），始终只读。 */
const historySlips = computed(() => archive.value.slips.slice().reverse());
/** 历史最新单据：刷新 / 跨标签恢复时据此提示“需重新签发”，不自动授权。 */
const latestHistory = computed(() =>
  archive.value.slips.length > 0 ? archive.value.slips[archive.value.slips.length - 1] : null
);

// ---- 更正补发：确认 → 带入草稿 → 重新过闸门 + 非空原因 → 签发独立编号新单 ----
/** 等待操作员明确确认的原单（点击“以此单更正”后、确认前）。 */
const pendingCorrection = ref<ReleaseSlip | null>(null);
// 更正规程状态放在共享会话里：切到单稿预检页修改文字后回来仍然保持。
const { correctionTarget, correctionReason } = session;

const correctionReasonEmpty = computed(() => correctionReason.value.trim() === '');
const canIssueCorrection = computed(
  () => correctionTarget.value !== null && !correctionReasonEmpty.value && canRelease.value
);

/** 更正链分析：与领域校验、只追加存档、共享会话同一份关联数据与同一份裁决状态。 */
const chainInfo = computed(() => analyzeCorrectionChains(archive.value.slips, adjudicationArchive.value.adjudications));
const correctionForks = computed(() => chainInfo.value.forks);
/** 仍需人工裁决（或重新裁决）的分叉：未裁决、旧裁决已失效或裁决冲突。 */
const pendingForks = computed(() =>
  correctionForks.value.filter((fork) => forkResolutionOf(fork.parentId)?.state !== 'resolved')
);
/** 已全部裁决的分叉（仅作信息展示）。 */
const resolvedForks = computed(() =>
  correctionForks.value.filter((fork) => forkResolutionOf(fork.parentId)?.state === 'resolved')
);

function forkResolutionOf(parentId: string): ForkResolution | null {
  return chainInfo.value.forkResolutions.get(parentId) ?? null;
}

function chainStatusOf(slip: ReleaseSlip): CorrectionChainStatus | null {
  if (!isInCorrectionChain(chainInfo.value, slip)) {
    return null;
  }
  return chainInfo.value.statusById.get(slip.id) ?? null;
}

function chainStatusText(slip: ReleaseSlip): string {
  const status = chainStatusOf(slip);
  const children = chainInfo.value.childrenById.get(slip.id) ?? [];
  switch (status) {
    case 'current':
      return '更正链现行版本';
    case 'superseded':
      return `已被更正单 ${children[0]?.id ?? ''} 取代`;
    case 'forked': {
      const resolution = forkResolutionOf(slip.id);
      if (resolution?.state === 'resolved') {
        return `分叉已经人工裁决：更正单 ${resolution.chosenSuccessorId} 所在分支为现行分支`;
      }
      if (resolution?.state === 'conflict') {
        return '更正分叉冲突：多页签裁决不一致，不作现行认定';
      }
      if (resolution?.state === 'stale') {
        return '更正分叉冲突：新增分支后旧裁决已失效，不作现行认定';
      }
      return '更正分叉冲突：不作现行认定';
    }
    case 'fork-branch': {
      const cause = chainInfo.value.forkBranchCauseById.get(slip.id);
      return cause === 'unchosen' ? '未被人工裁决选中的分支：不作现行认定' : '分叉分支：不作现行认定';
    }
    case 'orphan':
      return '原单编号不在存档中';
    default:
      return '';
  }
}

// ---- 人工分叉裁决：历史详情展示每个直接后继及可追溯终端，负责人选定分支并填写原因 ----
/** 各分叉点当前选择的直接后继编号（分叉点 id → 后继 id）。 */
const forkChoices = ref<Record<string, string>>({});
/** 各分叉点的裁决原因草稿。 */
const forkReasons = ref<Record<string, string>>({});

/** 分叉的每个直接后继及其可追溯终端（供负责人逐支复核）。 */
function forkBranches(fork: CorrectionFork): Array<{ id: string; terminals: string[] }> {
  return fork.slipIds.map((id) => ({ id, terminals: branchTerminals(chainInfo.value.childrenById, id) }));
}

/** 已裁决分叉当前生效的裁决记录（可能多张：相同选择的幂等重复）。 */
function forkActiveRecords(parentId: string) {
  return forkResolutionOf(parentId)?.active ?? [];
}

/** 裁决存档或放行单存档处于保护态时，禁止记录新裁决。 */
const adjudicationBlocked = computed(() => archive.value.protected || adjudicationArchive.value.protected);

/**
 * 裁决表单始终可用：已裁决的分叉也允许再次记录——相同选择是幂等重复，
 * 不同选择会成为明确的冲突（而不是被界面禁止），绝不会“最后写入者获胜”。
 */
function showForkForm(): boolean {
  return true;
}

function canSubmitFork(parentId: string): boolean {
  if (adjudicationBlocked.value) {
    return false;
  }
  const choice = forkChoices.value[parentId] ?? '';
  const reason = (forkReasons.value[parentId] ?? '').trim();
  return choice !== '' && reason !== '';
}

function forkStateText(parentId: string): string {
  const resolution = forkResolutionOf(parentId);
  switch (resolution?.state) {
    case 'resolved':
      return `已裁决：更正单 ${resolution.chosenSuccessorId} 所在分支为现行版本。`;
    case 'conflict':
      return '裁决冲突：多个页签对同一分叉作出不同选择，不作现行认定；请基于最新存档重新裁决（新裁决将显式取代冲突中的旧裁决）。';
    case 'stale':
      return '旧裁决已失效：分叉的直接后继集合已变化（可能有新增分支），请基于最新存档重新裁决。';
    default:
      return '尚未人工裁决：请选择一条更正链作为现行版本；在此之前不作现行认定，全部原件保留取证。';
  }
}

/** 记录人工分叉裁决：绑定分叉点与当前完整直接后继集合，冲突时显式取代旧裁决。 */
function submitAdjudication(fork: CorrectionFork) {
  adjudicationError.value = null;
  const resolution = forkResolutionOf(fork.parentId);
  const created = createForkAdjudication({
    forkParentId: fork.parentId,
    successorIds: fork.slipIds,
    chosenSuccessorId: forkChoices.value[fork.parentId] ?? '',
    reason: forkReasons.value[fork.parentId] ?? '',
    // 重新裁决冲突：显式取代冲突中的全部有效旧裁决，绝不是“最后写入者获胜”。
    supersedesAdjudicationIds: resolution?.state === 'conflict' ? resolution.active.map((a) => a.id) : []
  });
  if (!created.ok || !created.adjudication) {
    adjudicationError.value = created.blockers?.[0]?.message ?? '裁决内容不完整，无法记录。';
    return;
  }
  const outcome = session.decide(created.adjudication);
  if (!outcome.ok) {
    // 写入失败 / 分叉绑定失配 / 保护态：明确告警，原存档保留，不产生伪裁决。
    adjudicationError.value = outcome.error;
    return;
  }
  // 记录成功：清空该分叉的表单草稿。
  const nextChoices = { ...forkChoices.value };
  delete nextChoices[fork.parentId];
  forkChoices.value = nextChoices;
  const nextReasons = { ...forkReasons.value };
  delete nextReasons[fork.parentId];
  forkReasons.value = nextReasons;
}

/** 点击“以此单更正”：先进入待确认状态，绝不直接改草稿。 */
function startCorrection(slip: ReleaseSlip) {
  pendingCorrection.value = slip;
}

/** 操作员明确确认：把原单文字与行宽带入共享可编辑草稿，进入更正规程。 */
function confirmCorrection() {
  const target = pendingCorrection.value;
  if (!target) {
    return;
  }
  pendingCorrection.value = null;
  writeError.value = null;
  session.beginCorrection(target);
}

function cancelCorrection() {
  pendingCorrection.value = null;
  session.cancelCorrection();
}

function issueCorrection() {
  const target = correctionTarget.value;
  if (!target) {
    return;
  }
  writeError.value = null;
  const created = createCorrectionSlip({
    text: draft.text.value,
    rawWidth: draft.width.value,
    gate: gateView.value,
    reason: correctionReason.value,
    supersedesId: target.id
  });
  if (!created.ok || !created.slip) {
    return;
  }
  const outcome = session.issue(created.slip);
  if (!outcome.ok) {
    // 写入失败 / 保护态：明确告警，原存档保留，不产生伪签发。
    writeError.value = outcome.error;
    return;
  }
  // 签发成功：退出更正规程，新单成为当前授权并进入历史更正链。
  session.cancelCorrection();
}

// 跨标签页放行存档 / 裁决存档更新时，只依据完整、版本相符的记录恢复历史展示。
function onReleaseStorage(event: StorageEvent) {
  if (event.key === null || event.key === 'braille-plate:release:v1') {
    session.reloadArchive();
  }
  if (event.key === null || event.key === FORK_ADJUDICATION_STORAGE_KEY) {
    session.reloadAdjudications();
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', onReleaseStorage);
}
onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('storage', onReleaseStorage);
  }
});

function issueSlip() {
  writeError.value = null;
  const created = createReleaseSlip({
    text: draft.text.value,
    rawWidth: draft.width.value,
    gate: gateView.value
  });
  if (!created.ok || !created.slip) {
    return;
  }
  const outcome = session.issue(created.slip);
  if (!outcome.ok) {
    // 写入失败 / 保护态：明确告警，原存档保留，不产生伪签发。
    writeError.value = outcome.error;
  }
}

function blockerText(blocker: ReleaseBlocker): string {
  return blocker.message;
}

// 每次挂载重新读一次放行存档与裁决存档：跨标签页更新或外部损坏在进入本页时被完整恢复。
onMounted(() => {
  session.reloadArchive();
  session.reloadAdjudications();
});
</script>

<template>
  <section
    v-if="storageWarning"
    class="panel errors release-archive-warning"
    role="alert"
    data-testid="release-archive-warning"
  >
    <h2>放行单存档无法安全恢复</h2>
    <p>{{ storageWarning }}</p>
  </section>

  <section
    v-if="writeError"
    class="panel errors release-write-error"
    role="alert"
    data-testid="release-write-error"
  >
    <h2>放行单未能写入历史</h2>
    <p>{{ writeError }}</p>
  </section>

  <section
    v-if="archiveNotice"
    class="panel release-archive-notice"
    role="status"
    data-testid="release-archive-notice"
  >
    <h2>历史已自动补齐</h2>
    <p>{{ archiveNotice }}</p>
  </section>

  <section
    v-if="adjudicationWarning"
    class="panel errors fork-adjudication-warning"
    role="alert"
    data-testid="fork-adjudication-warning"
  >
    <h2>分叉裁决存档无法安全恢复</h2>
    <p>{{ adjudicationWarning }}</p>
  </section>

  <section
    v-if="adjudicationError"
    class="panel errors fork-adjudication-error"
    role="alert"
    data-testid="fork-adjudication-error"
  >
    <h2>分叉裁决未能写入</h2>
    <p>{{ adjudicationError }}</p>
  </section>

  <section
    v-if="adjudicationNotice"
    class="panel release-archive-notice"
    role="status"
    data-testid="fork-adjudication-notice"
  >
    <h2>裁决历史已自动补齐</h2>
    <p>{{ adjudicationNotice }}</p>
  </section>

  <section class="panel release-authorize" aria-label="压点放行签发">
    <p class="release-note">
      完成铭牌文字预检后，只有当前六点试压判定<strong>合格</strong>才能交付放行单。
      本页只读复核单稿预检与试压校准的当前结果：条件齐备时点击“签发压点放行单”，
      系统把单稿原文、行宽、逐方编码、排版结果与本次合格判定及六点读数固化为不可变快照。
    </p>

    <div class="release-gate" data-testid="release-gate">
      <div class="gate-block" data-testid="gate-draft">
        <h3>单稿预检</h3>
        <p class="gate-source">
          原文：<span class="gate-text" data-testid="gate-draft-text">{{ draftText || '（空）' }}</span>
          ｜每行 <span data-testid="gate-draft-width">{{ draftWidth }}</span> 方
        </p>
        <ul v-if="draftBlockers.length > 0" class="gate-blockers" data-testid="gate-draft-blockers">
          <li v-for="(blocker, i) in draftBlockers" :key="`d-${i}`" class="blocker">{{ blockerText(blocker) }}</li>
        </ul>
        <p v-else class="gate-ok" data-testid="gate-draft-ok">单稿预检通过，存在可压点的逐方排版结果。</p>
      </div>

      <div class="gate-block" data-testid="gate-calibration">
        <h3>六点试压校准</h3>
        <p
          v-if="calibrationResult?.verdict === 'pass'"
          class="gate-ok"
          data-testid="gate-calibration-pass"
        >
          最近判定：合格（极差 {{ formatHeight(calibrationResult.threshold.spread) }} 毫米）
        </p>
        <p v-else-if="calibrationResult?.verdict === 'adjust'" class="gate-muted">最近判定：需调机</p>
        <p v-else-if="calibrationResult?.verdict === 'blocked'" class="gate-muted">最近判定：读数受阻</p>
        <p v-else class="gate-muted">尚未执行判定</p>
        <ul v-if="calibrationBlockers.length > 0" class="gate-blockers" data-testid="gate-calibration-blockers">
          <li v-for="(blocker, i) in calibrationBlockers" :key="`c-${i}`" class="blocker">
            {{ blockerText(blocker) }}
          </li>
        </ul>
      </div>
    </div>

    <button
      type="button"
      class="compare-btn release-issue"
      data-testid="release-issue"
      :disabled="!canRelease"
      @click="issueSlip"
    >
      签发压点放行单
    </button>
    <p v-if="archive.protected" class="gate-blockers-note" role="alert" data-testid="release-protected-note">
      放行单存档处于保护态：在修复前不能签发新单据，历史完整记录仍可只读复核。
    </p>

    <section v-if="correctionTarget" class="correction-panel" aria-label="补发更正单" data-testid="correction-panel">
      <h2>补发更正单</h2>
      <p class="correction-meta">
        原单编号：<strong data-testid="correction-target-id">{{ correctionTarget.id }}</strong>
        （原单内容绝不改写，继续只读保留供换班追溯）。
      </p>
      <p class="correction-meta">
        已把原单文字与行宽带入可编辑草稿：请在“单稿预检”页修正文字或行宽，
        并确保六点试压重新判定合格；更正单必须重新通过编码、排版与合格试压闸门。
      </p>
      <label class="field">
        <span class="field-label">更正原因（必填）</span>
        <textarea
          v-model="correctionReason"
          rows="2"
          spellcheck="false"
          placeholder="填写本次更正的具体原因"
          data-testid="correction-reason"
          :class="{ 'input-invalid': correctionReasonEmpty }"
        ></textarea>
      </label>
      <p v-if="correctionReasonEmpty" class="correction-hint" data-testid="correction-reason-hint">
        更正原因不能为空，填写后才能签发更正单。
      </p>
      <div class="correction-actions">
        <button
          type="button"
          class="compare-btn release-issue"
          data-testid="correction-issue"
          :disabled="!canIssueCorrection"
          @click="issueCorrection"
        >
          签发更正单
        </button>
        <button type="button" class="quick-btn" data-testid="correction-cancel" @click="cancelCorrection">
          取消更正
        </button>
      </div>
    </section>

    <div v-if="activeSlip" class="release-active" role="status" data-testid="release-active">
      <h2>当前可放行：放行单 {{ activeSlip.id }}</h2>
      <p class="release-active-meta">放行依据为本次新完成的合格判定；来源快照如下，可逐项复核。</p>
      <ReleaseSlipCard :slip="activeSlip" />
    </div>

    <div
      v-else-if="invalidatedSlip"
      class="release-invalidated"
      role="status"
      data-testid="release-invalidated"
    >
      <h2>当前可放行状态已失效</h2>
      <p>
        放行单 <strong>{{ invalidatedSlip.id }}</strong> 签发后，单稿文字、行宽或某一点读数已被改动，
        或校准不再是当前合格判定。该单据仍可在下方历史记录只读复核，但已不是当前授权；
        请核对后重新满足条件并签发新的放行单。
      </p>
    </div>

    <div v-else-if="latestHistory" class="release-history-note" data-testid="release-need-reissue">
      <p>
        历史最新放行单为 <strong>{{ latestHistory.id }}</strong>。刷新或跨标签页恢复的旧单据不自动作为当前授权；
        如需放行，请确认当前单稿合法且试压重新判定合格后，再签发新的放行单。
      </p>
    </div>
  </section>

  <section class="panel release-history" aria-label="历史放行单只读复核">
    <h2>历史放行单（只读复核，{{ historySlips.length }} 份）</h2>

    <div
      v-if="pendingForks.length > 0"
      class="correction-fork-warning"
      role="alert"
      data-testid="correction-fork-warning"
    >
      <h3>更正链存在分叉冲突</h3>
      <p>
        以下单据被多张更正单同时指向（可能由多页签同时更正合并产生）：已停止自动认定现行版本，
        不会仅凭时间先后挑选现行单；全部原件保留取证，请负责人在下方逐分叉人工裁决。
      </p>
      <ul>
        <li v-for="fork in pendingForks" :key="fork.parentId" data-testid="correction-fork-item">
          原单 <strong>{{ fork.parentId }}</strong>：更正单 {{ fork.slipIds.join('、') }} 同时指向它
          （{{ forkStateText(fork.parentId) }}）
        </li>
      </ul>
    </div>

    <div
      v-if="resolvedForks.length > 0"
      class="correction-fork-resolved"
      role="status"
      data-testid="correction-fork-resolved"
    >
      <h3>分叉已经人工裁决</h3>
      <ul>
        <li v-for="fork in resolvedForks" :key="fork.parentId" data-testid="correction-fork-resolved-item">
          原单 <strong>{{ fork.parentId }}</strong>：{{ forkStateText(fork.parentId) }}
        </li>
      </ul>
    </div>

    <section
      v-for="fork in correctionForks"
      :key="`adj-${fork.parentId}`"
      class="fork-adjudication"
      :data-fork-id="fork.parentId"
      aria-label="人工分叉裁决"
      data-testid="fork-adjudication"
    >
      <h3>分叉点 {{ fork.parentId }}：人工裁决</h3>
      <p class="fork-adjudication-state" data-testid="fork-adjudication-state">{{ forkStateText(fork.parentId) }}</p>
      <ul class="fork-branch-list">
        <li v-for="branch in forkBranches(fork)" :key="branch.id" data-testid="fork-branch-item">
          <label class="fork-branch-choice">
            <input
              v-model="forkChoices[fork.parentId]"
              type="radio"
              :name="`fork-choice-${fork.parentId}`"
              :value="branch.id"
              :disabled="adjudicationBlocked"
              data-testid="fork-choice"
            />
            更正单 {{ branch.id }}（可追溯终端：{{ branch.terminals.join('、') }}）
          </label>
        </li>
      </ul>
      <ul
        v-if="forkActiveRecords(fork.parentId).length > 0"
        class="fork-adjudication-records"
        data-testid="fork-adjudication-records"
      >
        <li v-for="record in forkActiveRecords(fork.parentId)" :key="record.id" data-testid="fork-adjudication-record">
          裁决 {{ record.id }}：选定 {{ record.chosenSuccessorId }}；原因：{{ record.reason }}
        </li>
      </ul>
      <template v-if="showForkForm()">
        <label class="field">
          <span class="field-label">裁决原因（必填）</span>
          <textarea
            v-model="forkReasons[fork.parentId]"
            rows="2"
            spellcheck="false"
            placeholder="填写选定该分支作为现行版本的具体原因"
            data-testid="fork-reason"
          ></textarea>
        </label>
        <button
          type="button"
          class="compare-btn release-issue"
          data-testid="fork-decide"
          :disabled="!canSubmitFork(fork.parentId)"
          @click="submitAdjudication(fork)"
        >
          记录分叉裁决
        </button>
        <p v-if="adjudicationBlocked" class="correction-hint" data-testid="fork-adjudication-blocked">
          存档处于保护态：修复前不能记录新裁决，历史裁决仍可只读复核。
        </p>
      </template>
    </section>

    <p v-if="historySlips.length === 0" class="history-empty" data-testid="release-history-empty">
      尚无已签发的放行单。
    </p>
    <ol v-else class="history-list" data-testid="release-history-list">
      <li
        v-for="slip in historySlips"
        :key="slip.id"
        class="history-item"
        :class="{ 'is-active': activeSlip?.id === slip.id }"
        data-testid="release-history-item"
        :data-slip-id="slip.id"
      >
        <p
          v-if="chainStatusOf(slip)"
          class="chain-status"
          :class="`chain-${chainStatusOf(slip)}`"
          data-testid="chain-status"
        >
          {{ chainStatusText(slip) }}
        </p>
        <ReleaseSlipCard :slip="slip" />
        <div
          v-if="pendingCorrection?.id === slip.id"
          class="correction-confirm"
          role="alertdialog"
          aria-label="确认发起更正"
          data-testid="correction-confirm"
        >
          <p>
            确认以放行单 <strong>{{ slip.id }}</strong> 为基础发起更正？
            原单文字与行宽将带入可编辑草稿（覆盖当前草稿内容），原单内容不会被改写。
          </p>
          <div class="correction-actions">
            <button
              type="button"
              class="compare-btn"
              data-testid="correction-confirm-yes"
              @click="confirmCorrection"
            >
              确认发起更正
            </button>
            <button type="button" class="quick-btn" data-testid="correction-confirm-no" @click="cancelCorrection">
              取消
            </button>
          </div>
        </div>
        <button
          v-else
          type="button"
          class="quick-btn correction-start"
          data-testid="correct-with-slip"
          @click="startCorrection(slip)"
        >
          以此单更正
        </button>
      </li>
    </ol>
  </section>
</template>
