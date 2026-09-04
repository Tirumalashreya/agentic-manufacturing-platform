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
@pytest.fixture(scope="session", autouse=True)
def _isolate_mock_erp():
    shutil.copy(MOCK_ERP_PATH, _BACKUP_PATH)
    yield
    shutil.copy(_BACKUP_PATH, MOCK_ERP_PATH)
