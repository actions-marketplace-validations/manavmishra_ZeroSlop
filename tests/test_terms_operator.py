"""Guard the owner-confirmed hosted-service identity without changing legal rights."""
import pathlib
import unittest


class TermsOperatorTest(unittest.TestCase):
    def test_owner_confirmed_operator_is_used_consistently(self):
        terms = (pathlib.Path(__file__).resolve().parents[1] / "TERMS.md").read_text()
        self.assertNotIn("Garage Capital LLC", terms)
        self.assertEqual(terms.count("Garage Capital Ventures LLC"), 5)
        self.assertIn("Version 1.2", terms)
        self.assertIn("Effective 22 September 2026", terms)
        self.assertIn("Cloudflare Workers AI or OpenRouter", terms)
        self.assertIn("zero-data-retention routing", terms)


if __name__ == "__main__":
    unittest.main()
