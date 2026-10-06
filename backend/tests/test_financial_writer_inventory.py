"""New database writers and mutating URLs require a maintained accounting policy."""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT.parent / "docs" / "financial-writer-inventory.json"
WRITE_METHODS = {
    "insert_one", "insert_many", "update_one", "update_many", "replace_one", "delete_one",
    "delete_many", "find_one_and_update", "find_one_and_delete", "bulk_write", "create_index",
    "drop_index", "drop_collection", "create_collection", "upload_from_stream_with_id", "delete",
}


def writer_functions():
    result = set()
    paths = [ROOT / "server.py"]
    for directory in ("routes", "services", "scripts", "utils"):
        paths.extend((ROOT / directory).glob("*.py"))
    for path in paths:
        module = path.relative_to(ROOT).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))

        def inspect(node, ancestors=()):
            name = ancestors
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = (*ancestors, node.name)
                stack = list(node.body)
                direct = False
                while stack:
                    child = stack.pop()
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        continue
                    if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute) and child.func.attr in WRITE_METHODS:
                        direct = True
                    stack.extend(ast.iter_child_nodes(child))
                route = any(isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                    and d.func.attr in {"post", "put", "patch", "delete"} for d in node.decorator_list)
                if direct or route:
                    result.add(f"{module}:{'.'.join(name)}")
            # Nested transaction callbacks retain distinct parent bindings.
            for child in ast.iter_child_nodes(node):
                inspect(child, name)
        inspect(tree)
    return result


def test_all_writers_have_an_explicit_financial_policy():
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    entries = inventory["writers"]
    known = {entry["function"] for entry in entries}
    assert len(known) == len(entries), "Duplicate writer bindings in maintained inventory"
    assert writer_functions() == known, "Update the writer inventory and audit each new/removed writer"
    for entry in entries:
        assert entry["policy"] in inventory["policies"]
        assert inventory["policies"][entry["policy"]].strip()
