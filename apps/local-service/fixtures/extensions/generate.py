"""Generate project-authored ZIP regression fixtures; no third-party content."""
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).parent
manifest = json.dumps({"display_name": "Root extension", "js": "index.js", "license": "MIT"})
base = [("manifest.json", manifest), ("index.js", "export {};")]

def archive(name, entries):
    with ZipFile(root / (name + ".zip"), "w", compression=ZIP_DEFLATED) as target:
        for name, content in entries:
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            target.writestr(info, content)

archive("root", base + [("nested/manifest.json", "{}")])
archive("wrapper", [("repo-main/" + k, v) for k, v in base])
archive("missing-root", [("index.js", "export {};"), ("nested/manifest.json", manifest)])
archive("invalid-entry", [("manifest.json", json.dumps({"display_name": "Invalid", "js": "../evil.js"}))])
archive("duplicate", base + [("./index.js", "overwritten")])
archive("oversized-file", base + [("large.bin", bytes(16 * 1024 * 1024 + 1))])
archive("oversized-total", base + [(str(i) + ".bin", bytes(14 * 1024 * 1024)) for i in range(5)])
archive("too-many-entries", [(str(i) + "/", "") for i in range(4097)])
with ZipFile(root / "symlink.zip", "w") as target:
    for name, content in base:
        target.writestr(name, content)
    info = ZipInfo("link.js", (2026, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o120777 << 16
    target.writestr(info, "index.js")
