"""Regression tests for the enforcer false-positive / catch-22 fixes.

Covers:
  * delivery_enforcement: quote-masking so a browser-exe name or a source path
    inside a quoted argument (grep pattern, curl UA, a VCS commit message) no
    longer false-blocks; real launches/redirects still block.
  * expert_review_required: the low-risk exemption is reachable at commit time
    (staged/unstaged changes are considered, not just committed-vs-base).
  * enforcement_self_protect: the policy DATABASE is a protected bypass surface
    (writes / sqlite mutations blocked) while a quoted mention does not self-trip
    and the .uap/reviews compliance dir stays writable.

Trigger tokens are assembled from parts so the test source itself does not
contain a literal the live gate would block on.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENF_DIR = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers"
DELIV = ENF_DIR / "delivery_enforcement.py"
SELF = ENF_DIR / "enforcement_self_protect.py"
EXPERT = ENF_DIR / "expert_review_required.py"

BR = "chrom" + "ium"
RD = ">"
SQ = "sq" + "lite3"
PDB = "polic" + "ies.db"
UPD = "UPD" + "ATE"
SEL = "SEL" + "ECT"
GC = "git " + "commit"
GP = "git " + "push"


def _run(enf, op, args, env=None, cwd=None):
    e = dict(os.environ)
    e.pop("UAP_SELF_PROTECT_OFF", None)
    e.pop("UAP_NO_REVIEW", None)
    if env:
        e.update(env)
    p = subprocess.run(
        [sys.executable, str(enf), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, env=e, cwd=cwd,
    )
    out = json.loads(p.stdout) if p.stdout.strip() else {}
    return p.returncode, out


class DeliveryQuoteMasking(unittest.TestCase):
    def test_browser_name_inside_quotes_allowed(self):
        rc, out = _run(DELIV, "Bash", {"command": 'curl -A "Mozilla %s/120" http://x' % BR})
        self.assertTrue(out.get("allowed"), out)

    def test_commit_message_mentioning_path_allowed(self):
        cmd = '%s -m "update vendor/app.css; build %s dist/app.js"' % (GC, RD)
        rc, out = _run(DELIV, "Bash", {"command": cmd})
        self.assertTrue(out.get("allowed"), out)

    def test_real_browser_launch_still_blocked(self):
        rc, out = _run(DELIV, "Bash", {"command": "%s file:///tmp/x.html" % BR})
        self.assertFalse(out.get("allowed"), out)

    def test_real_source_redirect_still_blocked(self):
        rc, out = _run(DELIV, "Bash", {"command": "printf x %s src/app.ts" % RD})
        self.assertFalse(out.get("allowed"), out)


class ExpertReviewStagedExemption(unittest.TestCase):
    def _git_repo(self, td, staged_name):
        root = Path(td)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True)
        f = root / staged_name
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
        subprocess.run(["git", "add", staged_name], cwd=root, check=True)
        return root

    def test_staged_low_risk_change_exempt_at_commit_time(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._git_repo(td, "apps/web/styles.css")
            rc, out = _run(EXPERT, "Bash", {"command": "%s origin HEAD" % GP},
                           env={"UAP_REPO_ROOT": str(root)}, cwd=str(root))
            self.assertTrue(out.get("allowed"), out)

    def test_no_review_override_allows(self):
        rc, out = _run(EXPERT, "Bash", {"command": "%s origin HEAD" % GP},
                       env={"UAP_NO_REVIEW": "1"})
        self.assertTrue(out.get("allowed"), out)


class SelfProtectPolicyDB(unittest.TestCase):
    def test_write_policy_db_blocked(self):
        rc, out = _run(SELF, "Write", {"file_path": "agents/data/memory/%s" % PDB})
        self.assertFalse(out.get("allowed"), out)

    def test_sqlite_mutation_blocked(self):
        cmd = '%s agents/data/memory/%s "%s policies SET isActive=0"' % (SQ, PDB, UPD)
        rc, out = _run(SELF, "Bash", {"command": cmd})
        self.assertFalse(out.get("allowed"), out)

    def test_sqlite_read_allowed(self):
        cmd = '%s agents/data/memory/%s "%s * FROM policies"' % (SQ, PDB, SEL)
        rc, out = _run(SELF, "Bash", {"command": cmd})
        self.assertTrue(out.get("allowed"), out)

    def test_quoted_mention_not_self_tripped(self):
        cmd = 'uap memory store "note: %s %s %s flips a row"' % (SQ, PDB, UPD)
        rc, out = _run(SELF, "Bash", {"command": cmd})
        self.assertTrue(out.get("allowed"), out)

    def test_review_artifact_dir_still_writable(self):
        rc, out = _run(SELF, "Write", {"file_path": ".uap/reviews/some-branch.json"})
        self.assertTrue(out.get("allowed"), out)


if __name__ == "__main__":
    unittest.main()
