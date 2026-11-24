import { threadKey } from "@t3tools/client-runtime/state/entities";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DESKTOP_TRAY_MAX_THREADS_PER_SECTION,
  DESKTOP_TRAY_MAX_TITLE_LENGTH,
  EnvironmentId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { buildDesktopTraySnapshot } from "./desktopTray";
import { makeThreadFixture } from "./test-fixtures";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const threadId = ThreadId.make("same-id");
const before = "2026-06-20T00:59:00.000Z";
const completed = "2026-06-20T01:00:00.000Z";

function completedThread(environmentId: EnvironmentId, title: string) {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture({ id: threadId, title }).source,
    latestRunId: RunId.make("finished"),
    latestRunCompletedAt: DateTime.makeUnsafe(completed),
    status: "completed",
  });
}

describe("desktop tray snapshot", () => {
  it("includes read and unread threads even when they share an ID across environments", () => {
    const read = completedThread(local, "Read locally");
    const unread = { ...completedThread(remote, "Unread remotely"), lastVisitedAt: before };
    const localVisits = {
      [threadKey({ environmentId: local, threadId })]: completed,
      [threadKey({ environmentId: remote, threadId })]: completed,
    };

    expect(buildDesktopTraySnapshot([read, unread], localVisits)).toEqual({
      inbox: [
        { ref: { environmentId: local, threadId }, title: "Read locally" },
        { ref: { environmentId: remote, threadId }, title: "Unread remotely" },
      ],
      working: [],
      needsAttentionBadge: false,
    });
  });

  it("puts blockers and errors in the inbox, separates active work and skips settled or snoozed threads", () => {
    const thread = completedThread(local, "Fixture");
    const approval = { ...thread, title: "Approval", hasPendingApprovals: true };
    const input = { ...thread, title: "User input", hasPendingUserInput: true };
    const error = presentThreadShell(local, {
      ...thread.source,
      title: "Error",
      status: "failed",
    });
    const active = presentThreadShell(local, {
      ...thread.source,
      title: "Active",
      status: "running",
      activeRunId: RunId.make("finished"),
    });
    const settled = { ...input, title: "Settled", settledOverride: "settled" } as const;
    const quiet = { ...thread, title: "Read", lastVisitedAt: completed };
    const snoozed = { ...thread, title: "Snoozed", snoozedUntil: "2026-06-21T00:00:00.000Z" };

    const snapshot = buildDesktopTraySnapshot(
      [approval, error, active, settled, quiet, snoozed, input],
      {},
      completed,
    );

    expect(snapshot.inbox.map(({ title }) => title)).toEqual([
      "Approval",
      "Error",
      "Read",
      "User input",
    ]);
    expect(snapshot.working.map(({ title }) => title)).toEqual(["Active"]);
    expect(snapshot.needsAttentionBadge).toBe(true);
    expect(buildDesktopTraySnapshot([active, settled, quiet], {}).needsAttentionBadge).toBe(false);
  });

  it("limits each section and cleans up multiline titles for native menu labels", () => {
    const threads = Array.from({ length: DESKTOP_TRAY_MAX_THREADS_PER_SECTION + 2 }, (_, i) => ({
      ...completedThread(local, `Thread ${i}\n${"x".repeat(DESKTOP_TRAY_MAX_TITLE_LENGTH)}`),
      id: ThreadId.make(`id-${i}`),
      lastVisitedAt: before,
    }));
    const snapshot = buildDesktopTraySnapshot(threads, {});

    expect(snapshot.working).toEqual([]);
    expect(snapshot.needsAttentionBadge).toBe(false);
    expect(snapshot.inbox).toHaveLength(DESKTOP_TRAY_MAX_THREADS_PER_SECTION);
    expect(snapshot.inbox[0]?.title).toBe(
      `Thread 0 ${"x".repeat(DESKTOP_TRAY_MAX_TITLE_LENGTH - 9)}`,
    );
  });
});
