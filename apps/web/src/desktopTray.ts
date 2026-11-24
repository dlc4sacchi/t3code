import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { hasUnseenRunFailure } from "@t3tools/client-runtime/state/thread-settled";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  DESKTOP_TRAY_MAX_THREADS_PER_SECTION,
  DESKTOP_TRAY_MAX_TITLE_LENGTH,
  DESKTOP_TRAY_OPEN_THREAD_PREFIX,
  type DesktopTraySnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "./components/Sidebar.logic";
import type { AppRouter } from "./router";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentThreadShells } from "./state/threads";
import { useUiStateStore } from "./uiStateStore";

const trayThreadsAtom = Atom.make((get) => {
  const delegated = get(environmentThreadShells.delegatedUnderParentAtom);
  return get(environmentThreadShells.quietThreadShellsAtom)
    .filter((thread) => {
      const ref = { environmentId: thread.environmentId, threadId: thread.id };
      return thread.archivedAt === null && !isShownUnderParent(ref, thread.lineage, delegated);
    })
    .toSorted((left, right) =>
      (right.latestUserMessageAt ?? right.createdAt).localeCompare(
        left.latestUserMessageAt ?? left.createdAt,
      ),
    );
});

export function buildDesktopTraySnapshot(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  localVisits: Readonly<Record<string, string>>,
): DesktopTraySnapshot {
  const inbox: Array<DesktopTraySnapshot["inbox"][number]> = [];
  const working: Array<DesktopTraySnapshot["working"][number]> = [];
  let needsAttentionBadge = false;
  for (const thread of threads) {
    if (thread.settledOverride === "settled" || thread.archivedAt !== null) continue;
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      localVisits[threadKey(ref)],
    );
    const visitedThread = { ...thread, lastVisitedAt };
    const status = resolveSidebarRowStatus(visitedThread);
    const blocked =
      status === "approval" ||
      status === "input" ||
      status === "request" ||
      status === "limited" ||
      status === "failed" ||
      hasUnseenRunFailure(visitedThread);
    needsAttentionBadge ||= blocked;

    const section = blocked
      ? inbox
      : threadRuntimeIsActive(thread.runtime)
        ? working
        : !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks) &&
            hasUnseenCompletion(visitedThread)
          ? inbox
          : null;
    if (section && section.length < DESKTOP_TRAY_MAX_THREADS_PER_SECTION) {
      section.push({
        ref,
        title: thread.title
          .replace(/[\r\n\t]/g, " ")
          .trim()
          .slice(0, DESKTOP_TRAY_MAX_TITLE_LENGTH),
      });
    }
    if (
      needsAttentionBadge &&
      inbox.length === DESKTOP_TRAY_MAX_THREADS_PER_SECTION &&
      working.length === DESKTOP_TRAY_MAX_THREADS_PER_SECTION
    )
      break;
  }
  return { inbox, working, needsAttentionBadge };
}

export function startDesktopTray(router: AppRouter): void {
  const bridge = window.desktopBridge;
  const setSnapshot = bridge?.setTraySnapshot;
  if (!setSnapshot) return;

  let published = "";
  let displayedThreads = new Map<string, ScopedThreadRef>();

  const publish = () => {
    const threads = appAtomRegistry.get(trayThreadsAtom);
    const { threadLastVisitedAtById } = useUiStateStore.getState();
    const snapshot = buildDesktopTraySnapshot(threads, threadLastVisitedAtById);
    const key = JSON.stringify(snapshot);
    if (key === published) return;
    published = key;
    displayedThreads = new Map(
      [...snapshot.inbox, ...snapshot.working].map(({ ref }) => [threadKey(ref), ref]),
    );
    void setSnapshot(snapshot).catch(() => {
      if (published === key) published = "";
    });
  };

  bridge.onMenuAction((action) => {
    if (!action.startsWith(DESKTOP_TRAY_OPEN_THREAD_PREFIX)) return;
    const ref = displayedThreads.get(action.slice(DESKTOP_TRAY_OPEN_THREAD_PREFIX.length));
    if (ref) void router.navigate({ to: "/$environmentId/$threadId", params: ref });
  });
  appAtomRegistry.subscribe(trayThreadsAtom, publish);
  useUiStateStore.subscribe((state, previous) => {
    if (state.threadLastVisitedAtById !== previous.threadLastVisitedAtById) publish();
  });
  publish();
}
