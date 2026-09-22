"""Smoke-test documented installed-skill commands outside the repository cwd."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "SKILL.md"
SCRIPT_COMMAND = re.compile(r"python3\s+([^\s`]+\.py)")


class SkillCommands(unittest.TestCase):
    def test_documented_scripts_are_rooted_and_runnable_from_any_cwd(self):
        commands = SCRIPT_COMMAND.findall(SKILL.read_text(encoding="utf-8"))
        self.assertTrue(commands)
        scripts = set()
        for command in commands:
            self.assertTrue(command.startswith("<skill-root>/scripts/"), command)
            script = ROOT / command.removeprefix("<skill-root>/")
            self.assertTrue(script.is_file(), command)
            scripts.add(script)

        with tempfile.TemporaryDirectory() as directory:
            for script in sorted(scripts):
                with self.subTest(script=script.name):
                    result = subprocess.run(
                        [sys.executable, str(script), "--help"],
                        cwd=directory,
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
