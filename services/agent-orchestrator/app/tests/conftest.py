# app/tests/conftest.py
import shutil
import pytest

MOCK_ERP_PATH = "mock_erp.xlsx"
_BACKUP_PATH = MOCK_ERP_PATH + ".test_session_backup"


# Tests write real transactions (Sales Orders, Quotations, Reservations,
# ...) into the actual mock_erp.xlsx, since that's the only ERP this
# system has. Without this, every separate `pytest` invocation piles more
# state on top of the last one forever — which is exactly what broke
# credit-check tests (a shared test customer's exposure kept growing
# across reruns until it blew past its own credit_limit). This restores
# the file to how it looked at the start of the session, so one `pytest`
# run's data doesn't leak into the next.
# try/finally, not a bare yield — a killed/interrupted run (Ctrl-C, a
# test timeout, an external kill) used to skip the restore entirely,
# permanently baking that run's writes into mock_erp.xlsx. That's exactly
# what silently ground Wireless Mouse's stock down across many sessions
# until consignment tests started failing on real stock exhaustion, not a
# logic bug — this fixture is what's supposed to prevent that.
@pytest.fixture(scope="session", autouse=True)
def _isolate_mock_erp():
    shutil.copy(MOCK_ERP_PATH, _BACKUP_PATH)
    try:
        yield
    finally:
        shutil.copy(_BACKUP_PATH, MOCK_ERP_PATH)
