#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$HOME/.local/share/t3-thread-indicator"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
icon="$source_dir/../../../assets/nightly/nightly-universal-1024.png"

mkdir -p "$target" "$unit_dir"
/usr/bin/python3 - "$icon" "$target" <<'PY'
from pathlib import Path
import sys

import gi
from PIL import Image, ImageDraw

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")

target = Path(sys.argv[2])
with Image.open(sys.argv[1]) as source:
    icon = source.convert("RGBA").resize((32, 32), Image.Resampling.LANCZOS)
icon.save(target / "t3code.png")

draw = ImageDraw.Draw(icon)
draw.ellipse((20, 0, 31, 11), fill="#222226")
draw.ellipse((22, 2, 29, 9), fill="#e62d42")
icon.save(target / "t3code-attention.png")
PY
install -m 644 "$source_dir/indicator.py" "$target/indicator.py"
install -m 644 "$source_dir/t3-thread-indicator.service" "$unit_dir/t3-thread-indicator.service"
systemctl --user daemon-reload
systemctl --user enable t3-thread-indicator.service
systemctl --user restart t3-thread-indicator.service
