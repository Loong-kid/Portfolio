"""서비스 어카운트 JSON → Streamlit Cloud secrets.toml 변환 헬퍼.

사용법:
    python json_to_toml_secrets.py
    python json_to_toml_secrets.py path/to/sa.json

출력된 [gcp_service_account] 섹션을 Streamlit Cloud의
Settings → Secrets에 붙여넣기.
"""
from __future__ import annotations
import sys
import json
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def _toml_escape(s: str) -> str:
    """TOML basic string escape: \\, ", control chars."""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def convert(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    lines = ["[gcp_service_account]"]
    for k, v in data.items():
        if isinstance(v, str):
            lines.append(f'{k} = "{_toml_escape(v)}"')
        else:
            lines.append(f"{k} = {json.dumps(v)}")
    return "\n".join(lines)


def main():
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
    else:
        candidates = list(Path(".").glob("balance-sheet-*.json"))
        if not candidates:
            candidates = list(Path(".").glob("*.json"))
        if not candidates:
            print("❌ JSON 파일 못 찾음. 인자로 경로 넘기거나 현재 디렉토리에 두기.")
            sys.exit(1)
        path = candidates[0]
        print(f"# 자동 감지: {path}")

    print(convert(path))
    print()
    print("# ─── 위 [gcp_service_account] 섹션을 Streamlit Cloud secrets에 붙여넣기. ───")


if __name__ == "__main__":
    main()
