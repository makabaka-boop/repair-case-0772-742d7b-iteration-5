/**
 * 压点放行的“当前授权”会话。
 *
 * 与只追加的放行单存档不同，当前授权是页面会话态：
 *  - 只有本标签本次会话新签发的单据才成为当前授权；
 *  - 刷新页面后不恢复（旧单据只在历史中只读复核，不自动授权）；
 *  - 但在同一页面切换模式（放行页被卸载又重新挂载）时保持，
 *    这样回到放行页仍能看到当前可放行状态；
 *  - 单稿文字、行宽或任一校准读数 / 结论变化时立即失效。
 *
 * 更正规程（已确认的原单、更正原因草稿）同样放在会话里：
 * 操作员确认“以此单更正”后需要切到单稿预检页修改文字，更正状态必须在
 * 放行页卸载重挂后仍然保持；刷新页面则更正规程不恢复，历史单据不受影响。
 */
import { effectScope, ref, watch, type Ref } from 'vue';
import type { ReleaseSlip } from './release';
import {
  appendFailureWarning,
  appendReleaseSlip,
  loadReleaseState,
  type StoredReleases
} from './releaseStorage';
import { useDraftSession } from './draftSession';
import { useCalibrationSession } from './calibrationSession';

export interface IssueOutcome {
  ok: boolean;
  /** 写入失败时的告警文案；闸门不通过或成功时为 null。 */
  error: string | null;
}

export interface ReleaseSession {
  /** 历史放行单存档（响应式，跨标签页更新后重新加载）。 */
  archive: Ref<StoredReleases>;
  /** 本标签本次会话的当前授权单据；刷新后为 null。 */
  activeSlip: Ref<ReleaseSlip | null>;
  /** 最近被失效的单据（用于明确提示改动后授权已失效）。 */
  invalidatedSlip: Ref<ReleaseSlip | null>;
  /** 已确认发起更正的原单；null 表示当前不在更正规程。刷新后不保留。 */
  correctionTarget: Ref<ReleaseSlip | null>;
  /** 更正原因草稿：随会话保持（切换模式不丢失），刷新后不保留。 */
  correctionReason: Ref<string>;
  /**
   * 操作员明确确认后进入更正规程：把原单文字与行宽带入共享可编辑草稿，
   * 并记录更正关联的原单。原单内容绝不改写。
   */
  beginCorrection: (slip: ReleaseSlip) => void;
  /** 退出更正规程（取消或签发成功后）；不影响已带入的草稿内容。 */
  cancelCorrection: () => void;
  issue: (slip: ReleaseSlip) => IssueOutcome;
  reloadArchive: () => void;
}

let singleton: ReleaseSession | null = null;
let singletonScope: ReturnType<typeof effectScope> | null = null;

/** 进程内共享的放行会话：放行页反复挂载 / 卸载时当前授权不丢失。 */
export function useReleaseSession(): ReleaseSession {
  if (singleton) {
    return singleton;
  }

  // 关键：单例由任何一个组件首次创建，但其失效监听必须独立于该组件的生命周期——
  // 否则在组件 setup 中注册的 watch 会随放行页卸载而停止，切到单稿页改文字就漏检。
  singletonScope = effectScope(true);
  singleton = singletonScope.run(() => {
    const draft = useDraftSession();
    const calibration = useCalibrationSession();
    const archive = ref(loadReleaseState());
    const activeSlip = ref<ReleaseSlip | null>(null);
    const invalidatedSlip = ref<ReleaseSlip | null>(null);
    const correctionTarget = ref<ReleaseSlip | null>(null);
    const correctionReason = ref('');

    function reloadArchive() {
      archive.value = loadReleaseState();
    }

    function beginCorrection(slip: ReleaseSlip) {
      correctionTarget.value = slip;
      correctionReason.value = '';
      // 原单文字与行宽带入共享可编辑草稿（草稿改动同时让当前授权立即失效）。
      draft.text.value = slip.snapshot.draft.text;
      draft.width.value = String(slip.snapshot.draft.width);
    }

    function cancelCorrection() {
      correctionTarget.value = null;
      correctionReason.value = '';
    }

    function issue(slip: ReleaseSlip): IssueOutcome {
      const outcome = appendReleaseSlip(slip);
      // 无论成功失败都重新加载：成功时同步交错合并后的完整历史；
      // 失败（配额 / 编号冲突 / 持续交错 / 保护态）时让界面看到最新真实存档。
      reloadArchive();
      if (!outcome.ok) {
        return { ok: false, error: appendFailureWarning(outcome.kind).message };
      }
      invalidatedSlip.value = null;
      activeSlip.value = slip;
      return { ok: true, error: null };
    }

    // 闸门依据的任何变化都让当前授权立即失效（历史单据不受影响）。
    // 监听在单例作用域上，放行页未挂载时（如在单稿页改文字）同样生效。
    // 注意：文字 / 行宽是整体替换的原始值，不能与数组共用 deep 监听（deep 不追踪原始值替换）。
    function invalidate() {
      if (activeSlip.value) {
        invalidatedSlip.value = activeSlip.value;
        activeSlip.value = null;
      }
    }
    watch(draft.text, invalidate);
    watch(draft.width, invalidate);
    watch(
      [calibration.readings, calibration.result, calibration.isProtectedArchive, calibration.recordVersion],
      invalidate,
      { deep: true }
    );

    return {
      archive,
      activeSlip,
      invalidatedSlip,
      correctionTarget,
      correctionReason,
      beginCorrection,
      cancelCorrection,
      issue,
      reloadArchive
    };
  }) as ReleaseSession;
  return singleton;
}

/** 测试辅助：丢弃放行会话单例（模拟刷新）。 */
export function __resetReleaseSessionForTests(): void {
  singletonScope?.stop();
  singletonScope = null;
  singleton = null;
}
