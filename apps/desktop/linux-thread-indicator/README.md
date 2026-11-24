# Standalone GNOME thread indicator

Use this optional companion with the stock Linux desktop app. It runs as a systemd user service, so replacing or updating the T3 Code AppImage leaves the indicator installed. Use one indicator at a time if your desktop build already provides a tray icon.

The companion opens local threads through T3 Code's registered desktop links. It reads the local thread database in read-only mode. Inbox includes ordinary unsettled threads even when none need attention. Working shows active runs. The red dot indicates pending requests or unresolved failures.

## Install

Enable GNOME's AppIndicator and KStatusNotifierItem Support extension. The installer uses systemd, GTK 3, Python GObject and Pillow, and the Ayatana AppIndicator GTK 3 introspection library.

From the repository root, run the following command as your desktop user.

```sh
bash apps/desktop/linux-thread-indicator/install.sh
```

The service starts with the graphical session. To turn it off, run the following command.

```sh
systemctl --user disable --now t3-thread-indicator.service
```

An update that changes the local database schema may need a corresponding companion update. The menu reports when thread status is unavailable.
