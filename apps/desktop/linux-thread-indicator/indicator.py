#!/usr/bin/python3
"""GNOME tray access to the local T3 Code environment."""
from contextlib import closing
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from urllib.parse import quote

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import AyatanaAppIndicator3 as AppIndicator, Gio, GLib, Gtk

ASSETS = Path(__file__).resolve().parent
DATA = Path(os.environ.get("T3CODE_HOME", Path.home() / ".t3")) / "userdata"
APP_ID = "com.t3tools.T3Code"
BUSY = {"preparing", "queued", "starting", "running", "waiting"}
SQL = """
SELECT t.thread_id AS id, t.title, t.created_at,
       json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_id,
       json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
       json_extract(t.payload_json, '$.lineage.sideChat') AS side_chat,
       json_extract(t.payload_json, '$.lineage.workflowStep') AS workflow_step,
       json_extract(t.payload_json, '$.settledOverride') AS settled,
       json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
       json_extract(t.payload_json, '$.lastVisitedAt') AS visited_at,
       r.status, r.requested_at, r.completed_at,
       EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests q
              WHERE q.thread_id = t.thread_id AND q.status = 'pending' AND q.kind != 'auth_refresh')
           AS pending,
       EXISTS(SELECT 1 FROM json_each(t.payload_json, '$.guestShare.messages')
              WHERE json_extract(value, '$.status') = 'pending') AS guest_pending
FROM orchestration_v2_projection_threads t
LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
    SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = t.thread_id
    ORDER BY ordinal DESC LIMIT 1
)
WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
  AND (json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
       OR json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
       OR json_extract(t.payload_json, '$.lineage.sideChat') = 1)
ORDER BY COALESCE(r.requested_at, t.created_at) DESC, t.thread_id
"""


def time_of(raw):
    if not raw:
        return datetime.min.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(raw)


def nested(row):
    return row["side_chat"] or row["workflow_step"] or row["relationship"] == "subagent"


def select_threads(rows):
    now = datetime.now(timezone.utc)
    by_id = {row["id"]: row for row in rows}
    pending = set()
    for row in rows:
        if not (row["pending"] or row["guest_pending"]):
            continue
        target = row
        seen = {row["id"]}
        while nested(target):
            parent_id = target["parent_id"]
            if parent_id in seen or parent_id not in by_id:
                break
            seen.add(parent_id)
            target = by_id[parent_id]
        if not nested(target):
            pending.add(target["id"])

    inbox, working = [], []
    badge = False
    for row in rows:
        if row["settled"] == "settled" or nested(row):
            continue
        failed = row["status"] == "failed" and (
            not row["visited_at"] or time_of(row["completed_at"] or row["requested_at"]) >
            time_of(row["visited_at"])
        )
        attention = row["id"] in pending or failed
        if not attention and time_of(row["snoozed_until"]) > now:
            continue
        badge |= attention
        entry = (row["id"], " ".join(row["title"].split())[:100] or "Untitled thread")
        section = working if not attention and row["status"] in BUSY else inbox
        if len(section) < 12:
            section.append(entry)
    return inbox, working, badge


def snapshot():
    with closing(sqlite3.connect(
        f"{(DATA / 'statev2.sqlite').as_uri()}?mode=ro", uri=True, timeout=0.25
    )) as connection:
        connection.row_factory = sqlite3.Row
        groups = select_threads(connection.execute(SQL).fetchall())
        project_paths = connection.execute("""
            SELECT workspace_root FROM projection_projects
            WHERE archived_at IS NULL AND deleted_at IS NULL
            ORDER BY updated_at DESC
        """).fetchall()
    project = next((row[0] for row in project_paths if Path(row[0]).is_dir()), None)
    return (DATA / "environment-id").read_text().strip(), *groups, project


def open_thread(environment, thread):
    uri = f"t3code://threads/{quote(environment, safe='')}/{quote(thread, safe='')}"
    Gio.AppInfo.launch_default_for_uri(uri)


def launch(*args):
    subprocess.Popen(args, stdout=subprocess.DEVNULL)


def main():
    indicator = AppIndicator.Indicator.new(
        "t3-thread-indicator", str(ASSETS / "t3code.png"), AppIndicator.IndicatorCategory.APPLICATION_STATUS
    )
    indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
    indicator.set_title("T3 Code")
    previous = None
    previous_error = None

    def refresh():
        nonlocal previous, previous_error
        try:
            state = snapshot()
            previous_error = None
            message = None
        except (OSError, sqlite3.Error, ValueError) as error:
            if str(error) != previous_error:
                logging.warning("Could not read T3 Code thread status: %s", error)
                previous_error = str(error)
            state = ("", [], [], False, None)
            message = "Thread status unavailable"
        key = (*state, message)
        if key == previous:
            return GLib.SOURCE_CONTINUE
        previous = key

        environment, inbox, working, badge, project = state
        menu = Gtk.Menu()

        def item(label, callback=None, parent=menu):
            row = Gtk.MenuItem.new_with_label(label)
            if callback is None:
                row.set_sensitive(False)
            else:
                row.connect("activate", lambda _: callback())
            parent.append(row)
            return row

        def section(label, threads, empty=None):
            if not threads and empty is None:
                return
            item(label)
            if not threads:
                item(empty)
            for thread, title in threads[:3]:
                item(title, lambda thread=thread: open_thread(environment, thread))
            if len(threads) > 3:
                submenu = Gtk.Menu()
                more = Gtk.MenuItem.new_with_label("More")
                more.set_submenu(submenu)
                menu.append(more)
                for thread, title in threads[3:]:
                    item(title, lambda thread=thread: open_thread(environment, thread), submenu)
            menu.append(Gtk.SeparatorMenuItem())

        section("Inbox", inbox, message or "No inbox threads")
        section("Working", working)
        if project and (Path.home() / ".local/bin/t3").is_file():
            item("New Thread", lambda: launch(str(Path.home() / ".local/bin/t3"), "app", project))
        item("Open T3 Code", lambda: launch("gtk-launch", APP_ID))
        menu.append(Gtk.SeparatorMenuItem())
        item("Quit Indicator", Gtk.main_quit)
        menu.show_all()
        indicator.set_menu(menu)
        icon = "t3code-attention.png" if badge else "t3code.png"
        indicator.set_icon_full(str(ASSETS / icon), "T3 Code needs attention" if badge else "T3 Code")
        return GLib.SOURCE_CONTINUE

    refresh()
    GLib.timeout_add_seconds(3, refresh)
    Gtk.main()


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        _, inbox, working, badge, _ = snapshot()
        print(f"Inbox: {len(inbox)}, Working: {len(working)}, Attention badge: {badge}")
    else:
        main()
