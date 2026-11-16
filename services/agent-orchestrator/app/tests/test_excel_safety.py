# Phase 2: the Excel workbook is still a live store. These tests prove, across
# real OS processes (not just threads): writers never overwrite one another,
# a killed process cannot corrupt the workbook or wedge the lock, and
# lock-free readers never see a partial file.
import ast
import glob
import os
import signal
import subprocess
import sys
import textwrap
import time
import uuid

import openpyxl

from app.tools.idempotency_tools import save_workbook

PY = [sys.executable, "-I", "-c"]
PRELUDE = "import sys; sys.path.insert(0, '.')\n"


def _run(script: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(PY + [PRELUDE + textwrap.dedent(script)], capture_output=True, text=True, cwd=os.getcwd(), timeout=120, **kw)


def _sheet_rows(sheet: str) -> list[tuple]:
    wb = openpyxl.load_workbook("mock_erp.xlsx", read_only=True)
    try:
        return list(wb[sheet].iter_rows(min_row=2, values_only=True)) if sheet in wb.sheetnames else []
    finally:
        wb.close()


def test_every_function_that_saves_the_workbook_holds_the_exclusive_lock():
    """Structural guard: a new unlocked writer fails here instead of silently
    losing other writers' rows in production."""
    offenders = []
    for path in sorted(glob.glob("app/tools/*.py")):
        if path.endswith("idempotency_tools.py"):
            continue
        tree = ast.parse(open(path).read())
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            saves = any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id == "save_workbook" for c in ast.walk(node))
            locked = any("idempotency_lock" in ast.unparse(d) for d in node.decorator_list)
            if saves and not locked:
                offenders.append(f"{os.path.basename(path)}:{node.name}")
            if saves and isinstance(node, ast.AsyncFunctionDef):
                offenders.append(f"{os.path.basename(path)}:{node.name} (async: lock would release before the body runs)")
    assert not offenders, offenders


def test_no_code_saves_the_workbook_in_place_any_more():
    offenders = []
    for path in glob.glob("app/**/*.py", recursive=True):
        if "/tests/" in path or path.endswith("idempotency_tools.py"):
            continue
        for lineno, line in enumerate(open(path), 1):
            if ".save(" in line and not line.strip().startswith("#"):
                offenders.append(f"{path}:{lineno}")
    assert not offenders, offenders


def test_process_killed_mid_save_leaves_the_previous_workbook_intact():
    before = _sheet_rows("Customer Master")
    proc = _run("""
        import os, openpyxl
        from app.tools.idempotency_tools import save_workbook
        wb = openpyxl.load_workbook('mock_erp.xlsx')
        wb['Customer Master'].append(['CRASH', 'Crash Co', True, 1])
        def dies_mid_write(path):
            with open(path, 'wb') as f:
                f.write(b'PK\\x03\\x04 truncated')
            os._exit(9)
        wb.save = dies_mid_write
        save_workbook(wb)
    """)
    assert proc.returncode == 9
    assert _sheet_rows("Customer Master") == before  # still the complete old workbook, loadable
    assert not any(r[0] == "CRASH" for r in _sheet_rows("Customer Master"))


def test_killed_lock_holder_does_not_wedge_other_writers():
    child = subprocess.Popen(
        PY + [PRELUDE + textwrap.dedent("""
            import time
            from app.tools.idempotency_tools import idempotency_lock
            @idempotency_lock()
            def hold():
                print('locked', flush=True)
                time.sleep(300)
            hold()
        """)],
        stdout=subprocess.PIPE, text=True, cwd=os.getcwd(),
    )
    try:
        assert child.stdout.readline().strip() == "locked"
        child.send_signal(signal.SIGKILL)  # hard kill while holding the flock
        child.wait(timeout=10)
        from app.tools.customer_tools import create_customer

        started = time.time()
        out = create_customer(f"After Kill {uuid.uuid4().hex[:6]}")
        assert out["customer_id"].startswith("C")
        assert time.time() - started < 10  # the OS released the dead holder's lock
    finally:
        if child.poll() is None:
            child.kill()


def test_concurrent_writers_in_separate_processes_lose_nothing():
    tag = uuid.uuid4().hex[:6]
    scripts = []
    for i in range(6):
        scripts.append(f"""
            from app.tools.customer_tools import create_customer
            from app.tools.sales_tools import create_quotation, create_sales_order
            for j in range(3):
                create_customer('Proc{i}-{tag}-' + str(j))
                create_quotation('C001','ABC','P011','Mouse',1,10.0,30,'xp{i}-' + str(j) + '-{tag}')
                create_sales_order('C001','ABC',True,'P011','Mouse',1,10.0,None, idempotency_key='xp-{tag}-{i}-' + str(j))
        """)
    procs = [subprocess.Popen(PY + [PRELUDE + textwrap.dedent(s)], stderr=subprocess.PIPE, text=True, cwd=os.getcwd()) for s in scripts]
    errors = [p.communicate(timeout=180)[1] for p in procs]
    assert all(p.returncode == 0 for p in procs), errors

    names = {r[1] for r in _sheet_rows("Customer Master")}
    assert {f"Proc{i}-{tag}-{j}" for i in range(6) for j in range(3)} <= names
    quotes = [r for r in _sheet_rows("Quotations") if r[11] and str(r[11]).endswith(f"-{tag}")]
    assert len(quotes) == 18
    keys = [r[0] for r in _sheet_rows("IdempotencyKeys") if str(r[0]).startswith(f"xp-{tag}-")]
    assert len(keys) == 18 and len(set(keys)) == 18


def test_lock_free_readers_never_see_a_partial_workbook_while_it_is_being_rewritten():
    r = subprocess.Popen(PY + [PRELUDE + textwrap.dedent("""
        import time, openpyxl
        end = time.time() + 4
        n = bad = 0
        while time.time() < end:
            try:
                wb = openpyxl.load_workbook('mock_erp.xlsx', read_only=True); wb.close(); n += 1
            except Exception:
                bad += 1
        print(n, bad)
    """)], stdout=subprocess.PIPE, text=True, cwd=os.getcwd())
    end = time.time() + 4
    writes = 0
    while time.time() < end:
        wb = openpyxl.load_workbook("mock_erp.xlsx")
        wb["Customer Master"].append([f"RW{writes}", f"Reader Writer {writes}-{uuid.uuid4().hex[:4]}", True, 1])
        save_workbook(wb)
        writes += 1
    out, _ = r.communicate(timeout=30)
    reads, bad = map(int, out.split())
    assert writes > 3 and reads > 20
    assert bad == 0, f"{bad} of {reads} lock-free reads saw a partial workbook"
