import {
  DESKTOP_TRAY_NEW_THREAD_ACTION,
  DESKTOP_TRAY_OPEN_THREAD_PREFIX,
  DesktopTraySnapshot,
} from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { m, onLocaleChange } from "../../i18n/messages.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_TRAY_SNAPSHOT_CHANNEL } from "../channels.ts";

const INLINE_THREADS = 3;
const ICON_SIZE = 32;

function withAttentionBadge(icon: Electron.NativeImage): Electron.NativeImage {
  const bitmap = icon.toBitmap();
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const distanceSquared = (x - 25.5) ** 2 + (y - 5.5) ** 2;
      if (distanceSquared > 5.5 ** 2) continue;
      // Electron's Linux native bitmap uses BGRA. Both badge colors are fully opaque.
      const bgra = distanceSquared <= 4 ** 2 ? 0xffe62d42 : 0xff222226;
      bitmap.writeUInt32LE(bgra, (y * ICON_SIZE + x) * 4);
    }
  }
  return Electron.nativeImage.createFromBitmap(bitmap, { width: ICON_SIZE, height: ICON_SIZE });
}

class LinuxTrayError extends Schema.TaggedError<LinuxTrayError>()("LinuxTrayError", {
  operation: Schema.Literals(["create", "update-menu"]),
  cause: Schema.Defect(),
}) {}

export const installLinuxTray = Effect.fn("desktop.ipc.installLinuxTray")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "linux") return;

  const ipc = yield* DesktopIpc.DesktopIpc;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const assets = yield* DesktopAssets.DesktopAssets;
  const iconPath = (yield* assets.iconPaths).png;
  let tray: Electron.Tray | undefined;
  let snapshot: DesktopTraySnapshot = { inbox: [], working: [], needsAttentionBadge: false };
  let normalIcon: Electron.NativeImage | undefined;
  let attentionIcon: Electron.NativeImage | undefined;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const run = (effect: Effect.Effect<void, DesktopWindow.DesktopWindowError>) => {
    runFork(
      effect.pipe(Effect.catchCause((cause) => Effect.logWarning("Tray action failed", cause))),
    );
  };
  const open = () => run(desktopWindow.activate);

  function refreshMenu() {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const section = (label: string, threads: DesktopTraySnapshot["working"]) => {
      if (threads.length === 0) return;
      const rows = threads.map(({ ref, title }) => ({
        // GTK interprets ampersands as menu accelerators.
        label: title.replaceAll("&", "&&") || m(msg("Untitled thread")),
        click: () =>
          run(desktopWindow.dispatchMenuAction(DESKTOP_TRAY_OPEN_THREAD_PREFIX + threadKey(ref))),
      }));
      items.push({ label, enabled: false }, ...rows.slice(0, INLINE_THREADS));
      if (rows.length > INLINE_THREADS) {
        items.push({ label: m(msg("More")), submenu: rows.slice(INLINE_THREADS) });
      }
      items.push({ type: "separator" });
    };
    section(m(msg("Inbox")), snapshot.inbox);
    section(m(msg("Working")), snapshot.working);
    items.push(
      {
        label: m(msg("New Thread")),
        click: () => run(desktopWindow.dispatchMenuAction(DESKTOP_TRAY_NEW_THREAD_ACTION)),
      },
      { label: m(msg("Open T3 Code")), click: open },
      { type: "separator" },
      { label: m(msg("Quit")), role: "quit" },
    );
    tray?.setContextMenu(Electron.Menu.buildFromTemplate(items));
  }

  const updateMenu = Effect.try({
    try: refreshMenu,
    catch: (cause) => new LinuxTrayError({ operation: "update-menu", cause }),
  }).pipe(Effect.catch((error) => Effect.logWarning(error)));
  if (Option.isSome(iconPath)) {
    yield* Effect.try({
      try: () => {
        const icon = Electron.nativeImage.createFromPath(iconPath.value);
        if (icon.isEmpty()) return;
        normalIcon = icon.resize({ width: ICON_SIZE, height: ICON_SIZE });
        attentionIcon = withAttentionBadge(normalIcon);
        tray = new Electron.Tray(normalIcon);
        tray.setToolTip(Electron.app.name);
        tray.on("click", open);
        refreshMenu();
      },
      catch: (cause) => new LinuxTrayError({ operation: "create", cause }),
    }).pipe(
      Effect.catch((error) => {
        tray?.destroy();
        tray = undefined;
        return Effect.logWarning(error);
      }),
    );
  }

  const unsubscribeLocale = onLocaleChange(() => {
    if (tray) runFork(updateMenu);
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribeLocale();
      tray?.destroy();
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_TRAY_SNAPSHOT_CHANNEL,
      payload: DesktopTraySnapshot,
      result: Schema.Void,
      handler: (next) =>
        Effect.suspend(() => {
          const badgeChanged = snapshot.needsAttentionBadge !== next.needsAttentionBadge;
          snapshot = next;
          if (!tray) return Effect.void;
          const icon = next.needsAttentionBadge ? attentionIcon : normalIcon;
          return Effect.sync(() => {
            if (badgeChanged && icon) tray?.setImage(icon);
          }).pipe(Effect.andThen(updateMenu));
        }),
    }),
  );
});
