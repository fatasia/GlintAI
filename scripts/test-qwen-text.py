"""No model/torch dependency: verify text chunking used by the optional worker."""
import ast
from pathlib import Path
import re
import unittest

source = Path(__file__).parents[1] / "packages/tts/adapters/qwen_clone.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "split_text")
namespace = {"re": re}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
split_text = namespace["split_text"]

class ChunkTests(unittest.TestCase):
    def test_preserves_all_content(self):
        for text in ["短句。", "第一句。第二句！" * 100, "A long explanation. " * 100, "字" * 10000, "word " * 2000, "...!!!"]:
            chunks = split_text(text)
            self.assertTrue(all(0 < len(chunk) <= 180 for chunk in chunks))
            self.assertEqual(re.sub(r"\s", "", "".join(chunks)), re.sub(r"\s", "", text))
    def test_short_text_is_not_split(self):
        self.assertEqual(split_text("A short sentence. Another one!"), ["A short sentence. Another one!"])

if __name__ == "__main__": unittest.main()
